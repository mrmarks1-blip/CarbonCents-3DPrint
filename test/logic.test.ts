import { describe, expect, it } from 'vitest'
import { diagnose, type Context } from '../src/features/assistant'
import { freshTasks, recordJob, totalHours, usage } from '../src/features/maintenance'
import { parseKlipper } from '../src/printer/moonraker'
import { parseSdcpStatus } from '../src/printer/sdcp'
import { emptyState } from '../src/printer/types'

// Real capture from a Centauri Carbon (WalkerFrederick/sdcp-centauri-carbon README).
const CAPTURE = {
  CurrentStatus: [1], TimeLapseStatus: 0, PlatFormType: 0, TempOfHotbed: 50.04, TempOfNozzle: 255.01, TempOfBox: 29.2,
  TempTargetHotbed: 50, TempTargetNozzle: 255, TempTargetBox: 0, CurrenCoord: '139.96,123.71,5.33',
  CurrentFanSpeed: { ModelFan: 58, AuxiliaryFan: 0, BoxFan: 68 }, ZOffset: 0.415, LightStatus: { SecondLight: 1, RgbLight: [0, 0, 0] },
  PrintInfo: { Status: 13, CurrentLayer: 34, TotalLayer: 438, CurrentTicks: 364.98, TotalTicks: 4504, Filename: 'x.gcode', TaskId: 'abc', PrintSpeedPct: 100, Progress: 9 },
}

describe('SDCP status parsing', () => {
  it('maps a real printing capture', () => {
    const s = parseSdcpStatus(CAPTURE)
    expect(s.phase).toBe('printing')
    expect(s.job).toMatchObject({ filename: 'x.gcode', progress: 9, layer: 34, totalLayers: 438, total: 4504 })
    expect(s.temps).toMatchObject({ nozzle: 255.01, nozzleTarget: 255, bed: 50.04, bedTarget: 50, chamber: 29.2 })
    expect(s.fans).toEqual({ model: 58, aux: 0, box: 68 })
    expect(s.light).toBe(true)
    expect(s.zOffset).toBe(0.415)
    expect(s.pos).toEqual([139.96, 123.71, 5.33])
  })
  it('does not show the previous job\'s 100% while a new print prepares', () => {
    const s = parseSdcpStatus({ ...CAPTURE, PrintInfo: { ...CAPTURE.PrintInfo, Status: 16, CurrentTicks: 0, Progress: 100 } })
    expect(s.phase).toBe('preparing')
    expect(s.detail).toBe('Preheating')
    expect(s.job.progress).toBe(0)
  })
  it('falls back to machine status when no job is active, skipping file transfer', () => {
    expect(parseSdcpStatus({ CurrentStatus: [0], PrintInfo: { Status: 0 } }).phase).toBe('idle')
    expect(parseSdcpStatus({ CurrentStatus: [2, 9], PrintInfo: { Status: 0 } }).detail).toBe('Homing')
  })
  it('survives unknown codes, missing fields and the OpenCentauri filament key', () => {
    expect(parseSdcpStatus({}).phase).toBe('idle')
    expect(parseSdcpStatus({ CurrentStatus: [1], PrintInfo: { Status: 99 } }).phase).toBe('busy')
    const s = parseSdcpStatus({ ...CAPTURE, PrintInfo: { ...CAPTURE.PrintInfo, '54 6F 74 61 6C 45 78 74 72 75 73 69 6F 6E 00': 1234.5 } })
    expect(s.job.filamentMm).toBe(1234.5)
  })
  it('computes progress from ticks when the firmware omits Progress', () => {
    const { Progress: _, ...pi } = CAPTURE.PrintInfo
    expect(parseSdcpStatus({ ...CAPTURE, PrintInfo: { ...pi, CurrentTicks: 1126, TotalTicks: 4504 } }).job.progress).toBe(25)
  })
})

describe('real printer capture (V1.4.49, OpenCentauri patched, idle after a finished print)', () => {
  const REAL = {
    CurrentStatus: [0], TimeLapseStatus: 0, PlatFormType: 0, AmsConnectStatus: 0, TempOfHotbed: 18.39381956685076, TempOfNozzle: 21.79959107052033,
    TempOfBox: 17.57213152903705, TempTargetHotbed: 0, TempTargetNozzle: 0, TempTargetBox: 0, CurrenCoord: '202.00,264.50,98.43',
    CurrentFanSpeed: { ModelFan: 0, AuxiliaryFan: 0, BoxFan: 0 }, ZOffset: 1e-14, LightStatus: { SecondLight: 1, RgbLight: [0, 0, 0] },
    PrintInfo: { Status: 9, CurrentLayer: 129, TotalLayer: 129, CurrentTicks: 2509.7133530300002, TotalTicks: 2531, Filename: '', TaskId: '', PrintSpeedPct: 100, Progress: 0 },
  }
  it('reads as a completed print at 100% with sane values', () => {
    const s = parseSdcpStatus(REAL)
    expect(s.phase).toBe('complete')
    expect(s.job.progress).toBe(100)
    expect(s.zOffset).toBeCloseTo(0)
    expect(s.light).toBe(true)
    expect(s.pos).toEqual([202, 264.5, 98.43])
    expect(s.temps.nozzle).toBeCloseTo(21.8, 1)
  })
})

describe('Klipper status parsing', () => {
  it('maps COSMOS objects', () => {
    const s = parseKlipper({
      print_stats: { state: 'printing', filename: 'a.gcode', print_duration: 600, filament_used: 500, info: { current_layer: 3, total_layer: 30 } },
      virtual_sdcard: { progress: 0.25 }, webhooks: { state: 'ready' }, gcode_move: { speed_factor: 1.2, extrude_factor: 0.95, homing_origin: [0, 0, -0.03] },
      extruder: { temperature: 219.6, target: 220 }, heater_bed: { temperature: 60, target: 60 }, fan: { speed: 0.5 }, 'led case': { color_data: [[0, 0, 0, 1]] },
    })
    expect(s).toMatchObject({ phase: 'printing', speedPct: 120, flowPct: 95, zOffset: -0.03, light: true })
    expect(s.job).toMatchObject({ progress: 25, total: 2400, layer: 3 })
  })
  it('reports a Klipper shutdown as an error with its message', () => {
    const s = parseKlipper({ webhooks: { state: 'shutdown', state_message: 'Timer too close' }, print_stats: { state: 'printing' } })
    expect(s.phase).toBe('error')
    expect(s.error).toBe('Timer too close')
  })
})

describe('stuck-state assistant', () => {
  const now = 1_000_000_000
  const base = (patch: Partial<Context> = {}): Context => ({
    now, conn: 'connected', failures: 0, hasFallback: false, backend: 'sdcp', state: { ...emptyState(), phase: 'idle', lastUpdate: now }, caps: null,
    phaseSince: now, progressSince: now, heatSince: now, printNozzleTarget: 0, ...patch,
  })
  const ids = (c: Context) => diagnose(c).map((i) => i.id)
  const st = (patch: object) => ({ ...emptyState(), lastUpdate: now, ...patch })

  it('is quiet when all is well', () => expect(ids(base())).toEqual([]))
  it('explains repeated connection failures and offers the fallback address', () => {
    const [i] = diagnose(base({ conn: 'closed', failures: 3, hasFallback: true }))
    expect(i.id).toBe('no-connection')
    expect(i.actions).toEqual(['retry', 'switchHost'])
  })
  it('flags a stalled heater but not normal heating', () => {
    const heating = st({ phase: 'preparing', temps: { nozzle: 80, nozzleTarget: 220, bed: 40, bedTarget: 60, chamber: 25 } })
    expect(ids(base({ state: heating, heatSince: now - 60_000 }))).toEqual([])
    expect(ids(base({ state: heating, heatSince: now - 5 * 60_000 }))).toEqual(['not-heating'])
  })
  it('flags long preparation, stuck pausing and stalled progress', () => {
    const hot = { nozzle: 220, nozzleTarget: 220, bed: 60, bedTarget: 60, chamber: 30 }
    expect(ids(base({ state: st({ phase: 'preparing', detail: 'Auto-levelling', temps: hot }), phaseSince: now - 13 * 60_000 }))).toEqual(['stuck-preparing'])
    expect(ids(base({ state: st({ phase: 'pausing' }), phaseSince: now - 4 * 60_000 }))).toEqual(['stuck-pausing'])
    const printing = st({ phase: 'printing', job: { ...emptyState().job, elapsed: 500 } })
    expect(ids(base({ state: printing, progressSince: now - 7 * 60_000 }))).toEqual(['stalled'])
    expect(ids(base({ state: printing, progressSince: now - 60_000 }))).toEqual([])
  })
  it('offers a reheat when paused with the nozzle heater off', () => {
    const [i] = diagnose(base({ state: st({ phase: 'paused' }), printNozzleTarget: 220 }))
    expect(i.id).toBe('paused-cold')
    expect(i.actions).toContain('reheat')
  })
  it('notices heaters left on while idle, and a silent printer', () => {
    expect(ids(base({ state: st({ phase: 'idle', temps: { ...emptyState().temps, nozzleTarget: 220 } }), phaseSince: now - 31 * 60_000 }))).toEqual(['idle-hot'])
    expect(ids(base({ state: st({ phase: 'idle', lastUpdate: now - 30_000 }) }))).toEqual(['silent'])
  })
})

describe('maintenance', () => {
  it('counts each job once, keeping the longest duration seen', () => {
    const l: Record<string, number> = {}
    expect(recordJob(l, 'a', 1800)).toBe(true)
    expect(recordJob(l, 'a', 900)).toBe(false)
    expect(recordJob(l, 'a', 3600)).toBe(true)
    recordJob(l, 'b', 7200)
    expect(recordJob(l, '', 100)).toBe(false)
    expect(totalHours(l)).toBe(3)
  })
  it('is due by whichever of hours or days comes first', () => {
    const t = { ...freshTasks(0, 10)[0], everyHours: 200, everyDays: 90 }
    expect(usage(t, 0, 10)).toBe(0)
    expect(usage(t, 0, 110)).toBe(0.5)
    expect(usage(t, 90 * 86_400_000, 10)).toBe(1)
  })
})
