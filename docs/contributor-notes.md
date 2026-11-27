# Notes for anyone picking this up

What has been learned about the printer, what has been tried, and what is still open. Written for a
person or an AI agent continuing the work on their own Centauri Carbon. Read this first, then
`protocol-commands.md` and `printer-internals.md` in this folder.

Everything here was found on **one** printer: an Elegoo Centauri Carbon on firmware **V1.4.49 with the
OpenCentauri patch** (stock firmware plus the patch, not the COSMOS / Klipper build). Other firmware
versions may differ. Addresses are placeholders: `192.168.1.50` stands for the printer and
`192.168.1.10` for the computer you are working on.

## 1. Where things are

| Path | What it is |
|---|---|
| `src/` | The app: Preact + Vite + TypeScript. `src/printer/sdcp.ts` is the client for stock / patched firmware. |
| `android/` | Capacitor Android wrapper. |
| `test/` | `logic.test.ts` (vitest), `fake-printer.mjs` (simulated printer), `e2e.mjs` (browser test against the fake), `real-smoke.mjs` (browser test against a real printer). |
| `test/fixtures/real-1.4.49/` | Real replies captured from the printer, with identifiers replaced. Its README has the detail. |
| `tools/probe.py` | Read-only probe, dependency-free Python. Contains reusable `WS` and `Sdcp` classes. |
| `tools/capture.py` | Captures real replies as fixtures. Has a fixed WebSocket reader (`WS2`). |
| `tools/bedmesh.py` | Read-only bed mesh / probing report from the printer log (via the root shell), as HTML heatmaps. |
| `tools/rsh.py` | Runs a shell command on the printer as root through the OpenCentauri shell on port 4567. |
| `tools/printer_install.py` | Installs the build on the printer at `/cc/` (shipped in releases as `install_on_printer.py`). See section 4. |
| `docs/protocol-commands.md` | SDCP command table taken from the printer's own stock web UI and binary. |
| `docs/printer-internals.md` | Findings from read-only exploration over the root shell. |

Some notes refer to a `printer-dump/` folder (the stock web UI, config files and the strings of the
main binary, pulled off the printer). It is git-ignored and not published, because it holds the wifi
name and bed mesh. You can make your own with `tools/rsh.py` (`tar czf - <path>` with `--raw <file>`).

Setup is in the main README: `npm install`, `npm test`, `npm run build`, `npx vite preview --host`.

## 2. The printer

- Open ports:
  - 80: web server (stock web page, uploads, file downloads). Served by `/app/app`.
  - 3030: SDCP control websocket, `ws://<printer>:3030/websocket`. Also answers plain HTTP with the stock page.
  - 3031: camera, `http://<printer>:3031/video` (MJPEG, `multipart/x-mixed-replace; boundary=--foo`). `/` on this port returns 500 "not found".
  - 22: SSH (OpenCentauri's default login, `root` / `OpenCentauri`).
  - 4567: OpenCentauri bind shell. Root, BusyBox ash, **no login at all**.
  - Closed: 443, 7125, 8080, 1883, 8883, 9001, 54780. There is no Moonraker on this firmware.
- UDP discovery: send `M99999` to port 3000; it replies with name, IP, board ID and firmware.
- Root shell helper: `python -I tools/rsh.py --host <printer> --timeout 30 "<command>"`; add `--raw <file>` to save binary output.
  - **One connection at a time.** Two parallel calls gave one timeout and one hang.
  - The helper puts the whole command on one line because the shell prints a `/ # ` prompt per line, which would land inside binary output.
  - GNU tools and `python3.13` are in `/kip/bin` (not always on PATH; use full paths). `ffmpeg` and `curl` are in `/usr/bin`.
- Hardware limits: dual Cortex-A7 (ARMv7), Linux 5.4.61, **110 MB RAM with about 7 MB free** (about 54 MB counting cache).
  Storage: `/` overlay 120 MB, `/user-resource` 6.5 GB, `/board-resource` 120 MB.
- The main process is `/app/app` (find it with `pidof app`). It is a C++ port of Klipper plus the touchscreen UI,
  the web server, SDCP and the camera stream, all in one. **If it dies, a running print is lost.**
- The web server is slow and erratic. Small files take 0.1 to 0.3 s; the 103 KB app bundle took 9 s; an 800 KB file
  did not finish in 60 s. Unknown paths return a 10-byte 404 (a few return the stock `index.html`). Keep requests
  small and one at a time.
- SDCP allows about 5 websocket clients and 4 camera viewers. It accepts any browser Origin. Port 80 sends no CORS headers.

## 3. Safety rules

- **Only send SDCP payloads that are confirmed** in `protocol-commands.md` (the ones the stock page sends, plus
  the one verified exception, `{"ZOffset": <absolute mm>}` on Cmd 403). This firmware can crash its control process
  on unknown commands or wrong shapes, which ruins a running print. No fuzzing.
- **No heating, moving, homing, starting, stopping, deleting or renaming** without the owner's say-so for that action.
- **Never kill, restart, signal, strace or gdb `/app/app`.** Do not write to its devices (`/dev/rpmsg*`,
  `/dev/ttyACM0`, `/dev/ttyS4`, `/dev/video0`).
- Check the printer is idle (`CurrentStatus` is `[0]`) before anything beyond status reads.
- Keep shell work light: about 7 MB of free RAM. No big sorts or recursive greps over `/user-resource`.
- Do not use the printer's `wget`: it segfaulted and left a core dump in `/user-resource/`. Use `/usr/bin/curl`.
- One shell connection at a time; close websockets when done.
- **The printer has no password anywhere** (web, SDCP, camera, root shell on 4567), and `/tmp/wlan_entery_str` holds
  the wifi name and password in plain text, world-readable. Never port-forward it or expose it to the internet.
  Remote use goes through a VPN.
- Do not read or record the wifi password. Before publishing captures, replace the IP, MAC, board ID and file names.

## 4. Hosting the app on the printer

The app can be served by the printer itself at `http://<printer>/cc/`. No computer has to be running, and the page
is then same-origin with port 80, so `fetch()` of G-code, thumbnails and upload replies works (from any other origin
it does not, because port 80 sends no CORS headers). When the page is served over `http:` from a path starting with
`/cc`, the app takes the printer address from the page's own hostname and connects with no setup (`selfHost` in
`src/store.ts`).

Checked in a real browser: the page loads from the printer, connects with no setup, shows status, temperatures and
the 640x360 camera picture, and the light commands are accepted.

Install or update with `npm run build`, then `python tools/printer_install.py <printer-ip>` (`--remove` to undo).
Releases ship the same script with the built files as `CentauriControl-<version>-printer.zip`.

How it works, and why:
- Files are **pushed** through the root shell on 4567 as `printf` lines with 3-digit octal escapes (POSIX, so
  BusyBox handles it; the printer has no `base64` applet). 6000 bytes per line, one connection per line.
  Lines of 32 KB were also tested fine.
- They go into `/app/resources/www/cc.new`, every file's MD5 is compared, and only then is `cc` swapped
  for `cc.new`. A failed or interrupted install leaves the old copy working.
- This replaces the old `tools/deploy.py`, which made the printer pull files from a temporary web server on the
  computer. Its first run hung (probably a Windows firewall) after it had already deleted the old asset files.
- `/app` is on the root overlay. Expect `/cc/` to survive a reboot but to disappear after a firmware or
  OpenCentauri update (neither confirmed). Running the installer again puts it back.

## 5. Known facts worth keeping

- HTTP path mappings on port 80 (from the binary):
  - `/` -> `/app/resources/www/`
  - `/local/...` -> `/user-resource/...` (uploaded G-code; time-lapses under `aic_tlp/`)
  - `/usb/...` -> `/mnt/exUDISK/...`
  - `/thumbnail/...` -> `/tmp/thumbnail/...`
  - `/board-resource/history_image/...` -> same path on disk
- Upload: `POST http://<printer>/uploadFile/upload` with fields `TotalSize`, `Uuid`, `Offset`, `Check`, `S-File-MD5`,
  `File`. Answers "device is busy,can't upload" when busy.
- G-code download works: `GET /local/<url-encoded name>`, HTTP Range honoured (206).
- **The printer never pushes status unprompted: polling is required.** Cmd 0 / Cmd 1 replies are only `{"Ack":0}`;
  the data arrives as a separate `sdcp/status` / `sdcp/attributes` message about 20 ms later.
- **Cmd 260 (file detail) takes about 9 s and blocks the command queue**; commands sent behind it time out, and the
  app's 8 s timeout would fire. If 260 is added, use a longer timeout, send nothing else meanwhile, and never call it
  during a print without testing. It generates `/thumbnail/<name>.gcode.png` (144x144 PNG) as a side effect.
- Opening the WebSocket took 0.5 s, 7.9 s and 2.2 s on three tries: allow a generous connect timeout.
- A websocket `ping` gets no `pong`. Harmless so far; the app keeps the link alive by polling.
- Printer `TimeStamp` is seconds, not ms. Idle `PrintInfo` keeps the last job's layer / tick numbers with an empty `Filename`.
- Status oddities already handled in `sdcp.ts`: the firmware spells it `CurrenCoord`; `ZOffset` carries float noise
  (`1e-14`); `PrintInfo.Status` 9 with the old layer counts lingers after a finished job.
- Z offset write is absolute, and an exact `0` is accepted. Values in 0.001 mm steps are accepted and shown on the
  touchscreen (owner report, 2026-11-24). Whether the firmware applies sub-0.01 mm moves physically is not known. Sending back the printer's own noisy `1e-14` reading is ignored.
- `/usb` with no stick returns `Ack: -1`. Cmd 134 returns `Ack: 0` when there is no power-loss job. Cmd 324 returns an
  empty `canvas_list` without a multi-colour unit.
- Camera: USB 05a3:9230, 640x360 MJPEG, about 33 KB per frame; Cmd 386 `{Enable:1}` must be sent first. Frame rate is
  uneven (13 frames in 1.5 s, then a 3.5 s stall in one sample). No `v4l2-ctl` on the printer, and no resolution,
  exposure or brightness strings in the binary.
- Attributes report `XYZsize` "218.88x128.88x220" and `sysconf.cfg` says `device_name : NEPTUNE 5 PRO`; both are
  leftovers from other Elegoo models, not real values for this machine.
- Commands the stock page uses that the app does not: 134/135 (power-loss resume), 257 (rename file), 260 (file
  detail), 322 (delete history), 323 (time-lapse export), 324 (filament info), 386 with `Enable: 0`. Payloads for
  192, 255, 387, 503 and 64 are not shown in the stock page.
- **No local G-code channel.** The app holds `/dev/rpmsg0`, `/dev/rpmsg_ctrl0`, `/dev/ttyACM0`, `/dev/ttyS4`,
  `/dev/dsp_debug` and `/dev/video0`. Nothing listens on localhost only.
- **A Klipper API server is compiled into the binary but is not running** (strings include `apiserver`,
  `gcode/script`, `objects/subscribe`). No socket exists at runtime.
- Logs: `/board-resource/log` is a symlink to the active file; times are milliseconds since boot. It records every
  SDCP request and reply, network changes, probing, sensor events and on-screen message boxes. Reachable by shell
  only. `logread` is useless.
- Cloud-only handlers (Elegoo's phone-app channel, not reachable on 3030) accept keys the LAN protocol lacks:
  `Zoffset`, `ChamberFanStatus`, `FilamentDetect`, `PoweroffRecovery`, `Light`, `InputShaper`, `NozzlePid`,
  `BedLevel`, motor unlock and model download by URL. They show what the firmware can do internally.
- Status-setter key names present in the binary but never sent by the stock page: `TempTargetBox`, `MainLight`. Untested.
- **G-code the firmware knows (strings in `/app/app`, V1.4.49, 2026-11-27).** Klipper-derived: `G29` runs
  `BED_MESH_CALIBRATE` (fast/normal; the log shows `cmd_G29` and profile `besh_profile_standard_default`),
  `PROBE`, `PROBE_ACCURACY` (logs "PROBE_ACCURACY at X:%.3f Y:%.3f Z:%.3f (samples=%d ..."), `QUERY_PROBE`,
  `PROBE_CALIBRATE`, `PROBE_BY_STEP`, `G30`, `G31`, `M729` / `WIPE_NOZZLE` (nozzle clean; the filament-load routine
  calls `M729` between purges), `BED_MESH_CLEAR` / `_OUTPUT` / `_MAP` / `_OFFSET`. Whether a job *file* may use the
  extended (non-G/M) commands is **not tested**.
- **Bed report jobs (experimental, `src/features/levelling.ts`).** Re-level uploads an empty `cc-level-only.gcode` and
  starts it with `Calibration_switch: 1` (only known commands). Retake uploads `cc-retake.gcode`: `G28`, `M109 S170`,
  `M729`, `M104 S140`, then `PROBE_ACCURACY SAMPLES=5` at each point, read back from the `[probe] probe at` log lines.
  Neither has run on a real printer yet. First real test: retake one point with the owner watching, then check the
  log for the probe lines and for any "unknown command" message.

## 6. Known problems in the app

- **Fixed: no dead-link check.** `src/printer/link.ts` now replaces a connection that has been silent for 12 s
  (60 s with the app in the background), abandons connect attempts after 15 s, and on returning to the app or
  regaining a network asks for status and reconnects at once if nothing comes back within 3.5 s. Reconnecting is
  only a new WebSocket; it sends no command. `npm run e2e` covers it with the fake printer's `/__silence` switch.
- **Why the app disconnected so often (2026-11-24 analysis).** Most likely, in order: (1) half-dead sockets after
  wifi power-save / phone sleep were never noticed (fixed above); (2) Android freezes the page in the background,
  so the reconnect timer itself stalled until the back-off ran out (fixed: reconnect on resume); (3) every control
  reconnect also restarted the camera, and the printer holds on to closed video viewers, so blips used up camera
  slots (fixed: the camera stream is independent of the control connection and is never duplicated); (4) the
  printer's own `wlan0 lan disconnected` flapping (below), which the app cannot fix but now recovers from quickly.
- **Files tab failed twice against the real printer** ("did not answer command 258 within 8s"). The printer's log
  shows it did answer; the reply was lost because the printer's link dropped. During that test the firmware logged
  `wlan0 lan connected` then `wlan0 lan disconnected` about every 20 s, while the kernel and `wpa_cli` reported a
  healthy wifi link. Cause not found; it was not happening earlier the same day.
- A 404 for one resource is logged in the browser console on load. Not identified; probably the Moonraker probe to
  `/server/info`, which is expected on this firmware.
- `tools/probe.py`'s `WS` class mishandles WebSocket continuation frames (large replies). `capture.py` has the fixed
  reader `WS2`; port it across.
- `test/fake-printer.mjs` and the unit tests still use guessed message shapes. Replace them with the real fixtures.
- `test/real-smoke.mjs` needs `playwright-core`, which is not in `package.json`.

## 7. Suggested direction

a. **Make the printer-hosted `/cc/` build the main way to use the app at home**, now that the installer works
   (section 4). Next, find a home that survives firmware updates: for example keep the files under `/user-resource/`
   and re-link them into the web root from a `/kip/etc/init.d/` boot script, or serve them straight from `/local/...`
   if the stock server returns `.html` from there with a usable content type (untested).
b. **Add the dead-link check** (section 6).
c. **Add the quick wins from the command table**, all with stock-page payloads: power-loss resume prompt on connect
   (134, then 135), file detail before printing (260, with the caveats above), rename a file (257), delete history
   entries (322), turn the camera stream off when leaving the camera view (386 `Enable: 0`).
d. **Use the real fixtures in the tests.**
e. **Investigate a small helper running on the printer** (`/kip/bin/python3.13`, autostart through `/kip/etc/init.d/`)
   to offer what LAN SDCP lacks: a filtered tail of the firmware log for the stuck-state assistant, wifi signal
   (`wpa_cli -i wlan0 signal_poll`), and possibly the built-in Klipper API server for raw G-code. Research only: RAM
   is very tight, and anything that needs `/app/app` restarted is a risk to a running print.

## 8. Open questions

- Does upload from `/cc/` read the printer's replies, and how slow is a chunked upload on this server?
- Does `/cc/` survive a reboot and a firmware update? Exactly what does a firmware update wipe?
- Can the built-in Klipper API server be enabled? How is `/app/app` launched (`/proc/<pid>/cmdline` was not read)?
- Which controller is on `/dev/ttyACM0` and which on `/dev/ttyS4`?
- The format of `/board-resource/machine_info.bin` (print history).
- Are temperatures logged during a print? Only idle and probing sections of the log were sampled.
- Does the stock server serve `.html` from `/local/`?
- Time-lapses should appear under `http://<printer>/local/aic_tlp/`. Untested; the folder did not exist yet.
- Payloads for Cmd 192, 255, 387, 503 and 64, and whether `TempTargetBox` or `MainLight` do anything.
- Whether the firmware reacts to leftover `coredump-*` files (the binary has a `has_coredump_files` check near its cloud code).
- Why the firmware's "LAN up" judgement flapped every 20 s on a healthy wifi link (section 6).
- Does Z offset work mid-print? Verified only with the printer idle.
- The Android build has not been tested against the real printer since these findings.

## Releasing

Bump `version` in `package.json` (and `versionCode` / `versionName` in `android/app/build.gradle`),
add a "New in vX.Y.Z" section to `docs/release/notes.md`, and push to `main`. The build creates the
`vX.Y.Z` tag and the GitHub release with the APK, printer zip and web zip when no release for that
version exists yet. Pushing a `v*` tag, or publishing a release on the website, also works.

