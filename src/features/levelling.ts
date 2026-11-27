// Re-level and "wipe and retake" jobs, driven from the bed report.
//
// The LAN protocol has no command to probe or wipe, so each job is a tiny
// G-code file the app uploads and starts like a print:
//
// - Re-level: an empty file started with auto-levelling on. The printer runs its
//   own levelling routine (the same one as before any print) and then has
//   nothing to print. Warm mode reuses the warm-up from prep.ts first.
// - Retake: home, soften and wipe the nozzle (M729, the firmware's own nozzle
//   clean), then PROBE_ACCURACY at each chosen point. The firmware is built from
//   Klipper code and contains these commands; the readings land in the same
//   log the bed report reads.
//
// EXPERIMENTAL: neither job has been run on a real printer yet. The UI says so
// and asks before starting; the printer's own Stop works as for any print.
import { effect, signal } from '@preact/signals'
import { MAX_RETAKE, PROBE_C, SAMPLES, WIPE_C, relevelGcode, retakeGcode, type Pt } from './bedmesh'
import type { FileEntry, StartOptions } from '../printer/types'
import { act, backend, conn, log, settings, state } from '../store'
import { cameraElement, camLive } from './camera'
import { notify } from './notify'
import { soak, startWithWarmup } from './prep'

export { MAX_RETAKE, PROBE_C, SAMPLES, WIPE_C, type Pt }

export interface Snap {
  label: string
  canvas: HTMLCanvasElement
  at: number
}
export interface LevelJob {
  kind: 'relevel' | 'retake'
  warm: boolean
  points: Pt[]
  /** When the job was started (ms since 1970), to pick its readings out of the log. */
  startedAt: number
  phase: 'uploading' | 'warming' | 'running' | 'done' | 'failed'
  seenActive: boolean
  message: string
}

const JOB_KEY = 'cc.levelJob'
const loadJob = (): LevelJob | null => {
  try {
    return JSON.parse(localStorage.getItem(JOB_KEY) ?? 'null')
  } catch {
    return null
  }
}
export const job = signal<LevelJob | null>(loadJob())
effect(() => {
  try {
    localStorage.setItem(JOB_KEY, JSON.stringify(job.value))
  } catch {
    /* private mode: the job just isn't remembered */
  }
})
/** Camera stills taken around the latest job (this session only). */
export const snaps = signal<Snap[]>([])

const ACTIVE = ['preparing', 'printing', 'pausing', 'paused', 'resuming', 'stopping']
export const busy = () => !!job.value && ['uploading', 'warming', 'running'].includes(job.value.phase)

/** Copy the live camera picture into a canvas. Null if the camera is not showing a picture. */
export function snapshot(label: string): Snap | null {
  const img = cameraElement()
  if (!camLive.value || !img?.naturalWidth) return null
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  c.getContext('2d')?.drawImage(img, 0, 0)
  const s = { label, canvas: c, at: Date.now() }
  snaps.value = [...snaps.value, s].slice(-4)
  return s
}

async function send(name: string, text: string): Promise<FileEntry | null> {
  const f = new File([text], name, { type: 'text/plain' })
  if (!(await act(`Upload ${name}`, (b) => b.upload(f, () => {})))) return null
  try {
    const list = (await backend.value?.listFiles()) ?? []
    return list.find((e) => e.name === name) ?? { path: name, name, size: f.size, modified: 0, layers: 0 }
  } catch {
    return { path: name, name, size: f.size, modified: 0, layers: 0 }
  }
}

const opts = (levelling: boolean): StartOptions => ({ levelling, timelapse: false, plateSide: 0 })

function fail(message: string) {
  if (job.value) job.value = { ...job.value, phase: 'failed', message }
  log('error', message)
}

/** Re-level without printing. `warm` heats and soaks the bed first. */
export async function relevel(warm: { bed: number; minutes: number } | null) {
  if (busy() || conn.value !== 'connected') return
  snaps.value = []
  snapshot('Before')
  job.value = { kind: 'relevel', warm: !!warm, points: [], startedAt: Date.now(), phase: 'uploading', seenActive: false, message: 'Uploading the level-only job…' }
  const file = await send('cc-level-only.gcode', relevelGcode())
  if (!file) return fail('Re-level: the job file could not be uploaded.')
  if (warm) {
    if (!(await startWithWarmup(file, opts(true), warm.bed, warm.minutes))) return fail('Re-level: the bed could not be heated.')
    job.value = { ...job.value!, phase: 'warming', message: `Heating the bed to ${warm.bed} °C, then ${warm.minutes} min soak, then levelling.` }
  } else {
    if (!(await act('Start levelling only', (b) => b.start(file, opts(true))))) return fail('Re-level: the printer did not start the job.')
    job.value = { ...job.value!, phase: 'running', startedAt: Date.now(), message: 'Levelling. The printer heats the nozzle, wipes it and probes the bed.' }
  }
}

/** Wipe the nozzle, then probe the given points again. */
export async function retake(points: Pt[]) {
  if (busy() || conn.value !== 'connected' || !points.length) return
  const pts = points.slice(0, MAX_RETAKE)
  snaps.value = []
  snapshot('Before')
  job.value = { kind: 'retake', warm: false, points: pts, startedAt: Date.now(), phase: 'uploading', seenActive: false, message: 'Uploading the retake job…' }
  const file = await send('cc-retake.gcode', retakeGcode(pts))
  if (!file) return fail('Retake: the job file could not be uploaded.')
  if (!(await act(`Wipe and retake ${pts.length} point(s)`, (b) => b.start(file, opts(false))))) return fail('Retake: the printer did not start the job.')
  job.value = { ...job.value!, phase: 'running', startedAt: Date.now(), message: `Homing, wiping the nozzle at ${WIPE_C} °C, then probing ${pts.length} point(s) ${SAMPLES}× each.` }
}

export function clearJob() {
  if (!busy()) job.value = null
}

const START_WAIT_MS = 90_000

// Follow the printer until the job ends.
effect(() => {
  const j = job.value
  const ph = state.value.phase
  const warming = !!soak.value
  if (!j || !['warming', 'running'].includes(j.phase) || conn.value !== 'connected') return
  if (ACTIVE.includes(ph)) {
    if (!j.seenActive) job.value = { ...j, phase: 'running', seenActive: true, startedAt: j.phase === 'warming' ? Date.now() : j.startedAt }
    return
  }
  if (j.phase === 'warming') {
    // The warm-up ended: either it started the job (the printer reports it shortly) or it was cancelled.
    if (!warming) job.value = { ...j, phase: 'running', startedAt: Date.now(), message: 'Warm-up done. Levelling.' }
    return
  }
  if (!j.seenActive) {
    if (Date.now() - j.startedAt > START_WAIT_MS) job.value = { ...j, phase: 'failed', message: 'The printer never started the job (was the warm-up cancelled?).' }
    return
  }
  const ok = ph === 'complete' || ph === 'idle'
  job.value = { ...j, phase: ok ? 'done' : 'failed', message: ok ? 'Finished.' : `The job ended as "${ph}".` }
  snapshot('After')
  log(ok ? 'ok' : 'warn', `${j.kind === 'retake' ? 'Retake' : 'Re-level'} job ${ok ? 'finished' : `ended (${ph})`}.`)
  if (settings.value.notifications) notify(j.kind === 'retake' ? 'Retake finished' : 'Levelling finished', ok ? 'Open Care to see the new readings.' : `The job ended as "${ph}".`)
})
