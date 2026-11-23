import { useEffect, useRef, useState } from 'preact/hooks'
import { SCREEN_ERRORS } from '../printer/codes'
import { ACTIONS, act, activeHost, backend, conn, info, log, logs } from '../store'

const FILTERS = { Activity: ['info', 'ok', 'warn', 'error'], Problems: ['warn', 'error'], Everything: ['info', 'ok', 'warn', 'error', 'tx', 'rx'] }

async function reachable(url: string): Promise<boolean> {
  try {
    const c = new AbortController()
    const t = setTimeout(() => c.abort(), 9000) // the printer's web server can take several seconds
    await fetch(url, { mode: 'no-cors', signal: c.signal }) // resolves once headers arrive
    clearTimeout(t)
    c.abort()
    return true
  } catch {
    return false
  }
}

async function portCheck() {
  const host = activeHost.value
  if (!host || host === 'demo') return log('info', 'Port check needs a real printer address.')
  const moon = info.value?.backend === 'moonraker'
  const ports: [string, string][] = moon
    ? [['web / Moonraker (80)', `http://${host}/server/info`], ['camera (8080)', `http://${host}:8080/snapshot`]]
    : [['web page and uploads (80)', `http://${host}/`], ['camera (3031)', `http://${host}:3031/video`]]
  log('info', `Checking which services on ${host} answer…`)
  for (const [name, url] of ports) {
    const up = await reachable(url)
    log(up ? 'ok' : 'error', `${name}: ${up ? 'answering' : 'no answer within 9s'}`)
  }
  log(conn.value === 'connected' ? 'ok' : 'error', `control link (${moon ? '80' : '3030'}): ${conn.value === 'connected' ? 'connected' : 'not connected'}`)
  if (!moon) log('info', 'If all three are dead the printer\'s control process has crashed and it needs a power cycle. If only the control link fails, its connection slots are probably full.')
}

export function Console() {
  const [filter, setFilter] = useState<keyof typeof FILTERS>('Activity')
  const [cmd, setCmd] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const caps = backend.value?.caps
  const shown = logs.value.filter((l) => FILTERS[filter].includes(l.level))

  useEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [shown.length, filter])

  const send = () => {
    const script = cmd.trim()
    if (!script) return
    act(`G-code: ${script}`, (b) => b.gcode(script))
    setCmd('')
  }
  const copy = () =>
    navigator.clipboard
      ?.writeText(logs.value.map((l) => `${new Date(l.t).toISOString()} [${l.level}] ${l.text}`).join('\n'))
      .then(() => log('info', 'Log copied to the clipboard.'), () => log('warn', 'The browser blocked clipboard access.'))

  return (
    <>
      <section class="card wide">
        <div class="spread">
          <h2>Console</h2>
          <div class="row tight">
            {(Object.keys(FILTERS) as (keyof typeof FILTERS)[]).map((f) => (
              <button class={`btn sm ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>{f}</button>
            ))}
          </div>
        </div>
        <div class="console" ref={box} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}>
          {shown.length === 0 && <div class="rx">Nothing yet. Everything the app asks the printer, and every answer, appears here.</div>}
          {shown.map((l) => (
            <div class={l.level} key={l.t + l.text}>
              <time>{new Date(l.t).toLocaleTimeString([], { hour12: false })}</time>
              {l.level === 'tx' ? '→ ' : l.level === 'rx' ? '← ' : ''}{l.text}
            </div>
          ))}
        </div>
        {caps?.gcode ? (
          <div class="row tight">
            <input class="grow" type="text" placeholder="G-code or macro, e.g. M117 hello" value={cmd} autocapitalize="characters" spellcheck={false}
              onInput={(e) => setCmd(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
            <button class="btn primary" onClick={send}>Send</button>
          </div>
        ) : (
          caps && <p class="dim small">This firmware has no network G-code command, so there is no command line here: the console shows what the app sends and what the printer answers. COSMOS, the Klipper build of OpenCentauri, adds a full G-code console.</p>
        )}
      </section>

      <section class="card third">
        <h2>Diagnostics</h2>
        <button class="btn" onClick={() => ACTIONS.refresh.run()}>Ask for status again</button>
        <button class="btn" onClick={() => ACTIONS.retry.run()}>Reconnect</button>
        <button class="btn" onClick={portCheck}>Check which services answer</button>
        <button class="btn" onClick={copy}>Copy the log</button>
        <button class="btn" onClick={() => (logs.value = [])}>Clear</button>
        {info.value && <p class="dim small">{info.value.name} · firmware {info.value.firmware || 'unknown'}</p>}
      </section>

      <section class="card">
        <details>
          <summary>Touchscreen error codes</summary>
          <table>
            <thead><tr><th>Code</th><th>Meaning</th><th>What to check</th></tr></thead>
            <tbody>{SCREEN_ERRORS.map((e) => <tr><td class="num"><b>{e.code}</b></td><td>{e.meaning}</td><td class="dim">{e.check}</td></tr>)}</tbody>
          </table>
        </details>
      </section>
    </>
  )
}
