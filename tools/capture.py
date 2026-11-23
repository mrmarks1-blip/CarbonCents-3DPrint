#!/usr/bin/env python3
"""Capture real replies from a Centauri Carbon as test fixtures.

    python capture.py 192.168.1.50

Read-only. Sends ONLY the commands the stock web page sends, with the exact
payloads listed in STEPS below. If the printer is not idle it asks for status
and attributes and stops. Output: test/fixtures/real-1.4.49/*.json
"""
import json, os, socket, sys, time, urllib.error, urllib.parse, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from probe import WS  # noqa: E402

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
HOST = ARGS[0] if ARGS else "192.168.1.50"
HISTORY_ONLY = "--history" in sys.argv  # only Cmd 0, 1, 320, 321, 324 and the history thumbnail
OUT = os.path.join(HERE, "..", "test", "fixtures", "real-1.4.49")
os.makedirs(OUT, exist_ok=True)
SUMMARY = {"host": HOST, "started": time.strftime("%Y-%m-%d %H:%M:%S"), "timings_ms": {}, "errors": []}
T0 = time.time()


def save(name, obj):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)


def err(where, e):
    line = f"{where}: {type(e).__name__}: {e}"
    print("ERROR", line)
    SUMMARY["errors"].append(line)


def parse(raw):
    if "{" not in raw:
        return {"raw": raw}
    try:
        return json.loads(raw[raw.index("{"):])
    except ValueError:
        return {"unparsed": raw}


class WS2(WS):
    """probe.WS with a reader that survives timeouts mid-frame and reassembles
    fragmented messages (the printer splits large replies into continuation frames)."""

    parts = b""

    def _frame(self):
        b = self.buf
        if len(b) < 2:
            return None
        n, i = b[1] & 0x7F, 2
        if n == 126:
            if len(b) < 4:
                return None
            n, i = int.from_bytes(b[2:4], "big"), 4
        elif n == 127:
            if len(b) < 10:
                return None
            n, i = int.from_bytes(b[2:10], "big"), 10
        mask = None
        if b[1] & 0x80:
            if len(b) < i + 4:
                return None
            mask, i = b[i:i + 4], i + 4
        if len(b) < i + n:
            return None
        payload, self.buf = b[i:i + n], b[i + n:]
        if mask:
            payload = bytes(c ^ mask[k % 4] for k, c in enumerate(payload))
        return b[0] & 0x80, b[0] & 0x0F, payload

    def recv(self, timeout=3.0):
        end = time.time() + timeout
        while True:
            fr = self._frame()
            if fr is None:
                left = end - time.time()
                if left <= 0:
                    return None
                self.s.settimeout(left)
                try:
                    chunk = self.s.recv(65536)
                except socket.timeout:
                    return None
                if not chunk:
                    raise ConnectionError("closed by printer")
                self.buf += chunk
                continue
            fin, op, payload = fr
            if op == 0x8:
                raise ConnectionError(f"printer closed the connection: {payload!r}")
            if op == 0x9:  # ping -> pong
                m = os.urandom(4)
                self.s.sendall(bytes([0x8A, 0x80 | len(payload)]) + m + bytes(c ^ m[k % 4] for k, c in enumerate(payload)))
                continue
            if op in (0x0, 0x1, 0x2):
                self.parts += payload
                if fin:
                    text, self.parts = self.parts.decode(errors="replace"), b""
                    return text


class Link:
    def __init__(self, host):
        t = time.time()
        self.ws = WS2(host, 3030, "/websocket", timeout=10.0)
        SUMMARY["timings_ms"]["ws_connect"] = round((time.time() - t) * 1000)
        self.board = ""
        self.status = None

    def note(self, msg):
        self.board = self.board or msg.get("MainboardID") or (msg.get("Data") or {}).get("MainboardID", "") or ""
        st = msg.get("Status") or (msg.get("Data") or {}).get("Status")
        if isinstance(st, dict):
            self.status = st

    def call(self, cmd, data, fixture, wait=10.0, linger=0.8):
        rid = uuid.uuid4().hex
        envelope = {"Id": "", "Data": {"Cmd": cmd, "Data": data, "RequestID": rid, "MainboardID": self.board, "TimeStamp": int(time.time() * 1000), "From": 1}}
        sent = time.time()
        self.ws.send(json.dumps(envelope))
        reply, elapsed, pushed, end = None, None, [], sent + wait
        while time.time() < end:
            raw = self.ws.recv(max(0.05, end - time.time()))
            if raw is None:
                break
            at = round((time.time() - sent) * 1000)
            msg = parse(raw)
            self.note(msg)
            if (msg.get("Data") or {}).get("RequestID") == rid and reply is None:
                reply, elapsed = msg, at
                end = min(end, time.time() + linger)
            else:
                pushed.append({"at_ms": at, "message": msg})
        rec = {"cmd": cmd, "request_data": data, "request_envelope": envelope, "reply_ms": elapsed, "reply": reply, "pushed_meanwhile": pushed}
        save(fixture, rec)
        SUMMARY["timings_ms"][fixture] = elapsed
        print(f"Cmd {cmd} {json.dumps(data)[:80]} -> {elapsed} ms, pushed {len(pushed)}, reply {json.dumps((reply or {}).get('Data', {}).get('Data'))[:160] if reply else None}")
        return ((reply or {}).get("Data") or {}).get("Data"), rec


def camera(host):
    info = {}
    s = socket.create_connection((host, 3031), timeout=8)
    try:
        s.sendall(f"GET /video HTTP/1.1\r\nHost: {host}:3031\r\n\r\n".encode())
        s.settimeout(1.0)
        data, start, stamps, seen = b"", time.time(), [], 0
        while time.time() - start < 5.0:
            try:
                chunk = s.recv(65536)
            except socket.timeout:
                continue
            if not chunk:
                info["closed_early_s"] = round(time.time() - start, 2)
                break
            data += chunk
            n = data.count(b"\xff\xd9")
            if n > seen:
                stamps += [round(time.time() - start, 3)] * (n - seen)
                seen = n
    finally:
        s.close()
    head, _, body = data.partition(b"\r\n\r\n")
    info["response_head"] = head.decode(errors="replace").split("\r\n")
    info["bytes_received"] = len(data)
    info["first_part_head"] = body[:body.find(b"\xff\xd8")].decode(errors="replace") if b"\xff\xd8" in body else body[:300].decode(errors="replace")
    frames, pos = [], 0
    while True:
        a = body.find(b"\xff\xd8", pos)
        b = body.find(b"\xff\xd9", a + 2) if a >= 0 else -1
        if a < 0 or b < 0:
            break
        frames.append(body[a:b + 2])
        pos = b + 2
    info["frames"] = len(frames)
    info["frame_arrival_s"] = stamps
    if frames:
        info["avg_frame_bytes"] = round(sum(map(len, frames)) / len(frames))
        info["min_frame_bytes"], info["max_frame_bytes"] = min(map(len, frames)), max(map(len, frames))
        if len(stamps) > 1 and stamps[-1] > stamps[0]:
            info["fps"] = round((len(stamps) - 1) / (stamps[-1] - stamps[0]), 2)
        f = frames[len(frames) // 2]
        with open(os.path.join(OUT, "camera-frame.jpg"), "wb") as fh:
            fh.write(f)
        i = 2
        while i + 9 < len(f) and f[i] == 0xFF:
            m, ln = f[i + 1], int.from_bytes(f[i + 2:i + 4], "big")
            if m in (0xC0, 0xC1, 0xC2):
                info["sof_marker"] = hex(m)
                info["height"], info["width"] = int.from_bytes(f[i + 5:i + 7], "big"), int.from_bytes(f[i + 7:i + 9], "big")
                break
            if m == 0xDA:
                break
            i += 2 + ln
    return info


def http(url, headers=None, limit=None, save_as=None):
    rec = {"url": url, "request_headers": headers or {}}
    t = time.time()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "capture", **(headers or {})})
        try:
            r = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as e:
            r = e
        rec["status"] = r.status if hasattr(r, "status") else r.code
        rec["headers"] = r.headers.items()
        rec["headers_ms"] = round((time.time() - t) * 1000)
        body = r.read(limit) if limit else r.read()
        r.close()
        rec["total_ms"] = round((time.time() - t) * 1000)
        rec["bytes_read"] = len(body)
        rec["magic_hex"] = body[:16].hex()
        if save_as:
            with open(os.path.join(OUT, save_as), "wb") as f:
                f.write(body)
            rec["saved_as"] = save_as
        else:
            rec["body_text"] = body.decode("utf-8", errors="replace")
    except Exception as e:  # noqa: BLE001
        rec["error"] = f"{type(e).__name__}: {e}"
        rec["total_ms"] = round((time.time() - t) * 1000)
        err("http " + url, e)
    print("HTTP", url, "->", rec.get("status"), rec.get("bytes_read"), "bytes", rec.get("total_ms"), "ms", rec.get("error", ""))
    return rec


class HistoryDone(Exception):
    pass


def is_idle(st):
    return isinstance(st, dict) and st.get("CurrentStatus") == [0]


def main():
    files, thumbs, detail_thumbs = [], [], []
    p = Link(HOST)
    cam_on = False
    try:
        p.call(0, {}, "cmd-000-status.json")
        p.call(1, {}, "cmd-001-attributes.json")
        if p.status is None:  # give a late status push one more chance, without sending anything
            raw = p.ws.recv(3.0)
            if raw:
                p.note(parse(raw))
        SUMMARY["CurrentStatus"] = (p.status or {}).get("CurrentStatus")
        if not is_idle(p.status):
            SUMMARY["stopped_early"] = "printer not idle (or no status seen); only Cmd 0 and Cmd 1 were sent"
            print(SUMMARY["stopped_early"], SUMMARY["CurrentStatus"])
            return

        if HISTORY_ONLY:  # second pass: history replies arrive late if asked right after Cmd 260
            hist, _ = p.call(320, {}, "cmd-320-history-ids.json", wait=40.0)
            ids = (hist or {}).get("HistoryData") or []
            SUMMARY["history_ids"] = len(ids)
            for n, i in enumerate(range(0, len(ids), 20), 1):
                d, _ = p.call(321, {"Id": ids[i:i + 20]}, f"cmd-321-history-detail-{n}.json", wait=40.0)
                thumbs += [h.get("Thumbnail") for h in (d or {}).get("HistoryDetailList") or [] if isinstance(h, dict) and h.get("Thumbnail")]
            p.call(324, {}, "cmd-324-material.json", wait=40.0)
            raise HistoryDone()

        # Silent listen: does the printer push anything unprompted?
        heard, start = [], time.time()
        while time.time() - start < 20.0:
            raw = p.ws.recv(max(0.05, 20.0 - (time.time() - start)))
            if raw is None:
                break
            msg = parse(raw)
            p.note(msg)
            heard.append({"at_s": round(time.time() - start, 3), "message": msg})
        save("silent-listen-20s.json", {"note": "After one Cmd 0 and one Cmd 1, nothing was sent for 20 s (no ping either). Every message received is listed.", "seconds": 20, "count": len(heard), "messages": heard})
        SUMMARY["unprompted_messages_in_20s"] = len(heard)
        SUMMARY["unprompted_at_s"] = [h["at_s"] for h in heard]
        SUMMARY["unprompted_topics"] = sorted({str(h["message"].get("Topic", h["message"].get("raw", "?")))[:60] for h in heard})
        print("silent listen:", len(heard), "messages")

        if not is_idle(p.status):
            SUMMARY["stopped_early"] = "printer left idle during the listen"
            return

        local, _ = p.call(258, {"Url": "/local"}, "cmd-258-filelist-local.json")
        p.call(258, {"Url": "/usb"}, "cmd-258-filelist-usb.json")
        files = [f["name"] for f in (local or {}).get("FileList") or [] if isinstance(f, dict) and f.get("type") != 0 and isinstance(f.get("name"), str)]
        gcodes = [n for n in files if n.lower().endswith(".gcode")] or files
        for i, name in enumerate(gcodes[:2], 1):
            d, _ = p.call(260, {"Url": name}, f"cmd-260-filedetail-{i}.json")

            def walk(o):
                if isinstance(o, dict):
                    for k, v in o.items():
                        if "thumb" in k.lower() and isinstance(v, str) and v:
                            detail_thumbs.append(v)
                        walk(v)
                elif isinstance(o, list):
                    for v in o:
                        walk(v)
            walk(d)

        hist, _ = p.call(320, {}, "cmd-320-history-ids.json")
        ids = (hist or {}).get("HistoryData") or []
        SUMMARY["history_ids"] = len(ids)
        for n, i in enumerate(range(0, len(ids), 20), 1):
            d, _ = p.call(321, {"Id": ids[i:i + 20]}, f"cmd-321-history-detail-{n}.json", wait=15.0)
            thumbs += [h.get("Thumbnail") for h in (d or {}).get("HistoryDetailList") or [] if isinstance(h, dict) and h.get("Thumbnail")]

        p.call(324, {}, "cmd-324-material.json")
        p.call(134, {}, "cmd-134-powerloss.json")

        cam_on = True
        p.call(386, {"Enable": 1}, "cmd-386-camera-enable.json")
        try:
            time.sleep(0.5)
            cam = camera(HOST)
        except Exception as e:  # noqa: BLE001
            cam = {"error": f"{type(e).__name__}: {e}"}
            err("camera", e)
        save("camera-stream.json", cam)
        SUMMARY["camera"] = {k: v for k, v in cam.items() if k not in ("frame_arrival_s",)}
        print("camera:", json.dumps(SUMMARY["camera"])[:600])
    except HistoryDone:
        pass
    except Exception as e:  # noqa: BLE001
        err("websocket phase", e)
    finally:
        if cam_on:
            try:
                p.call(386, {"Enable": 0}, "cmd-386-camera-disable.json")
            except Exception as e:  # noqa: BLE001
                err("camera disable", e)
        p.ws.close()

    # HTTP on port 80, after the control link is closed. GET only.
    recs = {}
    if HISTORY_ONLY:
        try:
            recs = json.load(open(os.path.join(OUT, "http-port80.json"), encoding="utf-8"))
        except Exception:  # noqa: BLE001
            recs = {}
    origin = {"Origin": "http://localhost"}

    def local_url(u):
        path = urllib.parse.urlsplit(u).path if "://" in u else u
        return f"http://{HOST}" + urllib.parse.quote(path if path.startswith("/") else "/" + path)

    if thumbs:
        recs["history_thumbnail"] = {"url_in_reply": thumbs[0], **http(local_url(thumbs[0]), origin, save_as="history-thumbnail.png")}
    if detail_thumbs:
        recs["file_detail_thumbnail"] = {"url_in_reply": detail_thumbs[0], **http(local_url(detail_thumbs[0]), origin, save_as="file-detail-thumbnail.png")}
    gc = [n for n in files if n.lower().endswith(".gcode")]
    if gc:
        name = gc[0]
        path = name if name.startswith("/local") else "/local/" + name.lstrip("/")
        recs["gcode_ranged_get"] = {"name_in_258": name, **http(f"http://{HOST}" + urllib.parse.quote(path), {**origin, "Range": "bytes=0-2047"}, limit=2048)}
    save("http-port80.json", recs)
    if HISTORY_ONLY:
        SUMMARY["history_thumbnail"] = {x: recs.get("history_thumbnail", {}).get(x) for x in ("url_in_reply", "url", "status", "headers", "bytes_read", "total_ms", "error")}
        return
    SUMMARY["http"] = {k: {x: v.get(x) for x in ("url", "status", "headers", "bytes_read", "headers_ms", "total_ms", "magic_hex", "error")} for k, v in recs.items()}


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        err("main", e)
    SUMMARY["total_seconds"] = round(time.time() - T0, 1)
    save("capture-summary-history.json" if HISTORY_ONLY else "capture-summary.json", SUMMARY)
    print(json.dumps(SUMMARY, indent=1)[:6000])
