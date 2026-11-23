import { useEffect, useRef, useState } from 'preact/hooks'
import type { Issue } from '../features/assistant'
import { ACTIONS, act, activeHost, backend, conn, issues, log, settings, state } from '../store'
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
              <button class="btn grow" disabled={s.phase !== 'printing'} onClick={() => act('Pause', (b) => b.pause())}>Pause</button>
            )}
            <button class="btn danger grow" onClick={() => ACTIONS.stop.run()}>Stop</button>
          </div>
        )}
      </section>

      <section class="card third">
        <h2>Temperatures</h2>
        <Temp label="Nozzle" v={s.temps.nozzle} target={s.temps.nozzleTarget} max={320} />
        <Temp label="Bed" v={s.temps.bed} target={s.temps.bedTarget} max={110} />
        <Temp label="Chamber" v={s.temps.chamber} target={0} max={70} />
      </section>

      {issues.value.map((i) => <IssueCard key={i.id} issue={i} />)}

      <Camera />
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

export function Camera() {
  const [on, setOn] = useState(true)
  const [url, setUrl] = useState('')
  const [msg, setMsg] = useState('Camera is off.')
  const [tune, setTune] = useState(false)
  const tries = useRef(0)
  const timer = useRef(0)
  const cam = settings.value.cam
  const connected = conn.value === 'connected'

  const startStream = async () => {
    const b = backend.value
    if (!b) return
    setMsg('Starting the camera…')
    try {
      const u = await b.cameraUrl()
      if (!u) return setMsg('The demo printer has no camera.')
      setUrl(u)
    } catch (e) {
      const m = (e as Error).message
      log('error', `Camera: ${m}`)
      setMsg(m)
    }
  }
  useEffect(() => {
    clearTimeout(timer.current)
    tries.current = 0
    setUrl('')
    if (on && connected) startStream()
    else setMsg(on ? 'Waiting for the printer.' : 'Camera is off.')
    return () => clearTimeout(timer.current)
  }, [on, connected, activeHost.value])

  const onError = () => {
    setUrl('')
    const n = ++tries.current
    if (n > 5) {
      const m = 'The camera stream keeps failing. The printer allows a handful of video viewers and can hold on to closed ones: close other viewers, or restart the printer.'
      log('error', `Camera: ${m}`)
      return setMsg(m)
    }
    const wait = Math.min(30, 3 * n)
    setMsg(`Camera stream dropped. Retrying in ${wait}s (attempt ${n} of 5).`)
    log('warn', `Camera stream dropped; retry ${n}/5 in ${wait}s.`)
    timer.current = window.setTimeout(startStream, wait * 1000)
  }
  const setCam = (patch: Partial<typeof cam>) => (settings.value = { ...settings.value, cam: { ...cam, ...patch } })
  const filter = `brightness(${cam.brightness}%) contrast(${cam.contrast}%) saturate(${cam.saturation}%)`
  const transform = `${cam.rotate ? 'rotate(180deg)' : ''} ${cam.mirror ? 'scaleX(-1)' : ''}`

  return (
    <section class="card wide">
      <div class="spread">
        <h2>Camera</h2>
        <div class="row tight">
          <button class={`btn sm ${state.value.light ? 'on' : ''}`} disabled={!connected} onClick={() => act(state.value.light ? 'Light off' : 'Light on', (b) => b.setLight(!state.value.light))}>Light</button>
          <button class={`btn sm ${tune ? 'on' : ''}`} onClick={() => setTune(!tune)}>Adjust</button>
          <button class={`btn sm ${on ? 'on' : ''}`} onClick={() => setOn(!on)}>{on ? 'On' : 'Off'}</button>
        </div>
      </div>
      <div class="cam">
        {url ? <img src={url} alt="Live view of the print" style={{ filter, transform }} onError={onError} onLoad={() => (tries.current = 0)} /> : <div class="msg">{msg}</div>}
      </div>
      {tune && (
        <div style="display:grid;gap:8px">
          <p class="dim small">These adjust the picture as shown here. The printer's camera has no remote exposure setting on this firmware; for a dark image, switch the chamber light on.</p>
          {(['brightness', 'contrast', 'saturation'] as const).map((k) => (
            <label class="field">
              <span class="spread"><span style="text-transform:capitalize">{k}</span><span class="num">{cam[k]}%</span></span>
              <input type="range" min={40} max={250} step={5} value={cam[k]} onInput={(e) => setCam({ [k]: +e.currentTarget.value })} />
            </label>
          ))}
          <div class="row">
            <button class={`btn sm ${cam.rotate ? 'on' : ''}`} onClick={() => setCam({ rotate: !cam.rotate })}>Rotate 180°</button>
            <button class={`btn sm ${cam.mirror ? 'on' : ''}`} onClick={() => setCam({ mirror: !cam.mirror })}>Mirror</button>
            <button class="btn sm" onClick={() => setCam({ brightness: 100, contrast: 100, saturation: 100, rotate: false, mirror: false })}>Reset</button>
          </div>
        </div>
      )}
    </section>
  )
}
