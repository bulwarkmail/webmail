import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LiteLoginError,
  clearAllLiteSessions,
  clearLiteRefreshToken,
  clearLiteSlot,
  liteRefreshTokens,
  liteTokenLogin,
  probeLiteTokenLogin,
  readLiteBasicSession,
  readLiteRefreshToken,
  resetLiteProbeCache,
  saveLiteBasicSession,
  saveLiteRefreshToken,
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

  it('keeps a remembered refresh token in localStorage and a tab-only one in sessionStorage', () => {
    saveLiteRefreshToken(0, { serverUrl: `${SERVER}/`, username: 'alice', refreshToken: 'r0' }, true);
    saveLiteRefreshToken(1, { serverUrl: SERVER, username: 'bob', refreshToken: 'r1' }, false);

    expect(JSON.parse(localStorage.getItem('bulwark-lite:refresh:0')!)).toEqual({ serverUrl: SERVER, username: 'alice', refreshToken: 'r0' });
    expect(localStorage.getItem('bulwark-lite:refresh:1')).toBeNull();
    expect(JSON.parse(sessionStorage.getItem('bulwark-lite:refresh:1')!).refreshToken).toBe('r1');
    expect(readLiteRefreshToken(0)?.refreshToken).toBe('r0');
    expect(readLiteRefreshToken(1)?.refreshToken).toBe('r1');
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
    expect(readLiteRefreshToken(0)).toBeNull();
    expect(readLiteBasicSession(0)).toBeNull();
  });
});

describe('liteTokenLogin', () => {
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

    expect(tokens).toEqual({ accessToken: 'AT', expiresIn: 1200, refreshToken: 'RT' });
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
    expect(tokens).toEqual({ accessToken: 'AT', expiresIn: 3600, refreshToken: null });
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
    expect(JSON.parse(localStorage.getItem('bulwark-lite:refresh:2')!).refreshToken).toBe('RT2');
    expect(sessionStorage.getItem('bulwark-lite:refresh:2')).toBeNull();
  });

  it('keeps a tab-only token in sessionStorage after rotation', async () => {
    saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'a', refreshToken: 'RT1' }, false);
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'AT', refresh_token: 'RT2' }));
    await liteRefreshTokens(0);
    expect(localStorage.getItem('bulwark-lite:refresh:0')).toBeNull();
    expect(readLiteRefreshToken(0)?.refreshToken).toBe('RT2');
  });

  it('rejects immediately without a stored token', async () => {
    await expect(liteRefreshTokens(0)).rejects.toMatchObject({ code: 'refresh_rejected' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears the slot when the server rejects the refresh token', async () => {
    saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'a', refreshToken: 'RT' }, true);
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));
    await expect(liteRefreshTokens(0)).rejects.toMatchObject({ code: 'refresh_rejected', status: 400 });
    expect(readLiteRefreshToken(0)).toBeNull();
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
