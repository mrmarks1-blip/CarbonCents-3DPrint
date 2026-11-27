import { useState } from 'preact/hooks'
import { advice, axis, canRead, diffRuns, readReport, when, type ProbePoint, type Report } from '../features/bedmesh'
import { activeHost, info, log, state } from '../store'

/** Blue for low, red for high, near-white around 0. */
function colour(v: number, span: number) {
  const t = Math.max(-1, Math.min(1, span ? v / span : 0))
  return t >= 0 ? `rgb(255,${Math.round(245 - 175 * t)},${Math.round(235 - 190 * t)})` : `rgb(${Math.round(235 + 190 * t)},${Math.round(245 + 120 * t)},255)`
}

/** Heights on a grid, back of the bed at the top. */
function Heatmap({ points, span, label }: { points: { x: number; y: number; rel: number; retries?: number }[]; span?: number; label: string }) {
  if (!points.length) return null
  const xs = axis(points, 'x')
  const ys = axis(points, 'y')
  const sp = span ?? Math.max(0.05, ...points.map((p) => Math.abs(p.rel)))
  const cell = 60
  const pad = 60
  const w = pad + cell * xs.length + 6
  const h = pad - 16 + cell * ys.length + 6
  return (
    <svg class="mesh" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
      {xs.map((x, i) => <text x={pad + cell * i + cell / 2} y={20} class="ax">{x}</text>)}
      {[...ys].reverse().map((y, j) => <text x={pad - 6} y={pad - 16 + cell * j + cell / 2 + 4} class="ax" text-anchor="end">{y}</text>)}
      {points.map((p) => {
        const i = xs.indexOf(+p.x.toFixed(1))
        const j = ys.length - 1 - ys.indexOf(+p.y.toFixed(1))
        const x0 = pad + cell * i
        const y0 = pad - 16 + cell * j
        return (
          <g>
            <rect x={x0 + 2} y={y0 + 2} width={cell - 4} height={cell - 4} rx={6} fill={colour(p.rel, sp)} class={p.retries ? 'retry' : ''} />
            <text x={x0 + cell / 2} y={y0 + cell / 2 + 4} class="v">{(p.rel >= 0 ? '+' : '') + p.rel.toFixed(3)}</text>
            {!!p.retries && <text x={x0 + cell - 11} y={y0 + 16} class="flag">!</text>}
          </g>
        )
      })}
    </svg>
  )
}

/** Care tab card: the bed mesh / probing report (Android app, OpenCentauri-patched firmware). */
export function BedReport() {
  const [rep, setRep] = useState<Report | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [shown, setShown] = useState(0) // which run, counting back from the latest
  const host = activeHost.value
  const sdcp = info.value?.backend === 'sdcp'
  const printing = ['preparing', 'printing', 'pausing', 'paused', 'resuming', 'stopping'].includes(state.value.phase)

  const load = async () => {
    setBusy(true)
    setErr('')
    log('info', 'Bed report: reading the levelling log over the OpenCentauri shell (read-only).')
    try {
      const r = await readReport(host)
      setRep(r)
      setShown(0)
      log('ok', `Bed report: ${r.runs.length} levelling run(s) found.`)
    } catch (e) {
      setErr((e as Error).message)
      log('error', `Bed report: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  if (!canRead())
    return (
      <section class="card">
        <h2>Bed levelling report</h2>
        <p class="dim small">Reading the levelling data needs the Android app (a web page cannot open the printer's shell connection). On a computer, run <code>python tools/bedmesh.py --host {host || '<printer-ip>'}</code>.</p>
      </section>
    )

  const runs = rep?.runs ?? []
  const run = runs[runs.length - 1 - shown]
  const prev = runs[runs.length - 2 - shown]
  const diff = run && prev ? diffRuns(prev, run) : []
  const meshPts: ProbePoint[] = rep?.mesh
    ? (() => {
        const all = rep.mesh!.rows.flat()
        const avg = all.reduce((a, b) => a + b, 0) / all.length
        return rep.mesh!.rows.flatMap((row, j) => row.map((v, i) => ({ x: i, y: j, z: v, rel: v - avg, retries: 0, spread: 0 })))
      })()
    : []

  return (
    <section class="card bedreport">
      <div class="spread">
        <h2>Bed levelling report</h2>
        <button class="btn sm" onClick={load} disabled={busy || !host || host === 'demo' || printing}>{busy ? 'Reading…' : rep ? 'Read again' : 'Read from printer'}</button>
      </div>
      {!rep && !err && (
        <p class="dim small">
          Draws each recent auto-levelling run from the printer's log as a heat map, marks points where the probe had to retry, and compares the last two runs. Read-only:
          it only reads files over the OpenCentauri shell (patched firmware){sdcp ? '' : ', and this does not look like that firmware'}. {printing ? 'Available when the printer is not printing, so the read cannot disturb it.' : ''}
        </p>
      )}
      {err && <p class="small" style="color:var(--bad)">{err}</p>}
      {rep && (
        <>
          <ul class="small tips">{advice(runs.slice(0, runs.length - shown), shown === 0).map((t) => <li>{t}</li>)}</ul>
          {run ? (
            <>
              <div class="spread">
                <b class="small">{shown === 0 ? 'Latest run' : `${shown} run${shown > 1 ? 's' : ''} before the latest`}</b>
                <div class="row tight">
                  <button class="btn sm" disabled={shown >= runs.length - 1} onClick={() => setShown(shown + 1)} aria-label="Older run">‹</button>
                  <button class="btn sm" disabled={shown === 0} onClick={() => setShown(shown - 1)} aria-label="Newer run">›</button>
                </div>
              </div>
              <p class="dim small">
                {when(run.t0, rep.bootEpoch, run.thisBoot)} · {run.points.length} points · range {run.range.toFixed(3)} mm · edges {(run.edgeMinusCentre >= 0 ? '+' : '') + run.edgeMinusCentre.toFixed(3)} mm vs centre · {run.retried.length} retried
              </p>
              <Heatmap points={run.points} label="Probed heights" />
              {diff.length > 0 && (
                <>
                  <b class="small">Change since the run before</b>
                  <p class="dim small">Near 0 everywhere means the mesh is repeatable. Level once cold and once after a warm-up, then compare here.</p>
                  <Heatmap points={diff} span={0.1} label="Change since the previous run" />
                </>
              )}
            </>
          ) : null}
          {rep.mesh && (
            <>
              <b class="small">Saved mesh</b>
              <p class="dim small">From {rep.mesh.file}; grid positions, not mm.</p>
              <Heatmap points={meshPts} label="Saved mesh" />
            </>
          )}
          {!rep.mesh && rep.meshFiles.length > 0 && <p class="dim small">Files mentioning a mesh: {rep.meshFiles.join(', ')} (grid not recognised).</p>}
          <p class="dim small">Heights in mm relative to each run's average: red is higher (closer to the nozzle), blue lower. Outlined cells with ! needed probe retries.</p>
        </>
      )}
    </section>
  )
}
