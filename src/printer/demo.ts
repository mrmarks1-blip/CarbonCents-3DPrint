// A simulated printer, so the interface can be explored and tested without
// touching a real one. Speeds through a print in a few minutes.
import { PrinterError, emptyState, type Backend, type BackendEvents, type Capabilities, type FileEntry, type HistoryEntry, type PrinterState } from './types'

const now = () => Math.round(Date.now() / 1000)

export class DemoBackend implements Backend {
  readonly caps: Capabilities = {
    gcode: true, flow: true, estop: true, firmwareRestart: true, zOffset: 'native',
    speedPresets: [{ pct: 50, label: 'Silent' }, { pct: 100, label: 'Balanced' }, { pct: 130, label: 'Sport' }, { pct: 160, label: 'Ludicrous' }],
    startOptions: true,
  }
  private s: PrinterState = emptyState()
  private timer = 0
  private starting = 0
  private prep = 0
  private files: FileEntry[] = [
    { path: '/local/benchy_PLA_0.2.gcode', name: 'benchy_PLA_0.2.gcode', size: 3_400_000, modified: now() - 86400, layers: 240 },
    { path: '/local/cable_clip_x8.gcode', name: 'cable_clip_x8.gcode', size: 1_100_000, modified: now() - 400000, layers: 60 },
  ]
  private ev: BackendEvents
  constructor(ev: BackendEvents) {
    this.ev = ev
  }

  connect() {
    this.ev.conn('connecting')
    this.s = { ...emptyState(), phase: 'idle', detail: 'Idle', zOffset: 0.02, flowPct: 100, pos: [128, 128, 10], temps: { nozzle: 24, nozzleTarget: 0, bed: 23, bedTarget: 0, chamber: 24 } }
    clearTimeout(this.starting)
    this.starting = window.setTimeout(() => {
      clearInterval(this.timer)
      this.ev.conn('connected')
      this.ev.info({ backend: 'demo', name: 'Demo printer', firmware: 'simulated', mainboardId: 'demo', ocPatched: false })
      this.ev.log('ok', 'Demo printer connected. Nothing here reaches a real printer.')
      this.timer = window.setInterval(() => this.tick(), 1000)
    }, 400)
  }
  close() {
    clearTimeout(this.starting)
    clearInterval(this.timer)
  }
  reconnect() {
    this.close()
    this.connect()
  }

  private tick() {
    const s = this.s
    const t = s.temps
    const toward = (cur: number, target: number, rate: number) => (target > cur ? Math.min(target, cur + rate) : Math.max(target || 24, cur - rate / 3))
    t.nozzle = toward(t.nozzle, t.nozzleTarget, 14)
    t.bed = toward(t.bed, t.bedTarget, 4)
    t.chamber = toward(t.chamber, s.phase === 'printing' ? 38 : 24, 0.3)
    if (s.phase === 'preparing') {
      this.prep++
      s.detail = t.nozzle < t.nozzleTarget - 2 || t.bed < t.bedTarget - 2 ? 'Preheating' : this.prep < 26 ? 'Auto-levelling' : 'Starting print'
      if (s.detail === 'Starting print') Object.assign(s, { phase: 'printing', detail: 'Printing' })
    } else if (s.phase === 'printing') {
      const j = s.job
      j.elapsed += 30 * (s.speedPct / 100)
      j.progress = Math.min(100, (j.elapsed / j.total) * 100)
      j.layer = Math.round((j.progress / 100) * j.totalLayers)
      j.filamentMm = j.elapsed * 1.6
      if (j.progress >= 100) {
        Object.assign(s, { phase: 'complete', detail: 'Print complete' })
        t.nozzleTarget = t.bedTarget = 0
        s.fans = { model: 0, aux: 0, box: 0 }
      }
    } else if (s.phase === 'pausing') Object.assign(s, { phase: 'paused', detail: 'Paused' })
    else if (s.phase === 'resuming') Object.assign(s, { phase: 'printing', detail: 'Printing' })
    else if (s.phase === 'stopping') {
      Object.assign(s, { phase: 'stopped', detail: 'Stopped' })
      t.nozzleTarget = t.bedTarget = 0
    }
    s.raw = `demo ${s.phase}`
    s.lastUpdate = Date.now()
    this.ev.state(structuredClone(s))
  }

  private need(...phases: PrinterState['phase'][]) {
    if (!phases.includes(this.s.phase)) throw new PrinterError(`The printer cannot do that while it is ${this.s.detail.toLowerCase()}.`)
  }
  async refresh() {}
  async pause() {
    this.need('printing')
    Object.assign(this.s, { phase: 'pausing', detail: 'Pausing' })
  }
  async resume() {
    this.need('paused')
    Object.assign(this.s, { phase: 'resuming', detail: 'Resuming' })
  }
  async stop() {
    this.need('printing', 'paused', 'preparing', 'pausing')
    Object.assign(this.s, { phase: 'stopping', detail: 'Stopping' })
  }
  async start(file: FileEntry) {
    this.need('idle', 'complete', 'stopped')
    this.prep = 0
    Object.assign(this.s, { phase: 'preparing', detail: 'Preheating', error: null })
    this.s.job = { filename: file.name, taskId: `demo-${Date.now()}`, progress: 0, layer: 0, totalLayers: file.layers || 120, elapsed: 0, total: 5400, filamentMm: 0 }
    this.s.temps.nozzleTarget = 220
    this.s.temps.bedTarget = 60
    this.s.fans = { model: 80, aux: 30, box: 50 }
  }
  async setNozzle(t: number) {
    this.s.temps.nozzleTarget = t
  }
  async setBed(t: number) {
    this.s.temps.bedTarget = t
  }
  async setFan(which: 'model' | 'aux' | 'box', pct: number) {
    this.s.fans[which] = pct
  }
  async setLight(on: boolean) {
    this.s.light = on
  }
  async setSpeed(pct: number) {
    this.s.speedPct = pct
  }
  async setFlow(pct: number) {
    this.s.flowPct = pct
  }
  async adjustZ(delta: number) {
    this.s.zOffset = Math.round(((this.s.zOffset ?? 0) + delta) * 1000) / 1000
  }
  async home() {
    this.need('idle', 'complete', 'stopped')
    this.s.pos = [0, 0, 0]
  }
  async jog(axis: 'X' | 'Y' | 'Z', step: number) {
    this.need('idle', 'complete', 'stopped')
    if (this.s.pos) this.s.pos['XYZ'.indexOf(axis)] += step
  }
  async listFiles() {
    return [...this.files]
  }
  async deleteFile(file: FileEntry) {
    this.files = this.files.filter((f) => f.path !== file.path)
  }
  async upload(file: File, onProgress: (f: number) => void) {
    for (let i = 1; i <= 10; i++) {
      await new Promise((r) => setTimeout(r, 150))
      onProgress(i / 10)
    }
    this.files.unshift({ path: `/local/${file.name}`, name: file.name, size: file.size, modified: now(), layers: 0 })
  }
  async history(): Promise<HistoryEntry[]> {
    return [
      { id: 'd1', name: 'benchy_PLA_0.2.gcode', begin: now() - 90000, end: now() - 86000, outcome: 'completed', reason: '' },
      { id: 'd2', name: 'bracket_v3.gcode', begin: now() - 200000, end: now() - 197000, outcome: 'failed', reason: 'Filament ran out' },
      { id: 'd3', name: 'cable_clip_x8.gcode', begin: now() - 400000, end: now() - 398500, outcome: 'stopped', reason: '' },
    ]
  }
  async cameraUrl() {
    return ''
  }
  async gcode(script: string) {
    this.ev.log('tx', script)
    this.ev.log('rx', 'ok (demo)')
  }
  async estop() {
    Object.assign(this.s, { phase: 'error', detail: 'Emergency stop', error: 'Emergency stop pressed (demo). Use Firmware restart.' })
    this.s.temps.nozzleTarget = this.s.temps.bedTarget = 0
  }
  async firmwareRestart() {
    Object.assign(this.s, { phase: 'idle', detail: 'Idle', error: null })
  }
}
