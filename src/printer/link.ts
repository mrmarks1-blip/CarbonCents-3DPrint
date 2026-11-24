// One WebSocket to the printer, kept alive on a phone. Shared by the SDCP and
// Moonraker backends. What it adds over a bare WebSocket:
//
// - Dead-link watchdog. On wifi power-save, a network change or a phone waking
//   from sleep, a socket can go silent without ever firing `close`; the app then
//   said "Connected" while nothing arrived. The backend asks for something every
//   few seconds, so silence for longer than SILENT_MS means the link is dead.
// - Connect timeout. A connect attempt that hangs is abandoned and retried.
// - Coming back to the app (Android freezes background pages) or the network
//   coming back triggers a quick check and, if needed, an immediate reconnect,
//   instead of waiting out a frozen back-off timer.
// - `now()` for the Reconnect button and pull-to-reconnect.
//
// Reconnecting is only ever a new WebSocket: no printer command is sent by this
// file, so it cannot disturb a running print.
import type { BackendEvents } from './types'

export const CONNECT_TIMEOUT_MS = 15_000 // opening took up to 7.9 s on a real printer
export const SILENT_MS = 12_000 // foreground: the backend polls every 2 s
export const SILENT_HIDDEN_MS = 60_000 // background: browsers throttle timers
const WAKE_CHECK_MS = 3_500

export interface LinkOptions {
  url: string
  ev: BackendEvents
  /** Called with each new open socket. Use `every()` for timers tied to it. */
  onOpen(): void
  onMessage(text: string): void
  /** The socket is gone: reject anything still waiting for a reply. */
  onDown(): void
  /** Ask the printer for something small, to prove the link is alive. */
  ping(): void
  /** Console text for a failed connect attempt. */
  refusedText(waitSeconds: number): string
}

export class Link {
  ws: WebSocket | null = null
  private o: LinkOptions
  private running = false
  private retry = 0
  private lastRx = 0
  private sockTimers: number[] = []
  private retryTimer = 0
  private wakeTimer = 0

  constructor(o: LinkOptions) {
    this.o = o
  }

  get alive() {
    return this.ws?.readyState === 1
  }

  start() {
    if (this.running) return
    this.running = true
    window.addEventListener('online', this.onOnline)
    document.addEventListener('visibilitychange', this.onVisible)
    this.open()
  }

  stop() {
    this.running = false
    window.removeEventListener('online', this.onOnline)
    document.removeEventListener('visibilitychange', this.onVisible)
    clearTimeout(this.retryTimer)
    clearTimeout(this.wakeTimer)
    this.abandon()
  }

  /** Drop whatever socket there is and connect again right away. */
  now() {
    if (!this.running) return
    this.retry = 0
    clearTimeout(this.retryTimer)
    clearTimeout(this.wakeTimer)
    this.abandon()
    this.open()
  }

  /** A repeating timer that lives exactly as long as the current socket. */
  every(ms: number, fn: () => void) {
    this.sockTimers.push(window.setInterval(fn, ms))
  }

  send(text: string) {
    this.ws?.send(text)
  }

  private open() {
    const { url, ev } = this.o
    ev.conn('connecting')
    ev.log('info', `Connecting to ${url}`)
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (e) {
      ev.log('error', `The browser refused to open ${url}: ${(e as Error).message}. A page loaded over https cannot reach a printer on plain ws://; use the Android app or open this page over http on your network.`)
      ev.conn('closed', 'blocked')
      return
    }
    this.ws = ws
    let opened = false
    this.sockTimers.push(
      window.setTimeout(() => {
        if (opened || ws !== this.ws) return
        ev.log('warn', `No answer from ${url} after ${CONNECT_TIMEOUT_MS / 1000}s.`)
        this.down(ws, false)
      }, CONNECT_TIMEOUT_MS),
    )
    ws.onopen = () => {
      opened = true
      this.retry = 0
      this.lastRx = Date.now()
      ev.conn('connected')
      this.every(2000, () => this.watch(ws))
      this.o.onOpen()
    }
    ws.onmessage = (m) => {
      this.lastRx = Date.now()
      this.o.onMessage(String(m.data))
    }
    ws.onclose = () => this.down(ws, opened)
  }

  private watch(ws: WebSocket) {
    const quiet = Date.now() - this.lastRx
    if (quiet < (document.hidden ? SILENT_HIDDEN_MS : SILENT_MS)) return
    this.o.ev.log('warn', `Nothing from the printer for ${Math.round(quiet / 1000)}s although the connection looked open: the link is dead (wifi sleep or a network change). Reconnecting.`)
    this.down(ws, true, 1)
  }

  private down(ws: WebSocket, opened: boolean, waitSeconds?: number) {
    if (ws !== this.ws) return // already replaced
    this.abandon()
    if (!this.running) return
    const wait = waitSeconds ?? Math.min(15, 2 ** this.retry++)
    this.o.ev.conn('closed', opened ? 'dropped' : 'refused')
    this.o.ev.log(opened ? 'warn' : 'error', opened ? `Connection dropped. Reconnecting in ${wait}s.` : this.o.refusedText(wait))
    this.retryTimer = window.setTimeout(() => this.running && this.open(), wait * 1000)
  }

  /** Forget the current socket without triggering another round of `down`. */
  private abandon() {
    this.sockTimers.forEach((t) => (clearInterval(t), clearTimeout(t)))
    this.sockTimers = []
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null
      try {
        ws.close() // a live link gets a proper close, so the printer frees the slot
      } catch {
        /* already closed */
      }
    }
    this.o.onDown()
  }

  private onOnline = () => {
    if (!this.running || this.alive) return
    this.o.ev.log('info', 'The phone is back on a network. Reconnecting now.')
    this.now()
  }

  private onVisible = () => {
    if (document.hidden || !this.running) return
    clearTimeout(this.wakeTimer)
    if (!this.alive) {
      this.o.ev.log('info', 'Back in the app. Reconnecting now.')
      return this.now()
    }
    // The socket says it is open, but it may have died while the app was in the
    // background. Ask for status; if nothing comes back quickly, start over.
    const asked = Date.now()
    this.o.ping()
    this.wakeTimer = window.setTimeout(() => {
      if (this.running && this.lastRx < asked) {
        this.o.ev.log('warn', 'Back in the app, but the old connection is not answering. Reconnecting.')
        this.now()
      }
    }, WAKE_CHECK_MS)
  }
}
