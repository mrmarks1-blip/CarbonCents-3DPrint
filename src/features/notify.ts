// Notifications. In the Android app these are real system notifications,
// including maintenance reminders scheduled for their calendar due date. In a
// plain browser they need a secure page, so they may silently be unavailable;
// everything is also written to the in-app console.
import type { Task } from './maintenance'

const native = () => !!(window as any).Capacitor?.isNativePlatform?.()
const plugin = async () => (await import('@capacitor/local-notifications')).LocalNotifications

let nextId = 1000

export async function requestPermission(): Promise<string> {
  try {
    if (native()) return (await (await plugin()).requestPermissions()).display
    if ('Notification' in window) return await Notification.requestPermission()
  } catch {
    /* fall through */
  }
  return 'unavailable'
}

export async function notify(title: string, body: string) {
  try {
    if (native()) await (await plugin()).schedule({ notifications: [{ id: nextId++, title, body }] })
    else if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body })
    navigator.vibrate?.(200)
  } catch {
    /* notifications are best-effort */
  }
}

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) & 0x7fff

/** Android only: one scheduled notification per calendar-based task. */
export async function scheduleReminders(tasks: Task[]) {
  if (!native()) return
  try {
    const ln = await plugin()
    const ids = tasks.map((t) => ({ id: hash(t.id) }))
    if (ids.length) await ln.cancel({ notifications: ids })
    const due = tasks
      .filter((t) => t.everyDays > 0)
      .map((t) => ({ id: hash(t.id), title: 'Printer maintenance due', body: t.name, at: t.lastDone + t.everyDays * 86_400_000 }))
      .filter((n) => n.at > Date.now())
    if (due.length) await ln.schedule({ notifications: due.map((n) => ({ id: n.id, title: n.title, body: n.body, schedule: { at: new Date(n.at) } })) })
  } catch {
    /* best-effort */
  }
}
