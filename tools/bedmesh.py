#!/usr/bin/env python3
"""Bed mesh and probing report for the Centauri Carbon (OpenCentauri-patched firmware).

    python tools/bedmesh.py --host 192.168.1.50            # writes bedmesh.html and prints a summary
    python tools/bedmesh.py --host 192.168.1.50 --out ~/mesh.html --log-mb 8

READ-ONLY. It runs `cat`, `tail`, `grep`, `find` and `date` through the OpenCentauri
root shell (port 4567, see rsh.py). It writes nothing to the printer and sends no
printer command. Run it with the printer idle if you can: it is light, but the
printer has only a few MB of free RAM.

What it shows:
- Every levelling run found in the printer's log, as a heatmap of the probed heights
  (relative to that run's average). Points where the probe had to retry because its
  samples disagreed are outlined: lots of those, or big disagreements, mean noisy
  probing (filament on the nozzle tip, debris, a plate that is not seated flat).
- Edge versus centre: whether the outer ring of points is higher or lower than the middle.
- The difference between the two most recent full runs, so a cold run and a hot run can
  be compared (level once cold and once after a warm-up, then run this).
- The saved mesh, if a config file holding one is found.

Offline: --log FILE [--mesh FILE] reads local copies instead of the printer.
"""
import argparse, html, json, math, os, re, statistics, sys, time
from collections import OrderedDict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PROBE = re.compile(r"\[probe\]\[\d+\]\[\w+\]\[(\d+)\]:probe at (-?[\d.]+),\s*(-?[\d.]+) is z=(-?[\d.]+)")
RETRY = re.compile(r"\[probe\]\[\d+\]\[\w+\]\[(\d+)\]:.*exceed tolerance.*MAX:\s*(-?[\d.]+)\s+MIN:\s*(-?[\d.]+)(?:.*tolerance:\s*(-?[\d.]+))?")
RUN_GAP_MS = 120_000  # probes further apart than this belong to different runs
MIN_POINTS = 9  # fewer distinct points: a Z home / single probe, not a levelling run
LOG_FILES = ["/board-resource/log1", "/board-resource/log2"]


# ---------------------------------------------------------------- reading


def shell(host, cmd, timeout=40):
    from rsh import run  # same folder

    return run(host, cmd, timeout).decode("utf-8", "replace")


def read_printer(host, log_mb):
    out = {}
    up = shell(host, "cat /proc/uptime; date +%s").split()
    out["boot_epoch"] = float(up[-1]) - float(up[0]) if len(up) >= 2 else None
    n = int(log_mb * 1_000_000)
    # Only the probe lines come back over the wire; the filtering happens on the printer.
    out["log"] = shell(host, "; ".join(f"tail -c {n} {f} 2>/dev/null | grep -E '\\[probe\\]|exceed tolerance'" for f in LOG_FILES), timeout=90)
    # Small config-like files that mention a mesh. Bounded: no recursion into /user-resource.
    found = shell(
        host,
        "for f in $(find /board-resource /app /etc -maxdepth 3 -type f -size -300k \\( -name '*.cfg' -o -name '*.conf' -o -name '*.json' -o -name '*.ini' \\) 2>/dev/null); "
        "do grep -qi 'mesh' \"$f\" 2>/dev/null && echo \"$f\"; done",
    ).split()
    out["mesh_files"] = {}
    for f in found[:6]:
        out["mesh_files"][f] = shell(host, f"head -c 200000 '{f}'")
    return out


# ---------------------------------------------------------------- parsing


def parse_probes(text):
    """Probe samples and retries from log text, oldest first."""
    events = []
    for line in text.splitlines():
        m = PROBE.search(line)
        if m:
            events.append(("p", int(m[1]), float(m[2]), float(m[3]), float(m[4])))
            continue
        m = RETRY.search(line)
        if m:
            events.append(("r", int(m[1]), float(m[2]), float(m[3]), float(m[4]) if m[4] else None))
    events.sort(key=lambda e: e[1])
    # The two log files overlap when the tail of log1 and log2 both hold a line.
    dedup, seen = [], set()
    for e in events:
        if e not in seen:
            seen.add(e)
            dedup.append(e)
    return dedup


def split_runs(events):
    runs, cur, last_t = [], [], None
    for e in events:
        if last_t is not None and (e[1] - last_t > RUN_GAP_MS or e[1] < last_t):
            runs.append(cur)
            cur = []
        cur.append(e)
        last_t = e[1]
    if cur:
        runs.append(cur)
    out = []
    for r in runs:
        pts = OrderedDict()
        last_key = None
        for e in r:
            if e[0] == "p":
                key = (round(e[2], 1), round(e[3], 1))
                p = pts.setdefault(key, {"x": e[2], "y": e[3], "samples": [], "retries": 0, "spread": 0.0})
                p["samples"].append(e[4])
                last_key = key
            elif last_key is not None:
                p = pts[last_key]
                p["retries"] += 1
                p["spread"] = max(p["spread"], abs(e[2] - e[3]))
        if len(pts) < MIN_POINTS:
            continue
        for p in pts.values():
            p["z"] = statistics.median(p["samples"][-3:])  # the samples the firmware settled on
        out.append({"t0": r[0][1], "t1": r[-1][1], "points": list(pts.values())})
    return out


def parse_mesh(text):
    """A Klipper-style `points =` block, or JSON with a 2-D list. Returns rows of floats or None."""
    m = re.search(r"^\s*points\s*[=:]\s*\n?((?:[ \t]*-?[\d.]+(?:\s*,\s*-?[\d.]+)*\s*,?\s*\n?)+)", text, re.M)
    if m:
        rows = [[float(v) for v in re.findall(r"-?\d+\.?\d*", ln)] for ln in m[1].strip().splitlines()]
        rows = [r for r in rows if r]
        if len(rows) >= 2 and all(len(r) == len(rows[0]) for r in rows):
            return rows
    try:
        data = json.loads(text)
    except ValueError:
        return None

    def walk(o):
        if isinstance(o, list) and len(o) >= 2 and all(isinstance(r, list) and r and all(isinstance(v, (int, float)) for v in r) for r in o):
            if all(len(r) == len(o[0]) for r in o):
                return o
        if isinstance(o, dict):
            for v in o.values():
                got = walk(v)
                if got:
                    return got
        if isinstance(o, list):
            for v in o:
                got = walk(v)
                if got:
                    return got
        return None

    return walk(data)


# ---------------------------------------------------------------- analysis


def analyse(run):
    pts = run["points"]
    mean = statistics.fmean(p["z"] for p in pts)
    for p in pts:
        p["rel"] = p["z"] - mean
    xs = sorted({round(p["x"], 1) for p in pts})
    ys = sorted({round(p["y"], 1) for p in pts})
    edge = [p for p in pts if round(p["x"], 1) in (xs[0], xs[-1]) or round(p["y"], 1) in (ys[0], ys[-1])]
    centre = [p for p in pts if p not in edge] or pts
    run.update(
        xs=xs,
        ys=ys,
        range=max(p["z"] for p in pts) - min(p["z"] for p in pts),
        edge_minus_centre=statistics.fmean(p["z"] for p in edge) - statistics.fmean(p["z"] for p in centre),
        retried=[p for p in pts if p["retries"]],
        worst_spread=max((p["spread"] for p in pts), default=0.0),
    )
    return run


def diff_runs(a, b):
    """b minus a at the points both runs probed, each relative to its own average."""
    ia = {(round(p["x"], 1), round(p["y"], 1)): p["rel"] for p in a["points"]}
    out = []
    for p in b["points"]:
        k = (round(p["x"], 1), round(p["y"], 1))
        if k in ia:
            out.append({"x": p["x"], "y": p["y"], "rel": p["rel"] - ia[k], "retries": 0})
    return out


def advice(runs):
    tips = []
    if not runs:
        return ["No levelling runs were found in the log. Run auto-levelling once (touchscreen, or start a print with it on), then run this again."]
    last = runs[-1]
    if last["retried"]:
        tips.append(
            f"{len(last['retried'])} of {len(last['points'])} points needed retries in the latest run (worst disagreement {last['worst_spread']:.3f} mm). "
            "The probe is the nozzle pressing on the plate, so this usually means something between them: filament on the nozzle tip "
            "(brush it clean while hot), debris, or a plate not sitting flat on the magnet."
        )
    if abs(last["edge_minus_centre"]) > 0.08:
        tips.append(
            f"The edges are {abs(last['edge_minus_centre']):.2f} mm {'higher' if last['edge_minus_centre'] > 0 else 'lower'} than the centre on average. "
            "Check for grit under the plate near the edges and that the plate lies flat; a bed that is not fully warmed up can also do this."
        )
    if len(runs) >= 2:
        d = diff_runs(runs[-2], runs[-1])
        if d:
            worst = max(abs(p["rel"]) for p in d)
            tips.append(
                f"The two latest runs differ by up to {worst:.3f} mm at the same point. "
                + ("That is more than the first layer can absorb (about 0.05 mm): the mesh is not repeatable, so something changes between runs (temperature, nozzle tip, plate seating)." if worst > 0.05 else "That is small: the mesh is repeatable.")
            )
    if not tips:
        tips.append("Probing looks clean and the bed looks even. If PETG still lifts, look at the plate surface (wash with dish soap), bed temperature, part-cooling fan and a brim.")
    return tips


# ---------------------------------------------------------------- report


def colour(v, span):
    """Diverging colour: blue for low, red for high, near-neutral around 0."""
    t = max(-1.0, min(1.0, v / span)) if span else 0.0
    if t >= 0:
        r, g, b = 255, round(245 - 175 * t), round(235 - 190 * t)
    else:
        t = -t
        r, g, b = round(235 - 190 * t), round(245 - 120 * t), 255
    return f"rgb({r},{g},{b})"


def heatmap(points, title, note, span=None):
    if not points:
        return ""
    xs = sorted({round(p["x"], 1) for p in points})
    ys = sorted({round(p["y"], 1) for p in points})
    span = span or max(0.05, max(abs(p["rel"]) for p in points))
    cell, pad = 64, 58
    w, h = pad + cell * len(xs) + 8, pad + cell * len(ys) + 8
    out = [f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="{html.escape(title)}">']
    for i, x in enumerate(xs):
        out.append(f'<text x="{pad + cell * i + cell / 2}" y="{pad - 10}" class="ax">{x:g}</text>')
    for j, y in enumerate(reversed(ys)):  # y grows towards the back of the bed: draw it at the top
        out.append(f'<text x="{pad - 6}" y="{pad + cell * j + cell / 2 + 4}" class="ax" text-anchor="end">{y:g}</text>')
    for p in points:
        i = xs.index(round(p["x"], 1))
        j = len(ys) - 1 - ys.index(round(p["y"], 1))
        x0, y0 = pad + cell * i, pad + cell * j
        out.append(f'<rect x="{x0 + 2}" y="{y0 + 2}" width="{cell - 4}" height="{cell - 4}" rx="6" fill="{colour(p["rel"], span)}"'
                   + (' class="retry"' if p.get("retries") else "") + "/>")
        out.append(f'<text x="{x0 + cell / 2}" y="{y0 + cell / 2 + 4}" class="v">{p["rel"]:+.3f}</text>')
        if p.get("retries"):
            out.append(f'<text x="{x0 + cell - 10}" y="{y0 + 16}" class="flag">!</text>')
    out.append("</svg>")
    return f'<section><h2>{html.escape(title)}</h2><p class="note">{html.escape(note)}</p><div class="map">{"".join(out)}</div></section>'


def when(ms, boot_epoch):
    if boot_epoch is None:
        return f"{ms / 1000 / 3600:.1f} h after boot"
    return time.strftime("%a %d %b %H:%M", time.localtime(boot_epoch + ms / 1000))


def report(runs, mesh_rows, mesh_file, boot_epoch, host):
    parts = []
    for n, r in enumerate(reversed(runs[-6:])):
        label = "Latest levelling run" if n == 0 else f"Earlier run ({n} before the latest)"
        note = (f"{when(r['t0'], boot_epoch)} · {len(r['points'])} points · range {r['range']:.3f} mm · edges {r['edge_minus_centre']:+.3f} mm vs centre · "
                f"{len(r['retried'])} point(s) retried" + (f", worst disagreement {r['worst_spread']:.3f} mm" if r["retried"] else ""))
        parts.append(heatmap(r["points"], label, note))
        if n == 0 and len(runs) >= 2:
            d = diff_runs(runs[-2], runs[-1])
            parts.append(heatmap(d, "Change since the previous run",
                                 "Latest minus previous, each relative to its own average. Near 0 everywhere means the mesh is repeatable. "
                                 "Level once cold and once after a warm-up, then compare here.", span=0.1))
    if mesh_rows:
        pts = [{"x": i, "y": j, "rel": v - statistics.fmean(sum(mesh_rows, [])), "retries": 0} for j, row in enumerate(mesh_rows) for i, v in enumerate(row)]
        parts.append(heatmap(pts, "Saved mesh", f"From {mesh_file}, grid index on the axes (not mm), relative to its average."))
    tips = "".join(f"<li>{html.escape(t)}</li>" for t in advice(runs))
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bed mesh report</title><style>
:root{{--bg:#f4f5f7;--panel:#fff;--text:#161a21;--dim:#5d6878;--line:#dde2ea}}
@media (prefers-color-scheme:dark){{:root{{--bg:#0e1116;--panel:#171b22;--text:#e8ecf2;--dim:#8b95a5;--line:#2a303b}}}}
body{{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,sans-serif;padding:16px;max-width:900px;margin:auto}}
h1{{font-size:1.3rem}} h2{{font-size:1rem;margin:0 0 4px}} section{{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px;margin:14px 0}}
.note{{color:var(--dim);font-size:.85rem;margin:0 0 8px}} .map{{overflow-x:auto}} svg{{width:100%;max-width:640px;height:auto}}
.ax{{fill:var(--dim);font-size:11px;text-anchor:middle}} .v{{fill:#111;font-size:11px;text-anchor:middle;font-variant-numeric:tabular-nums}}
.retry{{stroke:#111;stroke-width:3}} .flag{{fill:#111;font-weight:800;font-size:14px}} li{{margin:6px 0}}
</style></head><body>
<h1>Bed mesh report</h1>
<p class="note">Printer {html.escape(host)} · made {time.strftime("%d %b %Y %H:%M")} · heights in mm relative to each run's average; red is higher (closer to the nozzle), blue is lower. Outlined cells with ! needed probe retries. Axes are bed X / Y in mm, back of the bed at the top.</p>
<section><h2>What it suggests</h2><ul>{tips}</ul></section>
{"".join(parts) or "<section><p>No levelling runs found in the log.</p></section>"}
</body></html>"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="192.168.1.50")
    ap.add_argument("--out", default="bedmesh.html")
    ap.add_argument("--log-mb", type=float, default=4, help="how much of the end of each log file to read (default 4 MB)")
    ap.add_argument("--log", help="offline: a local copy of the log instead of the printer")
    ap.add_argument("--mesh", help="offline: a local config file holding the mesh")
    a = ap.parse_args()

    if a.log:
        data = {"boot_epoch": None, "log": open(a.log, encoding="utf-8", errors="replace").read(), "mesh_files": {}}
        if a.mesh:
            data["mesh_files"][a.mesh] = open(a.mesh, encoding="utf-8", errors="replace").read()
        host = "offline"
    else:
        print(f"Reading from {a.host} (read-only)…", file=sys.stderr)
        data = read_printer(a.host, a.log_mb)
        host = a.host

    runs = [analyse(r) for r in split_runs(parse_probes(data["log"]))]
    mesh_rows, mesh_file = None, None
    for f, text in data["mesh_files"].items():
        rows = parse_mesh(text)
        if rows:
            mesh_rows, mesh_file = rows, f
            break

    with open(a.out, "w", encoding="utf-8") as fh:
        fh.write(report(runs, mesh_rows, mesh_file, data["boot_epoch"], host))

    print(f"{len(runs)} levelling run(s) found in the log.")
    for r in runs[-3:]:
        print(f"  {when(r['t0'], data['boot_epoch'])}: {len(r['points'])} points, range {r['range']:.3f} mm, edges {r['edge_minus_centre']:+.3f} mm vs centre, {len(r['retried'])} retried")
    if data["mesh_files"]:
        print("Config files mentioning a mesh: " + ", ".join(data["mesh_files"]) + ("" if mesh_rows else " (no mesh grid recognised; send me one and I will add its format)"))
    elif not a.log:
        print("No config file holding a mesh was found (searched /board-resource, /app, /etc).")
    print()
    for t in advice(runs):
        print("- " + t)
    print(f"\nReport: {os.path.abspath(a.out)}")


if __name__ == "__main__":
    main()
