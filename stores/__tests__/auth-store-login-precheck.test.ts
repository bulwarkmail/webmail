import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

const SERVER = 'https://mail.example.com';

// The login form's Basic-auth path asks /api/auth/verify first (#969) so a
// wrong password is rejected by our own origin as JSON instead of by the JMAP
// server as 401 + WWW-Authenticate: Basic, which would make the browser open
// its native login dialog on same-origin deployments.
describe('auth-store login Basic-auth pre-check (#969)', () => {
  let connectSpy: ReturnType<typeof vi.spyOn>;

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

    // Whatever the pre-check decides, a browser-side connect in these tests
    // ends the login with a server error so we never reach the post-connect
    // identity/settings machinery.
    connectSpy = vi.spyOn(JMAPClient.prototype, 'connect')
      .mockRejectedValue(new Error('Failed to get session: 503'));
  });

  afterEach(() => {
    connectSpy.mockRestore();
  });

  function stubVerify(handler: (init?: FetchInit) => Promise<unknown>) {
    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url === '/api/auth/verify') return handler(init);
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('rejects wrong credentials from the backend without touching the JMAP server from the browser', async () => {
    const fetchMock = stubVerify(async () => ({ ok: true, json: async () => ({ result: 'unauthorized' }) }));

    const ok = await useAuthStore.getState().login(SERVER, 'alice', 'wrong');

    expect(ok).toBe(false);
    expect(connectSpy).not.toHaveBeenCalled();
    expect(useAuthStore.getState().error).toBe('invalid_credentials');
    expect(useAuthStore.getState().isLoading).toBe(false);

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ serverUrl: SERVER, username: 'alice', password: 'wrong' });
  });

  it('falls through to the browser-side connect when the pre-check is inconclusive', async () => {
    stubVerify(async () => ({ ok: true, json: async () => ({ result: 'inconclusive' }) }));

    const ok = await useAuthStore.getState().login(SERVER, 'alice', 'pw');

    expect(ok).toBe(false);
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().error).toBe('server_error');
  });

  it('falls through when the pre-check route itself fails or is missing', async () => {
    stubVerify(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    await useAuthStore.getState().login(SERVER, 'alice', 'pw');
    expect(connectSpy).toHaveBeenCalledTimes(1);

    connectSpy.mockClear();
    stubVerify(async () => { throw new TypeError('Failed to fetch'); });
    await useAuthStore.getState().login(SERVER, 'alice', 'pw');
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('skips the pre-check for app-relative (mock) servers', async () => {
    const fetchMock = stubVerify(async () => ({ ok: true, json: async () => ({ result: 'unauthorized' }) }));

    await useAuthStore.getState().login('/api/dev-jmap', 'alice', 'pw');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });
});
