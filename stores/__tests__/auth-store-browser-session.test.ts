import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// BROWSER_SESSION_SIGN_IN (#1559): a sign-in made with "Remember me" unticked
// lasts until the browser closes instead of ending at the next reload. The
// password or access token goes into a session cookie (`remember: false`),
// a reload or a new tab restores every kind of sign-in from its cookies, and
// once the browser has dropped them the account goes as silently as an
// unticked one does at a reload with the setting off.

const setting = vi.hoisted(() => ({ on: false, cached: true }));
vi.mock('@/hooks/use-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-config')>();
  const { createConfig } = await import('@/lib/__tests__/fixtures/config');
  const config = () => createConfig({ rememberMeEnabled: true, loginShowRememberMe: true, browserSessionSignIn: setting.on });
  return {
    ...actual,
    getCachedConfig: () => (setting.cached ? config() : null),
    fetchConfig: async () => config(),
  };
});

vi.mock('@/lib/jmap/client', () => {
  class JMAPClient {
    constructor(public serverUrl: string, public username: string, public password: string) {}
    static withBearer(serverUrl: string, _token: string, username: string) { return new JMAPClient(serverUrl, username || 'token-user@x.test', ''); }
    async connect() {}
    getSessionUsername() { return this.username; }
    getUsername() { return this.username; }
    async getIdentities() { return [{ id: 'a', email: this.username, name: this.username, mayDelete: false }]; }
    getAuthHeader() { return this.password ? 'Basic eA==' : 'Bearer at'; }
    updateBasicAuth(password: string) { this.password = password; }
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
  }
  class RateLimitError extends Error {}
  class RequestTimeoutError extends Error {}
  return { JMAPClient, RateLimitError, RequestTimeoutError };
});
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null }));

import * as nav from '@/lib/browser-navigation';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore, type AccountEntry } from '@/stores/account-store';

const SERVER = 'https://mail.x.test';
// A new account per test: the store keeps each account's client between tests.
let run = 0;
let USER = '';
let ID = '';
const account = (overrides: Record<string, unknown> = {}) => ({
  id: ID, label: 'Bob', serverUrl: SERVER, username: USER, authMode: 'basic' as const,
  rememberMe: false, providerSession: false, cookieSlot: 0, displayName: 'Bob', email: USER, isConnected: false,
  hasError: false, lastLoginAt: 1, avatarColor: '#000000', isDefault: true, ...overrides,
});

type Call = { method: string; url: string; body?: Record<string, unknown> };
const calls: Call[] = [];
/** What the cookies hold: a session cookie for slot 0, a refresh token, or neither. */
const cookies = { session: true as boolean | 'refused', refreshToken: true as boolean | 'refused' };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) });
    if (url.startsWith('/api/auth/verify')) return json({ result: 'ok' });
    if (url.startsWith('/api/auth/session') && method === 'PUT') {
      if (cookies.session === 'refused') return json({ error: 'Invalid session' }, 401);
      return cookies.session ? json({ serverUrl: SERVER, username: USER, ...(useAccountStore.getState().getAccountById(ID)?.authMode === 'token' ? { token: 'tok' } : { password: 'pw' }) }) : json({ error: 'No session' }, 401);
    }
    if (url.startsWith('/api/auth/token') && method === 'PUT') {
      if (cookies.refreshToken === 'refused') return json({ error: 'Invalid refresh token' }, 401);
      return cookies.refreshToken ? json({ access_token: 'at', expires_in: 3600 }) : json({ error: 'No refresh token' }, 401);
    }
    return json({ ok: true });
  }));
  vi.spyOn(nav, 'replaceWindowLocation').mockImplementation(() => {});
});

beforeEach(() => {
  run += 1;
  USER = `bob${run}@x.test`;
  ID = `${USER}@mail.x.test`;
  calls.length = 0;
  setting.on = false;
  setting.cached = true;
  cookies.session = true;
  cookies.refreshToken = true;
  sessionStorage.clear();
  localStorage.clear();
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  useAuthStore.setState({ isAuthenticated: false, client: null, activeAccountId: null });
});

const sessionWrites = () => calls.filter((c) => c.method === 'POST' && c.url.startsWith('/api/auth/session'));
const restores = (path: string) => calls.filter((c) => c.method === 'PUT' && c.url.startsWith(path));

async function reload(entry: ReturnType<typeof account>) {
  useAccountStore.setState({ accounts: [entry] as never, activeAccountId: entry.id, defaultAccountId: entry.id });
  await useAuthStore.getState().checkAuth();
}

describe('signing in with the box unticked', () => {
  it('keeps the password in a cookie that ends with the browser when the admin allows it', async () => {
    setting.on = true;
    expect(await useAuthStore.getState().login(SERVER, USER, 'pw', undefined, false)).toBe(true);
    await vi.waitFor(() => expect(sessionWrites()).toHaveLength(1));
    expect(sessionWrites()[0].body).toMatchObject({ username: USER, password: 'pw', remember: false });
  });

  it('keeps nothing with the setting off', async () => {
    expect(await useAuthStore.getState().login(SERVER, USER, 'pw', undefined, false)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(sessionWrites()).toEqual([]);
  });

  it('still remembers a ticked sign-in for 30 days', async () => {
    setting.on = true;
    expect(await useAuthStore.getState().login(SERVER, USER, 'pw', undefined, true)).toBe(true);
    await vi.waitFor(() => expect(sessionWrites()).toHaveLength(1));
    expect(sessionWrites()[0].body).not.toHaveProperty('remember');
  });

  it('keeps an access token sign-in until the browser closes too', async () => {
    setting.on = true;
    expect(await useAuthStore.getState().loginWithToken(SERVER, 'tok', false)).toBe(true);
    expect(sessionWrites()).toHaveLength(1);
    expect(sessionWrites()[0].body).toMatchObject({ token: 'tok', remember: false });
  });

  it('writes the new password into the browser-session cookie after a password change', async () => {
    setting.on = true;
    await useAuthStore.getState().login(SERVER, USER, 'pw', undefined, false);
    await vi.waitFor(() => expect(sessionWrites()).toHaveLength(1));
    await useAuthStore.getState().updateBasicPassword('new-pw');
    expect(sessionWrites()).toHaveLength(2);
    expect(sessionWrites()[1].body).toMatchObject({ password: 'new-pw', remember: false });
  });
});

describe('a reload or a new tab', () => {
  it('restores an unticked password sign-in from its cookie when the admin allows it', async () => {
    setting.on = true;
    await reload(account());
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAccountStore.getState().accounts.map((a) => a.id)).toEqual([ID]);
  });

  it('waits for the config at start-up before it decides', async () => {
    setting.on = true;
    setting.cached = false;
    await reload(account());
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('restores an unticked two-factor or provider sign-in, renewing into a browser-session cookie', async () => {
    setting.on = true;
    await reload(account({ authMode: 'oauth' }));
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(restores('/api/auth/token').map((c) => c.url)).toEqual(['/api/auth/token?slot=0&remember=false']);
  });

  it('ends an unticked sign-in without asking the server when the setting is off', async () => {
    await reload(account());
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAccountStore.getState().accounts).toEqual([]);
    expect(restores('/api/auth/session')).toEqual([]);
    expect(sessionStorage.getItem('session_expired')).toBeNull();
  });

  it('ends an unticked provider sign-in when the setting is off, though its cookie is there', async () => {
    await reload(account({ authMode: 'oauth' }));
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(restores('/api/auth/token')).toEqual([]);
  });
});

describe('after the browser was closed', () => {
  it('drops an unticked password sign-in silently once its cookie is gone', async () => {
    setting.on = true;
    cookies.session = false;
    await reload(account());
    expect(restores('/api/auth/session')).toHaveLength(1);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAccountStore.getState().accounts).toEqual([]);
    expect(sessionStorage.getItem('session_expired')).toBeNull();
  });

  it('drops an unticked provider sign-in silently once its refresh token is gone', async () => {
    setting.on = true;
    cookies.refreshToken = false;
    await reload(account({ authMode: 'oauth' }));
    expect(restores('/api/auth/token')).toHaveLength(1);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAccountStore.getState().accounts).toEqual([]);
    expect(sessionStorage.getItem('session_expired')).toBeNull();
  });

  it('reports a cookie that is there but refused like a refused remembered sign-in', async () => {
    setting.on = true;
    cookies.session = 'refused';
    await reload(account());
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(sessionStorage.getItem('session_expired')).toBe('true');
  });
});

describe.each(['basic', 'token', 'oauth'] as const)('%s account retention with browser-session sign-in', (authMode) => {
  it('restores an unticked sign-in while its browser-session cookie is present', async () => {
    setting.on = true;
    await reload(account({ authMode }));
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAccountStore.getState().getAccountById(ID)).toMatchObject({ rememberMe: false, isConnected: true });
  });

  it('forgets the persisted address and server once the browser-session cookie is gone', async () => {
    setting.on = true;
    cookies.session = false;
    cookies.refreshToken = false;
    await reload(account({ authMode }));
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    const registry = localStorage.getItem('account-registry') ?? '';
    expect(registry).not.toContain(USER);
    expect(registry).not.toContain(SERVER);
    await useAccountStore.persist.rehydrate();
    expect(useAccountStore.getState().accounts).toEqual([]);
    expect(sessionStorage.getItem('session_expired')).toBeNull();
  });

  it.each([false, true])('retains a rejected remembered account with the policy set to %s', async (on) => {
    setting.on = on;
    cookies.session = 'refused';
    cookies.refreshToken = 'refused';
    await reload(account({ authMode, rememberMe: true }));
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAccountStore.getState().getAccountById(ID)).toMatchObject({ awaitingSignIn: true, isConnected: false });
    await useAccountStore.persist.rehydrate();
    expect(useAccountStore.getState().getAccountById(ID)?.awaitingSignIn).toBe(true);
    calls.length = 0;
    await useAuthStore.getState().checkAuth();
    expect(restores('/api/auth/session')).toEqual([]);
    expect(restores('/api/auth/token')).toEqual([]);
  });

  it.each([false, true])('forgets an explicitly signed-out account with rememberMe=%s', async (rememberMe) => {
    setting.on = true;
    await reload(account({ authMode, rememberMe }));
    await useAuthStore.getState().logout();
    expect(useAccountStore.getState().accounts).toEqual([]);
    expect(localStorage.getItem('account-registry')).toBeNull();
    expect(calls).toContainEqual({ method: 'DELETE', url: '/api/auth/session?slot=0' });
    if (authMode === 'oauth') expect(calls).toContainEqual({ method: 'DELETE', url: '/api/auth/token?slot=0' });
  });

  it('forgets an explicitly removed sign-in target after its remembered session was rejected', async () => {
    setting.on = true;
    cookies.session = 'refused';
    cookies.refreshToken = 'refused';
    await reload(account({ authMode, rememberMe: true }));
    useAuthStore.getState().removeAccount(ID);
    expect(useAccountStore.getState().getAccountById(ID)).toBeUndefined();
    await useAccountStore.persist.rehydrate();
    expect(useAccountStore.getState().accounts.map((entry: AccountEntry) => entry.id)).not.toContain(ID);
  });
});
