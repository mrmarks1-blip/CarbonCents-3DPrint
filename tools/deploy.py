#!/usr/bin/env python3
"""Copy the built app (dist/) onto the printer so it is served at http://<printer>/cc/.

WARNING: NOT WORKING YET. Its first run (2026-11-23) hung and left /cc/ without its
asset files, because it deletes the old files before the new ones arrive and the printer
could not reach this script's temporary web server (probably Windows firewall).
See docs/contributor-notes.md ("Hosting the app on the printer") for the manual method that works and what to fix.

    npm run build
    python tools/deploy.py                       # printer 192.168.1.50
    python tools/deploy.py --host 192.168.1.60
    python tools/deploy.py --remove              # delete /cc from the printer again

How it works: this script serves dist/ from this computer for a moment, and tells the
printer (through the OpenCentauri root shell on port 4567) to fetch each file with curl.
Then it downloads every file back from the printer and compares it with dist/.

Notes from the first manual run (2026-11-23):
- Use the printer's /usr/bin/curl. Its wget crashes (segfault) and leaves a core dump.
- Give curl 60 s per file; 15 s cut a 100 KB file short.
- Windows may ask to allow Python through the firewall the first time.
- /app is on the printer's root overlay; a firmware update may remove /cc. Just deploy again.
"""
import argparse, functools, http.server, os, socket, sys, threading, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rsh import run  # noqa: E402

TARGET = "/app/resources/www/cc"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="192.168.1.50")
    ap.add_argument("--remove", action="store_true")
    a = ap.parse_args()

    if a.remove:
        print(run(a.host, f"rm -rf {TARGET} && echo removed {TARGET}").decode(errors="replace"))
        return

    dist = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dist")
    files = []
    for root, _, names in os.walk(dist):
        for n in names:
            files.append(os.path.relpath(os.path.join(root, n), dist).replace("\\", "/"))
    if "index.html" not in files:
        sys.exit("dist/index.html not found. Run `npm run build` first.")
    bad = [f for f in files if not all(c.isalnum() or c in "._-/" for c in f)]
    if bad:
        sys.exit(f"Refusing file names with unusual characters: {bad}")

    # Which of this computer's addresses does the printer see?
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect((a.host, 80))
    me = s.getsockname()[0]
    s.close()

    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=dist)
    srv = http.server.ThreadingHTTPServer((me, 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://{me}:{srv.server_address[1]}"

    dirs = sorted({os.path.dirname(f) for f in files if "/" in f})
    cmd = f"mkdir -p {' '.join(TARGET + '/' + d for d in dirs) or TARGET} && cd {TARGET} && rm -f assets/*"
    for f in files:
        cmd += f"; /usr/bin/curl -s -f -m 60 -o {f} {base}/{f}; echo $? {f}"
    print(run(a.host, cmd, timeout=60 * len(files) + 30).decode(errors="replace"))
    srv.shutdown()

    ok = True
    for f in files:
        with open(os.path.join(dist, f), "rb") as fh:
            want = fh.read()
        try:
            got = urllib.request.urlopen(f"http://{a.host}/cc/{f}", timeout=90).read()
        except Exception as e:  # noqa: BLE001
            got = repr(e).encode()
        same = got == want
        ok &= same
        print("ok     " if same else "DIFFERS", f)
    print(f"\nOpen http://{a.host}/cc/" if ok else "\nSome files differ. Run it again; the printer's web server is slow.")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
