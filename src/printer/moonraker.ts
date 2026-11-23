// Moonraker (Klipper/Kalico) client for OpenCentauri COSMOS. COSMOS serves
// Moonraker on port 80 and the camera (ustreamer) on 8080. Object and macro
// names come from the COSMOS centauri-carbon-1 machine.cfg / shared-macros.cfg.
import {
  PrinterError,
  emptyState,
  type Backend,
  type BackendEvents,
  type Capabilities,
  type FileEntry,
  type HistoryEntry,
  type Phase,
  type PrinterState,
} from './types'

type Json = Record<string, any>

const OBJECTS = [
  'print_stats', 'virtual_sdcard', 'display_status', 'gcode_move', 'toolhead', 'extruder', 'heater_bed', 'fan',
  'fan_generic aux_fan', 'fan_generic case_fan', 'temperature_sensor chamber', 'led case', 'webhooks',
]

const PHASES: Record<string, [Phase, string]> = {
  standby: ['idle', 'Idle'],
  printing: ['printing', 'Printing'],
  paused: ['paused', 'Paused'],
  complete: ['complete', 'Print complete'],
  cancelled: ['stopped', 'Cancelled'],
  error: ['error', 'Error'],
}

/** Pure mapping of Klipper objects onto our model. Exported for tests. */
export function parseKlipper(o: Json): PrinterState {
  const st = emptyState()
  const ps: Json = o.print_stats ?? {}
  const wh: Json = o.webhooks ?? {}
  const gm: Json = o.gcode_move ?? {}
  let [phase, detail] = PHASES[ps.state] ?? ['idle', 'Idle']
  if (wh.state && wh.state !== 'ready') [phase, detail] = ['error', `Klipper ${wh.state}`]
  st.phase = phase
  st.detail = detail
  st.raw = `klipper ${wh.state ?? '?'} / print ${ps.state ?? '?'}`
  const progress = (o.virtual_sdcard?.progress ?? o.display_status?.progress ?? 0) * 100
  const elapsed = Number(ps.print_duration ?? 0)
  st.job = {
    filename: ps.filename ?? '',
    taskId: ps.filename ? `${ps.filename}` : '',
    progress: phase === 'complete' ? 100 : progress,
    layer: ps.info?.current_layer ?? 0,
    totalLayers: ps.info?.total_layer ?? 0,
    elapsed,
    total: progress > 1 ? elapsed / (progress / 100) : 0,
    filamentMm: typeof ps.filament_used === 'number' ? ps.filament_used : null,
  }
  st.temps = {
    nozzle: o.extruder?.temperature ?? 0,
    nozzleTarget: o.extruder?.target ?? 0,
    bed: o.heater_bed?.temperature ?? 0,
    bedTarget: o.heater_bed?.target ?? 0,
    chamber: o['temperature_sensor chamber']?.temperature ?? 0,
  }
  const pct = (v: unknown) => Math.round(Number(v ?? 0) * 100)
  st.fans = { model: pct(o.fan?.speed), aux: pct(o['fan_generic aux_fan']?.speed), box: pct(o['fan_generic case_fan']?.speed) }
  st.light = Number(o['led case']?.color_data?.[0]?.[3] ?? 0) > 0
  st.speedPct = pct(gm.speed_factor ?? 1)
  st.flowPct = pct(gm.extrude_factor ?? 1)
  st.zOffset = gm.homing_origin ? Number(gm.homing_origin[2]) : null
  const p = o.toolhead?.position
  st.pos = p ? [p[0], p[1], p[2]] : null
  st.error = phase === 'error' ? String(wh.state_message || ps.message || 'Klipper reported an error') : null
  st.lastUpdate = Date.now()
  return st
}

export class MoonrakerBackend implements Backend {
  readonly caps: Capabilities = { gcode: true, flow: true, estop: true, firmwareRestart: true, zOffset: 'native', speedPresets: null, startOptions: false }
  private ws: WebSocket | null = null
  private closed = false
  private nextId = 1
  private pending = new Map<number, { resolve: (d: any) => void; reject: (e: Error) => void }>()
  private objects: Json = {}
  private retry = 0
  private timer = 0
  private host: string
  private ev: BackendEvents

  constructor(host: string, ev: BackendEvents) {
    this.host = host
    this.ev = ev
  }

  connect() {
    this.closed = false
    this.open()
  }

  private open() {
    const url = `ws://${this.host}/websocket`
    this.ev.conn('connecting')
    this.ev.log('info', `Connecting to Moonraker at ${url}`)
    const ws = (this.ws = new WebSocket(url))
    let opened = false
    ws.onopen = async () => {
      opened = true
      this.retry = 0
      this.ev.conn('connected')
      try {
        const info = await this.rpc('printer.info')
        this.ev.info({ backend: 'moonraker', name: info.hostname ?? 'Centauri Carbon (COSMOS)', firmware: info.software_version ?? '', mainboardId: '', ocPatched: false })
        const sub = await this.rpc('printer.objects.subscribe', { objects: Object.fromEntries(OBJECTS.map((k) => [k, null])) })
        this.merge(sub.status ?? {})
        this.ev.log('ok', `Connected. Klipper is ${info.state}.`)
      } catch (e) {
        this.ev.log('error', `Moonraker answered but Klipper is not ready: ${(e as Error).message}. Try Firmware restart.`)
      }
    }
    ws.onmessage = (m) => {
      let msg: Json
      try {
        msg = JSON.parse(String(m.data))
      } catch {
        return
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new PrinterError(String(msg.error.message ?? 'Request failed')))
        else p.resolve(msg.result)
      } else if (msg.method === 'notify_status_update') this.merge(msg.params?.[0] ?? {})
      else if (msg.method === 'notify_gcode_response') {
        const line = String(msg.params?.[0] ?? '')
        this.ev.log(line.startsWith('!!') ? 'error' : 'rx', line)
      } else if (msg.method === 'notify_klippy_shutdown' || msg.method === 'notify_klippy_disconnected')
        this.ev.log('error', 'Klipper shut down or disconnected. Read the message above, then use Firmware restart.')
    }
    ws.onclose = () => {
      this.pending.forEach((p) => p.reject(new PrinterError('The connection closed before the printer answered.')))
      this.pending.clear()
      if (this.closed) return
      const wait = Math.min(15, 2 ** this.retry++)
      this.ev.conn('closed', opened ? 'dropped' : 'refused')
      this.ev.log(opened ? 'warn' : 'error', opened ? `Connection dropped. Reconnecting in ${wait}s.` : `Could not connect to Moonraker on ${this.host}. Retrying in ${wait}s. If this page is not served from a LAN IP address, Moonraker rejects it until its origin is added to cors_domains in moonraker.conf.`)
      this.timer = window.setTimeout(() => !this.closed && this.open(), wait * 1000)
    }
  }

  private merge(patch: Json) {
    for (const k in patch) this.objects[k] = { ...this.objects[k], ...patch[k] }
    this.ev.state(parseKlipper(this.objects))
  }

  private rpc(method: string, params?: Json): Promise<any> {
    const ws = this.ws
    if (!ws || ws.readyState !== 1) return Promise.reject(new PrinterError('Not connected to the printer.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }))
    })
  }

  close() {
    this.closed = true
    clearTimeout(this.timer)
    this.ws?.close()
    this.ws = null
  }

  async gcode(script: string) {
    this.ev.log('tx', script)
    await this.rpc('printer.gcode.script', { script })
  }
  async refresh() {
    const r = await this.rpc('printer.objects.query', { objects: Object.fromEntries(OBJECTS.map((k) => [k, null])) })
    this.merge(r.status ?? {})
  }
  pause = () => this.rpc('printer.print.pause')
  resume = () => this.rpc('printer.print.resume')
  stop = () => this.rpc('printer.print.cancel')
  start = (file: FileEntry) => this.rpc('printer.print.start', { filename: file.path })
  setNozzle = (t: number) => this.gcode(`M104 S${t}`)
  setBed = (t: number) => this.gcode(`M140 S${t}`)
  setFan = (which: 'model' | 'aux' | 'box', pct: number) => this.gcode(`M106 P${{ model: 1, aux: 2, box: 3 }[which]} S${Math.round(pct * 2.55)}`)
  setLight = (on: boolean) => this.gcode(`SET_LED LED=case WHITE=${on ? 1 : 0}`)
  setSpeed = (pct: number) => this.gcode(`M220 S${pct}`)
  setFlow = (pct: number) => this.gcode(`M221 S${pct}`)
  adjustZ = (delta: number) => this.gcode(`SET_GCODE_OFFSET Z_ADJUST=${delta.toFixed(3)} MOVE=1`)
  home = (axes: string) => this.gcode(`G28${axes === 'XYZ' ? '' : ' ' + axes}`)
  jog = (axis: string, step: number) => this.gcode(`G91\nG1 ${axis}${step} F${axis === 'Z' ? 600 : 6000}\nG90`)
  estop = () => this.rpc('printer.emergency_stop')
  firmwareRestart = () => this.rpc('printer.firmware_restart')

  async listFiles(): Promise<FileEntry[]> {
    const list: Json[] = await this.rpc('server.files.list', { root: 'gcodes' })
    return list
      .map((f) => ({ path: f.path, name: String(f.path).split('/').pop()!, size: f.size ?? 0, modified: Math.round(f.modified ?? 0), layers: 0 }))
      .sort((a, b) => b.modified - a.modified)
  }
  async deleteFile(file: FileEntry) {
    await this.rpc('server.files.delete_file', { path: `gcodes/${file.path}` })
  }
  upload(file: File, onProgress: (f: number) => void) {
    return new Promise<void>((resolve, reject) => {
      const form = new FormData()
      form.append('root', 'gcodes')
      form.append('file', file, file.name)
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `http://${this.host}/server/files/upload`)
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
      xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new PrinterError(`Upload failed: HTTP ${xhr.status} ${xhr.responseText.slice(0, 120)}`)))
      xhr.onerror = () => reject(new PrinterError('Upload failed: the printer was unreachable or rejected this page\'s origin.'))
      xhr.send(form)
    })
  }
  async history(): Promise<HistoryEntry[]> {
    const r = await this.rpc('server.history.list', { limit: 30, order: 'desc' })
    return (r.jobs ?? []).map((j: Json) => ({
      id: String(j.job_id),
      name: j.filename ?? '',
      begin: Math.round(j.start_time ?? 0),
      end: Math.round(j.end_time ?? 0),
      outcome: j.status === 'completed' ? 'completed' : j.status === 'cancelled' ? 'stopped' : j.status === 'in_progress' ? 'other' : 'failed',
      reason: j.status === 'completed' || j.status === 'cancelled' ? '' : String(j.status ?? ''),
    }))
  }
  async cameraUrl() {
    return `http://${this.host}:8080/stream`
  }
}

/** True when a Moonraker server answers on the host's port 80. */
export async function probeMoonraker(host: string): Promise<boolean> {
  try {
    const r = await fetch(`http://${host}/server/info`, { signal: AbortSignal.timeout(2500) })
    return !!(await r.json()).result
  } catch {
    return false
  }
}
