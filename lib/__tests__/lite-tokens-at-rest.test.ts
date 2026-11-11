// Lite keeps its sign-in tokens in the browser. What web storage holds must
// not contain them: a script on the origin that reads localStorage or
// sessionStorage finds no token, and what is stored is of no use outside
// this browser profile. The app itself still gets its tokens back, also
// after a reload and in a second tab. All token values here are made up.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLiteRefreshToken,
  forgetLiteTokenMemory,
  liteRefreshTokens,
  readLiteAccessToken,
  readLiteRefreshToken,
  replaceLiteRefreshToken,
  retireLiteSlot,
  revokeAllLiteSessions,
  revokeLiteSlot,
  saveLiteAccessToken,
  saveLiteRefreshToken,
  settleLiteTokenStorage,
} from '@/lib/auth/lite-tokens';

const REFRESH = 'fake-refresh-token-0123456789abcdef';
const ACCESS = 'fake-access-token-fedcba9876543210';
const SERVER = 'https://mail.example.org';

function everythingAScriptCanRead(): string {
  const parts: string[] = [];
  for (const store of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i)!;
      parts.push(key, store.getItem(key) ?? '');
    }
  }
  return parts.join('\n');
}

describe('Lite sign-in tokens in web storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  for (const persistent of [true, false]) {
    it(`does not leave the refresh token readable (${persistent ? 'remembered' : 'this tab only'})`, () => {
      saveLiteRefreshToken(0, { serverUrl: 'https://mail.example.org', username: 'alice@example.org', refreshToken: REFRESH, clientId: 'bulwark-webmail' }, persistent);
      expect(everythingAScriptCanRead()).not.toContain(REFRESH);
    });

    it(`does not leave the access token readable (${persistent ? 'remembered' : 'this tab only'})`, () => {
      saveLiteAccessToken(0, ACCESS, 3600, persistent);
      expect(everythingAScriptCanRead()).not.toContain(ACCESS);
    });
  }

  // Control: the session still resumes for the app itself.
  it('still gives the app its own token back', () => {
    saveLiteRefreshToken(0, { serverUrl: 'https://mail.example.org', username: 'alice@example.org', refreshToken: REFRESH, clientId: 'bulwark-webmail' }, true);
    expect(readLiteRefreshToken(0)?.username).toBe('alice@example.org');
  });
});

/** What IndexedDB holds for the tokens: database names, and every stored value of the key database. */
async function indexedDbContents(): Promise<{ names: string[]; values: unknown[] }> {
  const names = (await indexedDB.databases()).map((db) => db.name ?? '');
  if (!names.includes('bulwark-lite-keys')) return { names, values: [] };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('bulwark-lite-keys');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    const values = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction('keys', 'readonly').objectStore('keys').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return { names, values };
  } finally {
    db.close();
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('sealed Lite tokens', () => {
  const fetchMock = vi.fn();

  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    forgetLiteTokenMemory();
    await settleLiteTokenStorage();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('bulwark-lite-keys');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores only the sealed tokens, under a key script cannot copy out, and resumes after a reload', async () => {
    saveLiteRefreshToken(2, { serverUrl: `${SERVER}/`, username: 'alice@example.org', refreshToken: REFRESH, clientId: 'bulwark-webmail' }, true);
    saveLiteAccessToken(2, ACCESS, 1800, true);
    await settleLiteTokenStorage();

    const stored = everythingAScriptCanRead();
    expect(stored).not.toContain(REFRESH);
    expect(stored).not.toContain(ACCESS);
    // Whose token it is stays readable.
    expect(JSON.parse(localStorage.getItem('bulwark-lite:refresh:2')!)).toEqual({
      serverUrl: SERVER, username: 'alice@example.org', clientId: 'bulwark-webmail', id: expect.any(String), sealed: expect.any(String),
    });
    const db = await indexedDbContents();
    expect(db.values).toHaveLength(1);
    expect(db.values[0]).toBeInstanceOf(CryptoKey);
    expect((db.values[0] as CryptoKey).extractable).toBe(false);
    expect(JSON.stringify(db.values)).not.toContain(REFRESH);

    // A reload: nothing in memory. The stored access token is unsealed instead of renewing early.
    forgetLiteTokenMemory();
    expect(readLiteRefreshToken(2)).toBeNull();
    expect(readLiteAccessToken(2)).toBeNull();
    await expect(liteRefreshTokens(2)).resolves.toMatchObject({ accessToken: ACCESS, refreshToken: REFRESH });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readLiteRefreshToken(2)).toEqual({ serverUrl: SERVER, username: 'alice@example.org', clientId: 'bulwark-webmail', refreshToken: REFRESH });
    expect(readLiteAccessToken(2)?.accessToken).toBe(ACCESS);

    // Once that one is used up, the renewal presents the unsealed refresh token.
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'fake-access-2', expires_in: 900 }));
    forgetLiteTokenMemory();
    localStorage.removeItem('bulwark-lite:access:2');
    await liteRefreshTokens(2);
    expect(new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body)).get('refresh_token')).toBe(REFRESH);
  });

  it('seals tokens a browser kept in plain form, in every slot, and keeps the user signed in', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 1800;
    localStorage.setItem('bulwark-lite:refresh:1', JSON.stringify({ serverUrl: SERVER, username: 'bob', refreshToken: REFRESH, clientId: 'bulwark-webmail' }));
    localStorage.setItem('bulwark-lite:access:1', JSON.stringify({ accessToken: ACCESS, expiresAt }));
    sessionStorage.setItem('bulwark-lite:refresh:3', JSON.stringify({ serverUrl: SERVER, username: 'carol', refreshToken: 'fake-tab-refresh-3' }));

    // The first read seals every slot; the plain copies are gone at once.
    expect(readLiteRefreshToken(1)?.refreshToken).toBe(REFRESH);
    expect(everythingAScriptCanRead()).not.toContain(REFRESH);
    expect(everythingAScriptCanRead()).not.toContain(ACCESS);
    expect(everythingAScriptCanRead()).not.toContain('fake-tab-refresh-3');
    expect(readLiteAccessToken(1)?.accessToken).toBe(ACCESS);
    await settleLiteTokenStorage();
    expect(JSON.parse(localStorage.getItem('bulwark-lite:refresh:1')!).sealed).toEqual(expect.any(String));
    expect(JSON.parse(sessionStorage.getItem('bulwark-lite:refresh:3')!).sealed).toEqual(expect.any(String));

    // After a reload the sealed copies sign the same accounts in.
    forgetLiteTokenMemory();
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'fake-access-3' }));
    await expect(liteRefreshTokens(1)).resolves.toMatchObject({ accessToken: ACCESS, refreshToken: REFRESH });
    await liteRefreshTokens(3);
    expect(new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body)).get('refresh_token')).toBe('fake-tab-refresh-3');
  });

  it('keeps a session in the page only, writing nothing, when the browser cannot seal', async () => {
    const cases: Array<[string, () => void]> = [
      // IndexedDB blocked or failing, as in some private windows.
      ['IndexedDB fails', () => { vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new DOMException('blocked', 'InvalidStateError'); }); }],
      ['no IndexedDB', () => { vi.stubGlobal('indexedDB', undefined); }],
      // A plain http:// address other than localhost: no WebCrypto.
      ['no WebCrypto', () => { vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => globalThis.crypto.getRandomValues(a) }); }],
    ];
    for (const [name, breakIt] of cases) {
      localStorage.clear();
      sessionStorage.clear();
      forgetLiteTokenMemory();
      breakIt();
      expect(() => {
        saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'alice', refreshToken: REFRESH }, true);
        saveLiteAccessToken(0, ACCESS, 1800, true);
      }, name).not.toThrow();
      await settleLiteTokenStorage();
      expect(everythingAScriptCanRead(), name).not.toContain(REFRESH);
      expect(everythingAScriptCanRead(), name).not.toContain(ACCESS);
      expect(localStorage.getItem('bulwark-lite:refresh:0'), name).toBeNull();
      // The page itself still has the session...
      expect(readLiteRefreshToken(0)?.refreshToken, name).toBe(REFRESH);
      expect(readLiteAccessToken(0)?.accessToken, name).toBe(ACCESS);
      // ...and a reload ends it.
      forgetLiteTokenMemory();
      expect(readLiteRefreshToken(0), name).toBeNull();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.stubGlobal('fetch', fetchMock);
    }
  });

  it('lets a second tab present the refresh token the first one renewed', async () => {
    // Two tabs of one profile: one module each, sharing web storage and IndexedDB.
    vi.resetModules();
    const tabA = await import('@/lib/auth/lite-tokens');
    vi.resetModules();
    const tabB = await import('@/lib/auth/lite-tokens');
    const presented = () => new URLSearchParams(String(fetchMock.mock.calls.at(-1)?.[1]?.body)).get('refresh_token');

    tabA.saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'alice', refreshToken: 'fake-refresh-1' }, true);
    await tabA.settleLiteTokenStorage();

    // Tab B has been running with the first token.
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'fake-access-b', expires_in: 3600 }));
    await tabB.liteRefreshTokens(0);
    expect(presented()).toBe('fake-refresh-1');
    expect(tabB.readLiteRefreshToken(0)?.refreshToken).toBe('fake-refresh-1');

    // Tab A takes over B's fresh access token instead of renewing early, then
    // renews when the server refuses it, and the server rotates (Stalwart 1.0).
    await expect(tabA.liteRefreshTokens(0)).resolves.toMatchObject({ accessToken: 'fake-access-b' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'fake-access-a', refresh_token: 'fake-refresh-2', expires_in: 30 }));
    await tabA.liteRefreshTokens(0);
    expect(presented()).toBe('fake-refresh-1');

    // Tab B still holds the first token in memory, but presents the new one.
    expect(tabB.readLiteRefreshToken(0)).toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'fake-access-b2', expires_in: 3600 }));
    await tabB.liteRefreshTokens(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(presented()).toBe('fake-refresh-2');
    expect(tabB.readLiteRefreshToken(0)?.refreshToken).toBe('fake-refresh-2');
    expect(everythingAScriptCanRead()).not.toContain('fake-refresh-2');
  });

  it('keeps nothing of a session without "remember me" outside the tab', async () => {
    saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'alice', refreshToken: REFRESH }, false);
    saveLiteAccessToken(0, ACCESS, 1800, false);
    await settleLiteTokenStorage();
    expect(Object.keys(localStorage).filter((key) => key.startsWith('bulwark-lite:'))).toEqual([]);
    expect(Object.keys(sessionStorage).sort()).toEqual(['bulwark-lite:access:0', 'bulwark-lite:refresh:0']);
    expect(everythingAScriptCanRead()).not.toContain(REFRESH);
    // A new tab of the same profile has no sessionStorage: nothing to resume.
    sessionStorage.clear();
    forgetLiteTokenMemory();
    await expect(liteRefreshTokens(0)).rejects.toMatchObject({ code: 'refresh_rejected' });
  });

  it('deletes the sealed tokens at sign-out and account removal, and the key with the last account', async () => {
    const REVOKE = `${SERVER}/auth/revoke`;
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    for (const slot of [0, 1, 2]) {
      saveLiteRefreshToken(slot, { serverUrl: SERVER, username: `u${slot}`, refreshToken: `fake-refresh-${slot}`, revocationEndpoint: REVOKE }, slot !== 1);
      saveLiteAccessToken(slot, `fake-access-${slot}`, 1800, slot !== 1);
    }
    await settleLiteTokenStorage();
    expect((await indexedDbContents()).values).toHaveLength(1);

    // Sign-out of one account, after a reload: its token is unsealed to be revoked, and gone.
    forgetLiteTokenMemory();
    await revokeLiteSlot(1);
    expect(new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body)).get('token')).toBe('fake-refresh-1');
    expect(Object.keys(sessionStorage).filter((key) => key.startsWith('bulwark-lite:'))).toEqual([]);
    await settleLiteTokenStorage();
    expect((await indexedDbContents()).values).toHaveLength(1);

    // Removing an account.
    await retireLiteSlot(2, true);
    expect(localStorage.getItem('bulwark-lite:refresh:2')).toBeNull();
    expect(localStorage.getItem('bulwark-lite:access:2')).toBeNull();
    await settleLiteTokenStorage();
    expect((await indexedDbContents()).names).toContain('bulwark-lite-keys');

    // The last one: the key goes too.
    await revokeAllLiteSessions(true);
    await settleLiteTokenStorage();
    expect(Object.keys(localStorage).filter((key) => key.startsWith('bulwark-lite:'))).toEqual([]);
    expect((await indexedDbContents()).names).not.toContain('bulwark-lite-keys');
    const revoked = fetchMock.mock.calls.map(([, init]) => new URLSearchParams(String(init?.body)).get('token'));
    expect(revoked.sort()).toEqual(['fake-refresh-0', 'fake-refresh-1', 'fake-refresh-2']);

    // A new sign-in afterwards seals with a new key and works.
    await replaceLiteRefreshToken(0, { serverUrl: SERVER, username: 'u0', refreshToken: 'fake-refresh-new' }, true, true);
    await settleLiteTokenStorage();
    forgetLiteTokenMemory();
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'fake-access-new' }));
    await liteRefreshTokens(0);
    expect(new URLSearchParams(String(fetchMock.mock.calls.at(-1)?.[1]?.body)).get('refresh_token')).toBe('fake-refresh-new');
    clearLiteRefreshToken(0);
  });
});
