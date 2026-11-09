import { afterEach, describe, expect, it, vi } from 'vitest';
import { tokenLockName, withTokenLock } from '@/lib/auth/token-lock';

/** Web Locks with one holder at a time and waiters in order, like the browser's. */
function fakeLocks() {
  const queues = new Map<string, Promise<unknown>>();
  const held = new Set<string>();
  const names: string[] = [];
  return {
    names,
    request(name: string, options: { signal?: AbortSignal; ifAvailable?: boolean }, callback: (lock: unknown) => unknown) {
      names.push(name);
      if (options.ifAvailable && held.has(name)) return Promise.resolve(callback(null));
      const previous = queues.get(name) ?? Promise.resolve();
      const run = new Promise((resolve, reject) => {
        let aborted = false;
        options.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
        void previous.catch(() => {}).then(() => {
          if (aborted) return;
          held.add(name);
          Promise.resolve(callback({})).then(resolve, reject).finally(() => held.delete(name));
        });
      });
      queues.set(name, run.catch(() => {}));
      return run;
    },
  };
}

function stubLocks(locks: unknown) {
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
}

afterEach(() => {
  stubLocks(undefined);
  vi.restoreAllMocks();
});

describe('withTokenLock', () => {
  it('runs one renewal per slot at a time, so the second sends the token the first wrote', async () => {
    stubLocks(fakeLocks());
    const order: string[] = [];
    let releaseFirst = () => {};
    const first = withTokenLock(1, () => new Promise<string>((resolve) => {
      order.push('first starts');
      releaseFirst = () => {
        order.push('first ends');
        resolve('a');
      };
    }));
    const second = withTokenLock(1, async () => {
      order.push('second starts');
      return 'b';
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(['first starts']);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(['a', 'b']);
    expect(order).toEqual(['first starts', 'first ends', 'second starts']);
  });

  it('keeps slots apart: each login has its own refresh token', async () => {
    const locks = fakeLocks();
    stubLocks(locks);
    await withTokenLock(0, async () => 'x');
    await withTokenLock(2, async () => 'y');
    expect(new Set(locks.names)).toEqual(new Set([tokenLockName(0), tokenLockName(2)]));
    expect(tokenLockName(0)).not.toBe(tokenLockName(2));
  });

  it('runs at once without Web Locks', async () => {
    await expect(withTokenLock(1, async () => 'done')).resolves.toBe('done');
  });

  it('goes ahead when another window holds the lock too long, rather than never renewing', async () => {
    stubLocks(fakeLocks());
    void withTokenLock(1, () => new Promise(() => {}));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(withTokenLock(1, async () => 'went ahead', { waitMs: 10 })).resolves.toBe('went ahead');
  });

  it('says when it had to wait for another window, and when it did not', async () => {
    stubLocks(fakeLocks());
    const turns: boolean[] = [];
    let release = () => {};
    const first = withTokenLock(1, ({ contended }) => {
      turns.push(contended);
      return new Promise<void>((resolve) => { release = resolve; });
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = withTokenLock(1, async ({ contended }) => { turns.push(contended); });
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await Promise.all([first, second]);
    expect(turns).toEqual([false, true]);
    await withTokenLock(1, async ({ contended }) => { turns.push(contended); });
    expect(turns).toEqual([false, true, false]);
  });

  it('does nothing when the caller calls it off during the wait: a sign-out', async () => {
    stubLocks(fakeLocks());
    void withTokenLock(1, () => new Promise(() => {}));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const signOut = new AbortController();
    const work = vi.fn(async () => 'renewed');
    const queued = withTokenLock(1, work, { signal: signOut.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    signOut.abort();
    await expect(queued).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
  });

  it('hands the work\'s own error to the caller and does not run it twice', async () => {
    stubLocks(fakeLocks());
    const work = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(withTokenLock(1, work)).rejects.toThrow('Failed to fetch');
    expect(work).toHaveBeenCalledTimes(1);
  });
});
