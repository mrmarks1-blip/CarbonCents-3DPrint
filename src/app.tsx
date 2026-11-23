import { useEffect, useState } from 'preact/hooks'
import { conn, connect, dueTasks, info, issues, settings, toast } from './store'
import { Care } from './views/Care'
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

export function App() {
  const [tab, setTab] = useState(settings.value.host || settings.value.backend === 'demo' ? 'home' : 'settings')
  useEffect(() => void connect(), [])
  const problems = issues.value.filter((i) => i.level !== 'info').length
  const badge: Record<string, number> = { home: problems, care: dueTasks.value.length }
  const title = info.value?.name ?? (settings.value.backend === 'demo' ? 'Demo printer' : settings.value.host || 'Centauri Control')

  return (
    <div class="shell">
      <header class="top">
        <span class={`dot ${conn.value}`} title={conn.value} />
        <h1>{title}</h1>
        <span class="dim small">{{ idle: 'Not set up', connecting: 'Connecting…', connected: 'Connected', closed: 'Offline, retrying' }[conn.value]}</span>
      </header>
      <main>
        {tab === 'home' && <Dashboard go={setTab} />}
        {tab === 'control' && <Control />}
        {tab === 'files' && <Files />}
        {tab === 'console' && <Console />}
        {tab === 'care' && <Care />}
        {tab === 'settings' && <Settings go={setTab} />}
      </main>
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
    </div>
  )
}
