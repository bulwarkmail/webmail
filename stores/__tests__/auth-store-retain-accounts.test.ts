import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';
import type { AccountEntry } from '../account-store';

const session = vi.hoisted(() => ({ username: '', connect: async () => {} }));
vi.mock('@/lib/jmap/client', () => {
  class JMAPClient {
    constructor(public serverUrl: string, public username: string, public password: string) {}
    static withBearer(serverUrl: string, _token: string, username: string) { return new JMAPClient(serverUrl, username, ''); }
    async connect() { await session.connect(); if (this.password === 'wrong') throw new Error('Authentication failed'); }
    getSessionUsername() { return session.username || this.username; }
    getServerUrl() { return this.serverUrl; }
    getUsername() { return this.username; }
    getAuthHeader() { return 'Basic eA=='; }
    async getIdentities() { return [{ id: 'identity', email: this.getSessionUsername(), name: this.getSessionUsername() }]; }
    getAccountId() { return this.getSessionUsername(); }
    getRateLimitRemainingMs() { return 0; }
    onConnectionChange() {}
    onRateLimit() {}
    supportsContacts() { return false; }
    supportsPrincipals() { return false; }
    supportsVacationResponse() { return false; }
    supportsCalendars() { return false; }
    supportsSieve() { return false; }
    disconnect() {}
  }
  class RateLimitError extends Error {}
  class RequestTimeoutError extends Error {}
  return { JMAPClient, RateLimitError, RequestTimeoutError };
});
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null }));

let auth: typeof import('../auth-store').useAuthStore;
let accounts: typeof import('../account-store').useAccountStore;
let requests: Array<{ url: string; method: string }>;
const redirect = vi.fn();

/** Create metadata without a usable session or native secret. */
function entry(name: string, slot = 0): AccountEntry {
  const username = `${name}@example.test`;
  return {
    id: `${username}@mail.example.test`, username, email: username,
    label: name, displayName: name, serverUrl: 'https://mail.example.test',
    authMode: 'basic', rememberMe: true, cookieSlot: slot,
    isConnected: false, hasError: false, isDefault: slot === 0,
    lastLoginAt: 1, avatarColor: '#000000',
  };
}

/** Seed one browser's account registry independently of authentication state. */
function seed(entries: AccountEntry[]) {
  accounts.setState({ accounts: entries, activeAccountId: entries[0]?.id ?? null, defaultAccountId: entries[0]?.id ?? null });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  window.history.pushState({}, '', '/en/mail');
  requests = [];
  session.username = '';
  session.connect = async () => {};
  redirect.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ url, method });
    if (url.includes('/api/config')) return Response.json(createConfig());
    if (method === 'POST') return Response.json({ access_token: 'fresh', expires_in: 3600 });
    if (method === 'DELETE') return Response.json({});
    return Response.json({}, { status: 401 });
  }));
  ({ useAuthStore: auth } = await import('../auth-store'));
  ({ useAccountStore: accounts } = await import('../account-store'));
  const nav = await import('@/lib/browser-navigation');
  vi.spyOn(nav, 'replaceWindowLocation').mockImplementation(redirect);
  seed([]);
  auth.setState({ isAuthenticated: false, client: null, activeAccountId: null, error: null });
}, 60_000);

afterEach(() => {
  for (const client of auth.getState().getAllConnectedClients().values()) client.disconnect();
  vi.unstubAllGlobals();
});

describe('account entries outlive an unrestorable session', () => {
  it.each(['basic', 'oauth'] as const)('keeps a %s account for sign-in and clears its native credentials', async (authMode) => {
    const saved = { ...entry('alice', 2), authMode };
    seed([saved]);
    const offline = await import('@/lib/offline/state');
    offline.writeEnabled([saved.id]);
    await auth.getState().checkAuth();
    expect(accounts.getState().getAccountById(saved.id)).toMatchObject({
      username: saved.username, serverUrl: saved.serverUrl, label: saved.label,
      cookieSlot: 2, awaitingSignIn: true, isConnected: false, hasError: false,
    });
    expect(auth.getState().isAuthenticated).toBe(false);
    expect(auth.getState().error).not.toBe('connection_failed');
    expect(offline.isEvicted(saved.id)).toBe(true);
    expect(offline.visibleAccounts()).not.toContain(saved.id);
    await vi.waitFor(() => expect(requests).toContainEqual({ url: '/api/auth/session?slot=2', method: 'DELETE' }));
    if (authMode === 'oauth') expect(requests).toContainEqual({ url: '/api/auth/token?slot=2', method: 'DELETE' });
  });

  it('forgets a non-remembered account without reporting fake expiry', async () => {
    const saved = { ...entry('alice'), rememberMe: false };
    seed([saved]);
    await auth.getState().checkAuth();
    expect(accounts.getState().getAccountById(saved.id)).toBeUndefined();
    expect(sessionStorage.getItem('session_expired')).toBeNull();
    expect(requests.some((request) => request.url.includes('/api/auth/session') && request.method === 'GET')).toBe(false);
  });

  it('does not retry a rejected session on the next reload', async () => {
    const saved = entry('alice');
    seed([saved]);
    await auth.getState().checkAuth();
    requests.length = 0;
    sessionStorage.clear();
    await auth.getState().checkAuth();
    expect(accounts.getState().getAccountById(saved.id)?.awaitingSignIn).toBe(true);
    expect(requests.some((request) => request.method !== 'DELETE')).toBe(false);
    expect(sessionStorage.getItem('session_expired')).toBeNull();
  });

  it('removes an explicitly signed-out account but preserves another account awaiting sign-in on disk', async () => {
    const active = entry('alice');
    const pending = { ...entry('bob', 1), awaitingSignIn: true, rememberMe: false };
    seed([active, pending]);
    auth.setState({ isAuthenticated: true, activeAccountId: active.id, authMode: 'basic' });
    await auth.getState().logout();
    expect(accounts.getState().accounts.map((account) => account.id)).toEqual([pending.id]);
    const persisted = JSON.parse(localStorage.getItem('account-registry') ?? 'null');
    expect(persisted?.state.accounts.map((account: AccountEntry) => account.id)).toEqual([pending.id]);
    expect(accounts.getState().activeAccountId).toBeNull();
  });

  it('keeps only metadata after automatic sign-out and clears cached account data', async () => {
    const active = entry('alice');
    seed([active]);
    localStorage.setItem('email-snapshot', 'cached mail');
    auth.setState({ isAuthenticated: true, activeAccountId: active.id, authMode: 'basic' });
    await auth.getState().logout({ endProviderSession: false, keepLocalData: true });
    expect(accounts.getState().getAccountById(active.id)?.awaitingSignIn).toBe(true);
    expect(auth.getState().client).toBeNull();
    expect(auth.getState().isAuthenticated).toBe(false);
    expect(localStorage.getItem('email-snapshot')).toBeNull();
    expect(localStorage.getItem('auth-storage')).toBeNull();
  });

  it('forgets all entries on explicit sign-out of all accounts', async () => {
    seed([entry('alice'), { ...entry('bob', 1), awaitingSignIn: true }]);
    await auth.getState().logoutAll();
    expect(accounts.getState().accounts).toEqual([]);
    expect(localStorage.getItem('account-registry')).toBeNull();
  });

  it('uses the retained account for reauthentication and then allows explicit removal', async () => {
    const saved = entry('alice');
    seed([saved]);
    const offline = await import('@/lib/offline/state');
    offline.writeEnabled([saved.id]);
    await auth.getState().checkAuth();
    await auth.getState().switchAccount(saved.id);
    expect(redirect).toHaveBeenCalledWith(`/en/login?mode=add-account&account=${encodeURIComponent(saved.id)}`);
    expect(await auth.getState().signInRestoredAccount(saved.id, 'new-password', true)).toBe(true);
    expect(accounts.getState().getAccountById(saved.id)).toMatchObject({ cookieSlot: 0, awaitingSignIn: false, isConnected: true });
    expect(offline.isEvicted(saved.id)).toBe(false);
    auth.getState().removeAccount(saved.id);
    expect(accounts.getState().getAccountById(saved.id)).toBeUndefined();
  });

  it('does not expose a pending account when the server authenticates a different owner', async () => {
    const saved = { ...entry('alice'), awaitingSignIn: true };
    seed([saved]);
    session.username = 'bob@example.test';
    expect(await auth.getState().signInRestoredAccount(saved.id, 'password', true)).toBe(false);
    expect(accounts.getState().getAccountById(saved.id)?.awaitingSignIn).toBe(true);
    expect(auth.getState().getAllConnectedClients().size).toBe(0);
  });

  it.each(['alice', 'bob'])('only binds an OAuth callback for the selected account: %s', async (name) => {
    const saved = { ...entry('alice'), awaitingSignIn: true };
    seed([saved]);
    session.username = `${name}@example.test`;
    sessionStorage.setItem('oauth_reauthenticate_account', saved.id);
    const success = await auth.getState().loginWithOAuth(saved.serverUrl, 'code', 'verifier', 'https://app.test/en/auth/callback');
    expect(success).toBe(name === 'alice');
    expect(accounts.getState().accounts).toHaveLength(1);
    expect(accounts.getState().getAccountById(saved.id)?.awaitingSignIn).toBe(name === 'alice' ? undefined : true);
    expect(sessionStorage.getItem('oauth_reauthenticate_account')).toBeNull();
  });

  it('does not revive an entry removed while its password was being checked', async () => {
    const saved = { ...entry('alice'), awaitingSignIn: true };
    seed([saved]);
    let connected!: () => void;
    const started = new Promise<void>((resolve) => { connected = resolve; });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    session.connect = async () => { connected(); await waiting; };
    const signingIn = auth.getState().signInRestoredAccount(saved.id, 'password', true);
    await started;
    auth.getState().removeAccount(saved.id);
    release();
    expect(await signingIn).toBe(false);
    expect(accounts.getState().accounts).toEqual([]);
    expect(auth.getState().getAllConnectedClients().size).toBe(0);
  });

  it('does not send a targeted login to another port on the same hostname', async () => {
    const saved = { ...entry('alice'), serverUrl: 'https://mail.example.test:8443/jmap', awaitingSignIn: true };
    seed([saved]);
    expect(await auth.getState().login('https://mail.example.test', saved.username, 'password', undefined, true, saved.id)).toBe(false);
    expect(accounts.getState().getAccountById(saved.id)?.awaitingSignIn).toBe(true);
  });

  it('waits for an expired session cleanup before writing a fresh password session', async () => {
    const saved = entry('alice');
    seed([saved]);
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    let release!: () => void;
    const deleting = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') await deleting;
      return originalFetch(input, init);
    }));
    await auth.getState().checkAuth();
    const connect = vi.fn(async () => {});
    session.connect = connect;
    const signingIn = auth.getState().signInRestoredAccount(saved.id, 'password', true);
    await Promise.resolve();
    expect(connect).not.toHaveBeenCalled();
    release();
    expect(await signingIn).toBe(true);
    expect(requests).toContainEqual({ url: '/api/auth/session?slot=0', method: 'POST' });
    expect(requests).toContainEqual({ url: '/api/auth/stalwart-context', method: 'POST' });
  });

  it('does not extend a pending account data retention when another session expires', async () => {
    const pending = { ...entry('alice'), awaitingSignIn: true };
    const active = entry('bob', 1);
    seed([pending, active]);
    const offline = await import('@/lib/offline/state');
    offline.writeEnabled([pending.id]);
    const firstExpiry = Date.now() - 29 * 24 * 60 * 60 * 1_000;
    offline.markEvicted(pending.id, firstExpiry);
    await auth.getState().logoutAll({ endProviderSession: false, keepLocalData: true });
    expect(offline.readEvicted()[pending.id]).toBe(firstExpiry);
  });
});
