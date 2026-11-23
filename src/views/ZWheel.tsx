import { useEffect, useRef, useState } from 'preact/hooks'

// A date-picker style wheel for the Z offset. Values are whole micrometres (integers)
// internally so repeated steps never collect float noise. Larger values sit lower on the
// wheel, so swiping up raises the offset (nozzle further from the plate), like scrolling a list.

const ROW = 40 // px per row
const VISIBLE = 5 // rows shown (odd, so one is in the middle)
export const Z_STEPS = [0.001, 0.005, 0.01] as const

type Props = {
  current: number | null
  min: number
  max: number
  disabled: boolean
  onApply: (target: number) => unknown
}

const um = (mm: number) => Math.round(mm * 1000)
const fmt = (u: number) => `${u > 0 ? '+' : u < 0 ? '−' : ''}${(Math.abs(u) / 1000).toFixed(3)}`

export function ZWheel(p: Props) {
  const [stepMm, setStepMm] = useState<number>(Z_STEPS[0])
  const step = um(stepMm)
  const lo = um(p.min), hi = um(p.max)
  const cur = p.current === null ? null : um(p.current)
  // null = follow the printer's value; a number = the value picked but not yet sent
  const [picked, setPicked] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [drag, setDrag] = useState(0) // live pixel offset while dragging / gliding
  const target = picked ?? cur ?? 0
  const clamp = (u: number) => Math.min(hi, Math.max(lo, u))

  const g = useRef({ y: 0, start: 0, t: 0, v: 0, base: 0, raf: 0, down: false, lastTick: 0 })

  const tick = (n: number) => {
    if (n !== g.current.lastTick) {
      g.current.lastTick = n
      try { navigator.vibrate?.(4) } catch { /* not supported */ }
    }
  }
  const move = (steps: number) => {
    if (p.disabled || cur === null) return
    setPicked((v) => clamp((v ?? cur) + steps * step))
  }

  // pointer drag with momentum
  const onDown = (e: PointerEvent) => {
    if (p.disabled || cur === null) return
    cancelAnimationFrame(g.current.raf)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    Object.assign(g.current, { down: true, y: e.clientY, start: e.clientY, t: performance.now(), v: 0, base: target, lastTick: 0 })
  }
  const offsetToValue = (dy: number) => clamp(g.current.base + Math.round(-dy / ROW) * step)
  const onMove = (e: PointerEvent) => {
    if (!g.current.down) return
    const now = performance.now()
    const dt = Math.max(1, now - g.current.t)
    g.current.v = 0.8 * ((e.clientY - g.current.y) / dt) + 0.2 * g.current.v
    g.current.y = e.clientY
    g.current.t = now
    const dy = e.clientY - g.current.start
    const v = offsetToValue(dy)
    tick(v)
    setPicked(v)
    // the residual pixel offset inside one row gives the smooth feel; stop at the ends
    const r = dy + ((v - g.current.base) / step) * ROW
    setDrag((v === lo && r > 0) || (v === hi && r < 0) ? r * 0.25 : r)
  }
  const onUp = () => {
    if (!g.current.down) return
    g.current.down = false
    let vel = g.current.v * 16 // px per frame
    let dy = g.current.y - g.current.start
    // no glide if the finger rested before lifting
    if (performance.now() - g.current.t > 80 || Math.abs(vel) < 0.5) { setDrag(0); return }
    const glide = () => {
      vel *= 0.93
      dy += vel
      const v = offsetToValue(dy)
      tick(v)
      setPicked(v)
      if (Math.abs(vel) < 0.4 || v === lo || v === hi) { setDrag(0); return }
      setDrag(dy + ((v - g.current.base) / step) * ROW)
      g.current.raf = requestAnimationFrame(glide)
    }
    g.current.raf = requestAnimationFrame(glide)
  }
  useEffect(() => () => cancelAnimationFrame(g.current.raf), [])

  // mouse / trackpad wheel: one notch = one step
  const acc = useRef(0)
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    acc.current += e.deltaY
    const n = Math.trunc(acc.current / 40)
    if (n) { acc.current -= n * 40; move(n) }
  }
  const onKey = (e: KeyboardEvent) => {
    const k: Record<string, number> = { ArrowUp: 1, ArrowDown: -1, PageUp: 10, PageDown: -10 }
    if (k[e.key]) { e.preventDefault(); move(k[e.key]) }
    if (e.key === 'Enter' && picked !== null) apply()
  }

  const typed = text.trim().replace(',', '.').replace('−', '-')
  const typedU = typed === '' || isNaN(Number(typed)) ? null : um(Number(typed))
  const typedOk = typedU !== null && typedU >= lo && typedU <= hi
  const useTyped = () => {
    if (!typedOk || typedU === null) return
    setPicked(typedU)
    setText('')
  }

  const delta = cur === null ? 0 : target - cur
  const apply = async () => {
    if (cur === null || delta === 0 || busy) return
    if (Math.abs(delta) > 100 && !confirm(`Change the Z offset by ${fmt(delta)} mm in one go? That is a big step: on a running print the nozzle moves at once.`)) return
    setBusy(true)
    try {
      await p.onApply(target / 1000)
    } finally {
      setBusy(false)
      setPicked(null)
    }
  }

  // rows around the target
  const half = Math.floor(VISIBLE / 2) + 1
  const rows = []
  for (let i = -half; i <= half; i++) {
    const u = target + i * step
    if (u < lo || u > hi) { rows.push(<div class="zw-row" />); continue }
    const d = Math.abs(i * ROW + drag) / ROW
    rows.push(
      <div class={`zw-row num ${i === 0 ? 'mid' : ''} ${u === cur ? 'now' : ''}`} style={`opacity:${Math.max(0.15, 1 - d * 0.3)};transform:scale(${Math.max(0.78, 1 - d * 0.07)})`}>
        {fmt(u)}
      </div>,
    )
  }

  return (
    <div class="zw" aria-disabled={p.disabled || cur === null}>
      <div class="row tight">
        <span class="dim small">Wheel step</span>
        {Z_STEPS.map((s) => (
          <button class={`btn sm ${stepMm === s ? 'on' : ''}`} onClick={() => setStepMm(s)}>{s.toFixed(3)}</button>
        ))}
      </div>

      <div
        class="zw-wheel"
        role="spinbutton"
        tabIndex={0}
        aria-label="Z offset, millimetres"
        aria-valuemin={p.min}
        aria-valuemax={p.max}
        aria-valuenow={target / 1000}
        aria-valuetext={`${fmt(target)} mm`}
        style={`height:${ROW * VISIBLE}px`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onWheel={onWheel}
        onKeyDown={onKey}
      >
        <div class="zw-band" style={`top:${ROW * Math.floor(VISIBLE / 2)}px;height:${ROW}px`} />
        <div class="zw-rows" style={`transform:translateY(${drag - ROW}px)`}>{rows}</div>
        <span class="zw-unit dim">mm</span>
      </div>

      <div class="spread small">
        <span class="dim">Allowed {fmt(lo)} to {fmt(hi)} mm</span>
        <span class="num" style={`color:${delta ? 'var(--accent)' : 'var(--dim)'}`}>{delta ? `change ${fmt(delta)} mm` : 'no change'}</span>
      </div>

      <div class="row tight">
        <input
          class="grow num" type="text" inputMode="decimal" placeholder="Type a value, e.g. -0.035"
          value={text} disabled={p.disabled || cur === null}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && useTyped()}
        />
        <button class="btn" disabled={p.disabled || !typedOk} onClick={useTyped}>Use</button>
      </div>
      {typed !== '' && !typedOk && <span class="small" style="color:var(--bad)">Enter a number between {fmt(lo)} and {fmt(hi)}.</span>}

      <div class="row tight">
        <button class="btn grow" disabled={picked === null || busy} onClick={() => setPicked(null)}>Reset</button>
        <button class="btn primary grow" disabled={p.disabled || cur === null || delta === 0 || busy} onClick={apply}>
          {busy ? 'Sending…' : delta ? `Apply ${fmt(target)} mm` : 'Apply'}
        </button>
      </div>
    </div>
  )
}
