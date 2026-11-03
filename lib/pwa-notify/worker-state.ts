import { PUSH_STATE_CACHE } from '@/lib/push-preferences';

/**
 * What the service worker needs for a notification's buttons. It has no
 * settings store and no translations, so the page mirrors these into the
 * worker's Cache store, as it does the sound setting (lib/push-preferences.ts).
 * Signing out deletes the store with the rest of the push state.
 */
export interface NotificationActionPrefs {
  archiveEnabled: boolean;
  archiveMode: 'single' | 'year' | 'month';
  labels: { archive: string; markRead: string; reply: string; replyPlaceholder: string };
}

const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

/** A reply typed on a notification waits this long for the page it opened. */
const PENDING_REPLY_MAX_AGE_MS = 5 * 60 * 1000;

/** The cache key sw.js reads the prefs from. */
export function notificationActionPrefsKey(origin: string): string {
  return `${origin}${BASE_PATH}/__push-state/actions`;
}

/** The cache key sw.js keeps a reply typed on a notification under. */
export function pendingReplyKey(origin: string): string {
  return `${origin}${BASE_PATH}/__push-state/pending-reply`;
}

export async function writeNotificationActionPrefs(prefs: NotificationActionPrefs): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.put(
      notificationActionPrefsKey(window.location.origin),
      new Response(JSON.stringify(prefs), { headers: { 'Content-Type': 'application/json' } }),
    );
  } catch {
    // Without the store the worker offers no Archive, in English.
  }
}

/** The text typed on this message's notification, once. */
export async function consumePendingReplyText(emailId: string): Promise<string> {
  try {
    if (typeof caches === 'undefined') return '';
    const cache = await caches.open(PUSH_STATE_CACHE);
    const key = pendingReplyKey(window.location.origin);
    const res = await cache.match(key);
    if (!res) return '';
    const pending = (await res.json()) as { emailId?: unknown; text?: unknown; at?: unknown };
    await cache.delete(key);
    const fresh = typeof pending.at === 'number' && Date.now() - pending.at < PENDING_REPLY_MAX_AGE_MS;
    return fresh && pending.emailId === emailId && typeof pending.text === 'string' ? pending.text : '';
  } catch {
    return '';
  }
}
