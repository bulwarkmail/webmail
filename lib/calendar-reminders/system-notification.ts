/**
 * A browser's system notification for a reminder, where the user has already granted the
 * permission. This never asks for it. Through the service worker where there is one, since
 * Chrome on Android refuses `new Notification`. The tag keeps one per reminder, whichever
 * tab asks.
 */

export interface SystemReminder {
  key: string;
  title: string;
  body: string;
  /** Do not disturb: on screen, but quiet. */
  silent: boolean;
}

function tagOf(key: string): string {
  return `calendar-reminder:${key}`;
}

function permitted(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  try {
    return await navigator.serviceWorker?.getRegistration();
  } catch {
    return undefined;
  }
}

/** In front of the user the in-app toast says it already. */
export function wantsSystemNotification(): boolean {
  if (!permitted() || typeof document === 'undefined') return false;
  return document.visibilityState === 'hidden' || !document.hasFocus();
}

export async function showSystemReminder(reminder: SystemReminder, openUrl: string): Promise<void> {
  if (!wantsSystemNotification()) return;
  const options = { body: reminder.body, tag: tagOf(reminder.key), silent: reminder.silent };
  try {
    const worker = await registration();
    if (worker) {
      await worker.showNotification(reminder.title, { ...options, data: { kind: 'calendar-reminder' } });
      return;
    }
    const shown = new Notification(reminder.title, options);
    shown.onclick = () => {
      window.focus();
      window.location.href = openUrl;
      shown.close();
    };
  } catch (error) {
    console.warn('A system notification could not be shown:', error);
  }
}

/** Dealt with elsewhere: it shouldn't stay in the notification list. */
export async function closeSystemReminders(keys: readonly string[]): Promise<void> {
  if (!permitted() || keys.length === 0) return;
  const worker = await registration();
  if (!worker) return;
  try {
    for (const key of keys) {
      for (const shown of await worker.getNotifications({ tag: tagOf(key) })) shown.close();
    }
  } catch {
    // Nothing that matters is left behind.
  }
}
