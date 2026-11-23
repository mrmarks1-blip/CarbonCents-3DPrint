// Application state and every action the UI can take. Each action is logged
// to the console in plain language: what was asked, and what the printer said.
import { computed, effect, signal } from '@preact/signals'
import { diagnose, type ActionId, type Context } from './features/assistant'
import { freshTasks, recordJob, totalHours, usage, type Task } from './features/maintenance'
import { notify, scheduleReminders } from './features/notify'
import { DemoBackend } from './printer/demo'
import { MoonrakerBackend, probeMoonraker } from './printer/moonraker'
import { SdcpBackend } from './printer/sdcp'
import { emptyState, type Backend, type BackendEvents, type LogLevel, type PrinterInfo, type PrinterState } from './printer/types'

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`cc.${key}`)
    return v ? { ...fallback, ...JSON.parse(v) } : fallback
  } catch {
    return fallback
  }
}
function loadRaw<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`cc.${key}`)
    return v ? JSON.parse(v) : fallback
  } catch {
    return fallback
  }
}
const save = (key: string, v: unknown) => {
  try {
    localStorage.setItem(`cc.${key}`, JSON.stringify(v))
  } catch {
    /* private mode: run without persistence */
  }
}

export interface Settings {
  host: string
  fallbackHost: string
  backend: 'auto' | 'sdcp' | 'moonraker' | 'demo'
  notifications: boolean
  cam: { brightness: number; contrast: number; saturation: number; rotate: boolean; mirror: boolean }
}
// When this page is served by the printer itself (copied into its web root as /cc/),
// the printer's address is the page's own address: connect with no setup.
const selfHost = typeof location !== 'undefined' && location.protocol === 'http:' && location.pathname.startsWith('/cc') ? location.hostname : ''
export const settings = signal<Settings>(
  load('settings', { host: selfHost, fallbackHost: '', backend: 'auto', notifications: true, cam: { brightness: 100, contrast: 100, saturation: 100, rotate: false, mirror: false } }),
)
effect(() => save('settings', settings.value))

export interface LogEntry {
  t: number
  level: LogLevel
  text: string
}
export const logs = signal<LogEntry[]>([])
export function log(level: LogLevel, text: string) {
  logs.value = [...logs.value.slice(-499), { t: Date.now(), level, text }]
}

export const conn = signal<'idle' | 'connecting' | 'connected' | 'closed'>('idle')
export const state = signal<PrinterState>(emptyState())
export const info = signal<PrinterInfo | null>(null)
export const backend = signal<Backend | null>(null)
export const activeHost = signal('')
export const toast = signal<{ text: string; bad: boolean } | null>(null)
const clock = signal(Date.now())
setInterval(() => (clock.value = Date.now()), 5000)

let failures = 0
const track = { key: '', phaseSince: Date.now(), progressKey: '', progressSince: Date.now(), heatGap: Infinity, heatSince: Date.now(), printNozzleTarget: 0, zBaseline: null as number | null }

export const ledger = signal<Record<string, number>>(loadRaw('ledger', {}))
export const printHours = computed(() => totalHours(ledger.value))
export const tasks = signal<Task[]>(loadRaw('tasks', freshTasks(Date.now(), totalHours(ledger.value))))
effect(() => save('ledger', ledger.value))
effect(() => {
  save('tasks', tasks.value)
  scheduleReminders(tasks.value)
})
export const dueTasks = computed(() => tasks.value.filter((t) => usage(t, clock.value, printHours.value) >= 1))
const announced = new Set<string>()
effect(() => {
  for (const t of dueTasks.value)
    if (!announced.has(t.id)) {
      announced.add(t.id)
      log('warn', `Maintenance due: ${t.name}.`)
      if (settings.value.notifications) notify('Maintenance due', t.name)
    }
})

function onState(next: PrinterState) {
  const prev = state.value
  const now = Date.now()
  const key = `${next.phase}/${next.detail}`
  if (key !== track.key) {
    if (track.key) log('info', `Printer: ${next.detail || next.phase}${next.job.filename && next.phase !== 'idle' ? ` (${next.job.filename})` : ''}`)
    track.key = key
    track.phaseSince = now
  }
  const pk = `${Math.floor(next.job.elapsed)}/${next.job.layer}`
  if (pk !== track.progressKey) {
    track.progressKey = pk
    track.progressSince = now
  }
  const gap = Math.max(next.temps.nozzleTarget - next.temps.nozzle, 0) + Math.max(next.temps.bedTarget - next.temps.bed, 0)
  if (gap < track.heatGap - 1 || gap < 3) {
    track.heatGap = gap
    track.heatSince = now
  } else if (gap > track.heatGap + 20) track.heatGap = gap // a new, higher target was set
  if (next.phase === 'printing' && next.temps.nozzleTarget > 0) track.printNozzleTarget = next.temps.nozzleTarget
  if (track.zBaseline === null && next.zOffset !== null) track.zBaseline = next.zOffset

  if (prev.phase !== next.phase && prev.phase !== 'offline' && settings.value.notifications) {
    const name = next.job.filename || 'Print'
    if (next.phase === 'complete') notify('Print finished', name)
    else if (next.phase === 'error') notify('Printer error', next.error ?? next.detail)
    else if (next.phase === 'paused' && document.hidden) notify('Print paused', name)
  }
  const j = next.job
  if (j.taskId && j.elapsed > 60 && (next.phase !== prev.phase || Math.floor(j.elapsed / 300) !== Math.floor(prev.job.elapsed / 300))) {
    const l = { ...ledger.value }
    if (recordJob(l, j.taskId, j.elapsed)) ledger.value = l
  }
  state.value = next
}

const events: BackendEvents = {
  state: onState,
  info: (i) => (info.value = i),
  log,
  conn(status, why) {
    conn.value = status
    if (status === 'connected') failures = 0
    if (status === 'closed') {
      failures++
      state.value = { ...state.value, phase: 'offline', detail: 'Offline' }
      const s = settings.value
      if (why === 'refused' && failures === 3 && s.fallbackHost && s.backend !== 'demo') {
        const other = activeHost.value === s.host ? s.fallbackHost : s.host
        log('info', `Trying the other address, ${other}.`)
        connect(other)
      }
    }
  },
}

export async function connect(hostOverride?: string) {
  backend.value?.close()
  backend.value = null
  info.value = null
  state.value = emptyState()
  track.key = ''
  track.zBaseline = null
  const s = settings.value
  if (s.backend === 'demo') {
    backend.value = new DemoBackend(events)
    activeHost.value = 'demo'
  } else {
    const host = (hostOverride ?? s.host).trim().replace(/^\w+:\/\//, '').replace(/[/:].*$/, '')
    if (!host) {
      conn.value = 'idle'
      return
    }
    if (!hostOverride) failures = 0
    activeHost.value = host
    conn.value = 'connecting'
    let kind = s.backend
    if (kind === 'auto') {
      log('info', `Checking which firmware ${host} runs.`)
      kind = (await probeMoonraker(host)) ? 'moonraker' : 'sdcp'
      log('info', kind === 'moonraker' ? 'Found Moonraker: this is COSMOS (Klipper).' : 'No Moonraker on port 80: using the Elegoo protocol (stock or OpenCentauri-patched firmware).')
    }
    if (activeHost.value !== host) return // superseded while probing
    backend.value = kind === 'moonraker' ? new MoonrakerBackend(host, events) : new SdcpBackend(host, events)
  }
  backend.value.connect()
}

export const issues = computed(() => {
  const ctx: Context = {
    now: clock.value,
    conn: conn.value,
    failures,
    hasFallback: !!settings.value.fallbackHost,
    backend: info.value?.backend ?? (backend.value instanceof MoonrakerBackend ? 'moonraker' : backend.value ? 'sdcp' : null),
    state: state.value,
    caps: backend.value?.caps ?? null,
    phaseSince: track.phaseSince,
    progressSince: track.progressSince,
    heatSince: track.heatSince,
    printNozzleTarget: track.printNozzleTarget,
  }
  return diagnose(ctx)
})

let toastTimer = 0
function flash(text: string, bad = false) {
  toast.value = { text, bad }
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (toast.value = null), bad ? 7000 : 2500)
}

/** Run a printer action, narrating it in the console. Resolves true on success. */
export async function act(label: string, fn: (b: Backend) => Promise<unknown>): Promise<boolean> {
  const b = backend.value
  if (!b || conn.value !== 'connected') {
    log('error', `${label}: not connected to the printer.`)
    flash('Not connected to the printer', true)
    return false
  }
  log('info', `${label}…`)
  try {
    await fn(b)
    log('ok', `${label}: accepted by the printer.`)
    flash(label)
    return true
  } catch (e) {
    const msg = (e as Error).message
    log('error', `${label} failed. ${msg}`)
    flash(msg, true)
    return false
  }
}

const Z_LIMIT = 0.3
export function adjustZ(delta: number) {
  const cur = state.value.zOffset
  if (cur !== null && track.zBaseline !== null && Math.abs(cur + delta - track.zBaseline) > Z_LIMIT + 1e-9) {
    const msg = `Z offset is limited to ±${Z_LIMIT} mm from where it was when you connected (${track.zBaseline.toFixed(3)} mm), to protect the build plate. Reconnect to reset the limit.`
    log('warn', msg)
    flash(msg, true)
    return Promise.resolve(false)
  }
  return act(`Z offset ${delta > 0 ? '+' : ''}${delta.toFixed(2)} mm`, (b) => b.adjustZ(delta))
}

export const ACTIONS: Record<ActionId, { label: string; danger?: boolean; run: () => unknown }> = {
  retry: { label: 'Reconnect now', run: () => connect() },
  switchHost: {
    label: 'Try the other address',
    run: () => connect(activeHost.value === settings.value.host ? settings.value.fallbackHost : settings.value.host),
  },
  refresh: { label: 'Ask for status again', run: () => act('Refresh status', (b) => b.refresh()) },
  pause: { label: 'Send Pause', run: () => act('Pause', (b) => b.pause()) },
  resume: { label: 'Send Resume', run: () => act('Resume', (b) => b.resume()) },
  stop: { label: 'Send Stop', danger: true, run: () => confirm('Stop the print? This cannot be undone.') && act('Stop', (b) => b.stop()) },
  heatersOff: {
    label: 'Turn heaters off',
    run: async () => (await act('Nozzle heater off', (b) => b.setNozzle(0))) && act('Bed heater off', (b) => b.setBed(0)),
  },
  reheat: { label: 'Reheat nozzle', run: () => act(`Nozzle to ${track.printNozzleTarget} °C`, (b) => b.setNozzle(track.printNozzleTarget)) },
  firmwareRestart: { label: 'Firmware restart', danger: true, run: () => act('Firmware restart', (b) => b.firmwareRestart()) },
}

export async function syncHistoryHours() {
  const b = backend.value
  if (!b || conn.value !== 'connected') return
  try {
    const l = { ...ledger.value }
    let changed = false
    for (const h of await b.history()) changed = recordJob(l, h.id, h.seconds ?? h.end - h.begin) || changed
    if (changed) ledger.value = l
  } catch {
    /* history is a bonus; the live counter still works */
  }
}
effect(() => {
  if (conn.value === 'connected') setTimeout(syncHistoryHours, 3000)
})

effect(() => {
  const s = state.value
  const busy = ['printing', 'paused', 'preparing', 'pausing', 'resuming'].includes(s.phase)
  document.title = busy ? `${Math.round(s.job.progress)}% · ${s.detail} · Centauri Control` : 'Centauri Control'
})
