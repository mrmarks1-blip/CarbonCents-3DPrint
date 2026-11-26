// Two print-prep helpers, built only from commands the app already sends
// (bed temperature, start print, pause), so nothing new reaches the printer.
//
// 1. Warm up, then level and print. Heats the bed only (a cold nozzle cannot
//    ooze PETG onto the probe), waits until the bed reaches the target, lets it
//    soak for the chosen minutes so the plate stops expanding, then starts the
//    print with auto-levelling on. The mesh is then measured on a settled plate.
// 2. Pause after layer N, so the first layers can be inspected.
//
// Both live in the app: if the app is closed mid warm-up the bed stays warm
// (the printer's own idle timeout turns it off later) and nothing starts.
import { effect, signal } from '@preact/signals'
import type { FileEntry, StartOptions } from '../printer/types'
import { act, conn, log, markPauseAsked, settings, state } from '../store'
import { notify } from './notify'

export interface Soak {
  file: FileEntry
  opts: StartOptions
  target: number
  minutes: number
  phase: 'heating' | 'soaking' | 'starting'
  /** When the bed first reached the target (ms), 0 while heating. */
  reachedAt: number
}
export const soak = signal<Soak | null>(null)
/** Pause once the printer reports a layer above this. */
export const pauseAfter = signal<{ layer: number; seenPrinting: boolean } | null>(null)

const ACTIVE = ['preparing', 'printing', 'pausing', 'paused', 'resuming', 'stopping']
const NEAR = 2 // °C: "at temperature"

export async function startWithWarmup(file: FileEntry, opts: StartOptions, target: number, minutes: number) {
  if (!(await act(`Bed to ${target} °C (warm-up before levelling)`, (b) => b.setBed(target)))) return false
  soak.value = { file, opts: { ...opts, levelling: true }, target, minutes, phase: 'heating', reachedAt: 0 }
  log('info', `Warm-up: heating the bed to ${target} °C, then ${minutes} min soak, then ${file.name} starts with auto-levelling.`)
  return true
}

export async function cancelWarmup(bedOff = true) {
  if (!soak.value) return
  soak.value = null
  log('info', 'Warm-up cancelled.')
  if (bedOff) await act('Bed heater off', (b) => b.setBed(0))
}

/** Skip whatever is left of the soak and start now. */
export function startNow() {
  const s = soak.value
  if (s && s.phase !== 'starting') begin(s)
}

async function begin(s: Soak) {
  soak.value = { ...s, phase: 'starting' }
  const ok = await act(`Start ${s.file.name} (with auto-levelling)`, (b) => b.start(s.file, s.opts))
  soak.value = null
  if (ok && settings.value.notifications) notify('Warm-up done, print starting', `${s.file.name}: levelling on a warmed bed.`)
}

export function setPauseAfter(layer: number | null) {
  pauseAfter.value = layer && layer > 0 ? { layer: Math.floor(layer), seenPrinting: ACTIVE.includes(state.value.phase) } : null
  if (pauseAfter.value) log('info', `Will pause after layer ${pauseAfter.value.layer}.`)
}

function tick() {
  const s = soak.value
  if (s && conn.value === 'connected') {
    const st = state.value
    if (ACTIVE.includes(st.phase) && s.phase !== 'starting') {
      soak.value = null
      log('warn', 'Warm-up stopped: the printer started something else.')
    } else if (s.phase === 'heating' && st.temps.bed >= s.target - NEAR) {
      soak.value = { ...s, phase: 'soaking', reachedAt: Date.now() }
      log('info', `Bed at ${st.temps.bed.toFixed(0)} °C. Soaking for ${s.minutes} min.`)
    } else if (s.phase === 'soaking' && Date.now() - s.reachedAt >= s.minutes * 60_000) begin(s)
  }
}
setInterval(tick, 1000)

// Pause after layer N.
effect(() => {
  const p = pauseAfter.value
  const st = state.value
  if (!p) return
  if (ACTIVE.includes(st.phase)) {
    if (!p.seenPrinting) pauseAfter.value = { ...p, seenPrinting: true }
    if (st.phase === 'printing' && st.job.layer > p.layer) {
      pauseAfter.value = null
      markPauseAsked()
      log('info', `Layer ${p.layer} is done: pausing as asked.`)
      act(`Pause after layer ${p.layer}`, (b) => b.pause()).then((ok) => {
        if (ok && settings.value.notifications) notify(`Paused after layer ${p.layer}`, `${st.job.filename.split('/').pop() || 'Print'}: inspect the first layers, then Resume.`)
      })
    }
  } else if (p.seenPrinting && ['complete', 'stopped', 'error', 'idle'].includes(st.phase)) pauseAfter.value = null
})

/** Seconds left in the soak (for the countdown), or null while heating. */
export const soakLeft = (s: Soak, now = Date.now()) => (s.phase === 'soaking' ? Math.max(0, Math.ceil((s.minutes * 60_000 - (now - s.reachedAt)) / 1000)) : null)
