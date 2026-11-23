// Maintenance logbook. Intervals are defaults drawn from Elegoo's routine
// maintenance guidance (every 3 months) and community practice; all editable.
export interface Task {
  id: string
  name: string
  note: string
  everyHours: number // 0 = not tracked by print hours
  everyDays: number // 0 = not tracked by calendar
  lastDone: number // epoch ms
  hoursAtLastDone: number
}

export const DEFAULT_TASKS: Omit<Task, 'lastDone' | 'hoursAtLastDone'>[] = [
  { id: 'lube', name: 'Clean and lubricate rods and Z lead screws', note: 'Elegoo: clean, then grease the X/Y/Z shafts and Z lead screws. Some owners advise keeping the X rods dry and only wiping them; follow the guidance for your unit.', everyHours: 200, everyDays: 90 },
  { id: 'wipe', name: 'Wipe rods with isopropyl alcohol', note: 'Removes dust and old grease between full services.', everyHours: 50, everyDays: 30 },
  { id: 'belts', name: 'Check belt tension', note: 'Follow Elegoo\'s belt tensioning guide; loose belts cause layer shifts and ringing.', everyHours: 0, everyDays: 90 },
  { id: 'wear', name: 'Inspect nozzle, wiper, cutter, PTFE tube and toolhead cable', note: 'Replace the wiper when melted. The toolhead USB cable is a known wear item.', everyHours: 200, everyDays: 0 },
  { id: 'fans', name: 'Clean fans and vents', note: 'Clear dust and filament strings from the part, hotend and mainboard fans.', everyHours: 0, everyDays: 90 },
  { id: 'plate', name: 'Wash the build plate', note: 'Warm water and dish soap restores adhesion better than alcohol alone.', everyHours: 30, everyDays: 0 },
  { id: 'filter', name: 'Replace the carbon filter', note: 'Elegoo publishes no interval. Shorten this if you print ABS/ASA often.', everyHours: 300, everyDays: 0 },
]

export function freshTasks(now: number, hours: number): Task[] {
  return DEFAULT_TASKS.map((t) => ({ ...t, lastDone: now, hoursAtLastDone: hours }))
}

/** 0..1+ fraction of the interval used; >= 1 means due. */
export function usage(t: Task, now: number, hours: number): number {
  const byHours = t.everyHours > 0 ? (hours - t.hoursAtLastDone) / t.everyHours : 0
  const byDays = t.everyDays > 0 ? (now - t.lastDone) / (t.everyDays * 86_400_000) : 0
  return Math.max(byHours, byDays, 0)
}

export function remaining(t: Task, now: number, hours: number): string {
  const parts: string[] = []
  if (t.everyHours > 0) {
    const h = t.everyHours - (hours - t.hoursAtLastDone)
    parts.push(h >= 0 ? `${Math.round(h)} print hours left` : `${Math.round(-h)} print hours overdue`)
  }
  if (t.everyDays > 0) {
    const d = t.everyDays - (now - t.lastDone) / 86_400_000
    parts.push(d >= 0 ? `${Math.round(d)} days left` : `${Math.round(-d)} days overdue`)
  }
  return parts.join(' · ') || 'No interval set'
}

/**
 * Print-hours ledger: seconds per job id, taking the largest value seen so the
 * live job and the printer's history can both feed it without double counting.
 */
export function recordJob(ledger: Record<string, number>, id: string, seconds: number): boolean {
  if (!id || !(seconds > 0) || seconds > 30 * 86400) return false
  if ((ledger[id] ?? 0) >= seconds) return false
  ledger[id] = Math.round(seconds)
  return true
}

export const totalHours = (ledger: Record<string, number>) => Object.values(ledger).reduce((a, b) => a + b, 0) / 3600
