// A browser whose IndexedDB accepts the request to open the key database and
// then never answers it (no success, no error) is a browser that can't seal:
// the session stays in the page, and a renewal still comes back. Token values
// here are made up.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SERVER = 'https://mail.example.org';

/** An IndexedDB whose open() hands back a request nobody ever answers. */
function silentIndexedDb(): IDBFactory {
  const request = () => ({ result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null });
  return { open: request, deleteDatabase: request, databases: async () => [], cmp: () => 0 } as unknown as IDBFactory;
}

describe('Lite tokens when the key database never answers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.stubGlobal('indexedDB', silentIndexedDb());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('still finishes a renewal', async () => {
    const tokens = await import('@/lib/auth/lite-tokens');
    tokens.saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'alice@example.org', refreshToken: 'made-up-refresh-token-0001', clientId: 'bulwark-webmail' }, true);
    tokens.saveLiteAccessToken(0, 'made-up-access-token-0001', 3600, true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'made-up-access-token-0002', expires_in: 3600 }), { status: 200 })));

    let outcome: unknown = 'still waiting';
    void tokens.liteRefreshTokens(0).then((value) => { outcome = value; }, (error) => { outcome = error; });
    // Far longer than any wait a renewal may spend on storage.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(outcome).not.toBe('still waiting');
    expect(outcome).toMatchObject({ accessToken: 'made-up-access-token-0002' });
  });

  it('keeps the session in the page and leaves no half-written record behind', async () => {
    const tokens = await import('@/lib/auth/lite-tokens');
    tokens.saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'alice@example.org', refreshToken: 'made-up-refresh-token-0003', clientId: 'bulwark-webmail' }, true);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    // The page still has its token.
    expect(tokens.readLiteRefreshToken(0)?.refreshToken).toBe('made-up-refresh-token-0003');
    // A record that will never get its sealed token is of no use to the next page load.
    const stored = window.localStorage.getItem('bulwark-lite:refresh:0');
    expect(stored === null || typeof JSON.parse(stored).sealed === 'string').toBe(true);
  });
});

function storedLiteText(): string {
  const parts: string[] = [];
  for (const store of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i)!;
      if (key.startsWith('bulwark-lite:')) parts.push(key, store.getItem(key) ?? '');
    }
  }
  return parts.join('\n');
}

type Failure = 'blocked' | 'commit-aborts' | 'quota-on-put';

/**
 * An IndexedDB that opens and reads but fails its writes, or whose open is
 * blocked (another tab holds the database for a version change) and never
 * goes on.
 */
function failingIndexedDb(failure: Failure): IDBFactory {
  const later = (fn: () => void) => setTimeout(fn, 0);
  type Handlers = { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void; result?: unknown; error?: unknown };
  const open = () => {
    const request: Handlers = {};
    if (failure === 'blocked') {
      later(() => request.onblocked?.());
      return request;
    }
    const db = {
      objectStoreNames: { contains: () => true },
      close: () => {},
      onversionchange: null,
      transaction: () => {
        const tx: { error?: unknown; oncomplete?: () => void; onabort?: () => void; onerror?: () => void; objectStore?: () => unknown } = {};
        tx.objectStore = () => ({
          get: () => {
            const r: Handlers = {};
            later(() => { r.result = undefined; r.onsuccess?.(); });
            return r;
          },
          put: () => {
            const r: Handlers = {};
            const quota = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
            later(() => {
              if (failure === 'quota-on-put') {
                r.error = quota;
                r.onerror?.();
              } else {
                // The request goes through; committing the transaction does not.
                r.onsuccess?.();
              }
              tx.error = quota;
              later(() => tx.onabort?.());
            });
            return r;
          },
        });
        return tx;
      },
    };
    later(() => { request.result = db; request.onsuccess?.(); });
    return request;
  };
  const deleteDatabase = () => {
    const r: Handlers = {};
    later(() => r.onsuccess?.());
    return r;
  };
  return { open, deleteDatabase, databases: async () => [], cmp: () => 0 } as unknown as IDBFactory;
}

describe('Lite tokens when the key database fails', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('waits only so long when another tab blocks the open, then keeps the session in the page', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('indexedDB', failingIndexedDb('blocked'));
    const tokens = await import('@/lib/auth/lite-tokens');
    tokens.saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'alice', refreshToken: 'made-up-refresh-token-0101' }, true);
    tokens.saveLiteAccessToken(0, 'made-up-access-token-0101', 3600, true);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(storedLiteText()).toBe('');
    expect(tokens.readLiteRefreshToken(0)?.refreshToken).toBe('made-up-refresh-token-0101');
    expect(tokens.readLiteAccessToken(0)?.accessToken).toBe('made-up-access-token-0101');
    // The page does not wait on the database again.
    tokens.saveLiteRefreshToken(1, { serverUrl: SERVER, username: 'bob', refreshToken: 'made-up-refresh-token-0102' }, true);
    expect(storedLiteText()).toBe('');
  });

  for (const failure of ['commit-aborts', 'quota-on-put'] as const) {
    it(`falls back at once, writing nothing in clear, when a write fails (${failure})`, async () => {
      vi.stubGlobal('indexedDB', failingIndexedDb(failure));
      const tokens = await import('@/lib/auth/lite-tokens');
      const started = Date.now();
      tokens.saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'alice', refreshToken: 'made-up-refresh-token-0201' }, true);
      await vi.waitFor(() => expect(window.localStorage.getItem('bulwark-lite:refresh:0')).toBeNull(), { timeout: 2000 });
      // Well inside the time limit: the failure was heard, not waited out.
      expect(Date.now() - started).toBeLessThan(4000);
      await tokens.settleLiteTokenStorage();
      expect(storedLiteText()).not.toContain('made-up-refresh-token-0201');
      expect(tokens.readLiteRefreshToken(0)?.refreshToken).toBe('made-up-refresh-token-0201');
    });
  }

  it('keeps the session in the page when web storage is full', async () => {
    const tokens = await import('@/lib/auth/lite-tokens');
    // On the prototype: a property set on a Storage object is a stored item.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    expect(() => tokens.saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'alice', refreshToken: 'made-up-refresh-token-0301' }, true)).not.toThrow();
    await tokens.settleLiteTokenStorage();
    expect(storedLiteText()).toBe('');
    expect(tokens.readLiteRefreshToken(0)?.refreshToken).toBe('made-up-refresh-token-0301');
  });

  it('asks for a new sign-in after a reload when the key database does not answer, sending nothing', async () => {
    // A session sealed while the database worked.
    const before = await import('@/lib/auth/lite-tokens');
    before.saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'alice', refreshToken: 'made-up-refresh-token-0401' }, true);
    before.saveLiteAccessToken(0, 'made-up-access-token-0401', 3600, true);
    await before.settleLiteTokenStorage();
    expect(JSON.parse(window.localStorage.getItem('bulwark-lite:refresh:0')!).sealed).toEqual(expect.any(String));

    // The next page load: the database takes the request and never answers.
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal('indexedDB', silentIndexedDb());
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const after = await import('@/lib/auth/lite-tokens');
    let outcome: unknown = 'still waiting';
    void after.liteRefreshTokens(0).then((value) => { outcome = value; }, (error) => { outcome = error; });
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(outcome).toMatchObject({ name: 'LiteLoginError', code: 'refresh_rejected' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedLiteText()).not.toContain('made-up-refresh-token-0401');
    expect(storedLiteText()).not.toContain('made-up-access-token-0401');
  });
});
