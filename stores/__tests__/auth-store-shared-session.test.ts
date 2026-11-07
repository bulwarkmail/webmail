import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBroadcastChannel } from '@/lib/__tests__/fixtures/fake-broadcast-channel';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// A pop-out starts on the main window's session. It must not evict an account
// (a login without "remember me" has nothing to restore, which checkAuth
// answers by removing it from the list every window shares), and must not
// refresh on its own: without a cross-window lock a stale refresh can end in
// `Replay` on Stalwart 1.0, which revokes the grant.

// Going on without a main window waits out its answer, 3 s on a timer that a busy machine stretches.
vi.setConfig({ testTimeout: 30_000 });

const made: Array<{ header: string; refresh?: () => Promise<string | null> }> = [];

vi.mock('@/lib/jmap/client', () => {
  class JMAPClient {
    authHeader = '';
    onTokenRefresh?: () => Promise<string | null>;
    constructor(public serverUrl: string, public username: string, public password: string) {
      this.authHeader = `Basic ${password}`;
    }
    static withBearer(serverUrl: string, token: string, username: string, refresh?: () => Promise<string | null>) {
      const client = new JMAPClient(serverUrl, username, '');
      client.authHeader = `Bearer ${token}`;
      client.onTokenRefresh = refresh;
      made.push({ header: client.authHeader, refresh });
      return client;
    }
    static withSharedAuth(serverUrl: string, username: string, header: string, refresh?: () => Promise<string | null>) {
      const client = new JMAPClient(serverUrl, username, '');
      client.authHeader = header;
      client.onTokenRefresh = refresh;
      made.push({ header, refresh });
      return client;
    }
    async connect() {}
    getSessionUsername() { return this.username; }
    getUsername() { return this.username; }
    async getIdentities() { return [{ id: 'i', email: this.username, name: this.username, mayDelete: false }]; }
    getAuthHeader() { return this.authHeader; }
    updateAccessToken(token: string) { this.authHeader = `Bearer ${token}`; }
    onConnectionChange() {}
    onRateLimit() {}
    getRateLimitRemainingMs() { return 0; }
    supportsContacts() { return false; }
    supportsPrincipals() { return false; }
    supportsVacationResponse() { return false; }
    supportsCalendars() { return false; }
    supportsSieve() { return false; }
    disconnect() {}
    getAccountId() { return 'acct'; }
    isOfflineOnly() { return false; }
  }
  class RateLimitError extends Error {}
  return { JMAPClient, RateLimitError };
});
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null }));

import { openPopoutChannel, type PopoutChannel } from '@/lib/popout/channel';
import { credentialFingerprint, sealFor } from '@/lib/popout/sealed';
import { useAccountStore } from '@/stores/account-store';
import { SHARED_SESSION_ENDED_EVENT, useAuthStore } from '@/stores/auth-store';
import { SIGNED_OUT_KEY } from '@/lib/sign-out-cleanup';

const account = (id: string, slot: number, over: Record<string, unknown> = {}) => ({
  id, label: id, serverUrl: 'https://mail.example.test', username: `${id}@example.test`, authMode: 'oauth' as const,
  rememberMe: true, cookieSlot: slot, displayName: id, email: `${id}@example.test`, isConnected: false, hasError: false,
  lastLoginAt: 1, avatarColor: '#000', isDefault: slot === 0, ...over,
});

let fetched: Array<{ url: string; method?: string }>;
let tokenAnswers: Response[];
let main: PopoutChannel | null;
let requests: Array<{ accountId?: string; rejectedFingerprint?: string }>;

function startMainWindow(answer: (request: { accountId?: string; rejectedFingerprint?: string }) => { activeAccountId: string; sessions: unknown[] } | null) {
  main = openPopoutChannel((message) => {
    if (message.type !== 'session-request') return;
    requests.push({ accountId: message.accountId, rejectedFingerprint: message.rejectedFingerprint });
    const result = answer(message);
    if (result) void sealFor(message.publicKey, result).then((sealed) => main?.post({ type: 'session-answer', requestId: message.requestId, sealed }));
  });
}

const session = (id: string, authHeader = 'Bearer main-token', authMode = 'oauth') => ({
  accountId: id, serverUrl: 'https://mail.example.test', username: `${id}@example.test`, authMode, authHeader,
});

const tokenCalls = () => fetched.filter((call) => call.url.includes('/api/auth/token'));
const sessionCalls = () => fetched.filter((call) => call.url.includes('/api/auth/session'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true, advanceTimeDelta: 50 });
  FakeBroadcastChannel.reset();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  window.history.replaceState(null, '', '/en/popout/message/abc');
  made.length = 0;
  fetched = [];
  tokenAnswers = [];
  requests = [];
  main = null;
  useAccountStore.setState({ accounts: [account('alice', 0)], activeAccountId: 'alice', defaultAccountId: 'alice' });
  useAuthStore.setState({ isAuthenticated: false, client: null, activeAccountId: null });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/config')) return new Response(JSON.stringify(createConfig()), { status: 200 });
    fetched.push({ url: String(url), method: init?.method });
    if (String(url).includes('/api/auth/token')) {
      return tokenAnswers.shift() ?? new Response(JSON.stringify({ access_token: 'cookie-token', expires_in: 3600 }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
});

afterEach(() => {
  main?.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  localStorage.clear();
});

describe('startSharedSession', () => {
  it('uses the main window\'s session and asks no auth route for anything', async () => {
    startMainWindow(() => ({ activeAccountId: 'alice', sessions: [session('alice')] }));
    await expect(useAuthStore.getState().startSharedSession()).resolves.toBe('ready');
    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.activeAccountId).toBe('alice');
    expect(state.client?.getAuthHeader()).toBe('Bearer main-token');
    expect(tokenCalls()).toEqual([]);
    expect(sessionCalls()).toEqual([]);
  });

  it('takes a login without "remember me" from the main window too', async () => {
    useAccountStore.setState({ accounts: [account('alice', 0, { rememberMe: false, authMode: 'basic' })] });
    startMainWindow(() => ({ activeAccountId: 'alice', sessions: [session('alice', 'Basic abc', 'basic')] }));
    await expect(useAuthStore.getState().startSharedSession()).resolves.toBe('ready');
    expect(useAuthStore.getState().client?.getAuthHeader()).toBe('Basic abc');
  });

  it('asks for the login it wants, so only a window holding it answers', async () => {
    useAccountStore.setState({ accounts: [account('alice', 0), account('bob', 1)] });
    startMainWindow(() => ({ activeAccountId: 'bob', sessions: [session('bob', 'Bearer bob-token')] }));
    await useAuthStore.getState().startSharedSession({ accountId: 'bob' });
    expect(requests[0].accountId).toBe('bob');
  });

  it('opens the login it was asked for, whatever the main window has active', async () => {
    useAccountStore.setState({ accounts: [account('alice', 0), account('bob', 1)] });
    startMainWindow(() => ({ activeAccountId: 'alice', sessions: [session('alice'), session('bob', 'Bearer bob-token')] }));
    await useAuthStore.getState().startSharedSession({ accountId: 'bob' });
    expect(useAuthStore.getState().activeAccountId).toBe('bob');
    expect(useAuthStore.getState().client?.getAuthHeader()).toBe('Bearer bob-token');
  });

  it('never evicts: a login without "remember me" and no main window stays in the list', async () => {
    useAccountStore.setState({ accounts: [account('alice', 0, { rememberMe: false, authMode: 'basic' })] });
    await expect(useAuthStore.getState().startSharedSession()).resolves.toBe('no-session');
    expect(useAccountStore.getState().accounts.map((a) => a.id)).toEqual(['alice']);
    expect(sessionCalls().filter((call) => call.method === 'DELETE')).toEqual([]);
    expect(tokenCalls().filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('never evicts on a refused cookie either', async () => {
    tokenAnswers.push(new Response('{}', { status: 401 }));
    await expect(useAuthStore.getState().startSharedSession()).resolves.toBe('no-session');
    expect(useAccountStore.getState().accounts.map((a) => a.id)).toEqual(['alice']);
  });

  it('restores from the cookies when no main window is open, without forcing a renewal', async () => {
    await expect(useAuthStore.getState().startSharedSession()).resolves.toBe('ready');
    expect(useAuthStore.getState().client?.getAuthHeader()).toBe('Bearer cookie-token');
    const [call] = tokenCalls();
    expect(call.url).not.toContain('force=true');
  });

  it('does not write the list or the active account that the main window owns', async () => {
    useAccountStore.setState({ accounts: [account('alice', 0), account('bob', 1)], activeAccountId: 'alice' });
    localStorage.setItem('account-registry', 'written by the main window');
    localStorage.setItem('auth-storage', 'written by the main window');
    startMainWindow(() => ({ activeAccountId: 'alice', sessions: [session('bob', 'Bearer bob-token')] }));
    await useAuthStore.getState().startSharedSession({ accountId: 'bob' });
    expect(localStorage.getItem('account-registry')).toBe('written by the main window');
    expect(localStorage.getItem('auth-storage')).toBe('written by the main window');
  });

  it('starts no refresh timer', async () => {
    startMainWindow(() => ({ activeAccountId: 'alice', sessions: [session('alice')] }));
    await useAuthStore.getState().startSharedSession();
    await vi.advanceTimersByTimeAsync(7_200_000);
    expect(tokenCalls()).toEqual([]);
    expect(requests).toHaveLength(1);
  });
});

describe('a token the server refused in a pop-out', () => {
  async function started() {
    startMainWindow((request) => {
      const header = request.rejectedFingerprint ? 'Bearer renewed-by-main' : 'Bearer main-token';
      return { activeAccountId: 'alice', sessions: [session('alice', header)] };
    });
    await useAuthStore.getState().startSharedSession();
    return made[made.length - 1].refresh!;
  }

  it('comes from the main window, which is told which one was refused', async () => {
    const refresh = await started();
    await expect(refresh()).resolves.toBe('renewed-by-main');
    expect(requests[1]).toEqual({ accountId: 'alice', rejectedFingerprint: await credentialFingerprint('Bearer main-token') });
    expect(tokenCalls()).toEqual([]);
  });

  it('gives up when the main window could not renew it, without signing anyone out', async () => {
    startMainWindow(() => ({ activeAccountId: 'alice', sessions: [session('alice')] }));
    await useAuthStore.getState().startSharedSession();
    const refresh = made[made.length - 1].refresh!;
    await expect(refresh()).resolves.toBeNull();
    expect(tokenCalls()).toEqual([]);
    expect(useAccountStore.getState().accounts).toHaveLength(1);
  });

  it('comes through the locked cookie path once no main window is left', async () => {
    const refresh = await started();
    main?.close();
    main = null;
    const locks = { request: vi.fn((_name: string, _options: object, callback: (lock: unknown) => Promise<unknown>) => callback({})) };
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    try {
      await expect(refresh()).resolves.toBe('cookie-token');
    } finally {
      Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
    }
    expect(locks.request.mock.calls[0][0]).toBe('bulwark-token-refresh:0');
    expect(tokenCalls()).toHaveLength(1);
  });

  it('forces a renewal only when the cookie holds the refused token', async () => {
    const refresh = await started();
    main?.close();
    main = null;
    tokenAnswers.push(new Response(JSON.stringify({ access_token: 'main-token', expires_in: 3600 }), { status: 200 }));
    await expect(refresh()).resolves.toBe('cookie-token');
    expect(tokenCalls().map((call) => call.url.includes('force=true'))).toEqual([false, true]);
  });

  it('says so and signs nobody out when the cookie is refused too', async () => {
    const refresh = await started();
    main?.close();
    main = null;
    tokenAnswers.push(new Response('{}', { status: 401 }));
    const ended = vi.fn();
    window.addEventListener(SHARED_SESSION_ENDED_EVENT, ended);
    await expect(refresh()).resolves.toBeNull();
    window.removeEventListener(SHARED_SESSION_ENDED_EVENT, ended);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(useAccountStore.getState().accounts).toHaveLength(1);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });
});

describe('renewals in a main window', () => {
  it('take the same lock, so a main window and a pop-out never race', async () => {
    window.history.replaceState(null, '', '/mail');
    const locks = { request: vi.fn((_name: string, _options: object, callback: (lock: unknown) => Promise<unknown>) => callback({})) };
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    try {
      await useAuthStore.getState().refreshAccessToken({ accountId: 'alice', allowCached: true });
    } finally {
      Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
    }
    expect(locks.request.mock.calls.map((call) => call[0])).toContain('bulwark-token-refresh:0');
  });

  /** One window holds the lock until `release`; this one queues behind it. */
  function contendedLocks() {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const locks = {
      request: vi.fn((_name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => Promise<unknown>) =>
        (options.ifAvailable ? Promise.resolve(callback(null)) : held.then(() => callback({})))),
    };
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    return { release: () => release() };
  }
  const clearLocks = () => Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });

  beforeEach(() => {
    window.history.replaceState(null, '', '/mail');
  });
  afterEach(clearLocks);

  it('force a renewal when nobody else was at it', async () => {
    const locks = { request: vi.fn((_name: string, _options: object, callback: (lock: unknown) => Promise<unknown>) => callback({})) };
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    await useAuthStore.getState().refreshAccessToken({ accountId: 'alice' });
    expect(tokenCalls()[0].url).toContain('force=true');
  });

  it('take the cached token after waiting for another window: a second renewal this soon can be refused', async () => {
    const { release } = contendedLocks();
    const renewal = useAuthStore.getState().refreshAccessToken({ accountId: 'alice' });
    await vi.advanceTimersByTimeAsync(10);
    expect(tokenCalls()).toEqual([]);
    release();
    await expect(renewal).resolves.toBe('cookie-token');
    expect(tokenCalls()).toHaveLength(1);
    expect(tokenCalls()[0].url).not.toContain('force=true');
  });

  it('sign nobody out when the account left during the wait', async () => {
    const logout = vi.fn(async () => {});
    const removeAccount = vi.fn();
    useAuthStore.setState({ logout: logout as never, removeAccount: removeAccount as never, activeAccountId: 'bob' });
    useAccountStore.setState({ accounts: [account('alice', 0), account('bob', 1)] });
    tokenAnswers.push(new Response('{}', { status: 401 }));
    const { release } = contendedLocks();
    const renewal = useAuthStore.getState().refreshAccessToken({ accountId: 'alice' });
    await vi.advanceTimersByTimeAsync(10);
    useAccountStore.setState({ accounts: [account('bob', 1)] });
    release();
    await expect(renewal).resolves.toBeNull();
    expect(logout).not.toHaveBeenCalled();
    expect(removeAccount).not.toHaveBeenCalled();
  });

  it('judge who is active after the wait, not before: a refusal for a background account signs out only that one', async () => {
    const logout = vi.fn(async () => {});
    const removeAccount = vi.fn();
    useAccountStore.setState({ accounts: [account('alice', 0), account('bob', 1)] });
    useAuthStore.setState({ logout: logout as never, removeAccount: removeAccount as never, activeAccountId: 'alice' });
    tokenAnswers.push(new Response('{}', { status: 401 }));
    const { release } = contendedLocks();
    const renewal = useAuthStore.getState().refreshAccessToken({ accountId: 'alice' });
    await vi.advanceTimersByTimeAsync(10);
    // The user switched to bob while it waited. The refused token is alice's.
    useAuthStore.setState({ activeAccountId: 'bob' });
    release();
    await renewal;
    expect(removeAccount).toHaveBeenCalledWith('alice', 'evicted');
    expect(logout).not.toHaveBeenCalled();
  });
});

describe('everyone signing out in another window', () => {
  it('leaves a pop-out alone here, which saves its typing first (popout-shell)', () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    useAuthStore.setState({ isAuthenticated: true });
    window.dispatchEvent(new StorageEvent('storage', { key: SIGNED_OUT_KEY, newValue: '1' }));
    expect(close).not.toHaveBeenCalled();
    close.mockRestore();
  });
});
