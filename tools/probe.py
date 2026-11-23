#!/usr/bin/env python3
"""Read-only probe for an Elegoo Centauri Carbon (stock, OpenCentauri-patched or COSMOS).

    python probe.py 192.168.1.50            # safe: only asks questions
    python probe.py 192.168.1.50 --z-test   # idle only: small Z offset steps (max +0.04 mm), then undone
    python probe.py 192.168.1.50 --z-test --z-zero   # ...finishing at 0 instead of the starting value

Needs Python 3.8+ and nothing else. Works on Windows, Linux and macOS.
Writes everything to centauri-probe-report.txt next to where you run it.

Safety: by default this only sends commands the printer's own web page sends
(status, attributes, file list, history, camera on). It never starts, stops or
changes a print. --z-test refuses to run unless the printer is idle.
"""
import base64, json, os, socket, struct, sys, time, urllib.request, uuid

REPORT = []


def out(*parts):
    line = " ".join(str(p) for p in parts)
    print(line)
    REPORT.append(line)


def section(title):
    out("\n" + "=" * 8, title, "=" * 8)


def tcp_open(host, port, timeout=2.0):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def http_get(url, timeout=4.0, limit=4000):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "probe"}), timeout=timeout) as r:
            return r.status, dict(r.headers), r.read(limit)
    except Exception as e:  # noqa: BLE001 - report every failure verbatim
        code = getattr(e, "code", None)
        return code, dict(getattr(e, "headers", {}) or {}), str(e).encode()


class WS:
    """Minimal WebSocket client (text frames only), so no packages are needed."""

    def __init__(self, host, port, path, origin=None, timeout=6.0):
        self.s = socket.create_connection((host, port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
        if origin:
            req += f"Origin: {origin}\r\n"
        self.s.sendall((req + "\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.s.recv(1024)
            if not chunk:
                break
            head += chunk
        self.status = head.split(b"\r\n")[0].decode(errors="replace")
        self.buf = head.split(b"\r\n\r\n", 1)[1] if b"\r\n\r\n" in head else b""
        if " 101 " not in self.status:
            raise ConnectionError(f"handshake refused: {self.status} {self.buf[:120]!r}")

    def send(self, text):
        data = text.encode()
        mask = os.urandom(4)
        n = len(data)
        head = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n))
        self.s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _need(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise ConnectionError("closed by printer")
            self.buf += chunk
        data, self.buf = self.buf[:n], self.buf[n:]
        return data

    def recv(self, timeout=3.0):
        """One text message, or None on timeout."""
        self.s.settimeout(timeout)
        try:
            while True:
                b0, b1 = self._need(2)
                n = b1 & 0x7F
                if n == 126:
                    n = struct.unpack(">H", self._need(2))[0]
                elif n == 127:
                    n = struct.unpack(">Q", self._need(8))[0]
                payload = self._need(n)
                if b0 & 0x0F == 0x1:
                    return payload.decode(errors="replace")
                if b0 & 0x0F == 0x8:
                    raise ConnectionError("printer closed the connection")
        except socket.timeout:
            return None

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass


class Sdcp:
    def __init__(self, host):
        self.ws = WS(host, 3030, "/websocket")
        self.board = ""
        self.status = None

    def call(self, cmd, data, wait=4.0):
        """Send one command; return (reply Data, other messages seen meanwhile)."""
        rid = uuid.uuid4().hex
        self.ws.send(json.dumps({"Id": "", "Data": {"Cmd": cmd, "Data": data, "RequestID": rid, "MainboardID": self.board, "TimeStamp": int(time.time() * 1000), "From": 1}}))
        reply, extra, end = None, [], time.time() + wait
        while time.time() < end:
            raw = self.ws.recv(max(0.1, end - time.time()))
            if raw is None:
                break
            if "{" not in raw:
                continue
            try:
                msg = json.loads(raw[raw.index("{"):])
            except ValueError:
                extra.append({"unparsed": raw[:200]})
                continue
            self.board = self.board or msg.get("MainboardID") or msg.get("Data", {}).get("MainboardID", "")
            if "Status" in msg:
                self.status = msg["Status"]
            if msg.get("Data", {}).get("RequestID") == rid:
                reply = msg["Data"].get("Data")
                end = min(end, time.time() + 0.8)  # linger briefly for the status push that follows
            else:
                extra.append(msg)
        return reply, extra


def probe_sdcp(host, z_test):
    section("Elegoo protocol (port 3030)")
    try:
        p = Sdcp(host)
    except Exception as e:  # noqa: BLE001
        out("Could not open the control link:", e)
        out("If this says 'too many client' or HTTP 500, the printer's ~5 connection slots are full.")
        return
    out("Handshake:", p.ws.status)
    p.ws.send("ping")
    out("Keepalive: ping ->", p.ws.recv(3.0))

    for name, cmd, data in [("Attributes (Cmd 1)", 1, {}), ("Status (Cmd 0)", 0, {}), ("File list (Cmd 258)", 258, {"Url": "/local"}), ("History ids (Cmd 320)", 320, {})]:
        reply, extra = p.call(cmd, data)
        out(f"\n--- {name} ---")
        out("reply:", json.dumps(reply)[:1500])
        for m in extra:
            out("pushed:", json.dumps(m)[:3000])
        if cmd == 320 and reply and reply.get("HistoryData"):
            detail, _ = p.call(321, {"Id": reply["HistoryData"][:3]})
            out("\n--- History detail (Cmd 321, newest 3) ---")
            out("reply:", json.dumps(detail)[:3000])

    if z_test:
        section("Z offset write test")

        def read_z():
            time.sleep(1.0)
            p.call(0, {})
            return (p.status or {}).get("ZOffset")

        def write_z(value):
            reply, _ = p.call(403, {"ZOffset": value})
            out(f"sent ZOffset {value!r} -> reply {json.dumps(reply)}")
            return read_z()

        near = lambda x, y: abs(x - y) < 1e-4  # the printer reports values like 0.00999999999999
        st = p.status or {}
        c0 = st.get("ZOffset")
        if st.get("CurrentStatus") not in ([0], 0) or st.get("PrintInfo", {}).get("Status") not in (0, 8, 9, None):
            out("Skipped: the printer is not idle. Run this only when idle.")
        elif not isinstance(c0, (int, float)):
            out("Skipped: the printer did not report a ZOffset value.")
        else:
            step = 0.02
            goal = 0.0 if "--z-zero" in sys.argv else c0  # where to leave the offset afterwards
            base, r1, mode = c0, None, None
            if abs(c0) < 1e-4:
                # From zero, "new value" and "change" give the same result, so move off zero first.
                out(f"ZOffset is zero; stepping to {step} first.")
                base = write_z(step)
                out("ZOffset after:", repr(base))
            if not isinstance(base, (int, float)) or abs(base) < 1e-4:
                out("RESULT: UNCHANGED. This firmware ignored the write.")
            else:
                out(f"ZOffset now: {base!r}. Sending {base + step:.3f} to see whether the printer treats it as the new value or as a change.")
                r1 = write_z(round(base + step, 3))
                out("ZOffset after:", repr(r1))
                if not isinstance(r1, (int, float)):
                    out("RESULT: no ZOffset reported afterwards.")
                elif near(r1, base):
                    out("RESULT: UNCHANGED on the second write; not sending anything else.")
                elif near(r1, base + step):
                    mode = "absolute"
                elif near(r1, 2 * base + step):
                    mode = "relative"
                else:
                    out("RESULT: unexpected value; not sending anything else.")
            if mode:
                out(f"RESULT: writes WORK and the value is {mode.upper()}" + (" (the number sent becomes the offset)." if mode == "absolute" else " (the number sent is added to the offset)."))
                out(f"Returning the offset to {goal!r}.")
                back = write_z(round(goal, 3) if mode == "absolute" else round(goal - r1, 3))
                if isinstance(back, (int, float)) and near(back, goal):
                    out("RESULT: returned to", repr(back))
                else:
                    out("RESULT: the printer IGNORED the return to", repr(goal), "- it is at", repr(back), "- set it on the touchscreen.")
            out("Final ZOffset:", repr((p.status or {}).get("ZOffset")), "- compare with the touchscreen.")
    p.ws.close()

    section("Origin check on port 3030 (does the printer reject browser pages from other sites?)")
    for origin in ["http://localhost", "https://example.com"]:
        try:
            w = WS(host, 3030, "/websocket", origin=origin)
            out(origin, "-> accepted:", w.status)
            w.close()
        except Exception as e:  # noqa: BLE001
            out(origin, "-> refused:", e)

    section("Camera (port 3031)")
    try:
        with socket.create_connection((host, 3031), timeout=4) as s:
            s.sendall(f"GET /video HTTP/1.1\r\nHost: {host}:3031\r\n\r\n".encode())
            s.settimeout(5)
            data = b""
            while len(data) < 200000 and data.count(b"\xff\xd9") < 2:
                chunk = s.recv(65536)
                if not chunk:
                    break
                data += chunk
        head = data.split(b"\r\n\r\n")[0].decode(errors="replace")
        out("Response headers:\n" + head)
        a, b = data.find(b"\xff\xd8"), data.find(b"\xff\xd9")
        out("First JPEG frame:", f"{b - a + 2} bytes" if 0 <= a < b else "none received")
        if 0 <= a < b:
            with open("centauri-probe-frame.jpg", "wb") as f:
                f.write(data[a:b + 2])
            out("Saved as centauri-probe-frame.jpg")
    except Exception as e:  # noqa: BLE001
        out("Camera stream failed:", e)

    section("Upload endpoint CORS (OPTIONS only, nothing is uploaded)")
    try:
        req = urllib.request.Request(f"http://{host}/uploadFile/upload", method="OPTIONS", headers={"Origin": "http://localhost", "Access-Control-Request-Method": "POST"})
        with urllib.request.urlopen(req, timeout=4) as r:
            out("status", r.status, {k: v for k, v in r.headers.items() if k.lower().startswith("access-control")} or "no CORS headers")
    except Exception as e:  # noqa: BLE001
        out("OPTIONS ->", e, dict(getattr(e, "headers", {}) or {}))


def probe_moonraker(host):
    section("Moonraker / COSMOS (port 80)")
    for path in ["/server/info", "/printer/info", "/printer/objects/list", "/server/webcams/list", "/machine/update/status", "/server/files/list?root=gcodes"]:
        code, _, body = http_get(f"http://{host}{path}", limit=6000)
        out(f"\n--- GET {path} -> {code} ---")
        out(body.decode(errors="replace")[:6000])
    code, headers, body = http_get(f"http://{host}:8080/snapshot", limit=10)
    out("\nCamera snapshot on 8080 ->", code, headers.get("Content-Type"))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    host = args[0]
    out("Centauri probe,", time.strftime("%Y-%m-%d %H:%M:%S"), "target", host)

    section("UDP discovery (port 3000)")
    try:
        u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        u.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        u.settimeout(2.5)
        for target in (host, "255.255.255.255"):
            try:
                u.sendto(b"M99999", (target, 3000))
            except OSError as e:
                out("send to", target, "failed:", e)
        seen = set()
        while True:
            data, addr = u.recvfrom(4096)
            if addr not in seen:
                seen.add(addr)
                out("reply from", addr[0], ":", data.decode(errors="replace"))
    except socket.timeout:
        pass
    except OSError as e:
        out("discovery error:", e)
    if not any("reply from" in l for l in REPORT):
        out("No discovery reply (normal on COSMOS, or across subnets / VPN).")

    section("Open ports")
    names = {22: "SSH", 80: "web", 3030: "Elegoo control", 3031: "Elegoo camera", 4567: "OpenCentauri root shell", 7125: "Moonraker (classic port)", 8080: "COSMOS camera", 1883: "MQTT", 8883: "WebRTC signalling", 9001: "MQTT websocket"}
    open_ports = [p for p in names if tcp_open(host, p)]
    for p in names:
        out(f"{p:5} {names[p]:26}", "OPEN" if p in open_ports else "closed")
    if not open_ports:
        out("\nNothing answered. Wrong address, printer off, or a firewall / different network.")

    section("Web server (port 80)")
    code, headers, body = http_get(f"http://{host}/", timeout=15.0)
    out("GET / ->", code, "| Server:", headers.get("Server"), "| first bytes:", body[:160].decode(errors="replace").replace("\n", " "))
    code, _, body = http_get(f"http://{host}/server/info")
    is_moonraker = code == 200 and b'"result"' in body
    out("Firmware family:", "COSMOS (Moonraker answered)" if is_moonraker else "stock / OpenCentauri-patched (no Moonraker)")

    if is_moonraker:
        probe_moonraker(host)
    if 3030 in open_ports:
        probe_sdcp(host, "--z-test" in sys.argv)

    if 22 in open_ports:
        section("Optional: things only SSH can show (run these yourself and paste the output)")
        out("OpenCentauri-patched login is root / OpenCentauri:   ssh root@" + host)
        out("  v4l2-ctl -d /dev/video0 --list-ctrls      # which camera settings (brightness, exposure...) exist")
        out("  v4l2-ctl -d /dev/video0 --list-formats-ext # camera resolutions")
        out("  free -m; df -h | head                      # memory and storage headroom")
        out("  tail -n 60 /board-resource/log1            # the firmware's own log: the best clue when it is stuck")

    with open("centauri-probe-report.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(REPORT) + "\n")
    print("\nSaved to centauri-probe-report.txt. It contains the printer's IP, MAC and serial-like board ID; nothing else personal.")


if __name__ == "__main__":
    main()
