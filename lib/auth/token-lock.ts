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
  request<T>(name: string, options: { signal?: AbortSignal; ifAvailable?: boolean }, callback: (lock: unknown) => T | Promise<T>): Promise<T>;
}

/** How long a renewal waits for another window's before going ahead. Above the route's own timeouts. */
export const TOKEN_LOCK_WAIT_MS = 30_000;

const NOT_HELD = Symbol('not held');

export interface TokenLockTurn {
  /**
   * Another window held the lock first, so it may have renewed already. A
   * renewal that was going to force one should take the cached token instead:
   * an identity provider can refuse a second one this soon (Rauthy `nbf`, #552).
   */
  contended: boolean;
}

function lockManager(): LockManagerLike | null {
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManagerLike }).locks : undefined;
  return locks && typeof locks.request === 'function' ? locks : null;
}

export function tokenLockName(slot: number): string {
  return `bulwark-token-refresh:${slot}`;
}

export async function withTokenLock<T>(
  slot: number,
  work: (turn: TokenLockTurn) => Promise<T>,
  options: { waitMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const locks = lockManager();
  if (!locks) return work({ contended: false });

  const name = tokenLockName(slot);
  let started = false;
  const run = (contended: boolean) => {
    started = true;
    return work({ contended });
  };

  const gaveUp = new AbortController();
  const forwardAbort = () => gaveUp.abort();
  options.signal?.addEventListener('abort', forwardAbort);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await locks.request<T | typeof NOT_HELD>(name, { ifAvailable: true }, (lock) => (lock ? run(false) : NOT_HELD));
    if (first !== NOT_HELD) return first as T;
    timer = setTimeout(() => gaveUp.abort(), options.waitMs ?? TOKEN_LOCK_WAIT_MS);
    return await locks.request<T>(name, { signal: gaveUp.signal }, () => {
      clearTimeout(timer);
      return run(true);
    });
  } catch (error) {
    // An error from the work goes to the caller, who decides what it means. So
    // does a caller calling it off (a sign-out). Only the lock itself failing,
    // or the wait running out, runs the work.
    if (started || options.signal?.aborted) throw error;
    return run(true);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}
