#!/usr/bin/env python3
"""Run a shell command on the printer through the OpenCentauri bind shell (port 4567, root, no login).

    python rsh.py "uname -a; df -h"
    python rsh.py --host 192.168.1.50 --timeout 30 "cat /board-resource/log1 | tail -n 50"
    python rsh.py --raw out.bin "cat /some/binary"     # save bytes to a file instead of printing

The command runs as root. This helper adds nothing but a start/end marker, so
whatever you type is exactly what runs.
"""
import argparse, os, socket, sys


def run(host, command, timeout=15.0, port=4567):
    tag = os.urandom(6).hex()
    start, end = f"S{tag}S".encode(), f"E{tag}E".encode()
    # Markers are split in the echo so the echoed command line itself never matches.
    # One line only: the shell prints a "/ # " prompt per line, which would land inside binary output.
    wire = f"echo S{tag}''S; {command} ; echo E{tag}''E\n".encode()
    s = socket.create_connection((host, port), timeout=6)
    s.sendall(wire)
    s.settimeout(timeout)
    buf = b""
    try:
        while end not in buf:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
    except socket.timeout:
        buf += b"\n[rsh: timed out]\n"
    finally:
        try:
            s.sendall(b"exit\n")
        except OSError:
            pass
        s.close()
    a = buf.find(start)
    body = buf[a + len(start):] if a >= 0 else buf
    b = body.find(end)
    if b >= 0:
        body = body[:b]
    return body.lstrip(b"\r\n")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="192.168.1.50")
    ap.add_argument("--timeout", type=float, default=15.0)
    ap.add_argument("--raw", help="write output bytes to this file")
    ap.add_argument("command")
    a = ap.parse_args()
    data = run(a.host, a.command, a.timeout)
    if a.raw:
        with open(a.raw, "wb") as f:
            f.write(data)
        print(f"{len(data)} bytes -> {a.raw}")
    else:
        sys.stdout.buffer.write(data)
