// A stand-in Centauri Carbon speaking Elegoo SDCP, for testing the app without
// a real printer:  node test/fake-printer.mjs   (needs permission to bind port 80)
// Mirrors the real firmware's shapes: status pushes on Cmd 0, Ack replies,
// chunked MD5-checked uploads on port 80, MJPEG on 3031, a 5-client cap.
// Set CORS=1 to send CORS headers on uploads; without it the reply is unreadable
// from a browser on another origin, which is the worst case the app must handle.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { WebSocketServer } from 'ws'

const frame = readFileSync(new URL('./frame.jpg', import.meta.url))
const ID = '00000000000000000000000000000000'
const files = new Map([['/local/benchy.gcode', { size: 3400000, layers: 240, time: 1790000000 }]])
const uploads = new Map()
const S = {
  machine: [0], print: 0, nozzle: 25, nozzleT: 0, bed: 24, bedT: 0, z: Number(process.env.Z_START ?? 0.415), light: 0, speed: 100,
  fans: { ModelFan: 0, AuxiliaryFan: 0, BoxFan: 0 }, file: '', task: '', ticks: 0, total: 0, layer: 0, prep: 0,
}
export const received = []

setInterval(() => {
  S.nozzle += S.nozzleT > S.nozzle ? Math.min(25, S.nozzleT - S.nozzle) : -Math.min(3, S.nozzle - Math.max(25, S.nozzleT))
  S.bed += S.bedT > S.bed ? Math.min(8, S.bedT - S.bed) : -Math.min(1, S.bed - Math.max(24, S.bedT))
  if (S.print === 16 && S.nozzle >= S.nozzleT && S.bed >= S.bedT) S.print = 15
  else if (S.print === 15 && ++S.prep > 3) S.print = 13
  else if (S.print === 13) {
    S.ticks += 60 * (S.speed / 100)
    S.layer = Math.round((S.ticks / S.total) * 240)
    if (S.ticks >= S.total) Object.assign(S, { print: 9, machine: [0], nozzleT: 0, bedT: 0 })
  } else if (S.print === 5) S.print = 6
  else if (S.print === 12) S.print = 13
  else if (S.print === 7) Object.assign(S, { print: 8, machine: [0], nozzleT: 0, bedT: 0 })
}, 500)

const status = () => ({
  Status: {
    CurrentStatus: S.machine, TempOfHotbed: S.bed, TempOfNozzle: S.nozzle, TempOfBox: 28, TempTargetHotbed: S.bedT, TempTargetNozzle: S.nozzleT, TempTargetBox: 0,
    CurrenCoord: '120.00,110.00,4.20', CurrentFanSpeed: S.fans, ZOffset: S.z, LightStatus: { SecondLight: S.light, RgbLight: [0, 0, 0] },
    PrintInfo: { Status: S.print, CurrentLayer: S.layer, TotalLayer: 240, CurrentTicks: S.ticks, TotalTicks: S.total, Filename: S.file, TaskId: S.task, PrintSpeedPct: S.speed, ErrorNumber: 0 },
  },
  MainboardID: ID, TimeStamp: Math.floor(Date.now() / 1000), Topic: `sdcp/status/${ID}`,
})

function handle(cmd, d) {
  switch (cmd) {
    case 0: return { Ack: 0 }
    case 1: return { Ack: 0 }
    case 128:
      if (S.print && ![8, 9].includes(S.print)) return { Ack: 1 }
      if (!files.has(d.Filename)) return { Ack: 2 }
      Object.assign(S, { machine: [1], print: 16, file: d.Filename, task: `task-${Date.now()}`, ticks: 0, total: 3600, layer: 0, prep: 0, nozzleT: 220, bedT: 60, fans: { ModelFan: 80, AuxiliaryFan: 0, BoxFan: 40 } })
      return { Ack: 0 }
    case 129: if (S.print !== 13) return { Ack: 1 }; S.print = 5; return { Ack: 0 }
    case 131: if (S.print !== 6) return { Ack: 1 }; S.print = 12; return { Ack: 0 }
    case 130: if (!S.machine.includes(1)) return { Ack: 1 }; S.print = 7; return { Ack: 0 }
    case 258: return { Ack: 0, FileList: [...files].map(([name, f]) => ({ name, FileSize: f.size, TotalLayers: f.layers, CreateTime: f.time, type: 1 })) }
    case 259: for (const f of d.FileList ?? []) files.delete(f); return { Ack: 0, ErrData: [] }
    case 320: return { Ack: 0, HistoryData: ['h1', 'h2'] }
    case 321: return { Ack: 0, HistoryDetailList: [
      { TaskId: 'h1', TaskName: '/local/benchy.gcode', BeginTime: 1790000000, EndTime: 1790007200, TaskStatus: 1, ErrorStatusReason: 0, SliceInformation: { print_time: 7100.5 }, Thumbnail: 'http://192.168.1.2/board-resource/history_image/h1.png' },
      { TaskId: 'h2', TaskName: '/local/bracket.gcode', BeginTime: 1789900000, EndTime: 1789903600, TaskStatus: 2, ErrorStatusReason: 3 }] }
    case 386: return { Ack: 0, VideoUrl: '192.168.1.2:3031/video' } // sic: real firmware omits the scheme
    case 403:
      if ('TempTargetNozzle' in d) S.nozzleT = d.TempTargetNozzle
      if ('TempTargetHotbed' in d) S.bedT = d.TempTargetHotbed
      if (d.TargetFanSpeed) Object.assign(S.fans, d.TargetFanSpeed)
      if (d.LightStatus) S.light = d.LightStatus.SecondLight
      if ([50, 100, 130, 160].includes(d.PrintSpeedPct)) S.speed = d.PrintSpeedPct
      if (typeof d.ZOffset === 'number' && process.env.Z_READONLY !== '1') S.z = process.env.Z_MODE === 'relative' ? S.z + d.ZOffset : d.ZOffset - 1e-14 // real firmware reports e.g. 0.00999999999999
      return { Ack: 0 }
    case 512: return { Ack: 0 } // acked; like OpenCentauri-patched firmware, no idle pushes follow
    case 401: case 402: return S.machine.includes(1) ? { Ack: 1 } : { Ack: 0 }
    default:
      console.error(`UNKNOWN COMMAND ${cmd}: the real printer may crash here`)
      process.exitCode = 3
      return null
  }
}

// GET /__silence?ms=N[&refuse=1] makes every open control connection go quiet without
// closing, like a half-dead wifi link. Connections opened afterwards work.
let silentUntil = 0
let refuseNew = false
const quiet = new WeakSet()
const wss = new WebSocketServer({ port: 3030, path: '/websocket', verifyClient: (_i, cb) => (wss.clients.size >= 5 || (refuseNew && Date.now() < silentUntil) ? cb(false, 500, 'too many client') : cb(true)) })
wss.on('connection', (ws) => {
  console.log('ws connection', wss.clients.size)
  ws.on('message', (raw) => {
    if (quiet.has(ws) && Date.now() < silentUntil) return
    const text = raw.toString()
    if (text === 'ping') return ws.send('pong')
    const { Data } = JSON.parse(text)
    if (Data.Cmd !== 0) received.push(Data), console.log('cmd', Data.Cmd, JSON.stringify(Data.Data))
    const reply = handle(Data.Cmd, Data.Data)
    if (!reply) return
    ws.send(JSON.stringify({ Id: '', Data: { Cmd: Data.Cmd, Data: reply, RequestID: Data.RequestID, MainboardID: ID, TimeStamp: 0 }, Topic: `sdcp/response/${ID}` }))
    if (Data.Cmd === 0) ws.send(JSON.stringify(status()))
    if (Data.Cmd === 1) ws.send(JSON.stringify({ Attributes: { Name: 'Centauri Carbon', MachineName: 'Centauri Carbon', FirmwareVersion: 'V0.5.0-oc', MainboardID: ID, NumberOfVideoStreamConnected: 0, MaximumVideoStreamAllowed: 1 }, MainboardID: ID, Topic: `sdcp/attributes/${ID}` }))
  })
})

// Minimal multipart parser: enough for the upload form.
function parseMultipart(buf, boundary) {
  const out = {}
  const sep = Buffer.from(`--${boundary}`)
  let at = buf.indexOf(sep)
  while (at >= 0) {
    const next = buf.indexOf(sep, at + sep.length)
    if (next < 0) break
    const part = buf.subarray(at + sep.length + 2, next - 2)
    const split = part.indexOf('\r\n\r\n')
    const head = part.subarray(0, split).toString()
    const name = /name="([^"]+)"/.exec(head)?.[1]
    const filename = /filename="([^"]*)"/.exec(head)?.[1]
    const body = part.subarray(split + 4)
    if (name) out[name] = filename !== undefined ? { filename, data: body } : body.toString()
    at = next
  }
  return out
}

http.createServer((req, res) => {
  const cors = process.env.CORS === '1' ? { 'Access-Control-Allow-Origin': '*' } : {}
  if (req.url.startsWith('/__silence')) {
    const q = new URL(req.url, 'http://x').searchParams
    silentUntil = Date.now() + Number(q.get('ms') ?? 30000)
    refuseNew = q.get('refuse') === '1' // ...and turn new connections away too (printer unreachable)
    wss.clients.forEach((c) => quiet.add(c))
    return res.writeHead(200, cors).end('ok')
  }
  if (req.method !== 'POST' || req.url !== '/uploadFile/upload') return res.writeHead(200, { 'Content-Type': 'text/html', ...cors }).end('<h1>fake printer</h1>')
  const chunks = []
  req.on('data', (c) => chunks.push(c)).on('end', () => {
    const f = parseMultipart(Buffer.concat(chunks), /boundary=(.+)$/.exec(req.headers['content-type'])[1])
    const fail = (m) => res.writeHead(200, { 'Content-Type': 'application/json', ...cors }).end(JSON.stringify({ code: '111111', messages: [{ field: 'common_field', message: m }], data: null, success: false }))
    const up = uploads.get(f.Uuid) ?? { parts: [], size: 0 }
    if (Number(f.Offset) !== up.size) return fail(-2)
    up.parts.push(f.File.data)
    up.size += f.File.data.length
    uploads.set(f.Uuid, up)
    if (up.size >= Number(f.TotalSize)) {
      const all = Buffer.concat(up.parts)
      uploads.delete(f.Uuid)
      if (createHash('md5').update(all).digest('hex') !== f['S-File-MD5']) return fail(-4)
      files.set(`/local/${f.File.filename}`, { size: all.length, layers: 0, time: Math.floor(Date.now() / 1000) })
      console.log('upload complete', f.File.filename, all.length, 'md5 ok')
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors }).end(JSON.stringify({ code: '000000', messages: null, data: {}, success: true }))
  })
}).listen(Number(process.env.HTTP_PORT ?? 80))

let camViewers = 0
http.createServer((_req, res) => {
  console.log('camera viewer opened', ++camViewers)
  res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=--foo' })
  const t = setInterval(() => res.write(Buffer.concat([Buffer.from(`--foo\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`), frame, Buffer.from('\r\n')])), 200)
  res.on('close', () => clearInterval(t))
}).listen(3031)

console.log('fake Centauri Carbon listening: ws 3030, http 80, camera 3031')
