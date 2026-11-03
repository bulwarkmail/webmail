/**
 * Web Locks across the tabs of this browser, held until released: one tab
 * imports a file at a time, and an export's private file isn't swept while
 * the tab that wrote it still uses it. Where the browser has no Web Locks,
 * every request succeeds (one tab can't know about another then).
 */

interface LockManagerLike {
  request(name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => Promise<void> | void): Promise<unknown>;
}

function lockManager(): LockManagerLike | null {
  const locks = typeof navigator !== "undefined" ? (navigator as { locks?: LockManagerLike }).locks : undefined;
  return locks && typeof locks.request === "function" ? locks : null;
}

/**
 * Waits for the lock for as long as it takes, then holds it until released. The browser
 * frees a lock when the page holding it goes, so a window can wait to take over from one
 * that closes, reloads or is rebuilt.
 */
export function waitForLock(name: string): Promise<() => void> {
  const locks = lockManager();
  if (!locks) return Promise.resolve(() => {});
  return new Promise((resolve) => {
    locks
      .request(name, {}, () => new Promise<void>((release) => resolve(release)))
      .catch(() => resolve(() => {}));
  });
}

export function hasWebLocks(): boolean {
  return lockManager() !== null;
}

/** Takes the lock if nobody holds it: a release function, or null when another tab has it. */
export function holdLock(name: string): Promise<(() => void) | null> {
  const locks = lockManager();
  if (!locks) return Promise.resolve(() => {});
  return new Promise((resolve) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        return new Promise<void>((release) => resolve(release));
      })
      .catch(() => resolve(() => {}));
  });
}
