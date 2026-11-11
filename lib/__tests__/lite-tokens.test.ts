import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LiteLoginError,
  clearAllLiteSessions,
  clearLiteRefreshToken,
  clearLiteSlot,
  liteRefreshTokens,
  liteTokenLogin,
  probeLiteTokenLogin,
  readLiteAccessToken,
  revokeAllLiteSessions,
  revokeLiteSlot,
  readLiteBasicSession,
  readLiteRefreshToken,
  replaceLiteRefreshToken,
  resetLiteProbeCache,
  retireLiteRefreshToken,
  retireLiteSlot,
  resetLiteRegisteredClients,
  saveLiteAccessToken,
  saveLiteBasicSession,
  saveLiteRefreshToken,
  settleLiteTokenStorage,
} from '@/lib/auth/lite-tokens';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const SERVER = 'https://mail.example.com';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('lite token storage', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('keeps a remembered refresh token in localStorage and a tab-only one in sessionStorage, sealed', async () => {
    saveLiteRefreshToken(0, { serverUrl: `${SERVER}/`, username: 'alice', refreshToken: 'refresh-r0' }, true);
    saveLiteRefreshToken(1, { serverUrl: SERVER, username: 'bob', refreshToken: 'refresh-r1' }, false);
    await settleLiteTokenStorage();

    // The record names the account; the token itself is only there sealed.
    expect(JSON.parse(localStorage.getItem('bulwark-lite:refresh:0')!)).toEqual({ serverUrl: SERVER, username: 'alice', id: expect.any(String), sealed: expect.any(String) });
    expect(localStorage.getItem('bulwark-lite:refresh:0')).not.toContain('refresh-r0');
    expect(localStorage.getItem('bulwark-lite:refresh:1')).toBeNull();
    expect(JSON.parse(sessionStorage.getItem('bulwark-lite:refresh:1')!)).toMatchObject({ username: 'bob', sealed: expect.any(String) });
    expect(sessionStorage.getItem('bulwark-lite:refresh:1')).not.toContain('refresh-r1');
    expect(readLiteRefreshToken(0)?.refreshToken).toBe('refresh-r0');
    expect(readLiteRefreshToken(1)?.refreshToken).toBe('refresh-r1');
    expect(readLiteRefreshToken(2)).toBeNull();
  });

  it('moving a slot between persistence modes leaves no stale copy behind', () => {
    saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'alice', refreshToken: 'old' }, true);
    saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'alice', refreshToken: 'new' }, false);
    expect(localStorage.getItem('bulwark-lite:refresh:0')).toBeNull();
    expect(readLiteRefreshToken(0)?.refreshToken).toBe('new');
  });

  it('clears per slot and all at once, including the Basic fallback', () => {
    saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'a', refreshToken: 'r' }, true);
    saveLiteBasicSession(0, { serverUrl: SERVER, username: 'a', password: 'pw' });
    saveLiteBasicSession(3, { serverUrl: SERVER, username: 'c', password: 'pw3' });
    localStorage.setItem('unrelated', '1');

    clearLiteRefreshToken(0);
    expect(readLiteRefreshToken(0)).toBeNull();
    expect(readLiteBasicSession(0)?.password).toBe('pw');

    clearLiteSlot(0);
    expect(readLiteBasicSession(0)).toBeNull();
    expect(readLiteBasicSession(3)?.username).toBe('c');

    clearAllLiteSessions();
    expect(readLiteBasicSession(3)).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('1');
  });

  it('ignores corrupt storage entries', () => {
    localStorage.setItem('bulwark-lite:refresh:0', '{not json');
    sessionStorage.setItem('bulwark-lite:basic:0', JSON.stringify({ username: 'x' }));
    localStorage.setItem('bulwark-lite:access:0', JSON.stringify({ accessToken: 'AT' }));
    expect(readLiteRefreshToken(0)).toBeNull();
    expect(readLiteBasicSession(0)).toBeNull();
    expect(readLiteAccessToken(0)).toBeNull();
  });
});

describe('lite access token cache (#552)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ now: new Date('2026-09-29T12:00:00Z'), toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the access token where the session lives and reports its remaining life', () => {
    saveLiteAccessToken(0, 'AT0', 1800, true);
    saveLiteAccessToken(1, 'AT1', 600, false);

    expect(localStorage.getItem('bulwark-lite:access:1')).toBeNull();
    expect(sessionStorage.getItem('bulwark-lite:access:1')).not.toBeNull();
    expect(sessionStorage.getItem('bulwark-lite:access:1')).not.toContain('accessToken');
    vi.advanceTimersByTime(300_000);
    expect(readLiteAccessToken(0)).toEqual({ accessToken: 'AT0', expiresIn: 1500 });
    expect(readLiteAccessToken(1)).toEqual({ accessToken: 'AT1', expiresIn: 300 });
    expect(readLiteAccessToken(2)).toBeNull();
  });

  it('stops serving a token in its last minute, when renewal is due anyway', () => {
    saveLiteAccessToken(0, 'AT', 1800, true);
    vi.advanceTimersByTime(1740_000);
    expect(readLiteAccessToken(0)?.expiresIn).toBe(60);
    vi.advanceTimersByTime(1_000);
    expect(readLiteAccessToken(0)).toBeNull();
  });

  it('goes with the refresh token when the slot is cleared', () => {
    saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'a', refreshToken: 'r0' }, true);
    saveLiteAccessToken(0, 'AT0', 1800, true);
    saveLiteAccessToken(1, 'AT1', 1800, false);

    clearLiteRefreshToken(0);
    expect(readLiteAccessToken(0)).toBeNull();
    expect(readLiteAccessToken(1)?.accessToken).toBe('AT1');

    clearAllLiteSessions();
    expect(readLiteAccessToken(1)).toBeNull();
  });
});

describe('liteTokenLogin', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetLiteRegisteredClients();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs the authCode + PKCE flow against the mail server itself', async () => {
    fetchMock.mockImplementation(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url === `${SERVER}/api/auth`) {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          type: 'authCode',
          accountName: 'alice',
          accountSecret: 'pw',
          mfaToken: '123456',
          clientId: 'bulwark-webmail',
          redirectUri: 'https://lite.example/en/auth/callback',
          codeChallengeMethod: 'S256',
        });
        expect(body.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
        return jsonResponse({ type: 'authenticated', client_code: 'CODE' });
      }
      if (url === `${SERVER}/auth/token`) {
        const params = new URLSearchParams(String(init?.body));
        expect(params.get('grant_type')).toBe('authorization_code');
        expect(params.get('code')).toBe('CODE');
        expect(params.get('redirect_uri')).toBe('https://lite.example/en/auth/callback');
        expect(params.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(init?.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });
        return jsonResponse({ access_token: 'AT', expires_in: 1200, refresh_token: 'RT' });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const tokens = await liteTokenLogin({
      serverUrl: `${SERVER}/`,
      username: 'alice',
      password: 'pw',
      totp: '123456',
      redirectUri: 'https://lite.example/en/auth/callback',
    });

    expect(tokens).toEqual({ accessToken: 'AT', expiresIn: 1200, refreshToken: 'RT', clientId: 'bulwark-webmail' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('omits the MFA token when none was given and defaults expires_in', async () => {
    fetchMock.mockImplementation(async (input: FetchInput, init?: FetchInit) => {
      if (String(input).endsWith('/api/auth')) {
        expect(JSON.parse(String(init?.body))).not.toHaveProperty('mfaToken');
        return jsonResponse({ type: 'authenticated', client_code: 'C' });
      }
      return jsonResponse({ access_token: 'AT' });
    });
    const tokens = await liteTokenLogin({ serverUrl: SERVER, username: 'a', password: 'p', redirectUri: 'https://x/cb' });
    expect(tokens).toEqual({ accessToken: 'AT', expiresIn: 3600, refreshToken: null, clientId: 'bulwark-webmail' });
  });

  it.each([
    [{ type: 'mfaRequired' }, 'totp_required'],
    [{ type: 'failure' }, 'invalid_credentials'],
    [{ type: 'authenticated' }, 'login_failed'],
  ])('maps a %j login answer to %s', async (answer, code) => {
    fetchMock.mockResolvedValue(jsonResponse(answer));
    await expect(liteTokenLogin({ serverUrl: SERVER, username: 'a', password: 'p', redirectUri: 'https://x/cb' }))
      .rejects.toMatchObject({ name: 'LiteLoginError', code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a server without the structured login as endpoint_missing', async () => {
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));
    await expect(liteTokenLogin({ serverUrl: SERVER, username: 'a', password: 'p', redirectUri: 'https://x/cb' }))
      .rejects.toMatchObject({ code: 'endpoint_missing', status: 404 });
  });

  it('reports a failed code exchange', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ type: 'authenticated', client_code: 'C' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 400));
    await expect(liteTokenLogin({ serverUrl: SERVER, username: 'a', password: 'p', redirectUri: 'https://x/cb' }))
      .rejects.toMatchObject({ code: 'token_exchange_failed', status: 400 });
  });

  // Stalwart 1.0 (answers as seen live on 1.0.0): the request needs `query`,
  // the code comes in the redirect location, and only known clients sign in.
  function stalwart10(known: string[]) {
    return async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url === `${SERVER}/api/auth`) {
        const body = JSON.parse(String(init?.body));
        if (typeof body.query !== 'string') return jsonResponse({ title: 'Invalid parameters', detail: 'JSON deserialization failed' }, 400);
        const q = new URLSearchParams(body.query);
        if (!known.includes(q.get('client_id') ?? '')) return jsonResponse({ type: 'invalid', error: 'invalid_client', description: 'Unknown client id' });
        return jsonResponse({ type: 'authenticated', location: `${q.get('redirect_uri')}?code=V1&state=${q.get('state')}` });
      }
      if (url === `${SERVER}/auth/register`) return jsonResponse({ client_id: 'swc1.lite' }, 201);
      if (url === `${SERVER}/auth/token`) {
        const params = new URLSearchParams(String(init?.body));
        return params.get('code') === 'V1' ? jsonResponse({ access_token: 'AT', refresh_token: 'RT' }) : jsonResponse({ error: 'invalid_grant' }, 400);
      }
      throw new Error(`unexpected fetch ${url}`);
    };
  }

  it('signs in at Stalwart 1.0 with a client it knows', async () => {
    fetchMock.mockImplementation(stalwart10(['bulwark-webmail']));
    const tokens = await liteTokenLogin({ serverUrl: SERVER, username: 'a', password: 'p', redirectUri: 'https://x/cb' });
    expect(tokens).toEqual({ accessToken: 'AT', expiresIn: 3600, refreshToken: 'RT', clientId: 'bulwark-webmail' });
  });

  it('registers a client at Stalwart 1.0 when it knows none by the default name', async () => {
    fetchMock.mockImplementation(stalwart10(['swc1.lite']));
    const tokens = await liteTokenLogin({ serverUrl: SERVER, username: 'a', password: 'p', redirectUri: 'https://x/cb' });
    expect(tokens).toMatchObject({ accessToken: 'AT', clientId: 'swc1.lite' });
    const token = fetchMock.mock.calls.find(([url]) => String(url) === `${SERVER}/auth/token`)!;
    expect(new URLSearchParams(String(token[1]?.body)).get('redirect_uri')).toBe('http://127.0.0.1/bulwark-webmail/callback');
  });

  it('lets network failures propagate untouched', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(liteTokenLogin({ serverUrl: SERVER, username: 'a', password: 'p', redirectUri: 'https://x/cb' }))
      .rejects.toBeInstanceOf(TypeError);
  });
});

describe('liteRefreshTokens', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renews with grant_type=refresh_token and stores a rotated token where the old one lived', async () => {
    saveLiteRefreshToken(2, { serverUrl: SERVER, username: 'alice', refreshToken: 'RT1' }, true);
    fetchMock.mockImplementation(async (input: FetchInput, init?: FetchInit) => {
      expect(String(input)).toBe(`${SERVER}/auth/token`);
      const params = new URLSearchParams(String(init?.body));
      expect(params.get('grant_type')).toBe('refresh_token');
      expect(params.get('refresh_token')).toBe('RT1');
      expect(params.get('client_id')).toBe('bulwark-webmail');
      return jsonResponse({ access_token: 'AT2', expires_in: 900, refresh_token: 'RT2' });
    });

    const tokens = await liteRefreshTokens(2);

    expect(tokens).toEqual({ accessToken: 'AT2', expiresIn: 900, refreshToken: 'RT2' });
    expect(readLiteRefreshToken(2)?.refreshToken).toBe('RT2');
    expect(JSON.parse(localStorage.getItem('bulwark-lite:refresh:2')!)).toMatchObject({ username: 'alice', sealed: expect.any(String) });
    expect(localStorage.getItem('bulwark-lite:refresh:2')).not.toContain('refreshToken');
    expect(sessionStorage.getItem('bulwark-lite:refresh:2')).toBeNull();
    // The new access token is cached beside it for the next reload, sealed.
    expect(readLiteAccessToken(2)?.accessToken).toBe('AT2');
    expect(JSON.parse(localStorage.getItem('bulwark-lite:access:2')!)).toMatchObject({ sealed: expect.any(String) });
    expect(localStorage.getItem('bulwark-lite:access:2')).not.toContain('accessToken');
  });

  it('keeps a tab-only token in sessionStorage after rotation', async () => {
    saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'a', refreshToken: 'RT1' }, false);
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'AT', refresh_token: 'RT2' }));
    await liteRefreshTokens(0);
    expect(localStorage.getItem('bulwark-lite:refresh:0')).toBeNull();
    expect(readLiteRefreshToken(0)?.refreshToken).toBe('RT2');
    expect(localStorage.getItem('bulwark-lite:access:0')).toBeNull();
    expect(readLiteAccessToken(0)?.accessToken).toBe('AT');
  });

  it('rejects immediately without a stored token', async () => {
    await expect(liteRefreshTokens(0)).rejects.toMatchObject({ code: 'refresh_rejected' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears the slot when the server rejects the refresh token', async () => {
    saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'a', refreshToken: 'RT' }, true);
    saveLiteAccessToken(0, 'AT', 1800, true);
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));
    await expect(liteRefreshTokens(0)).rejects.toMatchObject({ code: 'refresh_rejected', status: 400 });
    expect(readLiteRefreshToken(0)).toBeNull();
    expect(readLiteAccessToken(0)).toBeNull();
  });

  it('keeps the token on a 5xx so the session can resume after the outage', async () => {
    saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'a', refreshToken: 'RT' }, true);
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    await expect(liteRefreshTokens(0)).rejects.toMatchObject({ code: 'token_exchange_failed', status: 503 });
    expect(readLiteRefreshToken(0)?.refreshToken).toBe('RT');
  });

  it.each([429, 408])('keeps the token on a %i, which is an outage and not a sign-out', async (status) => {
    saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'a', refreshToken: 'RT' }, true);
    fetchMock.mockResolvedValue(new Response('', { status }));
    await expect(liteRefreshTokens(0)).rejects.toMatchObject({ code: 'token_exchange_failed', status });
    expect(readLiteRefreshToken(0)?.refreshToken).toBe('RT');
  });

  it('propagates network errors and keeps the token', async () => {
    saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'a', refreshToken: 'RT' }, true);
    fetchMock.mockRejectedValue(new TypeError('offline'));
    await expect(liteRefreshTokens(0)).rejects.toBeInstanceOf(TypeError);
    expect(readLiteRefreshToken(0)?.refreshToken).toBe('RT');
  });
});

describe('probeLiteTokenLogin', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetLiteProbeCache();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers true for a Stalwart that validates the empty login and caches per URL', async () => {
    fetchMock.mockResolvedValue(new Response('bad request', { status: 400 }));
    await expect(probeLiteTokenLogin(`${SERVER}/`)).resolves.toBe(true);
    await expect(probeLiteTokenLogin(SERVER)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${SERVER}/api/auth`);
  });

  it.each([404, 405, 501])('answers false when the endpoint answers %i', async (status) => {
    fetchMock.mockResolvedValue(new Response('', { status }));
    await expect(probeLiteTokenLogin(SERVER)).resolves.toBe(false);
  });

  it('answers null when the server cannot be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('blocked'));
    await expect(probeLiteTokenLogin(SERVER)).resolves.toBeNull();
  });

  it('never probes a non-http URL', async () => {
    await expect(probeLiteTokenLogin('/api/dev-jmap')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exposes typed errors', () => {
    const err = new LiteLoginError('endpoint_missing', 404, 'nope');
    expect(err.message).toBe('endpoint_missing: nope');
    expect(err.status).toBe(404);
  });
});

describe('lite sign-out revocation (#1388)', () => {
  const REVOKE = `${SERVER}/auth/revoke`;
  const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'a', refreshToken: 'r0', revocationEndpoint: REVOKE }, true);
    saveLiteRefreshToken(1, { serverUrl: SERVER, username: 'b', refreshToken: 'r1', revocationEndpoint: REVOKE }, false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('revokes the refresh token by default', async () => {
    await revokeLiteSlot(0);

    expect(fetchMock).toHaveBeenCalledWith(REVOKE, expect.objectContaining({ method: 'POST' }));
    expect(readLiteRefreshToken(0)).toBeNull();
  });

  it('only forgets the tokens when revocation is turned off', async () => {
    await revokeLiteSlot(0, false);
    await revokeAllLiteSessions(false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readLiteRefreshToken(0)).toBeNull();
    expect(readLiteRefreshToken(1)).toBeNull();
  });
});

describe('lite tokens replaced by a new sign-in (#1571)', () => {
  const REVOKE = `${SERVER}/auth/revoke`;
  const fetchMock = vi.fn(async (_input: FetchInput, _init?: FetchInit) => new Response(null, { status: 200 }));
  const revoked = () => fetchMock.mock.calls.map(([, init]) => new URLSearchParams(String(init?.body)).get('token'));

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('revokes the token the slot held before and keeps the new one', async () => {
    saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'a', refreshToken: 'old', revocationEndpoint: REVOKE }, true);

    await replaceLiteRefreshToken(0, { serverUrl: SERVER, username: 'a', refreshToken: 'new', revocationEndpoint: REVOKE }, true, true);

    expect(revoked()).toEqual(['old']);
    expect(readLiteRefreshToken(0)?.refreshToken).toBe('new');
  });

  it('revokes a Stalwart OAuth token, whose endpoints are on the server origin', async () => {
    saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'a', refreshToken: 'old', tokenEndpoint: `${SERVER}/auth/token`, revocationEndpoint: REVOKE }, true);

    await replaceLiteRefreshToken(0, { serverUrl: SERVER, username: '', refreshToken: 'new' }, true, true);

    expect(revoked()).toEqual(['old']);
  });

  it('revokes nothing for the same token, with revocation off, or for an external provider', async () => {
    saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'a', refreshToken: 'same', revocationEndpoint: REVOKE }, true);
    await replaceLiteRefreshToken(0, { serverUrl: SERVER, username: 'a', refreshToken: 'same', revocationEndpoint: REVOKE }, true, true);

    await replaceLiteRefreshToken(0, { serverUrl: SERVER, username: 'a', refreshToken: 'next', revocationEndpoint: REVOKE }, true, false);

    saveLiteRefreshToken(1, {
      serverUrl: SERVER, username: 'b', refreshToken: 'sso',
      tokenEndpoint: 'https://id.example.org/token', revocationEndpoint: 'https://id.example.org/revoke',
    }, true);
    await replaceLiteRefreshToken(1, { serverUrl: SERVER, username: 'b', refreshToken: 'sso-2' }, true, true);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readLiteRefreshToken(0)?.refreshToken).toBe('next');
    expect(readLiteRefreshToken(1)?.refreshToken).toBe('sso-2');
  });

  it('retiring a slot forgets and revokes its token', async () => {
    saveLiteRefreshToken(2, { serverUrl: SERVER, username: 'c', refreshToken: 'r2', revocationEndpoint: REVOKE }, false);
    saveLiteBasicSession(2, { serverUrl: SERVER, username: 'c', password: 'p' });
    saveLiteRefreshToken(3, { serverUrl: SERVER, username: 'd', refreshToken: 'r3', revocationEndpoint: REVOKE }, true);

    await retireLiteSlot(2, true);
    await retireLiteRefreshToken(3, true);

    expect(revoked()).toEqual(['r2', 'r3']);
    expect(readLiteRefreshToken(2)).toBeNull();
    expect(readLiteBasicSession(2)).toBeNull();
    expect(readLiteRefreshToken(3)).toBeNull();
  });
});
