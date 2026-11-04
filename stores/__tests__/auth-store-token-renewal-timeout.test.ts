import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A token renewal holds the token lock for every window. A request that never answers, as one
 * caught when the desktop app closes its connections, can't be left to hold it for good.
 */

const SERVER = 'https://mail.example.test';

function account(id: string, slot: number) {
  return {
    id,
    label: id,
    serverUrl: SERVER,
    username: `${id}@example.test`,
    authMode: 'oauth' as const,
    rememberMe: true,
    displayName: id,
    email: `${id}@example.test`,
    lastLoginAt: 1,
    isConnected: false,
    hasError: false,
    isDefault: true,
    cookieSlot: slot,
    avatarColor: '#000',
  };
}

describe('a token renewal that gets no answer', { timeout: 30_000 }, () => {
  const held = new Set<string>();
  let renewals = 0;

  beforeEach(() => {
    vi.resetModules();
    held.clear();
    renewals = 0;
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => unknown) => {
          if (options.ifAvailable && held.has(name)) return callback(null);
          held.add(name);
          try {
            return await callback({});
          } finally {
            held.delete(name);
          }
        },
      },
    });
    vi.stubGlobal('fetch', vi.fn((url: unknown, init?: RequestInit) => {
      if (String(url).includes('/api/auth/token') && init?.method === 'PUT') {
        renewals += 1;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }));
  });

  afterEach(() => {
    delete (window as { bulwarkDesktop?: unknown }).bulwarkDesktop;
    delete (navigator as { locks?: unknown }).locks;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function storeWithAccount() {
    const { useAuthStore } = await import('../auth-store');
    const { useAccountStore } = await import('../account-store');
    useAccountStore.setState({ accounts: [account('A', 0)], activeAccountId: 'A', defaultAccountId: 'A' });
    useAuthStore.setState({ isAuthenticated: true, isLoading: false, serverUrl: SERVER, username: 'A@example.test', activeAccountId: 'A', authMode: 'oauth' });
    // After the imports: they don't finish on a stopped clock.
    vi.useFakeTimers();
    return useAuthStore;
  }

  it('lets go of the lock after its time, and counts as an outage', async () => {
    const store = await storeWithAccount();
    const done = vi.fn();
    void store.getState().refreshAccessToken({ accountId: 'A' }).then(done);
    await vi.advanceTimersByTimeAsync(0);
    expect(renewals).toBe(1);
    expect(held.size, 'it holds the lock while it runs').toBe(1);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(held.size).toBe(0);
    expect(done).toHaveBeenCalledWith(null);
    expect(store.getState().isAuthenticated, 'nobody is signed out for it').toBe(true);
  });

  it('lets go at once when the desktop app says its connections went', async () => {
    let reset = () => {};
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = {
      version: 1,
      certificates: {
        setAccount: async () => {},
        onConnectionsReset: (listener: () => void) => {
          reset = listener;
          return () => {};
        },
      },
    };
    const store = await storeWithAccount();
    const done = vi.fn();
    void store.getState().refreshAccessToken({ accountId: 'A' }).then(done);
    await vi.advanceTimersByTimeAsync(0);
    expect(held.size).toBe(1);
    reset();
    await vi.advanceTimersByTimeAsync(0);
    expect(held.size).toBe(0);
    expect(done).toHaveBeenCalledWith(null);
  });
});
