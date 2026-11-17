import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const SERVER = 'https://mail.example.com';

// #1750: a password + code sign-in whose token login the server refused
// (OAuth client, redirect URI or scope) fell back to Basic auth with
// `password$code`, which Stalwart 0.16 and later never accept, and so ended
// as "This code is wrong or too old" for a right code.
describe('auth-store TOTP login answered by the server (#1750)', () => {
  let connectSpy: ReturnType<typeof vi.spyOn>;
  let calls: string[];

  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    window.history.pushState({}, '', '/en/login');

    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
    useAuthStore.setState({
      isAuthenticated: false,
      isLoading: false,
      error: null,
      serverUrl: null,
      username: null,
      client: null,
      identities: [],
      primaryIdentity: null,
      authMode: 'basic',
      rememberMe: false,
      accessToken: null,
      tokenExpiresAt: null,
      connectionLost: false,
      activeAccountId: null,
    });

    connectSpy = vi.spyOn(JMAPClient.prototype, 'connect')
      .mockRejectedValue(new Error('Failed to get session: 401'));
  });

  afterEach(() => {
    connectSpy.mockRestore();
  });

  function stubExchange(status: number, body: unknown) {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      calls.push(url);
      if (url === '/api/auth/totp-token-exchange') {
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/auth/verify') {
        // The Basic pre-check: `password$code` is refused by 0.16+.
        expect(JSON.parse(String(init?.body)).password).toBe('pw$123456');
        return new Response(JSON.stringify({ result: 'unauthorized' }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
  }

  it('says the server refused the sign-in, without trying the code over Basic auth', async () => {
    stubExchange(502, { error: 'login_failed', detail: 'invalid_scope' });

    const ok = await useAuthStore.getState().login(SERVER, 'alice', 'pw', '123456');

    expect(ok).toBe(false);
    expect(useAuthStore.getState().error).toBe('login_refused');
    expect(calls).toEqual(['/api/auth/totp-token-exchange']);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('keeps a rejected password or code as wrong credentials, without a second try', async () => {
    stubExchange(401, { error: 'invalid_credentials' });

    await useAuthStore.getState().login(SERVER, 'alice', 'pw', '123456');

    expect(useAuthStore.getState().error).toBe('invalid_credentials');
    expect(calls).toEqual(['/api/auth/totp-token-exchange']);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('reports an unreachable mail server as a server error', async () => {
    stubExchange(502, { error: 'login_unreachable' });

    await useAuthStore.getState().login(SERVER, 'alice', 'pw', '123456');

    expect(useAuthStore.getState().error).toBe('server_error');
    expect(calls).toEqual(['/api/auth/totp-token-exchange']);
  });

  it('still sends the code over Basic auth to a server without the token login (404)', async () => {
    stubExchange(404, { error: 'login_endpoint_missing' });

    await useAuthStore.getState().login(SERVER, 'alice', 'pw', '123456');

    expect(calls).toEqual(['/api/auth/totp-token-exchange', '/api/auth/verify']);
    expect(useAuthStore.getState().error).toBe('invalid_credentials');
  });
});
