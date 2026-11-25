import { useEffect, useRef, useState } from 'preact/hooks'
import { isNative, permission, requestPermission } from './features/notify'
import { conn, connect, dueTasks, info, issues, question, reconnectNow, settings, toast } from './store'
import { Care } from './views/Care'
import { FloatingCamera, PinnedCamera, ZoomViewer } from './views/CameraView'
import { FilamentFilter, FilamentSheet } from './views/Filament'
import { Console } from './views/Console'
import { Control } from './views/Control'
import { Dashboard } from './views/Dashboard'
import { Files } from './views/Files'
import { Settings } from './views/Settings'

const TABS: [id: string, label: string, icon: string][] = [
  ['home', 'Status', 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z'],
  ['control', 'Control', 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4'],
  ['files', 'Files', 'M4 5a1 1 0 0 1 1-1h5l2 3h7a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z'],
  ['console', 'Console', 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5'],
  ['care', 'Care', 'M14 6a4 4 0 0 0-5 5l-6 6 3 3 6-6a4 4 0 0 0 5-5l-3 3-2-2z'],
  ['settings', 'Settings', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2'],
]

const PULL = 64 // px of pull needed to reconnect

export function App() {
  const [tab, setTab] = useState(settings.value.host || settings.value.backend === 'demo' ? 'home' : 'settings')
  useEffect(() => void connect(), [])
  useEffect(() => void askForNotificationsOnce(), [])
  const mainRef = useRef<HTMLElement>(null)
  const pull = usePullToReconnect(mainRef)
  useEffect(() => void mainRef.current?.scrollTo(0, 0), [tab])
  const problems = issues.value.filter((i) => i.level !== 'info').length
  const badge: Record<string, number> = { home: problems, care: dueTasks.value.length }
  const s = settings.value
  const setUp = !!s.host || s.backend === 'demo'
  const title = info.value?.name ?? (s.backend === 'demo' ? 'Demo printer' : s.host || 'Centauri Control')
  const view = s.camView
  const down = setUp && conn.value !== 'connected'

  const connecting = conn.value === 'connecting'

  return (
    <div class={`shell pin-${view}`}>
      <header class="top">
        <span class={`dot ${conn.value}`} title={conn.value} />
        <h1>{title}</h1>
        {down ? (
          <button class={`btn sm reconnect ${connecting ? 'busy' : ''}`} onClick={reconnectNow} aria-label="Reconnect">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" /></svg>
            {connecting ? 'Reconnecting…' : 'Reconnect'}
          </button>
        ) : (
          <span class="dim small">{conn.value === 'idle' ? 'Not set up' : 'Connected'}</span>
        )}
      </header>
      {view === 'top' && <PinnedCamera where="top" />}
      {pull > 0 && (
        <div class="pull" style={{ height: `${Math.min(pull, PULL * 1.4)}px` }} aria-hidden="true">
          <span>{pull >= PULL ? 'Release to reconnect' : 'Pull down to reconnect'}</span>
        </div>
      )}
      <main ref={mainRef}>
        {tab === 'home' && <Dashboard go={setTab} />}
        {tab === 'control' && <Control />}
        {tab === 'files' && <Files />}
        {tab === 'console' && <Console />}
        {tab === 'care' && <Care />}
        {tab === 'settings' && <Settings go={setTab} />}
      </main>
      {view === 'pip' && <FloatingCamera />}
      {view === 'bottom' && <PinnedCamera where="bottom" />}
      <nav>
        {TABS.map(([id, label, icon]) => (
          <button class={tab === id ? 'on' : ''} onClick={() => setTab(id)} aria-current={tab === id ? 'page' : undefined}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={icon} /></svg>
            {label}
            {badge[id] > 0 && <span class="badge">{badge[id]}</span>}
          </button>
        ))}
      </nav>
      {toast.value && <div class={`toast ${toast.value.bad ? 'bad' : ''}`} role="status">{toast.value.text}</div>}
      <ZoomViewer />
      <FilamentSheet />
      <FilamentFilter />
      <Dialog />
    </div>
  )
}

/** The "are you sure?" dialog. Cancel has the focus, so an accidental Enter does nothing harmful. */
function Dialog() {
  const q = question.value
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!q) return
    cancel.current?.focus()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && answer(false)
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [q])
  if (!q) return null
  const answer = (yes: boolean) => {
    question.value = null
    q.resolve(yes)
  }
  return (
    <div class="modal" role="presentation" onClick={(e) => e.target === e.currentTarget && answer(false)}>
      <div class="card" role="alertdialog" aria-modal="true" aria-labelledby="q-title" aria-describedby="q-body">
        <b id="q-title" style="font-size:1.1rem">{q.title}</b>
        <p id="q-body" class="dim">{q.body}</p>
        <div class="row">
          <button ref={cancel} class="btn grow" onClick={() => answer(false)}>Cancel</button>
          <button class={`btn grow ${q.danger ? 'danger solid' : 'primary'}`} onClick={() => answer(true)}>{q.ok}</button>
        </div>
      </div>
    </div>
  )
}

/** Drag down from the top of a page to reconnect. Returns the current pull distance. */
function usePullToReconnect(mainRef: { current: HTMLElement | null }) {
  const [dist, setDist] = useState(0)
  useEffect(() => {
    let start: { y: number; x: number } | null = null
    let d = 0
    const top = () => mainRef.current?.scrollTop ?? 0
    const skip = '.cam, .pip, .zv, .sheet, .pinned, .zw-wheel, .console, .modal, input, select, textarea'
    const ts = (e: TouchEvent) => {
      start = null
      if (e.touches.length !== 1 || top() > 0 || (e.target as HTMLElement).closest(skip)) return
      start = { y: e.touches[0].clientY, x: e.touches[0].clientX }
    }
    const tm = (e: TouchEvent) => {
      if (!start || e.touches.length !== 1) return
      const dy = e.touches[0].clientY - start.y
      const dx = Math.abs(e.touches[0].clientX - start.x)
      if (top() > 0 || dy < 0 || dx > dy) {
        d = 0
        setDist(0)
        if (dy < 0 || top() > 0) start = null
        return
      }
      d = dy * 0.5 // resistance, like the platform gesture
      setDist(d)
    }
    const te = () => {
      if (start && d >= PULL) reconnectNow()
      start = null
      d = 0
      setDist(0)
    }
    addEventListener('touchstart', ts, { passive: true })
    addEventListener('touchmove', tm, { passive: true })
    addEventListener('touchend', te)
    addEventListener('touchcancel', te)
    return () => {
      removeEventListener('touchstart', ts)
      removeEventListener('touchmove', tm)
      removeEventListener('touchend', te)
      removeEventListener('touchcancel', te)
    }
  }, [])
  return dist
}

/** Android app, first run: ask for notification permission once, as the setting defaults to on. */
async function askForNotificationsOnce() {
  if (!isNative() || !settings.value.notifications) return
  try {
    if (localStorage.getItem('cc.askedNotify')) return
    localStorage.setItem('cc.askedNotify', '1')
  } catch {
    return
  }
  if ((await permission()) === 'prompt') await requestPermission()
}
