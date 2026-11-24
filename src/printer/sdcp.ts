// Elegoo SDCP v3 client for the Centauri Carbon on stock or OpenCentauri-patched
// firmware. Payloads mirror the stock web UI exactly: this firmware can crash its
// control process (killing a running print) on unknown commands or wrong shapes,
// so nothing here is guessed except the clearly-marked ZOffset write.
import SparkMD5 from 'spark-md5'
import { ERROR_REASON, MACHINE_STATUS, PRINT_ERROR_NUMBER, PRINT_STATUS, START_ACK, UPLOAD_ERRORS } from './codes'
import {
  PrinterError,
  emptyState,
  type Backend,
  type BackendEvents,
  type Capabilities,
  type FileEntry,
  type HistoryEntry,
  type PrinterState,
  type StartOptions,
} from './types'
import { Link } from './link'

const TOTAL_EXTRUSION_KEY = '54 6F 74 61 6C 45 78 74 72 75 73 69 6F 6E 00'
const CHUNK = 1024 * 1024

type Json = Record<string, any>

const num = (v: unknown): number => {
  if (Array.isArray(v)) v = v[v.length - 1] // very old builds send [target, actual]
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Pure mapping of an SDCP Status object onto our model. Exported for tests. */
export function parseSdcpStatus(s: Json): PrinterState {
  const st = emptyState()
  const pi: Json = s.PrintInfo ?? {}
  const machine: number[] = Array.isArray(s.CurrentStatus) ? s.CurrentStatus : [num(s.CurrentStatus)]
  const ps = num(pi.Status)

  let phase = PRINT_STATUS[ps]
  if (!phase && ps !== 0) phase = ['busy', `Print status ${ps}`]
  if (!phase || ps === 0) {
    // No job state: describe what the machine itself is doing. A leading 2
    // (file transfer) can sit in front of the real status.
    const code = machine.find((c) => c !== 2) ?? machine[0] ?? 0
    phase = MACHINE_STATUS[code] ?? ['busy', `Machine status ${code}`]
    if (code === 1) phase = ['preparing', 'Starting print']
  }
  st.phase = phase[0]
  st.detail = phase[1]
  st.raw = `machine [${machine.join(',')}] / print ${ps}`

  const elapsed = num(pi.CurrentTicks)
  const total = num(pi.TotalTicks)
  let progress = typeof pi.Progress === 'number' ? pi.Progress : total > 0 ? (elapsed / total) * 100 : 0
  // The firmware reports the previous job's 100% while a new one is preparing.
  if (st.phase === 'preparing' && elapsed < 1) progress = 0
  if (st.phase === 'complete') progress = 100
  st.job = {
    filename: String(pi.Filename ?? ''),
    taskId: String(pi.TaskId ?? ''),
    progress: Math.max(0, Math.min(100, progress)),
    layer: num(pi.CurrentLayer),
    totalLayers: num(pi.TotalLayer),
    elapsed,
    total,
    filamentMm: TOTAL_EXTRUSION_KEY in pi ? num(pi[TOTAL_EXTRUSION_KEY]) : null,
  }
  st.temps = {
    nozzle: num(s.TempOfNozzle),
    nozzleTarget: num(s.TempTargetNozzle),
    bed: num(s.TempOfHotbed),
    bedTarget: num(s.TempTargetHotbed),
    chamber: num(s.TempOfBox),
  }
  const f: Json = s.CurrentFanSpeed ?? {}
  st.fans = { model: num(f.ModelFan), aux: num(f.AuxiliaryFan), box: num(f.BoxFan) }
  st.light = num(s.LightStatus?.SecondLight) === 1
  st.speedPct = num(pi.PrintSpeedPct ?? pi.PrintSpeed) || 100
  // Reported with float noise (1e-14, 0.00999999999999). Values in 0.001 mm steps are accepted and shown on the touchscreen.
  st.zOffset = typeof s.ZOffset === 'number' ? Math.round(s.ZOffset * 1000) / 1000 : null
  const coord = String(s.CurrenCoord ?? s.CurrentCoord ?? '') // sic: firmware typo
    .split(',')
    .map(Number)
  st.pos = coord.length === 3 && coord.every(Number.isFinite) ? (coord as [number, number, number]) : null
  const errNo = num(pi.ErrorNumber)
  st.error = errNo ? (PRINT_ERROR_NUMBER[errNo] ?? `Printer error ${errNo}`) : null
  st.lastUpdate = Date.now()
  return st
}

const hex32 = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')

export class SdcpBackend implements Backend {
  readonly caps: Capabilities = {
    gcode: false,
    flow: false,
    estop: false,
    firmwareRestart: false,
    zOffset: 'native',
    speedPresets: [
      { pct: 50, label: 'Silent' },
      { pct: 100, label: 'Balanced' },
      { pct: 130, label: 'Sport' },
      { pct: 160, label: 'Ludicrous' },
    ],
    startOptions: true,
  }

  private link: Link
  private mainboardId = ''
  private pending = new Map<string, { resolve: (d: Json) => void; reject: (e: Error) => void; timer: number; quiet?: boolean }>()
  private lastStatus: Json = {}
  private zOffset: number | null = null
  private host: string
  private ev: BackendEvents

  constructor(host: string, ev: BackendEvents) {
    this.host = host
    this.ev = ev
    this.link = new Link({
      url: `ws://${host}:3030/websocket`,
      ev,
      onOpen: () => {
        this.ev.log('ok', 'Connected. Asking the printer for its details and status.')
        this.send(1, {}, { quiet: true }).catch(() => {})
        this.poll()
        this.link.every(2000, () => this.poll())
      },
      onMessage: (t) => this.onMessage(t),
      onDown: () => this.rejectPending(),
      ping: () => this.send(0, {}, { quiet: true }).catch(() => {}),
      refusedText: (wait) =>
        `Could not connect to ${host}:3030. Retrying in ${wait}s. Usual causes: wrong address, printer off or on another network, or all of its connection slots are in use (it allows about 5: close the Elegoo web page, the slicer's device tab and other apps).`,
    })
  }

  connect() {
    this.link.start()
  }

  reconnect() {
    this.link.now()
  }

  close() {
    this.link.stop()
  }

  private rejectPending() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new PrinterError('The connection closed before the printer answered.'))
    }
    this.pending.clear()
  }

  private poll() {
    if (document.hidden && Date.now() % 6000 > 2000) return // roughly every 6s in the background
    this.send(0, {}, { quiet: true }).catch(() => {})
  }

  private onMessage(text: string) {
    if (text === 'pong') return
    const brace = text.indexOf('{')
    if (brace < 0) return
    let msg: Json
    try {
      msg = JSON.parse(text.slice(brace)) // some firmwares prefix frames with digits
    } catch {
      return
    }
    const topic = String(msg.Topic ?? '')
    const status = msg.Status ?? msg.Data?.Status
    const attrs = msg.Attributes ?? msg.Data?.Attributes
    if (msg.MainboardID && !this.mainboardId) this.mainboardId = msg.MainboardID
    if (status) {
      this.lastStatus = status
      const st = parseSdcpStatus(status)
      this.zOffset = st.zOffset
      this.ev.state(st)
    } else if (attrs) {
      this.mainboardId = attrs.MainboardID ?? this.mainboardId
      const fw = String(attrs.FirmwareVersion ?? '')
      this.ev.info({
        backend: 'sdcp',
        name: attrs.Name ?? attrs.MachineName ?? 'Centauri Carbon',
        firmware: fw,
        mainboardId: this.mainboardId,
        ocPatched: /o(c)?$/i.test(fw) || /-oc?\b/i.test(fw),
        freeBytes: typeof attrs.RemainingMemory === 'number' ? attrs.RemainingMemory : undefined,
      })
      this.ev.log('info', `Printer: ${attrs.MachineName ?? attrs.Name}, firmware ${fw}, video viewers ${attrs.NumberOfVideoStreamConnected ?? '?'}/${attrs.MaximumVideoStreamAllowed ?? '?'}.`)
    } else if (topic.includes('sdcp/error') || topic.includes('sdcp/notice')) {
      this.ev.log('warn', `Printer ${topic.includes('error') ? 'error' : 'notice'}: ${JSON.stringify(msg.Data ?? msg)}`)
    } else if (msg.Data?.RequestID) {
      const p = this.pending.get(msg.Data.RequestID)
      if (!p) return
      this.pending.delete(msg.Data.RequestID)
      clearTimeout(p.timer)
      if (!p.quiet) this.ev.log('rx', `Cmd ${msg.Data.Cmd} reply ${JSON.stringify(msg.Data.Data).slice(0, 300)}`)
      p.resolve(msg.Data.Data ?? {})
    }
  }

  private send(cmd: number, data: Json, opt: { quiet?: boolean; timeout?: number } = {}): Promise<Json> {
    if (!this.link.alive) return Promise.reject(new PrinterError('Not connected to the printer.'))
    const id = hex32()
    const body = { Id: '', Data: { Cmd: cmd, Data: data, RequestID: id, MainboardID: this.mainboardId, TimeStamp: Date.now(), From: 1 } }
    if (!opt.quiet) this.ev.log('tx', `Cmd ${cmd} ${JSON.stringify(data)}`)
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new PrinterError(`The printer did not answer command ${cmd} within ${(opt.timeout ?? 8000) / 1000}s. The wifi link may have dropped (the app reconnects by itself), or the printer is busy.`))
      }, opt.timeout ?? 8000)
      this.pending.set(id, { resolve, reject, timer, quiet: opt.quiet })
      this.link.send(JSON.stringify(body))
    })
  }

  private async cmd(cmd: number, data: Json, what: string, acks: Record<number, string> = {}) {
    const res = await this.send(cmd, data)
    const ack = res.Ack
    if (ack !== undefined && ack !== 0)
      throw new PrinterError(acks[ack] ?? `The printer refused to ${what} (code ${ack}). It is probably busy with something else; on stock firmware 1.1.29 to 1.1.40 changes are also blocked while printing.`)
    return res
  }

  private set(data: Json, what: string) {
    return this.cmd(403, data, what).then(() => void this.poll())
  }

  async refresh() {
    await this.send(0, {})
  }
  async pause() {
    await this.cmd(129, {}, 'pause')
  }
  async resume() {
    await this.cmd(131, {}, 'resume')
  }
  async stop() {
    await this.cmd(130, {}, 'stop')
  }
  async start(file: FileEntry, o: StartOptions) {
    await this.cmd(
      128,
      { Filename: file.path, StartLayer: 0, Calibration_switch: o.levelling ? 1 : 0, PrintPlatformType: o.plateSide, Tlp_Switch: o.timelapse ? 1 : 0, slot_map: [] },
      'start the print',
      START_ACK,
    )
  }
  async setNozzle(t: number) {
    await this.set({ TempTargetNozzle: t }, 'set the nozzle temperature')
  }
  async setBed(t: number) {
    await this.set({ TempTargetHotbed: t }, 'set the bed temperature')
  }
  async setFan(which: 'model' | 'aux' | 'box', pct: number) {
    const key = { model: 'ModelFan', aux: 'AuxiliaryFan', box: 'BoxFan' }[which]
    await this.set({ TargetFanSpeed: { [key]: pct } }, 'change the fan')
  }
  async setLight(on: boolean) {
    const rgb = this.lastStatus.LightStatus?.RgbLight ?? [0, 0, 0]
    await this.set({ LightStatus: { SecondLight: on ? 1 : 0, RgbLight: rgb } }, 'switch the light')
  }
  async setSpeed(pct: number) {
    await this.set({ PrintSpeedPct: pct }, 'change the speed')
  }
  async setFlow() {
    throw new PrinterError('Flow rate cannot be changed over the network on this firmware.')
  }
  async adjustZ(delta: number) {
    if (this.zOffset === null) throw new PrinterError('The printer has not reported its Z offset yet.')
    const before = this.zOffset
    const target = Math.round((before + delta) * 1000) / 1000
    // Undocumented key in the firmware's set-status handler. Verified on a real
    // OpenCentauri-patched 1.4.49 printer: the number is the new absolute offset
    // in mm, and an exact 0 is accepted. Read back after every write regardless.
    await this.cmd(403, { ZOffset: target }, 'change the Z offset')
    await new Promise((r) => setTimeout(r, 900))
    await this.send(0, {}, { quiet: true })
    await new Promise((r) => setTimeout(r, 300))
    const after = this.zOffset
    if (Math.abs(after - target) < 0.0015) return
    if (Math.abs(after - before) < 0.0015)
      throw new PrinterError(`The printer accepted the command but its Z offset is still ${before.toFixed(3)} mm. This firmware version may only allow Z offset changes from the touchscreen.`)
    throw new PrinterError(`Z offset is now ${after.toFixed(3)} mm, not the ${target.toFixed(3)} mm requested. Stop and check it on the touchscreen.`)
  }
  async home(axes: 'X' | 'Y' | 'Z' | 'XYZ') {
    await this.cmd(402, { Axis: axes }, 'home')
  }
  async jog(axis: 'X' | 'Y' | 'Z', step: number) {
    await this.cmd(401, { Axis: axis, Step: step }, 'move')
  }

  async listFiles(): Promise<FileEntry[]> {
    const res = await this.cmd(258, { Url: '/local' }, 'list files')
    const list: Json[] = res.FileList ?? []
    return list
      .filter((f) => f.type !== 0)
      .map((f) => ({
        path: String(f.name),
        name: String(f.name).split('/').pop() ?? String(f.name),
        size: num(f.FileSize ?? f.usedSize),
        modified: num(f.CreateTime),
        layers: num(f.TotalLayers),
      }))
      .sort((a, b) => b.modified - a.modified)
  }

  async deleteFile(file: FileEntry) {
    await this.cmd(259, { FileList: [file.path], FolderList: [] }, 'delete the file')
  }

  async upload(file: File, onProgress: (f: number) => void) {
    const url = `http://${this.host}:80/uploadFile/upload`
    this.ev.log('info', `Uploading ${file.name} (${(file.size / 1048576).toFixed(1)} MB) in 1 MB pieces to ${url}`)
    const spark = new SparkMD5.ArrayBuffer()
    for (let o = 0; o < file.size; o += CHUNK * 4) spark.append(await file.slice(o, o + CHUNK * 4).arrayBuffer())
    const md5 = spark.end()
    let uuid = hex32()
    let blind = false
    for (let offset = 0; offset < file.size || offset === 0; offset += CHUNK) {
      const form = new FormData()
      form.append('TotalSize', String(file.size))
      form.append('Uuid', uuid)
      form.append('Offset', String(offset))
      form.append('Check', '1')
      form.append('S-File-MD5', md5)
      form.append('File', file.slice(offset, offset + CHUNK), file.name)
      try {
        const r = await fetch(url, { method: 'POST', body: form, mode: blind ? 'no-cors' : 'cors' })
        if (!blind) {
          const j = await r.json()
          if (j.code !== '000000') {
            const code = String(j.messages?.[0]?.message ?? '')
            throw new PrinterError(`Upload failed at ${(offset / 1048576).toFixed(0)} MB: ${UPLOAD_ERRORS[code] ?? `printer code ${code || j.code}`}.`)
          }
        }
      } catch (e) {
        if (e instanceof PrinterError) throw e
        if (blind || offset > 0) throw new PrinterError(`Upload interrupted at ${(offset / 1048576).toFixed(0)} MB (${(e as Error).message}). Check the connection and try again.`)
        // Either the printer is unreachable on port 80 or the browser hid the
        // reply (no CORS header). Restart blind; the file list confirms the result.
        this.ev.log('warn', 'The browser could not read the printer\'s reply (cross-origin rule). Sending without reading replies; the file list will confirm the result.')
        blind = true
        uuid = hex32()
        offset = -CHUNK
        continue
      }
      onProgress(Math.min(1, (offset + CHUNK) / Math.max(1, file.size)))
      if (file.size === 0) break
    }
    if (blind) {
      await new Promise((r) => setTimeout(r, 1500))
      const files = await this.listFiles()
      if (!files.some((f) => f.name === file.name))
        throw new PrinterError(`${file.name} was sent but does not appear on the printer. Port 80 may be unreachable, or storage may be full.`)
    }
    this.ev.log('ok', `${file.name} uploaded.`)
  }

  async history(): Promise<HistoryEntry[]> {
    const ids: string[] = (await this.cmd(320, {}, 'read history')).HistoryData ?? []
    const list: Json[] = []
    // Newest 60, asked for in small batches to keep the printer's replies small.
    for (let i = 0; i < Math.min(ids.length, 60); i += 20) list.push(...((await this.cmd(321, { Id: ids.slice(i, i + 20) }, 'read history')).HistoryDetailList ?? []))
    return list.map((h) => {
      // Thumbnails are served from port 80; use the address we connected to, not the LAN one inside the URL.
      const thumbPath = /^https?:\/\/[^/]+(\/.+\.png)$/.exec(String(h.Thumbnail ?? ''))?.[1]
      return {
        id: String(h.TaskId),
        name: String(h.TaskName ?? '').split('/').pop() ?? '',
        begin: num(h.BeginTime),
        end: num(h.EndTime),
        outcome: (['other', 'completed', 'failed', 'stopped'] as const)[num(h.TaskStatus)] ?? 'other',
        reason: h.ErrorStatusReason ? (ERROR_REASON[h.ErrorStatusReason] ?? `Reason code ${h.ErrorStatusReason}`) : '',
        seconds: num(h.SliceInformation?.print_time) || undefined,
        thumb: thumbPath ? `http://${this.host}${thumbPath}` : undefined,
      }
    })
  }

  async cameraUrl() {
    await this.cmd(386, { Enable: 1 }, 'start the camera', {
      1: 'The camera stream limit is reached: another viewer (Elegoo web page, slicer, another app) already has the camera. Close it there, or restart the printer if nothing else is open.',
      2: 'The printer reports that no camera is connected.',
    })
    // Ignore the VideoUrl host: it is the printer's LAN address, which is wrong over a VPN.
    return `http://${this.host}:3031/video`
  }

  async gcode() {
    throw new PrinterError('This firmware has no network G-code command. COSMOS (the Klipper build of OpenCentauri) does.')
  }
  async estop() {
    throw new PrinterError('This firmware has no network emergency stop. Use Stop, or the power switch.')
  }
  async firmwareRestart() {
    throw new PrinterError('This firmware cannot be restarted over the network.')
  }
}
