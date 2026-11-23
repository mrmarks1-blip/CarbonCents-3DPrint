# Real replies from a Centauri Carbon, firmware V1.4.49 (OpenCentauri-patched)

> **Note for this public repository:** the printer's MAC address, board ID, wifi name, the Windows user name in
> paths, the LAN addresses and the names of the owner's print files have been replaced with placeholders
> (the printer appears as `192.168.1.50`). The raw `printer-dump/` folder is not uploaded.

Captured on 2026-11-23 from an idle printer with `tools/capture.py` (read-only; only commands the stock web page sends).
A fresh capture contains your printer's IP address, MAC address and mainboard ID. Replace them before publishing, as was done here.

Each `cmd-*.json` holds: `request_data` (the payload), `request_envelope` (exactly what was sent), `reply_ms`,
`reply` (the full message with the matching RequestID) and `pushed_meanwhile` (every other message that arrived
while waiting, plus 0.8 s afterwards).

## Files

| File | What it is | Reply time |
|---|---|---|
| `cmd-000-status.json` | Cmd 0 `{}`. The reply is only `{"Ack":0}`; the status arrives as a separate `sdcp/status/<id>` message about 20 ms later (in `pushed_meanwhile`). | 68 to 303 ms |
| `cmd-001-attributes.json` | Cmd 1 `{}`. Same pattern: `{"Ack":0}` reply, attributes in a separate `sdcp/attributes/<id>` message. | 126 to 136 ms |
| `cmd-258-filelist-local.json` | Cmd 258 `{"Url":"/local"}`. 214 files, all `type` 1, about 67 KB of JSON. | 1660 ms |
| `cmd-258-filelist-usb.json` | Cmd 258 `{"Url":"/usb"}` with no USB stick: `{"Ack":-1}`, no `FileList`. | 83 ms |
| `cmd-260-filedetail-1.json`, `-2.json` | Cmd 260 `{"Url":"/local/<name>.gcode"}` for two files. | 8969 and 8826 ms |
| `cmd-320-history-ids.json` | Cmd 320 `{}`. 50 task ids. | 220 ms |
| `cmd-321-history-detail-1..3.json` | Cmd 321 `{"Id":[...]}` in batches of 20, 20, 10. | 110 to 159 ms |
| `cmd-324-material.json` | Cmd 324 `{}`: `{"active_canvas_id":0,"active_tray_id":-1,"auto_refill":1,"canvas_list":[],"Ack":0}` (no multi-colour unit attached). | 134 ms |
| `cmd-134-powerloss.json` | Cmd 134 `{}`: `{"Ack":0}`. Its `pushed_meanwhile` also holds the late Cmd 320 and Cmd 324 replies from the first pass (see "Surprising"). | 376 ms |
| `cmd-386-camera-enable.json` | Cmd 386 `{"Enable":1}`: `{"Ack":0,"VideoUrl":"192.168.1.50:3031/video"}` (no scheme in the URL). | 64 ms |
| `cmd-386-camera-disable.json` | Cmd 386 `{"Enable":0}`: `{"Ack":0}`, plus three pushed attributes messages. | 154 ms |
| `silent-listen-20s.json` | 20 s of listening after one Cmd 0 and one Cmd 1, sending nothing. | 0 messages |
| `camera-stream.json`, `camera-frame.jpg` | 5 s read of `http://<ip>:3031/video` and one frame. | |
| `http-port80.json` | Three GETs on port 80 with status, headers, timing. The G-code entry includes the first 2 KB as text. | 20 to 474 ms |
| `history-thumbnail.png` | `/board-resource/history_image/<TaskId>.png`, 144x144, 2647 bytes. | |
| `file-detail-thumbnail.png` | `/thumbnail/<name>.gcode.png` from a 260 reply, 144x144, 2647 bytes. | |
| `capture-summary.json`, `capture-summary-history.json` | Timings and errors of the main pass and of the history pass. | |

Opening the WebSocket took 554 ms, 7880 ms and 2170 ms on three attempts.

## Findings

- **Status is not pushed unprompted.** Nothing arrived in 20 s of silence on an idle printer, and the printer did not close the link although no ping was sent. Polling Cmd 0 is needed. Attributes are pushed without being asked when the number of camera viewers changes (`NumberOfVideoStreamConnected` 1, then 0 after Enable 0).
- **Camera:** 640x360 baseline JPEG (SOF0), about 33 KB per frame (32.8 to 33.1 KB). Response is `HTTP/1.0 200`, `Content-Type: multipart/x-mixed-replace; boundary=--foo`, each part has `Content-Type: image/jpeg` and `Content-Length`. No CORS headers. **Frame rate is not settled:** 13 frames arrived in the first 1.5 s (about 10 fps over that stretch) and then nothing more for the remaining 3.5 s, with the socket still open. That is 2.6 fps over the whole 5 s. Measure again before relying on a number.
- **G-code download works and Range is honoured.** `GET /local/<url-encoded name>` with `Range: bytes=0-2047` returned `206`, `Content-Range: bytes 0-2047/1085790`, `Content-Length: 2048`, `Content-Type: text/plain; charset=utf-8`, an `Etag` of `"<mtime>.<size>"`, in 20 ms. The first 2 KB holds the OrcaSlicer header block and the start of a base64 144x144 thumbnail.
- **No CORS headers on port 80** on any of the three responses, although an `Origin` header was sent. A browser page can show the PNGs in `<img>` but cannot `fetch()` G-code or thumbnails cross-origin.
- **Thumbnails:** the history thumbnail and the 260 thumbnail both return `200 image/png`. The 260 thumbnail's Etag time equals the moment Cmd 260 was sent, so `/thumbnail/...png` appears to be created by Cmd 260 and probably does not exist before it. The 260 URL contains unencoded spaces and `:80`.

## Surprising

- **Cmd 260 takes about 9 s and blocks the printer's command queue.** Cmd 320 and Cmd 324 sent straight after two 260 calls got no reply within 10 s each; both replies turned up more than 10 s late, during Cmd 134. Asked on a fresh connection they answer in 220 ms and 134 ms. The app's 8 s timeout would fire in that situation.
- **Large replies are split into WebSocket continuation frames.** The reader in `tools/probe.py` (class `WS`) ignores continuation frames and loses its place if a timeout lands mid-frame; the first capture attempt failed on the file list for that reason. `tools/capture.py` has a corrected reader (`WS2`). Browsers handle this themselves, so the app is unaffected.
- `TimeStamp` in printer messages is in seconds, while the client sends milliseconds.
- When idle, `PrintInfo` keeps the last job's `CurrentLayer` 129, `TotalLayer` 129, `CurrentTicks` 2509.7 and `TotalTicks` 2531 with `Filename` "", `TaskId` "" and `Progress` 0. The hex-named total-extrusion key is absent when idle.
- `ZOffset` is reported as `1e-14`.
- `XYZsize` in attributes is `"218.88x128.88x220"`, which is not the real build volume.
- The camera's `Expires` header is an unfilled format string: `Expires: Thu, %d %d %d %d:%d:%d GMT`.

Fields present in replies that `src/printer/sdcp.ts` does not read:

- Status: `TimeLapseStatus`, `PlatFormType`, `AmsConnectStatus`, `TempTargetBox`, `LightStatus.RgbLight` (only passed back on writes).
- Attributes: `BrandName`, `ProtocolVersion`, `XYZsize`, `MainboardIP`, `MainboardMAC`, `SDCPStatus`, `NetworkStatus`, `UsbDiskStatus`, `Capabilities`, `SupportFileType`, `DevicesStatus` (`SgStatus`, `ZMotorStatus`, `XMotorStatus`, `YMotorStatus`), `CameraStatus`, `TLPNoCapPos`, `TLPStartCapPos`, `TLPInterLayers`, and the cloud counters.
- File list entries: `LayerHeight` and `EstFilamentLength` (both 0 in every entry looked at). There is no `usedSize`; `FileSize` is what is sent.
- Cmd 260 (not used by the app at all): `FileInfo.Thumbnail`, `EstTime` (s), `EstWeight` (g), `TotalLayers`, `ColorNum`, `AmsNum`, `ColorMapping` (`color`, `ams_id`, `tray_id`).
- History entries: `AlreadyPrintLayer`, `MD5`, `TimeLapseVideoStatus`, `TimeLapseVideoUrl` (holds the G-code path when there is no video), and `SliceInformation.layer_height`, `total_layer_numbers`, `model_size_x/y/z` (sizes are 0).
- Cmd 324: `active_canvas_id`, `active_tray_id`, `auto_refill`, `canvas_list`.
- `/usb` with no stick answers `Ack: -1`, which the app's `cmd()` would turn into "the printer refused"; the app only lists `/local` today.

## Notes on the capture

- First attempt: only the Cmd 0 and Cmd 1 fixtures were valid; the rest failed client-side because of the continuation-frame problem above. The printer was unaffected. Those files were overwritten by the later passes.
- Second pass (main): everything except 320/321/324, which timed out behind Cmd 260.
- Third pass (`python tools/capture.py 192.168.1.50 --history`): Cmd 0, 1, 320, 321 x3, 324. `cmd-000` and `cmd-001` are from this pass.
- The history thumbnail was fetched afterwards with the script's own `http()` helper.
- The printer reported `CurrentStatus: [0]` at the start of every pass, and the camera was switched off again (`NumberOfVideoStreamConnected` back to 0).
