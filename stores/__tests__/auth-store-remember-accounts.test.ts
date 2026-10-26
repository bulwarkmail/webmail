import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

vi.mock('@/lib/jmap/client', () => {
  class JMAPClient {
    constructor(public serverUrl: string, public username: string, public password: string) {}
    static withBearer() { throw new Error('not used'); }
    async connect() {}
    getSessionUsername() { return this.username; }
    getUsername() { return this.username; }
    async getIdentities() { return [{ id: 'a', email: this.username, name: this.username, mayDelete: false }]; }
    getAuthHeader() { return 'Basic eA=='; }
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
    async getEmails() { return { emails: [], total: 0 }; }
    async getTagCounts() { return {}; }
  }
  class RateLimitError extends Error {}
  class RequestTimeoutError extends Error {}
  return { JMAPClient, RateLimitError, RequestTimeoutError };
});
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null }));

import * as navigation from '@/lib/browser-navigation';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';
import { useAccountListPreferencesStore } from '../account-list-preferences-store';

const server = 'https://gmail.example.com';
const username = 'user@gmail.com';
const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/api/config')) return new Response(JSON.stringify(createConfig()));
  if (url.includes('/api/auth/session') && init?.method === 'PUT') return new Response('{}', { status: 401 });
  return new Response('{}');
});

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(navigation, 'replaceWindowLocation').mockImplementation(() => {});
  localStorage.clear();
  sessionStorage.clear();
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  useAuthStore.setState({ isAuthenticated: false, client: null, activeAccountId: null, isDemoMode: false });
  useAccountListPreferencesStore.setState({ rememberAccountList: true });
});

afterEach(async () => {
  await useAuthStore.getState().logoutAll();
  vi.restoreAllMocks();
});

it('preserves original sign-out cleanup when remembering accounts is not enabled', async () => {
  useAccountListPreferencesStore.setState({ rememberAccountList: false });
  await useAuthStore.getState().login(server, username, 'test-password', undefined, true);
  const id = useAuthStore.getState().activeAccountId!;
  await useAuthStore.getState().logout();
  expect(useAccountStore.getState().getAccountById(id)).toBeUndefined();
  expect(localStorage.getItem('account-registry')).toBeNull();
});

it('removes a rejected account when remembering accounts is disabled', async () => {
  useAccountListPreferencesStore.setState({ rememberAccountList: false });
  const id = useAccountStore.getState().addAccount({
    serverUrl: server, username, label: 'Gmail', email: username, displayName: 'Gmail',
    authMode: 'basic', rememberMe: true, lastLoginAt: Date.now(),
    isConnected: false, hasError: false, isDefault: true,
  });
  await useAuthStore.getState().checkAuth();
  expect(useAccountStore.getState().getAccountById(id)).toBeUndefined();
  expect(useAuthStore.getState().isAuthenticated).toBe(false);
});

it('keeps a signed-out account selectable for reauthentication on its own server', async () => {
  await useAuthStore.getState().login(server, username, 'test-password', undefined, true);
  const id = useAuthStore.getState().activeAccountId!;
  await useAuthStore.getState().logout();
  await useAccountStore.persist.rehydrate();
  expect(useAccountStore.getState().getAccountById(id)).toMatchObject({
    awaitingSignIn: true, isConnected: false, rememberMe: false,
  });
  await useAuthStore.getState().switchAccount(id);
  const redirect = vi.mocked(navigation.replaceWindowLocation).mock.lastCall?.[0];
  const target = new URL(redirect!, 'https://webmail.example.com');
  expect(target.searchParams.get('username')).toBe(username);
  expect(target.searchParams.get('server')).toBe(server);
});

it('keeps an entry when its remembered cookie is missing', async () => {
  const id = useAccountStore.getState().addAccount({
    serverUrl: server, username, label: 'Gmail', email: username, displayName: 'Gmail',
    authMode: 'basic', rememberMe: true, lastLoginAt: Date.now(),
    isConnected: false, hasError: false, isDefault: true,
  });
  await useAuthStore.getState().checkAuth();
  expect(useAccountStore.getState().getAccountById(id)).toMatchObject({ awaitingSignIn: true, isConnected: false });
  expect(useAuthStore.getState().isAuthenticated).toBe(false);
});

it('does not try to resume a deliberately signed-out account after reload', async () => {
  await useAuthStore.getState().login(server, username, 'test-password', undefined, true);
  const id = useAuthStore.getState().activeAccountId!;
  await useAuthStore.getState().logout();
  fetchMock.mockClear();
  sessionStorage.clear();
  await useAccountStore.persist.rehydrate();
  await useAuthStore.getState().checkAuth();
  expect(useAccountStore.getState().getAccountById(id)).toMatchObject({ awaitingSignIn: true });
  expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/api/auth/session') && init?.method === 'PUT')).toBe(false);
  expect(sessionStorage.getItem('session_expired')).toBeNull();
});

it('keeps metadata but clears credentials when signing out of every account', async () => {
  await useAuthStore.getState().login(server, username, 'test-password', undefined, true);
  const id = useAuthStore.getState().activeAccountId!;
  await useAuthStore.getState().logoutAll();
  expect(useAuthStore.getState().isAuthenticated).toBe(false);
  expect(useAuthStore.getState().getClientForAccount(id)).toBeUndefined();
  expect(useAccountStore.getState().getAccountById(id)).toMatchObject({ awaitingSignIn: true });
  expect(localStorage.getItem('account-registry')).not.toContain('test-password');
  expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/api/auth/session') && init?.method === 'DELETE')).toBe(true);
});

it('actually forgets a signed-out account only when removal is requested', async () => {
  await useAuthStore.getState().login(server, username, 'test-password', undefined, true);
  const id = useAuthStore.getState().activeAccountId!;
  await useAuthStore.getState().logout();
  expect(useAccountStore.getState().getAccountById(id)).toBeDefined();
  useAuthStore.getState().removeAccount(id);
  await useAccountStore.persist.rehydrate();
  expect(useAccountStore.getState().getAccountById(id)).toBeUndefined();
});

it('actually forgets an active account when removal is requested', async () => {
  await useAuthStore.getState().login(server, username, 'test-password', undefined, true);
  const id = useAuthStore.getState().activeAccountId!;
  useAuthStore.getState().removeAccount(id);
  await vi.waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(false));
  await useAccountStore.persist.rehydrate();
  expect(useAccountStore.getState().getAccountById(id)).toBeUndefined();
});

it('reactivates the same retained account and cookie slot after signing in again', async () => {
  await useAuthStore.getState().login(server, username, 'test-password', undefined, true);
  const id = useAuthStore.getState().activeAccountId!;
  const slot = useAccountStore.getState().getAccountById(id)!.cookieSlot;
  await useAuthStore.getState().logout();
  await useAuthStore.getState().login(server, username, 'test-password', undefined, true);
  expect(useAccountStore.getState().accounts).toHaveLength(1);
  expect(useAccountStore.getState().getAccountById(id)).toMatchObject({
    cookieSlot: slot, isConnected: true, rememberMe: true,
  });
  expect(useAccountStore.getState().getAccountById(id)?.awaitingSignIn).toBeFalsy();
});
