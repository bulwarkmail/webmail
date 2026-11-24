/**
 * iCal subscriptions refresh while the app is open, on any page (#716), and
 * one tab does it for all. Every open tab checks on the same schedule: a Web
 * Lock lets one check at a time (one that finds it taken skips this round),
 * and the time each feed was last fetched sits in localStorage, so the next
 * tab to check sees it was just done. Each tab's calendar store keeps its own
 * copy of lastRefreshed and doesn't hear about the others'.
 */

const LOCK = 'bulwark-ical-subscription-refresh';
const STORAGE_KEY = 'ical-subscriptions-refreshed';

/** How often the open app looks for subscriptions that are due. */
export const SUBSCRIPTION_CHECK_MS = 5 * 60 * 1000;

function readStamps(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, at]) => typeof at === 'number' && Number.isFinite(at))) as Record<string, number>;
  } catch {
    return {};
  }
}

/** When any tab last fetched subscription `id`, in ms; 0 when none says. */
export function refreshedInAnyTab(id: string): number {
  return readStamps()[id] ?? 0;
}

/** Subscription `id` was fetched at `at`; subscriptions no longer in `known` are dropped. */
export function noteRefreshed(id: string, at: number, known?: readonly string[]): void {
  const stamps = readStamps();
  stamps[id] = at;
  const kept = known ? Object.fromEntries(Object.entries(stamps).filter(([key]) => key === id || known.includes(key))) : stamps;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Without storage each tab goes by its own lastRefreshed.
  }
}

/** Runs `check` unless another tab is checking right now. Without Web Locks every tab checks. */
export async function oneTabChecks(check: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return check();
  await locks.request(LOCK, { ifAvailable: true }, async (lock) => {
    if (lock) await check();
  });
}
