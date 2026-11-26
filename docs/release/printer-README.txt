Centauri Control - install on the printer
==========================================

This puts the app on the printer itself. Afterwards any phone, tablet or computer on
the same network can open it at   http://<printer-ip>/cc/   with no setup and no
computer left running.

You need
- A Centauri Carbon running OpenCentauri Patched firmware
  (https://docs.opencentauri.cc/patched-firmware/). Stock Elegoo firmware does not
  allow this; use the Android app or the web zip instead.
- Python 3.8 or newer on your computer (https://www.python.org/downloads/).
  On Windows, tick "Add python.exe to PATH" when installing.
- Your printer's IP address (touchscreen: Settings > Network).

Install or update
1. Unzip this folder anywhere.
2. Open a terminal / command prompt in that folder.
3. Run:   python install_on_printer.py 192.168.1.50
   (use your printer's address). It takes a minute.
4. Open http://192.168.1.50/cc/ in a browser. Bookmark it, or on a phone use
   "Add to home screen".

Best done while the printer is idle. Every file is checked before the old version is
replaced, so if anything goes wrong the previous version keeps working.

Remove
   python install_on_printer.py 192.168.1.50 --remove

Good to know
- A firmware or OpenCentauri update may remove the app. Just run the installer again.
- The printer has no password. Never port-forward it to the internet; use a VPN
  (Tailscale, WireGuard) to reach it from outside your home.
- Unofficial hobby project, not affiliated with Elegoo or OpenCentauri. Use at your own risk.

Bed mesh report (optional)
--------------------------
bedmesh.py draws the printer's recent levelling runs as heatmaps and marks probe
points that needed retries. It only reads files on the printer and changes nothing.

    python bedmesh.py --host <printer-ip>

It writes bedmesh.html next to it; open that in a browser. Needs rsh.py in the
same folder (included). Best run with the printer idle.
