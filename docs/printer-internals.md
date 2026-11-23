# Centauri Carbon internals (read-only reconnaissance)

Probed 2026-11-23 over the OpenCentauri bind shell (TCP 4567) on 192.168.1.50, stock firmware 1.4.49 with the OpenCentauri patch. Nothing was written, killed or signalled on the printer. The printer was idle with one file loaded.

"Verified" means seen directly in command output. "Inferred" means deduced from strings in `/app/app` (`printer-dump/app-strings.txt`) or from scripts, and not tested.

Practical note for tooling: the bind shell appears to serve one connection at a time. Two `rsh.py` calls launched in parallel gave one `TimeoutError` on connect and one mid-command hang. Run commands sequentially.

---

## 1. G-code injection path

**Bottom line: no ready-made local channel for raw G-code was found.** There is no unix socket, FIFO or pty belonging to the app that accepts G-code. The Klipper API-server code is compiled into the binary but no socket for it exists at runtime.

### Verified

`pidof app` = 1544. Non-trivial entries of `ls -la /proc/1544/fd`:

| fd | target | what it is (inferred) |
|---|---|---|
| 10, 11 | `/dev/rpmsg_ctrl0`, `/dev/rpmsg0` | link to the on-chip DSP core that runs the main Klipper MCU firmware (log calls it `mcu`, 200 MHz clock) |
| 15 | `/dev/ttyACM0` | USB CDC serial to a second MCU |
| 18 | `/dev/ttyS4` | UART to another MCU (log shows an `stm32` at 84 MHz; which of ttyACM0/ttyS4 it is was not determined) |
| 7 | `/dev/dsp_debug` | DSP debug device |
| 8, 9 | `/dev/kbuf-mgr-0`, `/dev/kbuf-map-1-test` | shared memory with the DSP |
| 57 | `/dev/video0` | camera (app owns it) |
| 3 | `/board-resource/log2` | current log file |
| 34 | `/board-resource/wlan_entery` | wifi credential store |
| 35 | `/tmp/udhcpc.status` | FIFO, DHCP status only |
| 21 | `/dev/input/event1` | touchscreen |
| 4 | `/dev/fb0` | display |
| 58, 59 | unix sockets `/tmp/wpa_ctrl_1544-1`, `-2` | wpa_supplicant control, not printer control |
| many | anonymous pipes and sockets | internal thread wake-ups / socketpairs |

All named unix sockets on the system (`cat /proc/net/unix`): `/var/run/dbus/system_bus_socket`, `/tmp/run/udev/control`, `/var/run/wpa_supplicant/wlan0`, `/tmp/wpa_ctrl_1544-1`, `/tmp/wpa_ctrl_1544-2`, `/dev/log`, `/var/run/ubus.sock`. None is a Klipper/Moonraker-style socket.

Only FIFO in `/tmp`: `udhcpc.status`. `/dev/pts` is empty (only `ptmx`). Serial nodes present: `/dev/ttyS0`, `/dev/ttyS3`, `/dev/ttyS4`, `/dev/ttyACM0`.

Listening TCP (`netstat -ltnp`): 80, 3030, 3031 (all `app`), 22 (sshd), 4567 (bind-shell). Nothing bound to localhost only.

### Inferred from strings

- The app is a C++ port of Klipper (`.../core/klippy/gcode.cpp`, `webhooks`, `GCodeDispatch`, etc.). It contains the Klipper webhooks endpoint names: `gcode/script`, `gcode/help`, `gcode/restart`, `gcode/firmware_restart`, `gcode/subscribe_output`, `objects/list`, `objects/query`, `objects/subscribe`, `list_endpoints`, `register_remote_method`, next to the strings `apiserver`, `debuginput`, `ServerSocket`, `bind ok !`, `listen ok`, `hello, im server`. In stock Klipper, `apiserver` and `debuginput` are start-up options (`-a <socket path>`, `-I <fifo path>`). Since no such socket or FIFO exists at runtime, the feature looks compiled in but not enabled. Whether it can be switched on (command-line argument, config key) was not determined; `/proc/1544/cmdline` was not checked.
- `/tmp/klipper_host_` appears as a path prefix in `mcu.cpp` strings; no such file exists in `/tmp` now.
- The SDCP websocket (port 3030) command table, from the `desc` strings: request status, request attribute, start print, pause print, stop print, resume print, edit machine name, file trans stop, get file list, del file list, get file info, get history, get detail, del history, video export, material info get, stream live, enable/disable tlp, set machine status, rename file. No raw G-code command.
- Internally a print is started with `SDCARD_PRINT_FILE FILESLICE=%d FILENAME="%s"`.

### Candidates for later (none tested, none written to)

1. **Upload-and-print a tiny G-code file** (safest, uses only supported paths): put a few-line `.gcode` in `/user-resource` (via the normal upload, or the shell) and start it with the SDCP "start print" command. Works only when the printer is idle and it shows up as a print job and in history.
2. **Enable the built-in Klipper API server / debug input**, if a launch option exists. Needs study of how `/app/app` is started (init script, arguments) and would require restarting the app. Unverified that it works at all.
3. **Direct MCU access** via `/dev/rpmsg0`, `/dev/ttyACM0`, `/dev/ttyS4`: not usable. These carry Klipper's binary MCU protocol and are held open by the app; writing to them would corrupt the stream.
4. OpenCentauri/community patches to the app may add a G-code console; not investigated here.

---

## 2. Logs

### Verified

```
/board-resource/log  -> /board-resource/log2   (symlink to the active file)
/board-resource/log1    8388103 bytes  (full, last written Nov 23 04:42)
/board-resource/log2    5715854 bytes  (active, app fd 3)
```

Two-file rotation at about 8 MB each. Plain text with some Chinese messages and ANSI colour codes. Line format:

```
[module][source line][Level][milliseconds since boot]:message
```

Timestamps are uptime in ms, not wall-clock. Levels seen: Debug, Info, Warn.

Excerpt from the end of `log1` (bed probing):

```
[probe][174][Debug][36165882]:probe at 20.000,65.200 is z=1.248876
[probe][310][Debug][36165882]:PrinterProbe samples exceed tolerance. Retrying... MAX:1.248876 MIN:-1.387492 samples_tolerance:0.015000
[HX711][654][Info][36166293]:calibration ok! at: 36166.293302
```

Excerpt from the end of `log2` (idle, client connected):

```
[clocksync][282][Warn][33956602]:Ignoring clock sample sent_time:33956.602: freq=200000002.786474 diff=22368 stddev=2331.474 mcu
[hl_net][1561][Info][33967141]:wlan0 lan disconnected
[hl_net][1551][Info][33967145]:wlan0 lan connected
Generating coredump for PID 31219, executable 1795427524...
[sdcp_v3_handler][3102][Debug][33990623]:map[187] - desc : request status
[sdcp_v3_handler][448][Debug][33990670]:{"Id":"...","Data":{"Cmd":0,"Data":{"Ack":0},"RequestID":"...","MainboardID":"..."
```

Module mix in the last 4000 lines of `log2`: sdcp_v3_handler 1370, clocksync 1210, sdcp_v3 715, hl_net 448, ota 132, app 47, hl_net_tool 27, then small counts for idle_timeout, srv_status, corexy, app_msgbox, switch_sensor, fan_cover_sensor, buttons, multi_color_observer, cut_sensor, filament_wrap_sensor.

What it logs: every SDCP request with its description and the JSON reply, network up/down, probing and strain-gauge detail, sensor events (filament switch, cover fan, cutter, wrap sensor), idle timeout, message boxes shown on screen, OTA checks. No periodic temperature lines were seen in the sampled sections.

Things worth a look that showed up:
- `Generating coredump for PID 31219` - some process crashed and dumped core (not the main app, which is still PID 1544). Which program was not determined. Strings show core dumps are collected as `/user-resource/coredump-*.gz`.
- `wlan0 lan disconnected` / `connected` 4 ms apart, and frequent `clocksync ... Ignoring clock sample` warnings.

`logread | tail` (system log) is useless: it is flooded by a USB-stick polling loop:

```
user.notice procd: ls: /dev/sd[a-z]: No such file or directory
user.notice procd: No USB stick found or already mounted
user.notice procd: Looping...
```

### Assessment (inferred)

Useful for a "why is it stuck" view: `tail` the file behind `/board-resource/log`, drop `clocksync` and `sdcp_v3*` lines, and show `app_msgbox`, the sensor modules, `probe`, `HX711`, `hl_net` and anything at Warn level. It is only reachable through the shell (or ssh); `/board-resource/log*` is not in the HTTP mappings. Convert timestamps with the boot time (uptime).

---

## 3. Camera

### Verified

- `/sys/class/video4linux/video0` and `video1`: both named `Integrated Camera: Integrated C`, index 0 and 1, same USB device **05a3:9230**, manufacturer string `SML-FAY-250121`, product `Integrated Camera`, USB high speed (480). video1 is the usual UVC metadata node of the same camera (inferred from index 1 on the same device).
- No `v4l2-ctl` in `/usr/bin` or `/kip/bin` (a wider `find` was not run).
- The app holds `/dev/video0` open (fd 57).
- `/user-resource/aic_tlp` and `/board-resource/video_mp4` do not exist at the moment, so there are no time-lapse videos stored.

### Inferred from strings

- Stream: `Starting MJPEG stream listener on http://0.0.0.0:3031/video`. Client limit and readiness are enforced (`/video reject: too many client`, `/video reject: camera not ready`); status fields `NumberOfVideoStreamConnected`, `MaximumVideoStreamAllowed`.
- Capture: the app requires YUYV (`camera can't support V4L2_PIX_FMT_YUYV`), enumerates frame sizes and sets the frame rate itself. No literal resolution string was found, so **the stream resolution is not determined from strings**; measure it from a frame of the 3031 stream.
- No brightness/exposure setting strings; the only camera-adjacent control is the light (`camera control light error!!!`).
- Time-lapse: frames go to `%s/tlp_layer_%d`, are assembled in `/board-resource/video_mp4/%s` as `.mp4.tmp` then `.mp4`, and finished videos are moved to **`/user-resource/aic_tlp/<name>.mp4`**. Because `/local` maps to `/user-resource`, they should be downloadable at `http://<printer>/local/aic_tlp/<name>.mp4` (untested, no video present). SDCP exposes `TimeLapseVideoStatus`, `TimeLapseVideoUrl`, `TimeLapseVideoSize`, `TimeLapseVideoDuration`, plus settings `TLPNoCapPos`, `TLPStartCapPos`, `TLPInterLayers`.

---

## 4. Files a companion app can read

### Verified

- **G-code files**: flat in `/user-resource/` (HTTP `/local/`), named by the slicer, e.g. `ECC_0.4_Model Name 001_PLA _0.2_1h2m.gcode`. Sizes from 0.5 MB to 80 MB. Other entries there: `file_info/`, `.kipware/`, `.root/`, `lost+found/`.
- **Current thumbnail**: `/tmp/thumbnail/` (HTTP `/thumbnail/`) holds one file, `<gcode file name>.png`, 2647 bytes - only for the loaded/last file, and it is in RAM so it is gone after a reboot. String: `/tmp/thumbnail/%s.png`.
- **History**: `/board-resource/machine_info.bin`, 382120 bytes, binary (string: `machine_info.print_history_valid_numbers`). Not served over HTTP; use SDCP "get history" / "get detail" instead.
- **History thumbnails**: `/board-resource/history_image/`, 50 files named `<uuid>.png` (served over HTTP at `/board-resource/history_image/<uuid>.png`).
- **File metadata cache** (inferred): `/user-resource/file_info/file_info.txt`.

G-code header format (OrcaSlicer 2.4.0), first lines of one file:

```
; HEADER_BLOCK_START
; generated by OrcaSlicer 2.4.0 on 2026-07-24 at 15:59:19
; total layer number: 29
; filament_density: 1.25
; filament_diameter: 1.75
; max_z_height: 2.95
; filament: 1
; HEADER_BLOCK_END

; THUMBNAIL_BLOCK_START

;
; thumbnail begin 144x144 3836
; iVBORw0KGgoAAAANSUhEUgAAAJAAAACQCAYAAADnRuK4AAALAklEQVR4Ae2d+VIc1xXGu1zIBJCEBM
...
; thumbnail end
```

Block positions in that file: `HEADER_BLOCK_START` line 1, `HEADER_BLOCK_END` line 8, `thumbnail begin 144x144 3836` line 13 (base64 PNG, 3836 base64 characters, each line prefixed `; `), `thumbnail end` line 64, `EXECUTABLE_BLOCK_START` line 74, `CONFIG_BLOCK_START` line 18131 (slicer settings at the end of the file). A companion app can get the thumbnail and layer count by reading just the first ~6 KB over HTTP (range request, if the server supports it - untested).

---

## 5. System facts

### Verified

- CPU: 2 cores, `ARMv7 Processor rev 5 (v7l)`, CPU part 0xc07 (Cortex-A7), NEON/VFPv4. Allwinner SoC (inferred from `/dev/sunxi-*` nodes).
- Uptime 9 h 26 min, load average 0.29 / 0.19 / 0.11 (idle).
- Hostname `OpenCentauri` (DHCP hostname sent is `Centauri-Carbon`).
- Clock: `Mon Nov 23 17:52:09 CST 2026`; `/tmp/localtime -> /usr/share/zoneinfo/Asia/Shanghai`. The printer runs on China time, not local time; file dates must be converted.
- Wifi: `/proc/net/wireless`, `iwconfig` and `iw` are absent. `wpa_cli -i wlan0 signal_poll` works: `RSSI=-59`, `LINKSPEED=87`, `FREQUENCY=5620`, `WIDTH=80 MHz` (5 GHz).
- Cron: `/etc/crontabs` is empty, so crond does not start (the init script returns if it is empty).
- Mounts: `/` is an overlay with upper layer on `/dev/by-name/rootfs_data` (`/overlay`); `/user-resource` is `/dev/by-name/UDISK` (ext4); `/board-resource` is `/dev/by-name/user` (ext4).

### Boot scripts (from the local dump, `printer-dump/configs`)

`/etc/rc.d/S85oc-bootstrap` (same as `/etc/init.d/oc-bootstrap`): waits for `/user-resource`, creates `/user-resource/.root` and `/user-resource/.kipware`, bind-mounts them on `/root` and `/kip`, unpacks `/app/kipware.tar.gz` on first run, puts `/kip/sbin:/kip/bin` on PATH, generates ssh host keys, sets `PermitRootLogin yes`, runs `/kip/etc/init.d/rc.unslung start` (Entware-style service start-up), then runs `/app/oc-startwifi.sh &`.

`/app/oc-startwifi.sh`: extracts saved networks from `/board-resource/wlan_entery` with `wifi-network-config-tool`, writes them to `/tmp/wlan_entery_str`, kills the old udhcpc/wpa_supplicant, loads wifi modules (`aic_load_fw`, `aic8800_fdrv`, `8821cu`, `8723du`), starts `wpa_supplicant`, adds the networks through `wpa_cli`, then starts `udhcpc` with hostname `Centauri-Carbon`.

Security note: `/tmp/wlan_entery_str` holds the wifi SSID and password in plain text and is world-readable (mode 0644). It was not read and no password is recorded here. Combined with the unauthenticated root shell on 4567, anyone on the LAN can read it.

### Where a helper could live later (inferred, nothing installed)

- **`/user-resource/.kipware` (= `/kip`) and `/user-resource/.root` (= `/root`)**: on the 6.5 GB data partition, outside the root filesystem, and re-mounted by the bootstrap script on every boot. This is where OpenCentauri keeps its own tools, so it is the most likely place to survive a firmware update. `/kip/etc/init.d/` is started by `rc.unslung` at boot, which gives an autostart hook for a helper script.
- **Static web page**: anything under `/user-resource` is served by the stock HTTP server at `/local/...`. A page placed in, say, a subfolder of `/user-resource` should be reachable at `http://<printer>/local/<folder>/page.html` without touching `/app/resources/www`. Untested; also unknown whether the printer's file list would show the folder, and whether the server sends a usable content type for `.html`.
- **`/app` and `/etc`** live on the root overlay. They survive reboots, but a firmware update is expected to replace them (the OpenCentauri hooks themselves sit there, and `uninstall.sh` in `/app` removes only `/user-resource/OpenCentauri`). Not confirmed by any script that the overlay is wiped on update.
- `/tmp` is RAM and tiny; not for anything persistent.

---

## Not determined

- Whether the compiled-in Klipper `apiserver` / `debuginput` can be enabled, and how `/app/app` is launched.
- Which MCU is on `/dev/ttyACM0` versus `/dev/ttyS4`.
- Camera stream resolution and frame rate (no strings; needs a frame from port 3031).
- Which program produced the core dump (PID 31219).
- Whether the HTTP server supports range requests and serves `.html` from `/local`.
- Exactly what a firmware update erases.
- Format of `machine_info.bin`.
- Whether temperatures are ever written to the log during a print (the sampled sections were idle or probing).
