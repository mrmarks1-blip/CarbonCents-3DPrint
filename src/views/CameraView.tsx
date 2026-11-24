import { signal } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import { attachCamera, camLive, camMsg, camOn, cameraElement, restartCamera } from '../features/camera'
import { act, conn, settings, state, type Settings } from '../store'

// ---- Zoom -----------------------------------------------------------------
// One zoom shared by every view, so moving the picture keeps what you were
// looking at. Translation is a fraction of the view's size, which keeps it
// correct when the same zoom is shown at a different size.
//
// Predictable by design: the point under your fingers stays under your fingers
// while pinching, a double tap zooms to 3x exactly where you tapped (and back
// to 1x), and + / − step by 1.5x around the centre. Up to 12x: far past the
// camera's real detail, which is still useful for spotting a strand of spaghetti.
export const MAX_ZOOM = 12
const zoom = signal({ s: 1, x: 0, y: 0 })

const clampS = (s: number) => Math.min(MAX_ZOOM, Math.max(1, s))
function clamped(s: number, x: number, y: number) {
  s = clampS(s)
  return { s, x: Math.min(0, Math.max(1 - s, x)), y: Math.min(0, Math.max(1 - s, y)) }
}
/** Zoom to scale `s` keeping the point (px, py) (fractions of the view) fixed. */
export function zoomAt(s: number, px: number, py: number) {
  const z = zoom.value
  const k = clampS(s) / z.s
  zoom.value = clamped(z.s * k, px - (px - z.x) * k, py - (py - z.y) * k)
}
export const resetZoom = () => (zoom.value = { s: 1, x: 0, y: 0 })

type Pt = { x: number; y: number }

/** The live picture with zoom gestures. Put it anywhere; it borrows the one shared stream. */
export function CameraStage({ compact = false }: { compact?: boolean }) {
  const view = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const cam = settings.value.cam
  const z = zoom.value

  useEffect(() => attachCamera(stage.current!), [])

  const img = cameraElement()
  img.style.filter = `brightness(${cam.brightness}%) contrast(${cam.contrast}%) saturate(${cam.saturation}%)`
  img.style.transform = `${cam.rotate ? 'rotate(180deg)' : ''} ${cam.mirror ? 'scaleX(-1)' : ''}`

  // Gestures. Pointer positions are kept as fractions of the view.
  useEffect(() => {
    const el = view.current!
    const pts = new Map<number, Pt>()
    let pinch: { d: number; m: Pt; z: { s: number; x: number; y: number } } | null = null
    let pan: { p: Pt; z: { s: number; x: number; y: number } } | null = null
    let lastTap = { t: 0, p: { x: 0, y: 0 } }
    let downAt = { t: 0, p: { x: 0, y: 0 }, moved: false }
    const rel = (e: { clientX: number; clientY: number }): Pt => {
      const r = el.getBoundingClientRect()
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
    }
    const aspect = () => el.clientWidth / Math.max(1, el.clientHeight)
    const dist = (a: Pt, b: Pt) => Math.hypot((a.x - b.x) * aspect(), a.y - b.y)
    const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    const begin = () => {
      const [a, b] = [...pts.values()]
      if (a && b) {
        pinch = { d: Math.max(0.01, dist(a, b)), m: mid(a, b), z: zoom.value }
        pan = null
      } else if (a) {
        pinch = null
        pan = { p: a, z: zoom.value }
      }
    }
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('button')) return
      const p = rel(e)
      pts.set(e.pointerId, p)
      if (pts.size === 1) downAt = { t: Date.now(), p, moved: false }
      // Capture only when we will use the gesture, so a plain drag at 1x still scrolls the page.
      if (pts.size > 1 || zoom.value.s > 1) el.setPointerCapture?.(e.pointerId)
      begin()
    }
    const move = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return
      const p = rel(e)
      pts.set(e.pointerId, p)
      if (Math.hypot(p.x - downAt.p.x, p.y - downAt.p.y) > 0.03) downAt.moved = true
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()]
        const m = mid(a, b)
        const s = clampS(pinch.z.s * (dist(a, b) / pinch.d))
        // The picture point that was under the fingers' midpoint stays under it.
        const cx = (pinch.m.x - pinch.z.x) / pinch.z.s
        const cy = (pinch.m.y - pinch.z.y) / pinch.z.s
        zoom.value = clamped(s, m.x - cx * s, m.y - cy * s)
        e.preventDefault()
      } else if (pan && pan.z.s > 1) {
        zoom.value = clamped(pan.z.s, pan.z.x + (p.x - pan.p.x), pan.z.y + (p.y - pan.p.y))
        e.preventDefault()
      }
    }
    const up = (e: PointerEvent) => {
      if (!pts.delete(e.pointerId)) return
      if (e.type === 'pointerup' && pts.size === 0 && !downAt.moved && Date.now() - downAt.t < 300) {
        const p = rel(e)
        if (Date.now() - lastTap.t < 320 && Math.hypot(p.x - lastTap.p.x, p.y - lastTap.p.y) < 0.08) {
          if (zoom.value.s > 1.05) resetZoom()
          else zoomAt(3, p.x, p.y)
          lastTap = { t: 0, p }
        } else lastTap = { t: Date.now(), p }
      }
      begin()
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const p = rel(e)
      zoomAt(zoom.value.s * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), p.x, p.y)
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('wheel', wheel)
    }
  }, [])

  const zoomed = z.s > 1.001
  return (
    <div class={`cam ${compact ? 'compact' : ''}`} ref={view} style={{ touchAction: zoomed ? 'none' : 'pan-y' }}>
      <div class="cam-stage" ref={stage} style={{ transform: `translate(${z.x * 100}%, ${z.y * 100}%) scale(${z.s})` }} />
      {!camLive.value && (
        <div class="msg">
          {camMsg.value}
          {camOn.value && conn.value === 'connected' && /fail|dropped|limit|did not answer/i.test(camMsg.value) && (
            <div><button class="btn sm" onClick={restartCamera}>Retry</button></div>
          )}
        </div>
      )}
      {camLive.value && (
        <div class="zoom-ui" aria-label="Zoom">
          {zoomed && <button class="zbtn wide" onClick={resetZoom} title="Back to 1x">{z.s.toFixed(1)}× ↺</button>}
          {(zoomed || !compact) && <button class="zbtn" onClick={() => zoomAt(z.s / 1.5, 0.5, 0.5)} disabled={!zoomed} aria-label="Zoom out">−</button>}
          <button class="zbtn" onClick={() => zoomAt(z.s * 1.5, 0.5, 0.5)} disabled={z.s >= MAX_ZOOM} aria-label="Zoom in">+</button>
        </div>
      )}
    </div>
  )
}

// ---- Where the camera lives ----------------------------------------------

const VIEWS: [Settings['camView'], string][] = [
  ['card', 'Here'],
  ['pip', 'Float'],
  ['top', 'Pin top'],
  ['bottom', 'Pin bottom'],
]
export const setCamView = (v: Settings['camView']) => (settings.value = { ...settings.value, camView: v })

function LightButton() {
  const connected = conn.value === 'connected'
  return (
    <button class={`btn sm ${state.value.light ? 'on' : ''}`} disabled={!connected} onClick={() => act(state.value.light ? 'Light off' : 'Light on', (b) => b.setLight(!state.value.light))}>
      Light
    </button>
  )
}

/** The Camera card on the Status tab. */
export function CameraCard() {
  const [tune, setTune] = useState(false)
  const cam = settings.value.cam
  const where = settings.value.camView
  const setCam = (patch: Partial<typeof cam>) => (settings.value = { ...settings.value, cam: { ...cam, ...patch } })

  return (
    <section class="card wide">
      <div class="spread">
        <h2>Camera</h2>
        <div class="row tight">
          <LightButton />
          <button class={`btn sm ${tune ? 'on' : ''}`} onClick={() => setTune(!tune)}>Adjust</button>
          <button class={`btn sm ${camOn.value ? 'on' : ''}`} onClick={() => (camOn.value = !camOn.value)}>{camOn.value ? 'On' : 'Off'}</button>
        </div>
      </div>
      <div class="seg" role="group" aria-label="Where to show the camera">
        {VIEWS.map(([v, label]) => (
          <button class={where === v ? 'on' : ''} aria-pressed={where === v} onClick={() => setCamView(v)}>{label}</button>
        ))}
      </div>
      {where === 'card' ? (
        <CameraStage />
      ) : (
        <p class="dim small">
          {where === 'pip' ? 'The camera is in the floating player, on every tab. Drag it by its top bar to any corner.' : `The camera is pinned to the ${where} of every tab.`}
        </p>
      )}
      {tune && (
        <div style="display:grid;gap:8px">
          <p class="dim small">Pinch, double-tap or use + and − to zoom (up to {MAX_ZOOM}×); drag to look around while zoomed. These adjust the picture as shown here only. The printer's camera has no remote exposure setting on this firmware; for a dark image, switch the chamber light on.</p>
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

const pipBig = signal(false)

/** Floating player, like the mini player in video apps. Drag the bar; it snaps to the nearest corner. */
export function FloatingCamera() {
  const box = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const corner = settings.value.pipCorner

  const onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    const bar = e.currentTarget as HTMLElement // read now: it is null once the event has been handled
    const r = box.current!.getBoundingClientRect()
    const off = { x: e.clientX - r.left, y: e.clientY - r.top }
    bar.setPointerCapture?.(e.pointerId)
    const move = (m: PointerEvent) => setDrag({ x: m.clientX - off.x, y: m.clientY - off.y })
    const end = (m: PointerEvent) => {
      bar.removeEventListener('pointermove', move)
      bar.removeEventListener('pointerup', end)
      bar.removeEventListener('pointercancel', end)
      const cx = m.clientX - off.x + r.width / 2
      const cy = m.clientY - off.y + r.height / 2
      const c = `${cy < innerHeight / 2 ? 't' : 'b'}${cx < innerWidth / 2 ? 'l' : 'r'}` as Settings['pipCorner']
      settings.value = { ...settings.value, pipCorner: c }
      setDrag(null)
    }
    bar.addEventListener('pointermove', move)
    bar.addEventListener('pointerup', end)
    bar.addEventListener('pointercancel', end)
  }

  return (
    <div ref={box} class={`pip ${corner} ${pipBig.value ? 'big' : ''} ${drag ? 'dragging' : ''}`} style={drag ? { left: `${drag.x}px`, top: `${drag.y}px`, right: 'auto', bottom: 'auto' } : undefined}>
      <div class="pip-bar" onPointerDown={onDown}>
        <span class="grip" aria-hidden="true" />
        <button class="zbtn" onClick={() => (camOn.value = !camOn.value)} aria-label={camOn.value ? 'Camera off' : 'Camera on'}>{camOn.value ? '■' : '▶'}</button>
        <button class="zbtn" onClick={() => (pipBig.value = !pipBig.value)} aria-label={pipBig.value ? 'Smaller' : 'Bigger'}>{pipBig.value ? '⤡' : '⤢'}</button>
        <button class="zbtn" onClick={() => setCamView('card')} aria-label="Close the floating player">✕</button>
      </div>
      <CameraStage compact />
    </div>
  )
}

/** Camera pinned to the top (inside the header) or bottom (above the tab bar). */
export function PinnedCamera({ where }: { where: 'top' | 'bottom' }) {
  return (
    <div class={`pinned at-${where}`}>
      <CameraStage compact />
      <div class="pin-tools">
        <button class="zbtn" onClick={() => setCamView(where === 'top' ? 'bottom' : 'top')} aria-label={`Move to the ${where === 'top' ? 'bottom' : 'top'}`}>{where === 'top' ? '↓' : '↑'}</button>
        <button class="zbtn" onClick={() => setCamView('pip')} aria-label="Float">⧉</button>
        <button class="zbtn" onClick={() => setCamView('card')} aria-label="Unpin">✕</button>
      </div>
    </div>
  )
}
