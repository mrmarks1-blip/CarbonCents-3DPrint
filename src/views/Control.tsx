import { useState } from 'preact/hooks'
import { act, adjustZ, ask, backend, conn, setZ, state, zRange } from '../store'
import { ZWheel } from './ZWheel'

export function Control() {
  const s = state.value
  const caps = backend.value?.caps
  const off = conn.value !== 'connected'
  const printing = ['preparing', 'printing', 'pausing', 'paused', 'resuming', 'stopping'].includes(s.phase)
  if (!caps) return <div class="card"><p class="dim">Connect to a printer to use the controls.</p></div>

  return (
    <>
      <section class="card half">
        <h2>Z offset</h2>
        <div class="spread">
          <span class="dim">Current</span>
          <b class="num" style="font-size:1.6rem">{s.zOffset === null ? '—' : `${s.zOffset.toFixed(3)} mm`}</b>
        </div>
        <div class="row">
          {[-0.05, -0.01, 0.01, 0.05].map((d) => (
            <button class="btn grow num" disabled={off || s.zOffset === null} onClick={() => adjustZ(d)}>{d > 0 ? '+' : ''}{d.toFixed(2)}</button>
          ))}
        </div>
        <details class="zw-more" open>
          <summary>Fine tune (wheel or type a value)</summary>
          <ZWheel current={s.zOffset} min={zRange()?.min ?? -0.3} max={zRange()?.max ?? 0.3} disabled={off} onApply={setZ} />
        </details>
        <p class="dim small">Minus moves the nozzle closer to the plate (more squish); plus moves it away. Change in small steps and watch the first layer.</p>
        {caps.zOffset === 'experimental' && (
          <div class="banner small">
            Confirmed to change the offset on OpenCentauri-patched 1.4.49, but the command is undocumented. The app reads the value back after every step and stops with a message if it is not what was asked for.
          </div>
        )}
      </section>

      <section class="card half">
        <h2>Speed{caps.flow ? ' and flow' : ''}</h2>
        {caps.speedPresets ? (
          <div class="row">
            {caps.speedPresets.map((p) => (
              <button class={`btn grow ${s.speedPct === p.pct ? 'on' : ''}`} disabled={off} onClick={() => act(`Speed: ${p.label}`, (b) => b.setSpeed(p.pct))}>
                {p.label}
              </button>
            ))}
          </div>
        ) : (
          <Slider label="Speed" value={s.speedPct} min={50} max={200} unit="%" disabled={off} onSet={(v) => act(`Speed ${v}%`, (b) => b.setSpeed(v))} />
        )}
        {caps.speedPresets && <p class="dim small">This firmware only accepts these four speed modes.</p>}
        {caps.flow && s.flowPct !== null && <Slider label="Flow" value={s.flowPct} min={80} max={120} unit="%" disabled={off} onSet={(v) => act(`Flow ${v}%`, (b) => b.setFlow(v))} />}
      </section>

      <section class="card half">
        <h2>Temperatures</h2>
        <Heat label="Nozzle" now={s.temps.nozzle} target={s.temps.nozzleTarget} max={320} presets={[0, 220, 250, 270]} disabled={off} onSet={(v) => act(`Nozzle to ${v} °C`, (b) => b.setNozzle(v))} />
        <Heat label="Bed" now={s.temps.bed} target={s.temps.bedTarget} max={110} presets={[0, 60, 80, 100]} disabled={off} onSet={(v) => act(`Bed to ${v} °C`, (b) => b.setBed(v))} />
      </section>

      <section class="card half">
        <h2>Fans and light</h2>
        <Slider label="Part cooling" value={s.fans.model} min={0} max={100} unit="%" disabled={off} onSet={(v) => act(`Part fan ${v}%`, (b) => b.setFan('model', v))} />
        <Slider label="Auxiliary" value={s.fans.aux} min={0} max={100} unit="%" disabled={off} onSet={(v) => act(`Auxiliary fan ${v}%`, (b) => b.setFan('aux', v))} />
        <Slider label="Chamber exhaust" value={s.fans.box} min={0} max={100} unit="%" disabled={off} onSet={(v) => act(`Exhaust fan ${v}%`, (b) => b.setFan('box', v))} />
        <button class={`btn ${s.light ? 'on' : ''}`} disabled={off} onClick={() => act(s.light ? 'Light off' : 'Light on', (b) => b.setLight(!s.light))}>
          Chamber light: {s.light ? 'on' : 'off'}
        </button>
      </section>

      <section class="card half">
        <h2>Move</h2>
        {printing ? (
          <p class="dim">Moving and homing are locked while a print is running.</p>
        ) : (
          <>
            <div class="row">
              {(['XYZ', 'X', 'Y', 'Z'] as const).map((a) => (
                <button class="btn grow" disabled={off} onClick={() => act(`Home ${a === 'XYZ' ? 'all' : a}`, (b) => b.home(a))}>Home {a === 'XYZ' ? 'all' : a}</button>
              ))}
            </div>
            <Jog disabled={off} />
          </>
        )}
        {s.pos && <span class="dim small num">Position X {s.pos[0].toFixed(1)} · Y {s.pos[1].toFixed(1)} · Z {s.pos[2].toFixed(2)}</span>}
      </section>

      {caps.estop && (
        <section class="card half">
          <h2>Recovery</h2>
          <div class="row">
            <button class="btn danger grow" disabled={off} onClick={async () => (await ask({ title: 'Emergency stop?', body: 'Emergency stop halts everything immediately, abandons the print and needs a firmware restart afterwards.', ok: 'Emergency stop', danger: true })) && act('Emergency stop', (b) => b.estop())}>Emergency stop</button>
            <button class="btn grow" disabled={off} onClick={() => act('Firmware restart', (b) => b.firmwareRestart())}>Firmware restart</button>
          </div>
        </section>
      )}
    </>
  )
}

function Slider(p: { label: string; value: number; min: number; max: number; unit: string; disabled: boolean; onSet: (v: number) => void }) {
  // Moving the slider only picks a value; nothing is sent until Set is tapped, so a
  // stray touch while scrolling cannot change the printer.
  const [pend, setPend] = useState<number | null>(null)
  const [sent, setSent] = useState<number | null>(null)
  const v = pend ?? sent ?? p.value
  const changed = pend !== null && pend !== p.value
  return (
    <div class="field">
      <span class="spread"><span>{p.label}</span><b class="num" style={`color:${changed ? 'var(--accent)' : 'var(--text)'}`}>{Math.round(v)}{p.unit}</b></span>
      <input
        type="range" aria-label={p.label} min={p.min} max={p.max} step={5} value={v} disabled={p.disabled}
        onInput={(e) => setPend(+e.currentTarget.value)}
      />
      {changed && (
        <div class="row tight">
          <button class="btn sm primary grow" disabled={p.disabled} onClick={() => {
            p.onSet(pend)
            setSent(pend)
            setPend(null)
            setTimeout(() => setSent(null), 2500) // hold the thumb until the printer reports back
          }}>Set {p.label.toLowerCase()} to {pend}{p.unit}</button>
          <button class="btn sm" onClick={() => setPend(null)}>Cancel</button>
        </div>
      )}
    </div>
  )
}

function Heat(p: { label: string; now: number; target: number; max: number; presets: number[]; disabled: boolean; onSet: (v: number) => void }) {
  const [val, setVal] = useState('')
  const n = Number(val)
  const valid = val !== '' && n >= 0 && n <= p.max
  return (
    <div style="display:grid;gap:8px">
      <div class="spread"><span class="dim">{p.label}</span><span class="num"><b>{p.now.toFixed(0)}</b> / {p.target} °C</span></div>
      <div class="row tight">
        {p.presets.map((t) => (
          <button class={`btn sm grow ${p.target === t ? 'on' : ''}`} disabled={p.disabled} onClick={() => p.onSet(t)}>{t === 0 ? 'Off' : `${t}°`}</button>
        ))}
      </div>
      <div class="row tight">
        <input class="grow" type="number" inputMode="numeric" min={0} max={p.max} placeholder={`Custom, up to ${p.max} °C`} value={val} onInput={(e) => setVal(e.currentTarget.value)} />
        <button class="btn" disabled={p.disabled || !valid} onClick={() => (p.onSet(n), setVal(''))}>Set</button>
      </div>
    </div>
  )
}

function Jog({ disabled }: { disabled: boolean }) {
  const [step, setStep] = useState(10)
  const go = (axis: 'X' | 'Y' | 'Z', dir: number) => act(`Move ${axis} ${dir * step > 0 ? '+' : ''}${dir * step} mm`, (b) => b.jog(axis, dir * step))
  const B = ({ a, d, t }: { a: 'X' | 'Y' | 'Z'; d: number; t: string }) => <button class="btn" disabled={disabled} onClick={() => go(a, d)}>{t}</button>
  return (
    <>
      <div class="row tight">
        <span class="dim">Step</span>
        {[1, 10, 30].map((v) => <button class={`btn sm ${step === v ? 'on' : ''}`} onClick={() => setStep(v)}>{v} mm</button>)}
      </div>
      <div class="row" style="justify-content:space-around">
        <div class="pad">
          <span /><B a="Y" d={1} t="Y+" /><span />
          <B a="X" d={-1} t="X−" /><span /><B a="X" d={1} t="X+" />
          <span /><B a="Y" d={-1} t="Y−" /><span />
        </div>
        <div style="display:grid;gap:6px;width:72px">
          <B a="Z" d={1} t="Z+" />
          <B a="Z" d={-1} t="Z−" />
        </div>
      </div>
      <p class="dim small">Home first: the printer does not check limits on an unhomed axis.</p>
    </>
  )
}
