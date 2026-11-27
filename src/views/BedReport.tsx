import { useEffect, useRef, useState } from 'preact/hooks'
import { OFF_MM, advice, axis, canRead, diffRuns, explainPoint, judgeRetake, problemAreas, readReport, retakeResults, when, type ProbePoint, type Report, type Run } from '../features/bedmesh'
import { MAX_RETAKE, PROBE_C, SAMPLES, WIPE_C, busy as jobBusy, clearJob, job, relevel, retake, snaps, snapshot, type Pt } from '../features/levelling'
import { soak, soakLeft } from '../features/prep'
import { act, activeHost, ask, conn, info, log, state } from '../store'

/** Blue for low, red for high, near-white around 0. */
function colour(v: number, span: number) {
  const t = Math.max(-1, Math.min(1, span ? v / span : 0))
  return t >= 0 ? `rgb(255,${Math.round(245 - 175 * t)},${Math.round(235 - 190 * t)})` : `rgb(${Math.round(235 + 190 * t)},${Math.round(245 + 120 * t)},255)`
}

/** Heights on a grid, back of the bed at the top. */
function Heatmap({ points, span, label, pick, picked, flagOff = true }: { points: { x: number; y: number; rel: number; retries?: number }[]; span?: number; label: string; pick?: (i: number) => void; picked?: number; flagOff?: boolean }) {
  if (!points.length) return null
  const xs = axis(points, 'x')
  const ys = axis(points, 'y')
  const sp = span ?? Math.max(0.05, ...points.map((p) => Math.abs(p.rel)))
  const cell = 60
  const pad = 76 // left margin: side label + Y values
  const top = 64 // BACK label + X values
  const gw = cell * xs.length
  const gh = cell * ys.length
  const w = pad + gw + 26
  const h = top + gh + 28
  // Seen from the front of the printer: X grows to the right, Y towards the back
  // (the toolhead parks at the back right, about X 202 / Y 264).
  return (
    <svg class="mesh" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
      <text x={pad + gw / 2} y={14} class="side">BACK</text>
      <text x={pad + gw / 2} y={top + gh + 22} class="side">FRONT</text>
      <text x={14} y={top + gh / 2} class="side" transform={`rotate(-90 14 ${top + gh / 2})`}>LEFT</text>
      <text x={w - 10} y={top + gh / 2} class="side" transform={`rotate(90 ${w - 10} ${top + gh / 2})`}>RIGHT</text>
      {xs.map((x, i) => <text x={pad + cell * i + cell / 2} y={top - 10} class="ax">{x}</text>)}
      {[...ys].reverse().map((y, j) => <text x={pad - 6} y={top + cell * j + cell / 2 + 4} class="ax ay">{y}</text>)}
      {points.map((p, n) => {
        const i = xs.indexOf(+p.x.toFixed(1))
        const j = ys.length - 1 - ys.indexOf(+p.y.toFixed(1))
        const x0 = pad + cell * i
        const y0 = top + cell * j
        return (
          <g class={pick ? 'pickable' : ''} onClick={pick && (() => pick(n))} role={pick ? 'button' : undefined} aria-label={pick ? `Point ${p.x}, ${p.y}` : undefined}>
            <rect x={x0 + 2} y={y0 + 2} width={cell - 4} height={cell - 4} rx={6} fill={colour(p.rel, sp)} class={`${p.retries ? 'retry' : ''} ${flagOff && Math.abs(p.rel) > OFF_MM ? 'off' : ''} ${picked === n ? 'picked' : ''}`} />
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
  const [picked, setPicked] = useState<number | null>(null)
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
      setPicked(null)
      log('ok', `Bed report: ${r.runs.length} levelling run(s) found.`)
    } catch (e) {
      setErr((e as Error).message)
      log('error', `Bed report: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const j = job.value
  const blocked = !host || host === 'demo' || printing || jobBusy() || conn.value !== 'connected'
  useEffect(() => {
    if (j?.phase === 'done' && host) load()
  }, [j?.phase])

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
      <Relevel disabled={blocked} />
      <JobPanel run={rep?.runs[rep.runs.length - 1]} rep={rep} />
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
                  <button class="btn sm" disabled={shown >= runs.length - 1} onClick={() => (setShown(shown + 1), setPicked(null))} aria-label="Older run">‹</button>
                  <button class="btn sm" disabled={shown === 0} onClick={() => (setShown(shown - 1), setPicked(null))} aria-label="Newer run">›</button>
                </div>
              </div>
              <p class="dim small">
                {when(run.t0, rep.bootEpoch, run.thisBoot)} · {run.points.length} points · range {run.range.toFixed(3)} mm · edges {(run.edgeMinusCentre >= 0 ? '+' : '') + run.edgeMinusCentre.toFixed(3)} mm vs centre · {run.retried.length} retried
              </p>
              <Areas run={run.points} />
              {shown === 0 && <RetakeFlagged run={run} disabled={blocked} />}
              <Heatmap points={run.points} label="Probed heights" pick={(n) => setPicked(picked === n ? null : n)} picked={picked ?? undefined} />
              {picked !== null && run.points[picked] && (
                <div class="pointinfo small" role="status">
                  {explainPoint(run.points[picked], axis(run.points, 'x'), axis(run.points, 'y')).map((l) => <p>{l}</p>)}
                  {shown === 0 && (
                    <button class="btn sm" disabled={blocked} onClick={() => confirmRetake([run.points[picked]])}>
                      Wipe the nozzle and retake this point
                    </button>
                  )}
                </div>
              )}
              {picked === null && <p class="dim small">Tap a square for its readings.</p>}
              {diff.length > 0 && (
                <>
                  <b class="small">Change since the run before</b>
                  <p class="dim small">Near 0 everywhere means the mesh is repeatable. Level once cold and once after a warm-up, then compare here.</p>
                  <Heatmap points={diff} span={0.1} label="Change since the previous run" flagOff={false} />
                </>
              )}
            </>
          ) : null}
          {rep.mesh && (
            <>
              <b class="small">Saved mesh</b>
              <p class="dim small">From {rep.mesh.file}; grid positions, not mm.</p>
              <Heatmap points={meshPts} label="Saved mesh" flagOff={false} />
            </>
          )}
          {!rep.mesh && rep.meshFiles.length > 0 && <p class="dim small">Files mentioning a mesh: {rep.meshFiles.join(', ')} (grid not recognised).</p>}
          <p class="dim small">Heights in mm relative to each run's average: red is higher (closer to the nozzle), blue lower. Solid outline with ! = the probe retried there; dashed outline = more than {OFF_MM} mm from the average. Drawn as seen from the front of the printer (Y 0 is the front; the toolhead parks at the back right).</p>
        </>
      )}
    </section>
  )
}

/** The problem areas of a run, in words. */
function Areas({ run }: { run: ProbePoint[] }) {
  const a = problemAreas(run)
  const list = (v: string[]) => v.join(', ')
  if (!a.low.length && !a.high.length && !a.retried.length) return <p class="small" style="color:var(--ok)">No problem areas: every point is within {OFF_MM} mm of the average and probed cleanly.</p>
  return (
    <ul class="small areas">
      {a.low.length > 0 && <li><b>Low:</b> {list(a.low)}</li>}
      {a.high.length > 0 && <li><b>High:</b> {list(a.high)}</li>}
      {a.retried.length > 0 && <li><b>Probe retried:</b> {list(a.retried)}</li>}
    </ul>
  )
}

/** Points worth a second look: probe retried, or far from the average. Worst first. */
function suspects(run: Run): ProbePoint[] {
  const score = (p: ProbePoint) => (p.retries ? 1 + p.spread : 0) + Math.max(0, Math.abs(p.rel) - OFF_MM) * 10
  return run.points.filter((p) => score(p) > 0).sort((a, b) => score(b) - score(a)).slice(0, MAX_RETAKE)
}

async function confirmRetake(points: Pt[]) {
  const where = points.map((p) => `X ${p.x.toFixed(0)} Y ${p.y.toFixed(0)}`).join(', ')
  const yes = await ask({
    title: `Wipe and retake ${points.length} point${points.length > 1 ? 's' : ''}?`,
    body:
      `The printer will home, heat the nozzle to ${WIPE_C} °C, wipe it on its wiper, cool towards ${PROBE_C} °C and probe ${where}, ${SAMPLES} times each. Nothing is printed and the bed is not heated. ` +
      'Experimental: this has not been run on a real printer yet. Clear the plate and stay near the printer; Stop on the touchscreen or in the app ends it.',
    ok: 'Start the retake',
  })
  if (yes) retake(points)
}

function RetakeFlagged({ run, disabled }: { run: Run; disabled: boolean }) {
  const pts = suspects(run)
  if (!pts.length) return null
  return (
    <button class="btn sm" disabled={disabled} onClick={() => confirmRetake(pts)}>
      Wipe the nozzle and retake the {pts.length} worst point{pts.length > 1 ? 's' : ''}
    </button>
  )
}

function Relevel({ disabled }: { disabled: boolean }) {
  const [bed, setBed] = useState(60)
  const [mins, setMins] = useState(10)
  const cold = async () =>
    (await ask({
      title: 'Re-level now (cold bed)?',
      body: 'Starts a level-only job: the printer runs its normal auto-levelling (heats the nozzle, wipes it, probes the whole bed), then stops without printing. The bed is not heated. Clear the plate first. Experimental: the level-only job has not been run on a real printer yet.',
      ok: 'Start levelling',
    })) && relevel(null)
  const warm = async () =>
    (await ask({
      title: `Warm up to ${bed} °C, then re-level?`,
      body: `Heats the bed to ${bed} °C, waits ${mins} min for the plate to settle, then runs the printer's normal auto-levelling without printing. Keep the app open during the warm-up. Clear the plate first. Experimental: the level-only job has not been run on a real printer yet.`,
      ok: 'Start the warm-up',
    })) && relevel({ bed, minutes: mins })
  return (
    <details class="relevel">
      <summary class="small"><b>Re-level the bed</b>{' '}(cold, or after a warm-up)</summary>
      <p class="dim small">Level once cold and once warm, then compare the two under "Change since the run before". The report reads itself again when a run finishes.</p>
      <button class="btn sm" disabled={disabled} onClick={cold}>Re-level now (cold)</button>
      <div class="row tight">
        <label class="field grow small">Bed °C
          <select value={bed} onChange={(e) => setBed(+e.currentTarget.value)}>{[55, 60, 70, 80, 90].map((t) => <option value={t}>{t}</option>)}</select>
        </label>
        <label class="field grow small">Soak, min
          <select value={mins} onChange={(e) => setMins(+e.currentTarget.value)}>{[5, 10, 15, 20].map((t) => <option value={t}>{t}</option>)}</select>
        </label>
      </div>
      <button class="btn sm" disabled={disabled} onClick={warm}>Warm up, then re-level</button>
    </details>
  )
}

function Stills() {
  const box = useRef<HTMLDivElement>(null)
  const list = snaps.value
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.replaceChildren(
      ...list.map((s) => {
        const f = document.createElement('figure')
        const cap = document.createElement('figcaption')
        cap.textContent = `${s.label} · ${new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        f.append(s.canvas, cap)
        return f
      }),
    )
  }, [list])
  return (
    <>
      <div class="stills" ref={box} />
      <button class="btn sm" onClick={() => snapshot('Snapshot') || log('warn', 'No camera picture to copy: turn the camera on (Status tab, or Float) first.')}>Take a camera still</button>
      <p class="dim small">Stills are copied from the live camera so you can compare before and after. Look for strings on the nozzle and debris near the points being probed.</p>
    </>
  )
}

function JobPanel({ run, rep }: { run?: Run; rep: Report | null }) {
  const j = job.value
  if (!j) return null
  const s = soak.value
  const left = s ? soakLeft(s) : null
  const status =
    j.phase === 'warming' && s
      ? s.phase === 'heating'
        ? `Heating the bed to ${s.target} °C (now ${state.value.temps.bed.toFixed(0)} °C).`
        : left !== null
          ? `Soaking: ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left, then levelling.`
          : 'Starting the levelling…'
      : j.message
  const results = j.kind === 'retake' && j.phase === 'done' && rep ? retakeResults(rep.spots, rep.bootEpoch, j.startedAt, j.points) : []
  const runZ = (p: Pt) => run?.points.find((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1.5)?.z
  return (
    <div class="pointinfo small job" role="status">
      <div class="spread">
        <b>{j.kind === 'retake' ? `Retake: ${j.points.length} point${j.points.length > 1 ? 's' : ''}` : `Re-level${j.warm ? ' after warm-up' : ''}`}</b>
        {jobBusy() ? (
          <button class="btn sm danger" onClick={async () => (await ask({ title: 'Stop the job?', body: 'Stops the levelling job on the printer.', ok: 'Stop', danger: true })) && act('Stop', (b) => b.stop())}>Stop</button>
        ) : (
          <button class="btn sm" onClick={clearJob}>Close</button>
        )}
      </div>
      <p style={j.phase === 'failed' ? 'color:var(--bad)' : ''}>{status}</p>
      {results.map(({ point, spot }) => {
        const z0 = runZ(point)
        return (
          <p>
            <b>X {point.x.toFixed(0)} Y {point.y.toFixed(0)}:</b>{' '}
            {spot
              ? `retaken z ${spot.z.toFixed(3)} mm (${spot.samples.length} readings, spread ${spot.spread.toFixed(3)} mm)` + (z0 !== undefined ? `; the levelling run had ${z0.toFixed(3)}. ${judgeRetake(z0, spot)}` : '.')
              : 'no new readings found in the log. The firmware may not accept PROBE_ACCURACY from a job file; the Console tab and the printer screen may say why.'}
          </p>
        )
      })}
      <Stills />
    </div>
  )
}
