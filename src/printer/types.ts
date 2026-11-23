// Firmware-neutral model of the printer. Both backends (Elegoo SDCP for stock /
// OpenCentauri-patched firmware, Moonraker for COSMOS) map onto this.

export type Phase =
  | 'offline'
  | 'idle'
  | 'preparing'
  | 'printing'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'stopping'
  | 'stopped'
  | 'complete'
  | 'error'
  | 'busy'

export interface PrinterState {
  phase: Phase
  /** Human sub-step, e.g. "Preheating", "Auto-levelling". */
  detail: string
  /** Raw codes from the wire, for the console and bug reports. */
  raw: string
  lastUpdate: number
  job: {
    filename: string
    taskId: string
    progress: number // 0..100
    layer: number
    totalLayers: number
    elapsed: number // seconds
    total: number // seconds, 0 when unknown
    filamentMm: number | null
  }
  temps: {
    nozzle: number
    nozzleTarget: number
    bed: number
    bedTarget: number
    chamber: number
  }
  fans: { model: number; aux: number; box: number } // 0..100
  light: boolean
  speedPct: number
  flowPct: number | null
  zOffset: number | null
  pos: [number, number, number] | null
  error: string | null
}

export const emptyState = (): PrinterState => ({
  phase: 'offline',
  detail: '',
  raw: '',
  lastUpdate: 0,
  job: { filename: '', taskId: '', progress: 0, layer: 0, totalLayers: 0, elapsed: 0, total: 0, filamentMm: null },
  temps: { nozzle: 0, nozzleTarget: 0, bed: 0, bedTarget: 0, chamber: 0 },
  fans: { model: 0, aux: 0, box: 0 },
  light: false,
  speedPct: 100,
  flowPct: null,
  zOffset: null,
  pos: null,
  error: null,
})

export interface PrinterInfo {
  backend: 'sdcp' | 'moonraker' | 'demo'
  name: string
  firmware: string
  mainboardId: string
  /** OpenCentauri-patched stock firmware (version string ends in O / OC). */
  ocPatched: boolean
  /** Free storage on the printer, bytes. */
  freeBytes?: number
}

export interface Capabilities {
  gcode: boolean
  flow: boolean
  estop: boolean
  firmwareRestart: boolean
  /** 'native' = documented live babystep, 'experimental' = undocumented key. */
  zOffset: 'native' | 'experimental' | 'none'
  /** null = any percentage is accepted. */
  speedPresets: { pct: number; label: string }[] | null
  /** Print-start options that only the stock protocol has. */
  startOptions: boolean
}

export interface FileEntry {
  path: string // what the backend needs to start/delete it
  name: string
  size: number
  modified: number // epoch seconds, 0 unknown
  layers: number
}

export interface HistoryEntry {
  id: string
  name: string
  begin: number // epoch seconds
  end: number
  outcome: 'completed' | 'stopped' | 'failed' | 'other'
  reason: string
  /** Actual printing time in seconds, when the printer reports it. */
  seconds?: number
  thumb?: string
}

export interface StartOptions {
  levelling: boolean
  timelapse: boolean
  plateSide: 0 | 1
}

export type LogLevel = 'info' | 'ok' | 'warn' | 'error' | 'tx' | 'rx'

export interface BackendEvents {
  state(patch: PrinterState): void
  info(info: PrinterInfo): void
  conn(status: 'connecting' | 'connected' | 'closed', why?: string): void
  log(level: LogLevel, text: string): void
}

export interface Backend {
  readonly caps: Capabilities
  connect(): void
  close(): void
  refresh(): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
  start(file: FileEntry, opts: StartOptions): Promise<void>
  setNozzle(t: number): Promise<void>
  setBed(t: number): Promise<void>
  setFan(which: 'model' | 'aux' | 'box', pct: number): Promise<void>
  setLight(on: boolean): Promise<void>
  setSpeed(pct: number): Promise<void>
  setFlow(pct: number): Promise<void>
  adjustZ(delta: number): Promise<void>
  home(axes: 'X' | 'Y' | 'Z' | 'XYZ'): Promise<void>
  jog(axis: 'X' | 'Y' | 'Z', step: number): Promise<void>
  listFiles(): Promise<FileEntry[]>
  deleteFile(file: FileEntry): Promise<void>
  upload(file: File, onProgress: (fraction: number) => void): Promise<void>
  history(): Promise<HistoryEntry[]>
  cameraUrl(): Promise<string>
  gcode(script: string): Promise<void>
  estop(): Promise<void>
  firmwareRestart(): Promise<void>
}

/** Thrown for refusals we can explain; `message` is already plain language. */
export class PrinterError extends Error {}
