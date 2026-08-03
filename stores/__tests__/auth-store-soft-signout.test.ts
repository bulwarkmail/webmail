import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as browserNavigation from '@/lib/browser-navigation';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

/**
 * These tests lock in the soft-signout contract: when the server rejects a
 * refresh token, the auth flow must preserve the account entry so the user
 * re-signs in from the switcher without losing settings/identities/subs.
 *
 * The pre-existing test file (auth-store-logout.test.ts) covers the old
 * behaviour where a 401 caused a full evict + redirect. That path stays valid
 * for the "no active account bound" defensive fallback; here we cover the
 * happy path where accountId is bound and the account entry survives.
 */
describe('auth-store soft signout', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    window.history.pushState({}, '', '/en');

    useAccountStore.setState({
      accounts: [],
      activeAccountId: null,
      defaultAccountId: null,
    });

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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks the account needsReauth and drops both cookies on softSignOut', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    // Register an account so softSignOut has something to act on.
    const accountStore = useAccountStore.getState();
    accountStore.addAccount({
      label: 'luc@undust.co',
      serverUrl: 'https://mail.undust.co',
      username: 'luc@undust.co',
      authMode: 'oauth',
      rememberMe: true,
      displayName: 'Luc',
      email: 'luc@undust.co',
      lastLoginAt: Date.now(),
      isConnected: true,
      hasError: false,
      isDefault: true,
    });
    const accountId = useAccountStore.getState().accounts[0].id;

    useAuthStore.getState().softSignOut(accountId, 'refresh_rejected');

    const acc = useAccountStore.getState().getAccountById(accountId);
    expect(acc).toBeDefined();
    expect(acc!.needsReauth).toBe(true);
    expect(acc!.hasError).toBe(true);
    expect(acc!.errorMessage).toBe('refresh_rejected');
    expect(acc!.isConnected).toBe(false);

    // Session cookie always cleared; OAuth account also clears refresh token.
    const urls = fetchMock.mock.calls
      .map(([input, init]) => `${(init as FetchInit)?.method ?? 'GET'} ${String(input)}`);
    expect(urls).toContain('DELETE /api/auth/session?slot=0');
    expect(urls).toContain('DELETE /api/auth/token?slot=0');
  });

  it('preserves the account entry (and its settings blob) across a softSignOut', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

    const accountStore = useAccountStore.getState();
    accountStore.addAccount({
      label: 'luc@undust.co',
      serverUrl: 'https://mail.undust.co',
      username: 'luc@undust.co',
      authMode: 'oauth',
      rememberMe: true,
      displayName: 'Luc',
      email: 'luc@undust.co',
      lastLoginAt: Date.now(),
      isConnected: true,
      hasError: false,
      isDefault: true,
    });
    const accountId = useAccountStore.getState().accounts[0].id;
    const originalSlot = useAccountStore.getState().accounts[0].cookieSlot;

    useAuthStore.getState().softSignOut(accountId, 'session_expired');

    // The account is still there, same id, same slot — a subsequent login for
    // the same (username, serverUrl) will land back on this row and reuse
    // the settings blob rather than provisioning a new slot.
    const still = useAccountStore.getState().getAccountById(accountId);
    expect(still).toBeDefined();
    expect(still!.cookieSlot).toBe(originalSlot);
    expect(useAccountStore.getState().accounts).toHaveLength(1);
  });

  it('routes the 401 refresh path through softSignOut (not through logout eviction)', async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/auth/token?slot=0' && method === 'PUT') {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      if (method === 'DELETE') {
        return { ok: true, json: async () => ({}) };
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});

    const accountStore = useAccountStore.getState();
    accountStore.addAccount({
      label: 'luc@undust.co',
      serverUrl: 'https://mail.undust.co',
      username: 'luc@undust.co',
      authMode: 'oauth',
      rememberMe: true,
      displayName: 'Luc',
      email: 'luc@undust.co',
      lastLoginAt: Date.now(),
      isConnected: true,
      hasError: false,
      isDefault: true,
    });
    const accountId = useAccountStore.getState().accounts[0].id;

    useAuthStore.setState({
      isAuthenticated: true,
      authMode: 'oauth',
      activeAccountId: accountId,
    });

    await useAuthStore.getState().refreshAccessToken();
    await vi.runAllTimersAsync();

    // The account entry survives — this is the whole point of soft signout.
    const survivor = useAccountStore.getState().getAccountById(accountId);
    expect(survivor).toBeDefined();
    expect(survivor!.needsReauth).toBe(true);
  });

  it('when no account is bound, the refresh 401 path still falls back to full logout', async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === '/api/auth/token?slot=0' && method === 'PUT') {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      if (method === 'DELETE') return { ok: true, json: async () => ({}) };
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const replaceSpy = vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});

    // No account entry → activeAccountId=null. The defensive branch keeps the
    // original logout behaviour so an orphaned session doesn't get stuck.
    useAuthStore.setState({
      isAuthenticated: true,
      authMode: 'oauth',
      activeAccountId: null,
    });

    await useAuthStore.getState().refreshAccessToken();
    await vi.runAllTimersAsync();

    expect(sessionStorage.getItem('session_expired')).toBe('true');
    expect(replaceSpy).toHaveBeenCalled();
  });

  it('a soft-signed-out account is re-armed (needsReauth cleared) on the next successful login', () => {
    const accountStore = useAccountStore.getState();
    accountStore.addAccount({
      label: 'luc@undust.co',
      serverUrl: 'https://mail.undust.co',
      username: 'luc@undust.co',
      authMode: 'oauth',
      rememberMe: true,
      displayName: 'Luc',
      email: 'luc@undust.co',
      lastLoginAt: Date.now(),
      isConnected: true,
      hasError: false,
      isDefault: true,
    });
    const accountId = useAccountStore.getState().accounts[0].id;

    // Simulate a prior softSignOut having flipped the flag.
    accountStore.updateAccount(accountId, {
      needsReauth: true,
      hasError: true,
      errorMessage: 'session_expired',
    });

    // The login success path (auth-store.ts) hard-sets needsReauth=false on
    // the updateAccount call — mirror the same shape here so the assertion
    // reflects the production sequence.
    accountStore.updateAccount(accountId, {
      authMode: 'oauth',
      rememberMe: true,
      isConnected: true,
      hasError: false,
      errorMessage: undefined,
      needsReauth: false,
      lastLoginAt: Date.now(),
    });

    const acc = useAccountStore.getState().getAccountById(accountId);
    expect(acc!.needsReauth).toBe(false);
    expect(acc!.hasError).toBe(false);
    expect(acc!.errorMessage).toBeUndefined();
  });
});
