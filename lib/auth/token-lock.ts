/**
 * One token renewal at a time across the windows of this browser.
 *
 * Refresh tokens rotate, and the token route reads the current one from a
 * cookie. Two windows renewing at once send the same token twice; on Stalwart
 * 1.0 a superseded token reused past its retry window counts as a replay and
 * revokes the whole grant. Held across the request, so the next window's
 * request carries the cookie the first one's answer wrote.
 *
 * Without Web Locks, or after waiting too long for a window that hangs, the
 * work runs anyway: never worse than having no lock.
 */

interface LockManagerLike {
  request<T>(name: string, options: { signal?: AbortSignal }, callback: () => Promise<T>): Promise<T>;
}

/** How long a renewal waits for another window's before going ahead. Above the route's own timeouts. */
export const TOKEN_LOCK_WAIT_MS = 30_000;

function lockManager(): LockManagerLike | null {
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManagerLike }).locks : undefined;
  return locks && typeof locks.request === 'function' ? locks : null;
}

export function tokenLockName(slot: number): string {
  return `bulwark-token-refresh:${slot}`;
}

export async function withTokenLock<T>(slot: number, work: () => Promise<T>, waitMs: number = TOKEN_LOCK_WAIT_MS): Promise<T> {
  const locks = lockManager();
  if (!locks) return work();

  const gaveUp = new AbortController();
  const timer = setTimeout(() => gaveUp.abort(), waitMs);
  let started = false;
  try {
    return await locks.request(tokenLockName(slot), { signal: gaveUp.signal }, () => {
      started = true;
      clearTimeout(timer);
      return work();
    });
  } catch (error) {
    // Only the lock itself failing runs the work: an error from the work
    // (started) goes to the caller, who decides what it means.
    if (started) throw error;
    return work();
  } finally {
    clearTimeout(timer);
  }
}
