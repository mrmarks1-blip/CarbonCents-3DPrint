// Notifications. In the Android app these are real system notifications,
// including maintenance reminders scheduled for their calendar due date. In a
// plain browser they need a secure page, so they may silently be unavailable;
// everything is also written to the in-app console.
//
// Android 13+ asks once or twice; after that (or if the person dismissed the
// prompt) it never shows the prompt again and `requestPermissions` just answers
// "denied" with nothing on screen. That is what "tapping Allow does nothing" was.
// In that state the only way to turn them on is the system settings page, which
// `openSettings` opens directly (AppSettingsPlugin.java).
import { registerPlugin } from '@capacitor/core'
import type { Task } from './maintenance'

export type Permission = 'granted' | 'denied' | 'prompt' | 'unavailable'

const native = () => !!(window as any).Capacitor?.isNativePlatform?.()
const plugin = async () => (await import('@capacitor/local-notifications')).LocalNotifications
const AppSettings = registerPlugin<{ openNotifications(): Promise<void> }>('AppSettings')

let nextId = 1000

const norm = (p: string): Permission => (p === 'granted' ? 'granted' : p === 'denied' ? 'denied' : p.startsWith('prompt') || p === 'default' ? 'prompt' : 'unavailable')

/** What the device currently allows, without asking. */
export async function permission(): Promise<Permission> {
  try {
    if (native()) return norm((await (await plugin()).checkPermissions()).display)
    if ('Notification' in window) return norm(Notification.permission)
  } catch {
    /* fall through */
  }
  return 'unavailable'
}

/** Ask for permission. Answers 'denied' at once when the system will not show its prompt any more. */
export async function requestPermission(): Promise<Permission> {
  try {
    if (native()) {
      const ln = await plugin()
      const now = norm((await ln.checkPermissions()).display)
      if (now === 'granted') return now
      return norm((await ln.requestPermissions()).display)
    }
    if ('Notification' in window) return norm(await Notification.requestPermission())
  } catch {
    /* fall through */
  }
  return 'unavailable'
}

/** Android: open this app's notification settings. Resolves false where that is not possible. */
export async function openSettings(): Promise<boolean> {
  if (!native()) return false
  try {
    await AppSettings.openNotifications()
    return true
  } catch {
    return false
  }
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

export const isNative = native
