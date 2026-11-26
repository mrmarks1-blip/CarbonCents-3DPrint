import type { Issue } from '../features/assistant'
import { ACTIONS, act, confirmPause, confirmStop, conn, issues, settings, state } from '../store'
import { CameraCard } from './CameraView'
import { cancelWarmup, pauseAfter, setPauseAfter, soak, soakLeft, startNow } from '../features/prep'
import { useEffect, useState } from 'preact/hooks'
import { Bar, clock, duration } from './bits'

export function Dashboard({ go }: { go: (tab: string) => void }) {
  const s = state.value
  const j = s.job
  const active = ['preparing', 'printing', 'pausing', 'paused', 'resuming', 'stopping'].includes(s.phase)
  const left = j.total > 0 ? Math.max(0, j.total - j.elapsed) : 0
  const offline = conn.value !== 'connected'

  return (
    <>
      {offline && s.lastUpdate > 0 && <div class="banner">Offline. Showing the last known state from {clock(s.lastUpdate)}.</div>}
      {!settings.value.host && settings.value.backend !== 'demo' && (
        <div class="card">
          <b>No printer set up yet</b>
          <p class="dim">Enter your printer's address, or try the built-in demo printer first.</p>
          <button class="btn primary" onClick={() => go('settings')}>Open settings</button>
        </div>
      )}

      <WarmupCard />

      <section class="card hero wide">
        <div class="spread">
          <span class={`chip ${s.phase}`}>{s.detail || 'Not connected'}</span>
          <span class="dim small num">{s.raw}</span>
        </div>
        {active || s.phase === 'complete' ? (
          <>
            <div class="file">{j.filename.split('/').pop() || 'Print job'}</div>
            <div class="row" style="align-items:flex-end">
              <span class="pct num">{Math.floor(j.progress)}<span style="font-size:1.4rem">%</span></span>
              <span class="dim grow" style="text-align:right">{j.totalLayers > 0 && <>Layer <b class="num">{j.layer}</b> of <span class="num">{j.totalLayers}</span></>}</span>
            </div>
            <Bar value={j.progress} tone={s.phase === 'complete' ? 'ok' : s.phase === 'printing' ? '' : 'warn'} live={s.phase === 'printing'} />
            {j.totalLayers > 0 && <Bar value={(j.layer / j.totalLayers) * 100} tone="cool" thin />}
            <div class="stats">
              <div class="stat"><b class="num">{duration(j.elapsed)}</b><span>Elapsed</span></div>
              <div class="stat"><b class="num">{left ? duration(left) : '—'}</b><span>Remaining</span></div>
              <div class="stat"><b class="num">{left && s.phase !== 'complete' ? clock(Date.now() + left * 1000) : '—'}</b><span>Finishes at</span></div>
            </div>
            {j.filamentMm !== null && <span class="dim small">Filament used: <span class="num">{(j.filamentMm / 1000).toFixed(2)}</span> m</span>}
          </>
        ) : (
          <p class="dim">{offline ? 'Waiting for the printer.' : 'Ready. Start a print from the Files tab.'}</p>
        )}
        {active && (
          <div class="row">
            {s.phase === 'paused' ? (
              <button class="btn primary grow" onClick={() => act('Resume', (b) => b.resume())}>Resume</button>
            ) : (
              <button class="btn grow" disabled={s.phase !== 'printing'} onClick={() => confirmPause()}>Pause</button>
            )}
            <button class="btn danger grow" onClick={() => confirmStop()}>Stop</button>
          </div>
        )}
        {(active || pauseAfter.value) && <PauseAfter />}
      </section>

      <CameraCard />

      <section class="card third">
        <h2>Temperatures</h2>
        <Temp label="Nozzle" v={s.temps.nozzle} target={s.temps.nozzleTarget} max={320} />
        <Temp label="Bed" v={s.temps.bed} target={s.temps.bedTarget} max={110} />
        <Temp label="Chamber" v={s.temps.chamber} target={0} max={70} />
      </section>

      {issues.value.map((i) => <IssueCard key={i.id} issue={i} />)}

    </>
  )
}

function Temp({ label, v, target, max }: { label: string; v: number; target: number; max: number }) {
  const heating = target > 0
  return (
    <div class="temp">
      <div class="spread">
        <span class="dim">{label}</span>
        <span><span class="v num">{v.toFixed(0)}</span> <span class="dim num">{heating ? `/ ${target} °C` : '°C'}</span></span>
      </div>
      <Bar value={heating ? (v / target) * 100 : (v / max) * 100} tone={heating ? (v >= target - 3 ? 'ok' : '') : 'cool'} thin />
    </div>
  )
}

function IssueCard({ issue }: { issue: Issue }) {
  return (
    <section class={`card issue ${issue.level}`}>
      <b>{issue.title}</b>
      <p>{issue.why}</p>
      {issue.tips.length > 0 && <ul>{issue.tips.map((t) => <li>{t}</li>)}</ul>}
      {issue.actions.length > 0 && (
        <div class="row">
          {issue.actions.map((a) => (
            <button class={`btn sm ${ACTIONS[a].danger ? 'danger' : ''}`} onClick={() => ACTIONS[a].run()}>{ACTIONS[a].label}</button>
          ))}
        </div>
      )}
    </section>
  )
}

function WarmupCard() {
  const s = soak.value
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  if (!s) return null
  const bed = state.value.temps.bed
  const left = soakLeft(s)
  return (
    <section class="card wide warmup">
      <div class="spread">
        <h2>Warm-up before levelling</h2>
        <span class="chip preparing">{s.phase === 'heating' ? 'Heating bed' : s.phase === 'soaking' ? 'Soaking' : 'Starting'}</span>
      </div>
      <div class="file">{s.file.name}</div>
      {s.phase === 'heating' ? (
        <>
          <span class="dim">Bed <b class="num">{bed.toFixed(0)}</b> of <span class="num">{s.target}</span> °C</span>
          <Bar value={(bed / s.target) * 100} />
        </>
      ) : (
        <>
          <span class="dim">Bed <b class="num">{bed.toFixed(0)}</b> °C · starts with auto-levelling in <b class="num">{Math.floor((left ?? 0) / 60)}:{String((left ?? 0) % 60).padStart(2, '0')}</b></span>
          <Bar value={100 - ((left ?? 0) / (s.minutes * 60)) * 100} tone="ok" />
        </>
      )}
      <div class="row">
        <button class="btn grow" onClick={() => cancelWarmup(true)} disabled={s.phase === 'starting'}>Cancel (bed off)</button>
        <button class="btn primary grow" onClick={startNow} disabled={s.phase === 'starting' || conn.value !== 'connected'}>Start now</button>
      </div>
    </section>
  )
}

function PauseAfter() {
  const p = pauseAfter.value
  const [v, setV] = useState('')
  if (p)
    return (
      <div class="row tight small">
        <span class="grow">Will pause after layer <b class="num">{p.layer}</b> so you can check it.</span>
        <button class="btn sm" onClick={() => setPauseAfter(null)}>Don't</button>
      </div>
    )
  const n = parseInt(v, 10)
  return (
    <div class="row tight">
      <input class="grow" type="number" inputMode="numeric" min={1} placeholder={`Pause after layer… (now ${state.value.job.layer})`} value={v} onInput={(e) => setV(e.currentTarget.value)} />
      <button class="btn sm" disabled={!(n > state.value.job.layer)} onClick={() => (setPauseAfter(n), setV(''))}>Set</button>
    </div>
  )
}
