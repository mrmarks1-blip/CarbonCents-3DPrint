# Centauri Control

A phone-first control app for the Elegoo Centauri Carbon 3D printer. One codebase,
shipped as an Android app and as a web page for a desktop browser on the same network.

It talks to the printer directly over your local network. There is no cloud account,
no relay server and no telemetry.

- **Stock and OpenCentauri-patched firmware**: Elegoo's SDCP protocol
  (`ws://<printer>:3030/websocket`, uploads on port 80, camera on 3031).
- **OpenCentauri COSMOS** (Klipper): Moonraker on port 80, camera on 8080.

The firmware is detected when you connect.

> This is an unofficial hobby project, not affiliated with or endorsed by Elegoo or
> OpenCentauri. It sends commands to a machine with heaters and motors. Use it at your own risk.

## Why it is useful

The printer's built-in web page is a desktop layout that is awkward on a phone, and it
tells you very little when something goes wrong. This app was built to fix the things
that were annoying in day-to-day use:

- **It is built for a phone.** Big touch targets, one-handed layout, and the same build
  works in a desktop browser.
- **It explains itself.** The console narrates every command and the printer's reply, and
  turns refusals and error codes into plain language instead of a silent failure.
- **It notices when the printer is stuck.** Stalled heating, a print hung in preparing /
  pausing / stopping, a print whose clock has stopped, a cold nozzle while paused, heaters
  left on after a job: the assistant spots these and offers the commands worth retrying.
- **Z offset from the phone**, in 0.01 / 0.05 mm buttons or a 0.001 mm fine-tune wheel, with the value read back from the
  printer after every step so you see what the printer actually has, not what was sent.
- **A maintenance logbook** driven by real print hours and calendar time, with reminders.
- **A demo printer** so you can try every screen without a printer, and a **probe script**
  that documents what a real printer answers, which is useful to anyone else working on
  this protocol.

## What it does

- Live status with progress, layer and time-remaining bars; temperatures.
- Pause, resume, stop; nozzle and bed targets; fans; chamber light; speed mode.
- Z offset in 0.01 / 0.05 mm steps or 0.001 mm fine tuning, with read-back and a ±0.3 mm limit per connection.
- Send G-code files to the printer (chunked, MD5-checked), start and delete them, view print history.
- Camera with reconnect and zoom (pinch, double-tap or + / −, up to 12x), plus brightness / contrast /
  saturation / rotate applied in the app. Show it on the Status tab, in a floating player that
  stays on every tab, or pinned to the top or bottom of the screen. Moving it never opens a second
  video connection to the printer.
- Pause and Stop ask "are you sure?" first.
- If the printer pauses a print by itself (usually a filament runout), you get an alert saying the
  filament may have run out, even with the app on screen.
- Camera colour tuning for your filament colour, with an optional highlight that greys out
  everything else so stray strands stand out (picture only, nothing is sent to the printer).
- Reconnects by itself: a connection that goes silent (wifi sleep, network change, phone waking up)
  is detected within about 14 s and replaced. Reconnect at once with the button in the header or by
  pulling down from the top of a page.
- A console that narrates every command and reply, and explains refusals in plain language.
- A stuck-state assistant (see above).
- Maintenance logbook with reminders.
- A demo printer (Settings > Use the demo printer) to try everything safely.

## Drawbacks and limits

Read these before relying on it.

- **Young and lightly tested on real hardware.** The protocol was checked against one real
  printer (OpenCentauri-patched firmware 1.4.49) with `tools/probe.py`. The app itself is
  tested against `test/fake-printer.mjs`, a simulated printer that copies the message shapes
  of the stock web UI and of Elegoo's own SDK. Other firmware versions may behave differently.
- **The COSMOS / Moonraker path has not been run against a real COSMOS printer.** It is
  written from the Moonraker API and is untested on hardware.
- **Stock and patched firmware expose only part of the printer.** There is no network command
  for raw G-code, flow rate, emergency stop or camera exposure. Those controls appear only on COSMOS.
- **Z offset on stock / patched firmware uses an undocumented command**
  (`{"ZOffset": <absolute mm>}`). It was verified with the printer idle: the value is absolute,
  and an exact `0` is accepted. It has **not** been verified mid-print on real hardware. The
  first time you use it during a print, press one 0.01 step and confirm the value changes
  before relying on it.
- **The firmware can crash its control process on malformed commands**, so the app only sends
  commands whose payloads are confirmed in the stock web UI (the Z offset write is the single
  exception).
- **Camera adjustments are cosmetic.** Brightness, contrast and saturation are applied to the
  picture in the app. They do not change the camera's exposure, so a dark image stays noisy.
- **Print-finished alerts need the app open.** There is no background service. Calendar
  maintenance reminders are scheduled on the phone and do work with the app closed.
- **The printer has no password**, so neither does this. Never port-forward the printer. Use a
  VPN (Tailscale, WireGuard) and put the VPN address in "Second address".
- **Plain HTTP only.** The printer does not speak TLS, so the web build must be opened over
  `http://` by IP address. An `https://` page is not allowed to reach the printer.
- **Android builds are debug builds.** They are not on any app store, and unless you add a fixed
  signing key (below) a new APK will not install over the old one.
- **No iOS build**, one printer at a time, English only.

## Direction

Roughly in order:

1. Confirm Z offset mid-print on real hardware.
2. Real camera exposure control on OpenCentauri firmware (needs the camera's V4L2 controls
   mapped), instead of the in-app picture filters.
3. Test and finish the COSMOS / Moonraker path on a real COSMOS printer.
4. Print-finished alerts with the app closed.
5. Reports from other firmware versions. If you run `tools/probe.py` on a different version,
   the output shows what differs. The report contains your printer's IP, MAC and board ID, so
   redact those before sharing it.

Detailed findings, safety rules and open questions for anyone continuing the work are in
[docs/contributor-notes.md](docs/contributor-notes.md), with the command table in
[docs/protocol-commands.md](docs/protocol-commands.md) and the firmware exploration in
[docs/printer-internals.md](docs/printer-internals.md).

## Download

Get the latest from the [Releases page](https://github.com/mrmarks1-blip/CarbonCents-3DPrint/releases/latest):

- **Android:** `CentauriControl-<version>.apk`. Open it on the phone and allow installing from that source
  when asked. Then Settings > enter the printer's IP address > Save and connect.
- **On the printer itself** (OpenCentauri Patched firmware): `CentauriControl-<version>-printer.zip`. Unzip it
  and run `python install_on_printer.py <printer-ip>`; then open `http://<printer-ip>/cc/` from any device on
  your network, with no setup. Details in `README.txt` inside the zip.
- **From your own computer:** `CentauriControl-<version>-web.zip`, served by any static web server
  (see below).

Every push also builds an APK in GitHub Actions (workflow "Centauri Control", artifact `centauri-control-apk`).
To publish a release, push a tag: `git tag v0.2.0 && git push origin v0.2.0`.

## Install on Android (signing)

To let future builds install over the old one without losing settings, add a fixed signing key once
in your own fork:

    keytool -genkey -v -keystore debug.keystore -storepass android -alias androiddebugkey \
      -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
    base64 -w0 debug.keystore   # save the output as the repository secret ANDROID_DEBUG_KEYSTORE_B64

## Use in a desktop browser

From a release: unzip `CentauriControl-<version>-web.zip`, run `python -m http.server 4173` inside it, and open
`http://<this-computer's-LAN-IP>:4173`. From source:

    npm install
    npm run build
    npx vite preview --host      # then open http://<this-computer's-LAN-IP>:4173

## Probe a real printer

    python tools/probe.py <printer-ip>            # read-only questions, safe during a print
    python tools/probe.py <printer-ip> --z-test   # idle only: small Z offset steps, then undone (--z-zero finishes at 0)

Needs only Python 3.8+. It reports open ports, firmware, raw status and attribute messages, camera
headers and whether Z offset writes work, and saves it all to `centauri-probe-report.txt`
(which is git-ignored, because it contains your printer's IP, MAC and board ID).

## Develop

    npm run dev            # live-reloading app
    npm test               # unit tests (status parsing, assistant rules, maintenance)
    npm run fake-printer   # a simulated printer on ports 80 / 3030 / 3031 (needs root for port 80)
    npm run e2e            # builds, then drives the app in a browser against the fake printer

## Layout

- `src/printer/` — the two protocol clients (`sdcp.ts`, `moonraker.ts`), the demo printer and error codes
- `src/features/` — stuck-state assistant, maintenance logbook, notifications
- `src/views/` — the screens
- `android/` — the Capacitor Android project
- `tools/probe.py` — the printer probe; `tools/printer_install.py` — installs the app on the printer
- `test/` — unit tests, the simulated printer and the browser test

## Credits

Protocol references: ELEGOO-3D/elegoo-link and bjan/pycentauri (Apache-2.0),
danielcherubini/elegoo-homeassistant (MIT), and the OpenCentauri docs.

## Licence

MIT. See [LICENSE](LICENSE).
