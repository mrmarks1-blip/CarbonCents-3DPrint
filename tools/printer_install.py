#!/usr/bin/env python3
"""Install Centauri Control on the printer itself, so it opens at http://<printer>/cc/

    python install_on_printer.py 192.168.1.50            # install or update
    python install_on_printer.py 192.168.1.50 --remove   # take it off again

Needs: Python 3.8 or newer on your computer (nothing else), and a Centauri Carbon running
OpenCentauri Patched firmware (it provides the root shell on port 4567 this uses).

How it works: the files are sent through that shell and written into a new folder first.
Every file is checked (MD5) before the old copy is replaced, so a failed or interrupted
install leaves the previous version working. It only touches /app/resources/www/cc*.
A firmware or OpenCentauri update may remove the app again; just run this again.

Developers: run it from the repo after `npm run build` and it installs dist/.
"""
import argparse, hashlib, os, socket, sys, urllib.request

PORT = 4567
WWW = "/app/resources/www"
TARGET, STAGE, OLD = f"{WWW}/cc", f"{WWW}/cc.new", f"{WWW}/cc.old"
CHUNK = 6000  # bytes per shell line; encoded lines stay under ~24 KB
SAFE = set(b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-/:=,+ ")


class Shell:
    """One command per connection; the shell allows only one connection at a time."""

    def __init__(self, host):
        self.host = host

    def run(self, command, timeout=30.0):
        tag = os.urandom(6).hex()
        start, end = f"S{tag}S".encode(), f"E{tag}E".encode()
        # Markers are split in the echo so the echoed command line never matches.
        wire = f"echo S{tag}''S; {command} ; echo E{tag}''E\n".encode()
        s = socket.create_connection((self.host, PORT), timeout=8)
        try:
            s.sendall(wire)
            s.settimeout(timeout)
            buf = b""
            while end not in buf:
                chunk = s.recv(65536)
                if not chunk:
                    raise RuntimeError("the printer closed the connection")
                buf += chunk
            try:
                s.sendall(b"exit\n")
            except OSError:
                pass
        finally:
            s.close()
        body = buf[buf.find(start) + len(start):]
        return body[: body.find(end)].decode(errors="replace").strip()


def encode(data):
    # printf with 3-digit octal escapes is POSIX and works on the printer's BusyBox shell.
    return "".join(chr(c) if c in SAFE else "\\%03o" % c for c in data)


def find_www():
    here = os.path.dirname(os.path.abspath(__file__))
    for d in (os.path.join(here, "www"), os.path.join(here, "..", "dist")):
        if os.path.isfile(os.path.join(d, "index.html")):
            return os.path.normpath(d)
    sys.exit("Could not find the app files (a 'www' folder next to this script, or dist/ after `npm run build`).")


def files_in(root):
    out = []
    for d, _, names in os.walk(root):
        for n in sorted(names):
            p = os.path.join(d, n)
            rel = os.path.relpath(p, root).replace(os.sep, "/")
            if not set(rel.encode()) <= SAFE or rel.startswith("/") or ".." in rel.split("/"):
                sys.exit(f"Unexpected file name, refusing to continue: {rel}")
            with open(p, "rb") as f:
                out.append((rel, f.read()))
    return out


def main():
    ap = argparse.ArgumentParser(description="Install Centauri Control on the printer (http://<printer>/cc/).")
    ap.add_argument("printer", help="the printer's IP address, e.g. 192.168.1.50")
    ap.add_argument("--remove", action="store_true", help="remove the app from the printer")
    ap.add_argument("--www", help="folder with the built app (default: www/ next to this script, or dist/)")
    a = ap.parse_args()
    sh = Shell(a.printer)

    try:
        check = sh.run(f"[ -d {WWW} ] && echo www-ok; which md5sum >/dev/null && echo md5-ok", 15)
    except (ConnectionRefusedError, socket.timeout, OSError) as e:
        sys.exit(
            f"Could not reach the printer's shell on {a.printer}:{PORT} ({e}).\n"
            "Check the address, that this computer is on the same network, and that the printer runs\n"
            "OpenCentauri Patched firmware (stock Elegoo firmware does not have this shell)."
        )
    if "www-ok" not in check or "md5-ok" not in check:
        sys.exit(f"This printer does not look like a supported Centauri Carbon ({check!r}). Nothing was changed.")

    if a.remove:
        print(sh.run(f"rm -rf {TARGET} {STAGE} {OLD} && echo 'Removed {TARGET}'"))
        return

    root = os.path.abspath(a.www) if a.www else find_www()
    files = files_in(root)
    total = sum(len(d) for _, d in files)
    print(f"Installing {len(files)} files ({total // 1024} KB) from {root} to {a.printer}")

    dirs = sorted({os.path.dirname(f) for f, _ in files} - {""})
    sh.run(f"rm -rf {STAGE} && mkdir -p {STAGE}" + "".join(f" {STAGE}/{d}" for d in dirs))
    sent = 0
    for rel, data in files:
        for i in range(0, max(len(data), 1), CHUNK):
            part = data[i : i + CHUNK]
            sh.run(f"printf '{encode(part)}' {'>' if i == 0 else '>>'} {STAGE}/{rel}", 60)
            sent += len(part)
            print(f"\r  {sent * 100 // max(total, 1):3d}%  {rel[:60]:<60}", end="", flush=True)
    print()

    # Verify everything before touching the live copy.
    listed = sh.run(f"cd {STAGE} && md5sum " + " ".join(rel for rel, _ in files), 60)
    got = {}
    for line in listed.splitlines():
        parts = line.split()
        if len(parts) == 2:
            got[parts[1]] = parts[0]
    bad = [rel for rel, data in files if got.get(rel) != hashlib.md5(data).hexdigest()]
    if bad:
        sh.run(f"rm -rf {STAGE}")
        sys.exit(f"These files did not arrive intact: {', '.join(bad)}. Nothing was changed; please try again.")

    sh.run(f"rm -rf {OLD}; if [ -d {TARGET} ]; then mv {TARGET} {OLD}; fi; mv {STAGE} {TARGET} && rm -rf {OLD}")

    url = f"http://{a.printer}/cc/"
    try:
        with urllib.request.urlopen(url + "index.html", timeout=10) as r:
            served = r.read()
        local = dict(files)["index.html"]
        ok = hashlib.md5(served).digest() == hashlib.md5(local).digest()
    except OSError:
        ok = False
    print(("Done. " if ok else "Installed, but the page could not be checked over HTTP. ") + f"Open {url} in a browser on the same network.")


if __name__ == "__main__":
    main()
