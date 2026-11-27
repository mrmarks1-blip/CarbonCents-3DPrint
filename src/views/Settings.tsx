import { useEffect, useState } from 'preact/hooks'
import { isNative, notify, openSettings, permission, requestPermission, type Permission } from '../features/notify'
import { connect, info, log, settings, type Settings as S } from '../store'

export function Settings({ go }: { go: (tab: string) => void }) {
  const [draft, setDraft] = useState<S>(settings.value)
  const [perm, setPerm] = useState<Permission | ''>('')
  // Read the real state on open, and again when coming back from the system settings page.
  useEffect(() => {
    const check = () => !document.hidden && permission().then(setPerm)
    check()
    document.addEventListener('visibilitychange', check)
    return () => document.removeEventListener('visibilitychange', check)
  }, [])
  const allow = async () => {
    const p = await requestPermission()
    setPerm(p)
    log('info', `Notification permission: ${p}.`)
    // Android shows no prompt once permission has been refused: take the person to the switch instead.
    if (p === 'denied' && !(await openSettings())) log('warn', 'Notifications are blocked. Turn them on in the system settings for this app.')
  }
  const set = (patch: Partial<S>) => setDraft({ ...draft, ...patch })
  const apply = (next: S = draft) => {
    // Only the fields this form edits: the rest may have changed elsewhere since it opened.
    settings.value = { ...settings.value, host: next.host, fallbackHost: next.fallbackHost, backend: next.backend }
    connect()
    go('home')
  }

  return (
    <>
      <section class="card half">
        <h2>Printer</h2>
        <label class="field">Printer address (shown on the touchscreen under Settings &gt; Network)
          <input type="text" inputMode="url" placeholder="192.168.1.50" value={draft.host} autocapitalize="off" spellcheck={false} onInput={(e) => set({ host: e.currentTarget.value })} />
        </label>
        <label class="field">Second address, tried when the first fails (for example its VPN / Tailscale address)
          <input type="text" inputMode="url" placeholder="Optional" value={draft.fallbackHost} autocapitalize="off" spellcheck={false} onInput={(e) => set({ fallbackHost: e.currentTarget.value })} />
        </label>
        <label class="field">Firmware
          <select value={draft.backend === 'demo' ? 'auto' : draft.backend} onChange={(e) => set({ backend: e.currentTarget.value as S['backend'] })}>
            <option value="auto">Detect automatically</option>
            <option value="sdcp">Stock or OpenCentauri patched (Elegoo protocol)</option>
            <option value="moonraker">OpenCentauri COSMOS (Klipper / Moonraker)</option>
          </select>
        </label>
        <button class="btn primary" disabled={!draft.host.trim()} onClick={() => apply({ ...draft, backend: draft.backend === 'demo' ? 'auto' : draft.backend })}>Save and connect</button>
        <button class="btn" onClick={() => apply({ ...draft, backend: 'demo' })}>Use the demo printer</button>
        {info.value && <p class="dim small">Connected to {info.value.name}, firmware {info.value.firmware || 'unknown'}.</p>}
      </section>

      <section class="card half">
        <h2>Notifications</h2>
        <label class="check">
          <input type="checkbox" checked={settings.value.notifications} onChange={(e) => (settings.value = { ...settings.value, notifications: e.currentTarget.checked })} />
          Tell me when a print finishes, pauses or fails, and when maintenance is due
        </label>
        {perm === 'granted' ? (
          <div class="row tight">
            <span class="small" style="color:var(--ok)">Notifications are allowed on this device.</span>
            <button class="btn sm" onClick={() => notify('Centauri Control', 'Test notification: alerts are working.')}>Send a test</button>
          </div>
        ) : perm === 'denied' && isNative() ? (
          <>
            <p class="small" style="color:var(--warn)">Notifications are blocked for this app. Android no longer shows its permission prompt after a refusal, so they can only be turned on in the system settings.</p>
            <button class="btn primary" onClick={() => openSettings()}>Open notification settings</button>
          </>
        ) : perm === 'unavailable' ? (
          <p class="small dim">This browser cannot show notifications for a page loaded over plain http. The Android app can.</p>
        ) : (
          <button class="btn primary" onClick={allow}>{perm === 'denied' ? 'Notifications are blocked: ask again' : 'Allow notifications on this device'}</button>
        )}
        <p class="dim small">Print alerts arrive while the app is open. Android stops background apps from holding a connection, so alerts with the app closed need an always-on device; calendar maintenance reminders are scheduled on the phone and arrive regardless.</p>
      </section>

      <section class="card">
        <h2>Good to know</h2>
        <ul class="dim small" style="margin:0;padding-left:18px;display:grid;gap:6px">
          <li>The printer has no password. Keep it off the public internet; use a VPN such as Tailscale or WireGuard to reach it from outside and enter its VPN address above.</li>
          <li>It accepts about five connections at once. This app uses one, plus one for the camera.</li>
          <li>On stock and OpenCentauri-patched firmware there is no network command for raw G-code, flow rate, emergency stop or camera exposure. Those appear here automatically on COSMOS.</li>
        </ul>
        <p class="dim small num" style="margin:0">Centauri Control v{__APP_VERSION__} · build {__APP_BUILD__}</p>
      </section>
    </>
  )
}
