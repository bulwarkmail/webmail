import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// A reload during a server outage must keep a remembered account. Only a real
// rejection may evict it and clear its saved credentials. (#1167)
const connectError = vi.hoisted(() => ({ current: null as (() => Error) | null }));

vi.mock('@/lib/jmap/client', () => {
  class RequestTimeoutError extends Error {
    constructor(timeoutMs: number) {
      super(`Request timed out after ${timeoutMs}ms`);
      this.name = 'RequestTimeoutError';
    }
  }
  class JMAPClient {
    constructor(public serverUrl: string, public username: string, public password: string) {}
    static withBearer() { throw new Error('not used'); }
    async connect() { if (connectError.current) throw connectError.current(); }
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
  }
  class RateLimitError extends Error {}
  return { JMAPClient, RateLimitError, RequestTimeoutError };
});
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null }));

import { RequestTimeoutError } from '@/lib/jmap/client';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useAccountListPreferencesStore } from '@/stores/account-list-preferences-store';

const account = {
  id: 'bob@x.test@mail.x.test', label: 'Bob', serverUrl: 'https://mail.x.test', username: 'bob@x.test', authMode: 'basic' as const,
  rememberMe: true, cookieSlot: 0, displayName: 'Bob', email: 'bob@x.test', isConnected: false, hasError: false,
  lastLoginAt: 1, avatarColor: '#000000', isDefault: true,
};
const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/api/auth/session') && (!init?.method || init.method === 'GET')) {
    return new Response(JSON.stringify({ serverUrl: account.serverUrl, username: account.username, password: 'x' }), { status: 200 });
  }
  if (url.includes('/api/config')) return new Response(JSON.stringify(createConfig()), { status: 200 });
  return new Response('{}', { status: 200 });
});

function credentialsCleared() {
  return fetchMock.mock.calls.some(([input, init]) => String(input).includes('/api/auth/session') && init?.method === 'DELETE');
}

beforeAll(() => {
  vi.stubGlobal('fetch', fetchMock);
});

beforeEach(() => {
  fetchMock.mockClear();
  useAccountListPreferencesStore.setState({ rememberAccountList: false });
  useAuthStore.setState({ isAuthenticated: false, client: null, activeAccountId: null, error: null });
  useAccountStore.setState({ accounts: [account] as never, activeAccountId: account.id, defaultAccountId: account.id });
});

it.each([
  ['a request timeout', () => new RequestTimeoutError(30_000)],
  ['a CORS_ERROR from a failed fetch', () => new Error('CORS_ERROR')],
  ['a network TypeError', () => new TypeError('Failed to fetch')],
  ['a 502 from the session endpoint', () => new Error('Failed to get session: 502')],
])('keeps the account through %s', async (_label, error) => {
  connectError.current = error;
  await useAuthStore.getState().checkAuth();
  expect(useAccountStore.getState().getAccountById(account.id)).toMatchObject({ hasError: true, errorMessage: 'Server unreachable' });
  expect(credentialsCleared()).toBe(false);
});

it('removes the account on a real rejection when remembering accounts is disabled', async () => {
  connectError.current = () => new Error('Failed to get session: 401');
  await useAuthStore.getState().checkAuth();
  expect(useAccountStore.getState().getAccountById(account.id)).toBeUndefined();
  await vi.waitFor(() => expect(credentialsCleared()).toBe(true));
});

it('keeps the account awaiting sign-in on a real rejection when opted in', async () => {
  useAccountListPreferencesStore.setState({ rememberAccountList: true });
  connectError.current = () => new Error('Failed to get session: 401');
  await useAuthStore.getState().checkAuth();
  expect(useAccountStore.getState().getAccountById(account.id)).toMatchObject({ awaitingSignIn: true, isConnected: false });
  await vi.waitFor(() => expect(credentialsCleared()).toBe(true));
});
