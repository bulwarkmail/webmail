/**
 * The app badge as the service worker needs it to keep the installed app's
 * icon right while no window is open (#1516). The page leaves here the number
 * it shows and each login's share in it; a push for one of those logins makes
 * public/sw.js (appBadgeFromPush) swap that share for the login's Inbox
 * unread count now, and badge the icon with the new total.
 */
import { PUSH_STATE_CACHE } from '@/lib/push-preferences';

const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

export interface AppBadgeWorkerState {
  /** The badge setting (faviconUnreadBadge), and not the desktop app; off: the worker leaves the icon alone. */
  enabled: boolean;
  /** The number on the icon. */
  total: number;
  /**
   * By the user name a push names its login with: the login's own JMAP account
   * and how much of `total` is its Inbox. Only logins the page counted.
   */
  logins: Record<string, { accountId: string; unread: number }>;
}

/** One login whose own Inbox the badge counts. */
export interface AppBadgeShare {
  username: string | null | undefined;
  /** The login's own JMAP account, the one its Inbox count is for. */
  accountId: string | null | undefined;
  /** What the badge counts for it (0 while its folders aren't loaded). */
  unread: number;
}

/**
 * `allUsernames`: every signed-in login's user name, counted or not. A push names
 * its login by user name only, so a name two logins share is left out: the
 * worker couldn't tell whose count changed.
 */
export function buildAppBadgeWorkerState(
  enabled: boolean,
  total: number,
  shares: readonly AppBadgeShare[],
  allUsernames: readonly (string | null | undefined)[],
): AppBadgeWorkerState {
  const seen = new Map<string, number>();
  for (const name of allUsernames) if (name) seen.set(name, (seen.get(name) ?? 0) + 1);
  const logins: AppBadgeWorkerState['logins'] = {};
  for (const share of shares) {
    if (!share.username || !share.accountId || (seen.get(share.username) ?? 0) > 1) continue;
    logins[share.username] = { accountId: share.accountId, unread: share.unread };
  }
  return { enabled, total, logins };
}

export function appBadgeWorkerKey(origin: string): string {
  return `${origin}${BASE_PATH}/__push-state/app-badge`;
}

export async function writeAppBadgeWorkerState(state: AppBadgeWorkerState): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    // A frame sandboxed without allow-same-origin throws on any read of `caches`.
    if (typeof caches === 'undefined') return;
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.put(
      appBadgeWorkerKey(window.location.origin),
      new Response(JSON.stringify(state), { headers: { 'Content-Type': 'application/json' } }),
    );
  } catch {
    // Without the store the worker leaves the icon as the page last set it.
  }
}
