import { signal } from '@preact/signals'
import { useEffect, useRef, useState } from 'preact/hooks'
import { attachCamera, camLive, camMsg, camOn, cameraElement, restartCamera } from '../features/camera'
import { act, conn, settings, state, type Settings } from '../store'
import { FilamentDot, filamentCss } from './Filament'

// ---- Zoom: Instagram-style full-screen viewer -----------------------------
// Pinch (or double-tap, or +, or the mouse wheel) lifts the picture out of
// wherever it is shown and zooms it over the whole screen. It stays zoomed when
// you let go, so you can look around with one finger; pinch back below about
// 1.1x, double-tap, or tap ✕ and it drops back into place.
//
// Predictable by design: the point under your fingers stays under your fingers,
// and + / − step by 1.5x around the middle of the screen. Up to 12x: far past
// the camera's real detail, which is still useful for spotting a strand of spaghetti.
export const MAX_ZOOM = 12
const MIN_LIVE = 0.7 // allowed while pinching, so zooming out to close feels natural
const CLOSE_BELOW = 1.12
type Rect = { l: number; t: number; w: number; h: number }
type Z = { open: boolean; base: Rect; s: number; x: number; y: number; anim: boolean }
/** Image box on screen = base rect, scaled by s from its top-left, then moved by (x, y) px. */
export const zv = signal<Z>({ open: false, base: { l: 0, t: 0, w: 1, h: 1 }, s: 1, x: 0, y: 0, anim: false })
const put = (p: Partial<Z>) => (zv.value = { ...zv.value, ...p })
let animTimer = 0

function openFrom(el: HTMLElement) {
  const r = el.getBoundingClientRect()
  clearTimeout(animTimer)
  put({ open: true, base: { l: r.left, t: r.top, w: r.width, h: r.height }, s: 1, x: 0, y: 0, anim: false })
}
/** Scale to `s` keeping screen point (px, py) fixed. */
function scaledAt(s: number, px: number, py: number, min = 1) {
  const z = zv.value
  const s2 = Math.min(MAX_ZOOM, Math.max(min, s))
  const cx = (px - z.base.l - z.x) / z.s
  const cy = (py - z.base.t - z.y) / z.s
  return { s: s2, x: px - z.base.l - cx * s2, y: py - z.base.t - cy * s2 }
}
/** Where the picture should rest: centred on an axis where it is smaller than the screen, edge to edge where it is bigger. */
function rest(s: number, x: number, y: number) {
  const { base } = zv.value
  const fit = (start: number, size: number, screen: number) => (size <= screen ? (screen - size) / 2 : Math.min(0, Math.max(screen - size, start)))
  return { s, x: fit(base.l + x, base.w * s, innerWidth) - base.l, y: fit(base.t + y, base.h * s, innerHeight) - base.t }
}
function animate(p: Partial<Z>, then?: () => void) {
  clearTimeout(animTimer)
  put({ ...p, anim: true })
  animTimer = window.setTimeout(() => (then ? then() : put({ anim: false })), 240)
}
export function closeZoom() {
  if (!zv.value.open) return
  animate({ s: 1, x: 0, y: 0 }, () => put({ open: false, anim: false }))
}
function settle() {
  const z = zv.value
  if (!z.open) return
  if (z.s < CLOSE_BELOW) return closeZoom()
  animate(rest(z.s, z.x, z.y))
}
export function zoomBy(k: number) {
  const z = zv.value
  const t = scaledAt(z.s * k, innerWidth / 2, innerHeight / 2)
  if (t.s < CLOSE_BELOW) return closeZoom()
  animate(rest(t.s, t.x, t.y))
}

type Pt = { x: number; y: number }
export interface DragHandlers {
  start(p: Pt): void
  move(p: Pt): void
  end(): void
}

/**
 * Pointer gestures for a picture. On a picture in the page, two fingers open
 * the viewer and zoom; one finger is left to the page (or to `drag`, for the
 * floating player). Inside the viewer, one finger pans.
 */
function useGestures(ref: { current: HTMLElement | null }, opts: { viewer?: boolean; drag?: DragHandlers }) {
  const o = useRef(opts)
  o.current = opts
  useEffect(() => {
    const el = ref.current!
    const pts = new Map<number, Pt>()
    let pinch: { d: number; m: Pt; z: Z } | null = null
    let pan: { p: Pt; z: Z } | null = null
    let dragging = false
    let gestured = false
    let lastTap = { t: 0, p: { x: 0, y: 0 } }
    let downAt = { t: 0, p: { x: 0, y: 0 }, moved: false }
    const pt = (e: { clientX: number; clientY: number }) => ({ x: e.clientX, y: e.clientY })
    const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
    const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    const begin = () => {
      const [a, b] = [...pts.values()]
      pinch = pan = null
      if (a && b) {
        if (dragging) (dragging = false), o.current.drag?.end()
        if (!zv.value.open) openFrom(el)
        pinch = { d: Math.max(10, dist(a, b)), m: mid(a, b), z: zv.value }
      } else if (a && zv.value.open) pan = { p: a, z: zv.value }
    }
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('button, input, label')) return
      const p = pt(e)
      pts.set(e.pointerId, p)
      if (pts.size === 1) {
        downAt = { t: Date.now(), p, moved: false }
        gestured = false
        if (o.current.drag && !zv.value.open) {
          dragging = true
          o.current.drag.start(p)
        }
      }
      if (o.current.viewer || o.current.drag || pts.size > 1) el.setPointerCapture?.(e.pointerId)
      begin()
    }
    const move = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return
      const p = pt(e)
      pts.set(e.pointerId, p)
      if (dist(p, downAt.p) > 8) downAt.moved = true
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()]
        const m = mid(a, b)
        const s = pinch.z.s * (dist(a, b) / pinch.d)
        // The picture point that was under the fingers' midpoint stays under it.
        const cx = (pinch.m.x - pinch.z.base.l - pinch.z.x) / pinch.z.s
        const cy = (pinch.m.y - pinch.z.base.t - pinch.z.y) / pinch.z.s
        const s2 = Math.min(MAX_ZOOM, Math.max(MIN_LIVE, s))
        put({ s: s2, x: m.x - pinch.z.base.l - cx * s2, y: m.y - pinch.z.base.t - cy * s2, anim: false })
        gestured = true
        e.preventDefault()
      } else if (pan) {
        put({ x: pan.z.x + p.x - pan.p.x, y: pan.z.y + p.y - pan.p.y, anim: false })
        gestured = true
        e.preventDefault()
      } else if (dragging) {
        o.current.drag!.move(p)
        e.preventDefault()
      }
    }
    const up = (e: PointerEvent) => {
      if (!pts.delete(e.pointerId)) return
      if (pts.size === 0) {
        if (dragging) (dragging = false), o.current.drag!.end()
        if (e.type === 'pointerup' && !downAt.moved && Date.now() - downAt.t < 300) {
          const p = pt(e)
          if (Date.now() - lastTap.t < 320 && dist(p, lastTap.p) < 30) {
            lastTap = { t: 0, p }
            if (zv.value.open) closeZoom()
            else {
              openFrom(el)
              const t = scaledAt(3, p.x, p.y)
              animate(rest(t.s, t.x, t.y))
            }
            return
          }
          lastTap = { t: Date.now(), p }
        }
        if (gestured) settle()
      }
      begin()
    }
    let wheelTimer = 0
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      if (!zv.value.open) openFrom(el)
      put({ ...scaledAt(zv.value.s * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), e.clientX, e.clientY, MIN_LIVE), anim: false })
      clearTimeout(wheelTimer)
      wheelTimer = window.setTimeout(settle, 350)
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
}

/** The live picture. Put it anywhere; it borrows the one shared stream. */
export function CameraStage({ compact = false, drag }: { compact?: boolean; drag?: DragHandlers }) {
  const view = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const cam = settings.value.cam

  useEffect(() => attachCamera(stage.current!), [])
  useGestures(view, { drag })

  const img = cameraElement()
  img.style.filter = `${filamentCss()}brightness(${cam.brightness}%) contrast(${cam.contrast}%) saturate(${cam.saturation}%)`
  img.style.transform = `${cam.rotate ? 'rotate(180deg)' : ''} ${cam.mirror ? 'scaleX(-1)' : ''}`

  return (
    <div class={`cam ${compact ? 'compact' : ''}`} ref={view} style={{ touchAction: drag ? 'none' : 'pan-y' }}>
      <div class="cam-stage" ref={stage} />
      {!camLive.value && (
        <div class="msg">
          {camMsg.value}
          {camOn.value && conn.value === 'connected' && /fail|dropped|limit|did not answer/i.test(camMsg.value) && (
            <div><button class="btn sm" onClick={restartCamera}>Retry</button></div>
          )}
        </div>
      )}
      {camLive.value && <FilamentDot from={() => view.current} />}
      {camLive.value && !compact && (
        <div class="zoom-ui">
          <button
            class="zbtn"
            aria-label="Zoom in"
            onClick={() => {
              openFrom(view.current!)
              const t = scaledAt(2, innerWidth / 2, innerHeight / 2)
              animate(rest(t.s, t.x, t.y))
            }}
          >+</button>
        </div>
      )}
    </div>
  )
}

/** The full-screen zoom viewer. Rendered once at app level; shows while zoomed. */
export function ZoomViewer() {
  return zv.value.open ? <ZoomViewerOpen /> : null
}
function ZoomViewerOpen() {
  const root = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  useEffect(() => attachCamera(stage.current!), [])
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && closeZoom()
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [])
  useGestures(root, { viewer: true })
  const z = zv.value
  const dim = Math.min(0.94, Math.max(0, (z.s - 1) * 3))
  return (
    <div class={`zv ${z.anim ? 'anim' : ''}`} ref={root} style={{ background: `rgba(0,0,0,${dim})` }} role="dialog" aria-label="Zoomed camera">
      <div class="zv-pic" style={{ left: `${z.base.l}px`, top: `${z.base.t}px`, width: `${z.base.w}px`, height: `${z.base.h}px`, transform: `translate(${z.x}px, ${z.y}px) scale(${z.s})` }}>
        <div class="cam-stage" ref={stage} />
      </div>
      <div class="zv-top" style={{ opacity: dim > 0.5 ? 1 : 0 }}>
        <button class="zbtn" onClick={closeZoom} aria-label="Close zoom">✕</button>
      </div>
      <div class="zv-bottom" style={{ opacity: dim > 0.5 ? 1 : 0 }}>
        <button class="zbtn" onClick={() => zoomBy(1 / 1.5)} aria-label="Zoom out">−</button>
        <span class="zbtn wide" aria-live="polite">{z.s.toFixed(1)}×</span>
        <button class="zbtn" onClick={() => zoomBy(1.5)} disabled={z.s >= MAX_ZOOM} aria-label="Zoom in">+</button>
      </div>
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
          {where === 'pip' ? 'The camera is in the floating player, on every tab. Drag it anywhere; fling it to send it across the screen.' : `The camera is pinned to the ${where} of every tab.`}
        </p>
      )}
      {tune && (
        <div style="display:grid;gap:8px">
          <p class="dim small">Tap the colour dot on the picture to tune it for your filament colour. Pinch, double-tap or tap + to zoom to full screen (up to {MAX_ZOOM}×) and drag to look around; pinch back or double-tap to return. These adjust the picture as shown here only. The printer's camera has no remote exposure setting on this firmware; for a dark image, switch the chamber light on.</p>
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

/**
 * Floating player. Drag it from anywhere on the picture and it stays exactly
 * where you let go; fling it and it glides, slowing down, and stops at the
 * screen edge. Pinch or double-tap it to zoom.
 */
export function FloatingCamera() {
  const size = () => {
    const w = pipBig.value ? Math.min(innerWidth * 0.86, 560) : Math.min(innerWidth * 0.46, 320)
    return { w, h: (w * 9) / 16 }
  }
  const clampPos = (x: number, y: number) => {
    const { w, h } = size()
    return { x: Math.min(innerWidth - w, Math.max(0, x)), y: Math.min(innerHeight - h, Math.max(0, y)) }
  }
  const fromSaved = () => {
    const { w, h } = size()
    const p = settings.value.pipPos
    return p ? clampPos(p.cx * innerWidth - w / 2, p.cy * innerHeight - h / 2) : clampPos(innerWidth - w - 10, innerHeight - h - 84)
  }
  const [pos, setPos] = useState(fromSaved)
  const live = useRef(pos)
  live.current = pos
  const fling = useRef(0)

  const save = (p: { x: number; y: number }) => {
    const { w, h } = size()
    settings.value = { ...settings.value, pipPos: { cx: (p.x + w / 2) / innerWidth, cy: (p.y + h / 2) / innerHeight } }
  }
  // Keep it on screen after rotating the phone or resizing it.
  useEffect(() => {
    const fix = () => setPos(fromSaved())
    addEventListener('resize', fix)
    return () => removeEventListener('resize', fix)
  }, [])
  useEffect(() => setPos((p) => clampPos(p.x, p.y)), [pipBig.value])

  const drag = useRef<DragHandlers | null>(null)
  if (!drag.current) {
    let off = { x: 0, y: 0 }
    let trail: { t: number; x: number; y: number }[] = []
    drag.current = {
      start(p) {
        cancelAnimationFrame(fling.current)
        off = { x: p.x - live.current.x, y: p.y - live.current.y }
        trail = [{ t: performance.now(), ...live.current }]
      },
      move(p) {
        const next = clampPos(p.x - off.x, p.y - off.y)
        trail.push({ t: performance.now(), ...next })
        if (trail.length > 8) trail.shift()
        setPos(next)
      },
      end() {
        const now = performance.now()
        const recent = trail.filter((s) => now - s.t < 100)
        const a = recent[0]
        const b = recent[recent.length - 1]
        let vx = a && b && b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0 // px per ms
        let vy = a && b && b.t > a.t ? (b.y - a.y) / (b.t - a.t) : 0
        if (Math.hypot(vx, vy) < 0.35) return save(live.current) // placed, not flung: stays exactly here
        const speed = Math.hypot(vx, vy)
        if (speed > 4) (vx *= 4 / speed), (vy *= 4 / speed) // cap, so a hard flick stays controllable
        let last = now
        const step = (t: number) => {
          const dt = Math.min(32, t - last)
          last = t
          const { w, h } = size()
          let x = live.current.x + vx * dt
          let y = live.current.y + vy * dt
          // Stop dead at a screen edge (that axis only), never bounce back.
          if (x <= 0 || x >= innerWidth - w) (vx = 0), (x = Math.min(innerWidth - w, Math.max(0, x)))
          if (y <= 0 || y >= innerHeight - h) (vy = 0), (y = Math.min(innerHeight - h, Math.max(0, y)))
          const f = Math.pow(0.996, dt) // friction
          vx *= f
          vy *= f
          live.current = { x, y }
          setPos({ x, y })
          if (Math.hypot(vx, vy) > 0.02) fling.current = requestAnimationFrame(step)
          else save({ x, y })
        }
        fling.current = requestAnimationFrame(step)
      },
    }
  }
  useEffect(() => () => cancelAnimationFrame(fling.current), [])

  const { w } = size()
  return (
    <div class="pip" style={{ left: `${pos.x}px`, top: `${pos.y}px`, width: `${w}px` }}>
      <CameraStage compact drag={drag.current!} />
      <div class="pip-tools">
        <button class="zbtn" onClick={() => (camOn.value = !camOn.value)} aria-label={camOn.value ? 'Camera off' : 'Camera on'}>{camOn.value ? '■' : '▶'}</button>
        <button class="zbtn" onClick={() => (pipBig.value = !pipBig.value)} aria-label={pipBig.value ? 'Smaller' : 'Bigger'}>{pipBig.value ? '⤡' : '⤢'}</button>
        <button class="zbtn" onClick={() => setCamView('card')} aria-label="Close the floating player">✕</button>
      </div>
    </div>
  )
}

/** Camera pinned to the top (under the header) or bottom (above the tab bar). The pages scroll in the space left over. */
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
