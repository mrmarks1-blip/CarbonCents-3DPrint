import { describe, expect, it } from 'vitest'
import { judgeRetake, parseProbes, retakeResults, spotChecks } from '../src/features/bedmesh'
import { MAX_RETAKE, relevelGcode, retakeGcode } from '../src/features/bedmesh'

const line = (t: number, x: number, y: number, z: number) => `[probe][174][Debug][${t}]:probe at ${x.toFixed(3)},${y.toFixed(3)} is z=${z.toFixed(6)}`

describe('job files', () => {
  it('level-only job has no moves or heating of its own', () => {
    expect(relevelGcode()).not.toMatch(/^(G0|G1|G28|M104|M109|M140|M190)\b/m)
  })
  it('retake job homes, wipes, then probes each point, and cools at the end', () => {
    const g = retakeGcode([{ x: 246, y: 246 }, { x: 20, y: 65.2 }])
    const order = ['G28', 'M109 S170', 'M729', 'X246.0 Y246.0', 'PROBE_ACCURACY', 'X20.0 Y65.2', 'M104 S0']
    let at = -1
    for (const k of order) {
      const i = g.indexOf(k, at + 1)
      expect(i, k).toBeGreaterThan(at)
      at = i
    }
    expect(g).not.toMatch(/M140|M190/) // never heats the bed
  })
  it('caps the number of points', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ x: i * 10, y: 20 }))
    expect(retakeGcode(pts).match(/PROBE_ACCURACY/g)).toHaveLength(MAX_RETAKE)
  })
})

describe('retake results', () => {
  // A 25-point levelling run, then two minutes later a 5-sample retake at one point.
  const L: string[] = []
  let t = 1_000_000
  for (const y of [20, 65, 110, 155, 200]) for (const x of [20, 65, 110, 155, 200]) L.push(line((t += 900), x, y, 0.3))
  t += 300_000
  for (const z of [0.401, 0.4, 0.402, 0.399, 0.4]) L.push(line((t += 900), 200, 200, z))
  const ev = parseProbes(L.join('\n'))

  it('finds the retake burst as a spot check, not a run', () => {
    const s = spotChecks(ev)
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ x: 200, y: 200, z: 0.4 })
    expect(s[0].samples).toHaveLength(5)
    expect(s[0].spread).toBeCloseTo(0.003, 6)
  })
  it('matches readings logged after the job started', () => {
    const boot = 1_790_000_000 // seconds since 1970 when the printer started
    const spots = spotChecks(ev)
    const jobAt = (boot + 1_200) * 1000 // job started 1200 s after boot; burst is at ~1330 s
    expect(retakeResults(spots, boot, jobAt, [{ x: 200, y: 200 }])[0].spot?.z).toBe(0.4)
    expect(retakeResults(spots, boot, jobAt + 600_000, [{ x: 200, y: 200 }])[0].spot).toBeNull() // too old
    expect(retakeResults(spots, boot, jobAt, [{ x: 20, y: 20 }])[0].spot).toBeNull() // another point
  })
  it('explains what changed', () => {
    const s = spotChecks(ev)[0]
    expect(judgeRetake(0.3, s)).toMatch(/probably dirt/)
    expect(judgeRetake(0.39, s)).toMatch(/reading is real/)
    expect(judgeRetake(0.4, { ...s, spread: 0.08 })).toMatch(/still disagree/)
  })
})
