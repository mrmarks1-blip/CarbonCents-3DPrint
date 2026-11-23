# SDCP command table, from this printer's own firmware

Source: the stock web UI and the control binary pulled off the printer at 192.168.1.50
(OpenCentauri-patched 1.4.49) on 2026-11-23. Raw copies are in `printer-dump/`
(`stock-webui/www/*.js`, `app-strings.txt`).

Envelope, sent as text on `ws://<printer>:3030/websocket`:

    {"Id":"","Data":{"Cmd":<n>,"Data":{...},"RequestID":"<32 hex>","MainboardID":"<id>","TimeStamp":<ms>,"From":1}}

The firmware rejects a message with no `RequestID`, `From`, `TimeStamp`, or `Cmd`/`Data`
("request id not found", "from not found", "TimeStamp not found", "cmd or data not found").

## Every command the stock web UI knows

"Payload" is exactly what the stock page sends. "In app" says whether `src/printer/sdcp.ts` uses it today.

| Cmd | Stock name | Payload | In app |
|----:|---|---|---|
| 0 | GET_PRINTER_STATUS | `{}` | yes |
| 1 | GET_PRINTER_ATTR | `{}` | yes |
| 64 | SEND_PRINTER_DISCONNECT | not sent by the page | no |
| 128 | SEND_PRINTER_START_PRINT | `{Filename, StartLayer:0, Calibration_switch:0/1, PrintPlatformType, Tlp_Switch:0/1, slot_map:[{t, canvas_id, tray_id}]}` | yes (`slot_map: []`) |
| 129 | SEND_PRINTER_SUSPEND_PRINT | `{}` | yes |
| 130 | SEND_PRINTER_STOP_PRINT | `{}` | yes |
| 131 | SEND_PRINTER_RESTORE_PRINT | `{}` | yes |
| 134 | GET_BLACKOUT_STATUS | `{}` ; `Ack: 1` means a power-loss job is waiting | **no** |
| 135 | SEND_BLACKOUT_ACTION | `{action: 1}` resume, `{action: 0}` discard | **no** |
| 192 | SEND_PRINTER_EDIT_NAME | (rename the printer; firmware logs "edit machine name", has a length limit) payload not shown in the page | no |
| 255 | SEND_PRINTER_SEND_FILE_END | ("file trans stop") not sent by the page | no |
| 257 | EDIT_PRINTER_FILE_NAME | `{SrcPath: "<name from list>", TargetPath: "<new name>"}` | **no** |
| 258 | GET_PRINTER_FILE_LIST | `{Url: "/local"}` (also `/usb`) | yes |
| 259 | DELETE_PRINTER_FILE_LIST | `{FileList: [...]}` (app also sends `FolderList: []`) | yes |
| 260 | GET_PRINTER_FILE_DETAIL | `{Url: "<file name>"}` ; reply has `FileInfo` with `Thumbnail`, `EstTime`, `EstWeight`, `TotalLayers`, `ColorNum`, `ColorMapping` | **no** |
| 320 | GET_PRINTER_HISTORY_ID | `{}` | yes |
| 321 | GET_PRINTER_TASK_DETAIL | `{Id: [...]}` | yes |
| 322 | DELETE_PRINTER_HISTORY | `{Id: [...]}` | **no** |
| 323 | GET_PRINTER_HISTORY_VIDEO | `{Url: "<time-lapse path>"}` ; asks the printer to export a time-lapse | **no** |
| 324 | GET_MATERIAL_DATA | `{}` ; filament / multi-colour unit info (`canvas_list`, `tray_list`, `filament_name`, `filament_color`, `min/max_nozzle_temp`) | **no** |
| 386 | EDIT_PRINTER_VIDEO_STREAMING | `{Enable: 1}` / `{Enable: 0}` | yes (on only) |
| 387 | EDIT_PRINTER_TIME_LAPSE_STATUS | (time-lapse on/off) payload not shown in the page | no |
| 401 | EDIT_PRINTER_AXIS_NUMBER | `{Axis: "X"/"Y"/"Z", Step: ±mm}` | yes |
| 402 | EDIT_PRINTER_AXIS_ZERO | `{Axis: "X"/"Y"/"Z"/"XYZ"}` | yes |
| 403 | EDIT_PRINTER_STATUS_DATA | one of `{TempTargetNozzle}`, `{TempTargetHotbed}`, `{TargetFanSpeed:{ModelFan,AuxiliaryFan,BoxFan}}`, `{LightStatus:{SecondLight,RgbLight}}`, `{PrintSpeedPct}` ; plus undocumented `{ZOffset}` | yes |
| 503 | GET_FILE_COLOR_DATA | not sent by the page | no |

Status-setter keys the firmware's handler names but the page never sends: `TempTargetBox`, `MainLight`.
Untested; treat as unknown.

## Quick wins for the app (all use payloads the stock page sends)

1. **Power-loss resume** (134 / 135): on connect, ask 134; if `Ack` is 1 offer "resume" or "discard".
2. **File detail before printing** (260): thumbnail, estimated time, filament weight, layer count.
3. **Rename a file** (257) and **delete history entries** (322).
4. **Filament info** (324), if a multi-colour unit is ever fitted.
5. **Turn the camera stream off** when leaving the camera view (386 `Enable: 0`): the printer allows 4 viewers.

## Files over plain HTTP (port 80)

The firmware's web server maps these paths (string in the binary):

    /                                  -> /app/resources/www/        (stock web page)
    /local/...                         -> /user-resource/...         (uploaded G-code)
    /usb/...                           -> /mnt/exUDISK/...           (USB stick)
    /thumbnail/...                     -> /tmp/thumbnail/...         (file thumbnails)
    /board-resource/history_image/...  -> same path on disk          (history thumbnails)

Unknown paths return the stock `index.html`, not a 404, except a few that return a 10-byte 404.
The server is slow and single-minded: an 800 KB file took over a minute and was cut short by a
60 s timeout. Keep requests small and sequential.

Upload is `POST /uploadFile/upload` with form fields `TotalSize`, `Uuid`, `Offset`, `Check`, `S-File-MD5`, `File`.
It answers "device is busy,can't upload" while the printer is busy.

## A second, cloud-only control path exists

The binary also holds handlers named `rtm_*` (Elegoo's cloud / phone app channel) with keys the LAN
protocol lacks: `Zoffset`, `ChamberFanStatus`, `FilamentDetect`, `PoweroffRecovery`, `Light`,
`InputShaper`, `NozzlePid`, `BedLevel` calibration starts, motor unlock and model download by URL.
These are not reachable on port 3030. They show what the firmware can do internally, which matters
if a helper running on the printer itself is ever added.
