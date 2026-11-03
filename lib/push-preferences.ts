/**
 * Settings the service worker needs when a push arrives. The worker shows
 * push notifications without the page (and so without the settings store),
 * so the page mirrors them into the worker's own Cache API store, where
 * public/sw.js reads them before calling showNotification (#1289).
 */

const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

/** Same store as sw.js's PUSH_STATE_CACHE. */
export const PUSH_STATE_CACHE = 'bulwark-push-state-v1';

export interface PushPreferences {
  /** False: show push notifications for new mail without a sound. */
  sound: boolean;
}

/** The cache key sw.js reads the preferences from. */
export function pushPreferencesKey(origin: string): string {
  return `${origin}${BASE_PATH}/__push-state/prefs`;
}

/**
 * True for a login with "Email notifications" off or do not disturb on. The worker
 * shows nothing for its mail. Per login, as settings are: the store only holds the
 * active login's, and the other logins' mail must not go quiet because of them.
 */
export async function writeLoginQuiet(login: string, quiet: boolean): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open(PUSH_STATE_CACHE);
    const key = `${window.location.origin}${BASE_PATH}/__push-state/quiet-logins`;
    const stored = (await (await cache.match(key))?.json().catch(() => null)) as Record<string, boolean> | null;
    await cache.put(key, new Response(JSON.stringify({ ...stored, [login]: quiet }), { headers: { 'Content-Type': 'application/json' } }));
  } catch {
    // Without the store the worker shows every push.
  }
}

export async function writePushPreferences(prefs: PushPreferences): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    // A frame sandboxed without allow-same-origin (the plugin sandbox loads
    // the settings store too) throws on any read of `caches`, typeof included.
    if (typeof caches === 'undefined') return;
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.put(
      pushPreferencesKey(window.location.origin),
      new Response(JSON.stringify(prefs), { headers: { 'Content-Type': 'application/json' } }),
    );
  } catch {
    // Without the store the worker keeps its default: a sound for every alert.
  }
}
