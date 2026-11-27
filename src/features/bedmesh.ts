// Bed mesh / probing report, the in-app version of tools/bedmesh.py (keep the
// two in step). Reads the printer's log through the OpenCentauri root shell
// (Android app only: PrinterShellPlugin.java runs a fixed set of read-only
// commands), splits the probe lines into levelling runs and analyses them.
import { registerPlugin } from '@capacitor/core'

export interface ProbePoint {
  x: number
  y: number
  /** Height the firmware settled on (median of its last samples). */
  z: number
  /** z minus the run's average. */
  rel: number
  retries: number
  /** Worst disagreement between samples when it retried, mm. */
  spread: number
}
export interface Run {
  /** False for runs logged before the printer last restarted (their clock time is unknown). */
  thisBoot: boolean
  t0: number // ms since boot
  t1: number
  points: ProbePoint[]
  range: number
  edgeMinusCentre: number
  retried: ProbePoint[]
  worstSpread: number
}
export interface Report {
  runs: Run[]
  bootEpoch: number | null
  mesh: { file: string; rows: number[][] } | null
  meshFiles: string[]
}

const PROBE = /\[probe\]\[\d+\]\[\w+\]\[(\d+)\]:probe at (-?[\d.]+),\s*(-?[\d.]+) is z=(-?[\d.]+)/
const RETRY = /\[probe\]\[\d+\]\[\w+\]\[(\d+)\]:.*exceed tolerance.*MAX:\s*(-?[\d.]+)\s+MIN:\s*(-?[\d.]+)/
const RUN_GAP_MS = 120_000
const MIN_POINTS = 9
const key = (x: number, y: number) => `${x.toFixed(1)},${y.toFixed(1)}`
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length)
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

type Ev = { kind: 'p'; t: number; x: number; y: number; z: number } | { kind: 'r'; t: number; max: number; min: number }

export function parseProbes(text: string): Ev[] {
  const seen = new Set<string>()
  const out: Ev[] = []
  for (const line of text.split(/\r?\n/)) {
    if (seen.has(line)) continue // log1 and log2 tails can overlap
    let m = PROBE.exec(line)
    if (m) {
      seen.add(line)
      out.push({ kind: 'p', t: +m[1], x: +m[2], y: +m[3], z: +m[4] })
      continue
    }
    m = RETRY.exec(line)
    if (m) {
      seen.add(line)
      out.push({ kind: 'r', t: +m[1], max: +m[2], min: +m[3] })
    }
  }
  // Kept in log order, not sorted: times are milliseconds since the printer
  // started, so they jump back at every restart. splitRuns uses that jump to
  // tell boots apart instead of merging runs from different days.
  return out
}

export function splitRuns(events: Ev[]): Run[] {
  const groups: { boot: number; ev: Ev[] }[] = []
  let cur: Ev[] = []
  let last: number | null = null
  let boot = 0
  for (const e of events) {
    const restarted = last !== null && e.t < last - 1000
    if (last !== null && (e.t - last > RUN_GAP_MS || restarted)) {
      groups.push({ boot, ev: cur })
      cur = []
    }
    if (restarted) boot++
    cur.push(e)
    last = e.t
  }
  if (cur.length) groups.push({ boot, ev: cur })
  const runs: Run[] = []
  for (const { boot: b, ev: g } of groups) {
    const pts = new Map<string, { x: number; y: number; samples: number[]; retries: number; spread: number }>()
    let lastKey: string | null = null
    for (const e of g) {
      if (e.kind === 'p') {
        const k = key(e.x, e.y)
        if (!pts.has(k)) pts.set(k, { x: e.x, y: e.y, samples: [], retries: 0, spread: 0 })
        pts.get(k)!.samples.push(e.z)
        lastKey = k
      } else if (lastKey) {
        const p = pts.get(lastKey)!
        p.retries++
        p.spread = Math.max(p.spread, Math.abs(e.max - e.min))
      }
    }
    if (pts.size < MIN_POINTS) continue // a Z home or single probe, not a levelling run
    const points: ProbePoint[] = [...pts.values()].map((p) => ({ x: p.x, y: p.y, z: median(p.samples.slice(-3)), rel: 0, retries: p.retries, spread: p.spread }))
    runs.push(analyse({ thisBoot: b === boot, t0: g[0].t, t1: g[g.length - 1].t, points, range: 0, edgeMinusCentre: 0, retried: [], worstSpread: 0 }))
  }
  return runs
}

function analyse(r: Run): Run {
  const avg = mean(r.points.map((p) => p.z))
  for (const p of r.points) p.rel = p.z - avg
  const xs = axis(r.points, 'x')
  const ys = axis(r.points, 'y')
  const isEdge = (p: ProbePoint) => [xs[0], xs[xs.length - 1]].includes(+p.x.toFixed(1)) || [ys[0], ys[ys.length - 1]].includes(+p.y.toFixed(1))
  const edge = r.points.filter(isEdge)
  const centre = r.points.filter((p) => !isEdge(p))
  const zs = r.points.map((p) => p.z)
  r.range = Math.max(...zs) - Math.min(...zs)
  r.edgeMinusCentre = mean(edge.map((p) => p.z)) - mean((centre.length ? centre : r.points).map((p) => p.z))
  r.retried = r.points.filter((p) => p.retries > 0)
  r.worstSpread = Math.max(0, ...r.points.map((p) => p.spread))
  return r
}

export const axis = (pts: { x: number; y: number }[], k: 'x' | 'y') => [...new Set(pts.map((p) => +p[k].toFixed(1)))].sort((a, b) => a - b)

/** Latest minus previous at points both probed, each relative to its own average. */
export function diffRuns(a: Run, b: Run): ProbePoint[] {
  const prev = new Map(a.points.map((p) => [key(p.x, p.y), p.rel]))
  return b.points.filter((p) => prev.has(key(p.x, p.y))).map((p) => ({ ...p, rel: p.rel - prev.get(key(p.x, p.y))!, retries: 0, spread: 0 }))
}

/** A Klipper-style `points =` block, or JSON holding a 2-D number grid. */
export function parseMesh(text: string): number[][] | null {
  const m = /^\s*points\s*[=:]\s*\n?((?:[ \t]*-?[\d.]+(?:\s*,\s*-?[\d.]+)*\s*,?\s*\n?)+)/m.exec(text)
  if (m) {
    const rows = m[1].trim().split(/\n/).map((ln) => (ln.match(/-?\d+\.?\d*/g) ?? []).map(Number)).filter((r) => r.length)
    if (rows.length >= 2 && rows.every((r) => r.length === rows[0].length)) return rows
  }
  try {
    const walk = (o: unknown): number[][] | null => {
      if (Array.isArray(o) && o.length >= 2 && o.every((r) => Array.isArray(r) && r.length && r.every((v) => typeof v === 'number')) && o.every((r) => r.length === o[0].length)) return o as number[][]
      for (const v of Array.isArray(o) ? o : o && typeof o === 'object' ? Object.values(o) : []) {
        const got = walk(v)
        if (got) return got
      }
      return null
    }
    return walk(JSON.parse(text))
  } catch {
    return null
  }
}

export function advice(runs: Run[], latest = true): string[] {
  if (!runs.length) return ['No levelling runs were found in the log. Run auto-levelling once (touchscreen, or start a print with it on), then read the report again.']
  const tips: string[] = []
  const last = runs[runs.length - 1]
  if (last.retried.length)
    tips.push(
      `${last.retried.length} of ${last.points.length} points needed retries in ${latest ? 'the latest' : 'this'} run (worst disagreement ${last.worstSpread.toFixed(3)} mm). ` +
        'The probe is the nozzle pressing on the plate, so this usually means something between them: filament on the nozzle tip (brush it clean while hot), debris, or a plate not sitting flat on the magnet.',
    )
  if (Math.abs(last.edgeMinusCentre) > 0.08)
    tips.push(
      `The edges are ${Math.abs(last.edgeMinusCentre).toFixed(2)} mm ${last.edgeMinusCentre > 0 ? 'higher' : 'lower'} than the centre on average. ` +
        'Check for grit under the plate near the edges and that the plate lies flat; a bed that is not fully warmed up can also do this.',
    )
  if (runs.length >= 2) {
    const d = diffRuns(runs[runs.length - 2], last)
    if (d.length) {
      const worst = Math.max(...d.map((p) => Math.abs(p.rel)))
      tips.push(
        `${latest ? 'The two latest runs' : 'This run and the one before'} differ by up to ${worst.toFixed(3)} mm at the same point. ` +
          (worst > 0.05
            ? 'That is more than the first layer can absorb (about 0.05 mm): the mesh is not repeatable, so something changes between runs (temperature, nozzle tip, plate seating).'
            : 'That is small: the mesh is repeatable.'),
      )
    }
  }
  if (!tips.length) tips.push('Probing looks clean and the bed looks even. If PETG still lifts, look at the plate surface (wash with dish soap), bed temperature, part-cooling fan and a brim.')
  return tips
}

// ---- Reading it from the printer -------------------------------------------

type Query = 'clock' | 'probe-log' | 'mesh-files' | 'mesh-file'
interface ShellPlugin {
  read(o: { host: string; query: Query; path?: string; logMb?: number }): Promise<{ text: string }>
}
const PrinterShell = registerPlugin<ShellPlugin>('PrinterShell')
const native = () => !!(window as any).Capacitor?.isNativePlatform?.()
/** Test hook for the end-to-end test only (the web build has no shell access). */
const mock = () => (window as any).__ccShellMock as ShellPlugin | undefined

/** Whether this build of the app can read the report at all. */
export const canRead = () => native() || !!mock()

async function read(host: string, query: Query, path?: string, logMb = 4) {
  return (await (mock() ?? PrinterShell).read({ host, query, path, logMb })).text
}

/** Read and analyse. Only read-only queries; nothing is sent to the printer's control process. */
export async function readReport(host: string, logMb = 4): Promise<Report> {
  let clock: string
  try {
    clock = await read(host, 'clock')
  } catch (e) {
    throw new Error(`Could not reach the printer's OpenCentauri shell on port 4567 (${(e as Error).message}). This report needs OpenCentauri-patched firmware.`)
  }
  const up = clock.trim().split(/\s+/)
  const bootEpoch = up.length >= 2 ? +up[up.length - 1] - +up[0] : null
  const meshFiles = (await read(host, 'mesh-files')).split(/\s+/).filter(Boolean).slice(0, 6)
  let mesh: Report['mesh'] = null
  for (const f of meshFiles) {
    try {
      const rows = parseMesh(await read(host, 'mesh-file', f))
      if (rows) {
        mesh = { file: f, rows }
        break
      }
    } catch {
      /* not allowed or unreadable: try the next */
    }
  }
  // Last: the biggest read. If it is slow, the small ones above are already done.
  const runs = splitRuns(parseProbes(await read(host, 'probe-log', undefined, logMb)))
  return { runs, bootEpoch: Number.isFinite(bootEpoch) ? bootEpoch : null, mesh, meshFiles }
}

export function when(ms: number, bootEpoch: number | null, thisBoot = true) {
  if (!thisBoot) return 'before the printer last restarted'
  if (bootEpoch === null) return `${(ms / 3_600_000).toFixed(1)} h after the printer started`
  return new Date((bootEpoch + ms / 1000) * 1000).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

// ---- Naming problem areas ----------------------------------------------------

/** Points further than this from the run's average are flagged on the map. */
export const OFF_MM = 0.1

/**
 * Where a point sits, in words. Left/right follow X (X 0 on the left). Front/back
 * assume Y 0 is the front of the bed, as on most printers.
 */
export function zoneOf(p: { x: number; y: number }, xs: number[], ys: number[]) {
  const third = (v: number, a: number[]) => {
    const i = a.indexOf(+v.toFixed(1))
    const f = a.length > 1 ? i / (a.length - 1) : 0.5
    return f < 0.2 ? 0 : f > 0.8 ? 2 : 1 // only the outermost points count as an edge
  }
  const col = ['left', '', 'right'][third(p.x, xs)]
  const row = ['front', '', 'back'][third(p.y, ys)]
  return row && col ? `${row}-${col}` : row || col || 'centre'
}

export interface Areas {
  low: string[]
  high: string[]
  retried: string[]
}
/** Areas with points off by more than OFF_MM, and areas where the probe retried. */
export function problemAreas(points: ProbePoint[]): Areas {
  const xs = axis(points, 'x')
  const ys = axis(points, 'y')
  const uniq = (ps: ProbePoint[]) => [...new Set(ps.map((p) => zoneOf(p, xs, ys)))]
  const EDGES = ['front-left', 'front', 'front-right', 'left', 'right', 'back-left', 'back', 'back-right']
  const tidy = (zones: string[]) => (EDGES.every((z) => zones.includes(z)) ? ['all edges', ...zones.filter((z) => !EDGES.includes(z))] : zones)
  return {
    low: tidy(uniq(points.filter((p) => p.rel < -OFF_MM))),
    high: tidy(uniq(points.filter((p) => p.rel > OFF_MM))),
    retried: uniq(points.filter((p) => p.retries > 0)),
  }
}

/** What one point's readings mean, for the tap-for-details panel. */
export function explainPoint(p: ProbePoint, xs: number[], ys: number[]) {
  const where = zoneOf(p, xs, ys)
  const lines = [`X ${p.x.toFixed(0)}, Y ${p.y.toFixed(1)} (${where}): ${Math.abs(p.rel).toFixed(3)} mm ${p.rel >= 0 ? 'above' : 'below'} this run's average.`]
  if (Math.abs(p.rel) > OFF_MM)
    lines.push(
      p.rel < 0
        ? 'Low spot: the first layer here gets less squish and is the likeliest place for PETG to lift. Look for grit under the plate here or a plate edge not sitting flat.'
        : 'High spot: the nozzle gets close here, which can scrape or over-squish. Look for debris on top of the plate or a bump under it.',
    )
  if (p.retries)
    lines.push(
      `The probe retried ${p.retries}× here because its readings disagreed by up to ${p.spread.toFixed(3)} mm (it allows 0.015 mm). Usually filament on the nozzle tip or something on the plate at this spot.`,
    )
  if (lines.length === 1) lines.push('Within normal range.')
  return lines
}
