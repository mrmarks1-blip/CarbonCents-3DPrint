A phone-first control app for the Elegoo Centauri Carbon. It talks to the printer directly on your
local network: no cloud account, no relay server, no telemetry.

## New in v0.2.0

- **Camera zoom**: pinch, double-tap or + / −, up to 12x. Drag to look around while zoomed.
- **Camera anywhere**: on the Status tab, in a floating mini player on every tab (drag it to any
  corner), or pinned to the top or bottom of the screen.
- **Filament colour tuning**: tap the colour dot on the picture, pick your filament colour, and
  optionally highlight it so stray strands stand out.
- **Are you sure?** before Pause and Stop.
- **Filament runout alert**: a pause the app did not ask for is reported as a possible runout.
- **Much better reconnecting**: a dead connection is noticed within about 14 s and replaced, the app
  reconnects as soon as you come back to it, there is a Reconnect button at the top right while
  offline, and you can pull down from the top of a page to reconnect.
- **Notifications on Android**: if Android has blocked them, Settings now says so and opens the
  right system page to turn them on.

## Which download do I want?

| File | For |
|---|---|
| `CentauriControl-<version>.apk` | **Android phones and tablets.** Download it on the phone, open it, and allow installing from that source when asked. Then Settings > enter the printer's IP > Save and connect. |
| `CentauriControl-<version>-printer.zip` | **Put the app on the printer itself** (OpenCentauri Patched firmware only). Then any device on your network opens it at `http://<printer-ip>/cc/`. Needs Python on a computer once; see `README.txt` inside. |
| `CentauriControl-<version>-web.zip` | **Run it from your own computer** with any static web server, e.g. `python -m http.server 4173` inside the unzipped folder, then open `http://<computer-ip>:4173`. Open it over `http://`, not `https://`. |

## Before you rely on it

- Tested against one real printer (OpenCentauri-patched firmware 1.4.49). Other versions may differ.
- The COSMOS / Klipper path has not been tested on real hardware.
- Z offset uses an undocumented command. The first time you use it during a print, try one small step and check the value changes.
- The APK is a debug build. If an older version is installed and the new one will not install over it, uninstall the old one first (its settings are lost).
- The printer has no password. Never port-forward it; use a VPN to reach it from outside.

Unofficial hobby project, not affiliated with Elegoo or OpenCentauri. Use at your own risk. See the
[README](https://github.com/mrmarks1-blip/CarbonCents-3DPrint#readme) for the full list of features and limits.
