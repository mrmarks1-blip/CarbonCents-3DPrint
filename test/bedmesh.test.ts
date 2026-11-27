import { describe, expect, it } from 'vitest'
import { advice, diffRuns, parseMesh, parseProbes, splitRuns } from '../src/features/bedmesh'

// A synthetic printer log in the real line format (seen in /board-resource/log1).
function makeLog() {
  const L: string[] = ['[clocksync][282][Warn][10]:Ignoring clock sample', '[probe][174][Debug][1000]:probe at 110.000,110.000 is z=0.100000'] // a Z home: not a run
  const run = (t: number, edgeDrop: number, noisy: boolean) => {
    const ys = [20, 65.2, 110.4, 155.6, 200.8]
    const xs = [20, 65, 110, 155, 200]
    ys.forEach((y, j) =>
      xs.forEach((x, i) => {
        const edge = i === 0 || i === 4 || j === 0 || j === 4
        const z = 0.2 - (edge ? edgeDrop : 0) + ((i * 7 + j * 3) % 5) * 0.001
        t += 900
        L.push(`[probe][174][Debug][${t}]:probe at ${x.toFixed(3)},${y.toFixed(3)} is z=${z.toFixed(6)}`)
        if (noisy && ((i === 0 && j === 0) || (i === 4 && j === 2))) {
          L.push(`[probe][310][Debug][${t}]:PrinterProbe samples exceed tolerance. Retrying... MAX:${(z + 0.4).toFixed(6)} MIN:${(z - 0.1).toFixed(6)} samples_tolerance:0.015000`)
          t += 300
          L.push(`[probe][174][Debug][${t}]:probe at ${x.toFixed(3)},${y.toFixed(3)} is z=${z.toFixed(6)}`)
        }
      }),
    )
  }
  run(1_000_000, 0.02, false)
  run(5_000_000, 0.15, true)
  return L.join('\n')
}

describe('bed mesh report', () => {
  const runs = splitRuns(parseProbes(makeLog()))
  it('finds the two levelling runs and ignores a lone Z home', () => {
    expect(runs).toHaveLength(2)
    expect(runs.map((r) => r.points.length)).toEqual([25, 25])
  })
  it('marks retried points with how far the samples disagreed', () => {
    expect(runs[1].retried).toHaveLength(2)
    expect(runs[1].worstSpread).toBeCloseTo(0.5)
    expect(runs[0].retried).toHaveLength(0)
  })
  it('measures edges against the centre', () => {
    expect(runs[1].edgeMinusCentre).toBeCloseTo(-0.15, 2)
    expect(runs[0].edgeMinusCentre).toBeCloseTo(-0.02, 2)
  })
  it('compares the last two runs point by point', () => {
    const d = diffRuns(runs[0], runs[1])
    expect(d).toHaveLength(25)
    expect(Math.max(...d.map((p) => Math.abs(p.rel)))).toBeGreaterThan(0.05)
  })
  it('turns the findings into advice', () => {
    const a = advice(runs).join(' ')
    expect(a).toMatch(/2 of 25 points needed retries/)
    expect(a).toMatch(/edges are 0\.15 mm lower/)
    expect(a).toMatch(/not repeatable/)
    expect(advice([])[0]).toMatch(/No levelling runs/)
  })
  it('does not double-count lines present in both log files', () => {
    const log = makeLog()
    expect(splitRuns(parseProbes(log + '\n' + log))).toHaveLength(2)
  })
  it('reads a Klipper-style saved mesh and a JSON one', () => {
    expect(parseMesh('[bed_mesh default]\nversion = 1\npoints =\n\t0.10, 0.05, 0.02\n\t0.04, 0.00, -0.03\nx_count = 3\n')).toEqual([[0.1, 0.05, 0.02], [0.04, 0, -0.03]])
    expect(parseMesh('{"bed_mesh":{"probed_matrix":[[1,2],[3,4]]}}')).toEqual([[1, 2], [3, 4]])
    expect(parseMesh('nothing here')).toBeNull()
  })
})
