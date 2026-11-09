import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// The server says on each restore whether the session is the one an admin's
// impersonation handoff opened. The account keeps that, so the app-top-banner
// slot can tell plugins (the username alone no longer shows it).

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
  }
  class RateLimitError extends Error {}
  return { JMAPClient, RateLimitError, RequestTimeoutError };
});
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null }));

import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';

const account = {
  id: 'alice@x.test@mail.x.test', label: 'Alice', serverUrl: 'https://mail.x.test', username: 'alice@x.test', authMode: 'basic' as const,
  rememberMe: true, cookieSlot: 0, displayName: 'Alice', email: 'alice@x.test', isConnected: false, hasError: false,
  lastLoginAt: 1, avatarColor: '#000000', isDefault: true,
};
const session = vi.hoisted(() => ({ extra: {} as Record<string, unknown> }));
const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/api/auth/session') && init?.method !== 'DELETE') {
    return new Response(JSON.stringify({ serverUrl: account.serverUrl, username: account.username, password: 'x', ...session.extra }), { status: 200 });
  }
  if (url.includes('/api/config')) return new Response(JSON.stringify(createConfig()), { status: 200 });
  return new Response('{}', { status: 200 });
});

beforeAll(() => {
  vi.stubGlobal('fetch', fetchMock);
});

beforeEach(() => {
  fetchMock.mockClear();
  useAuthStore.setState({ isAuthenticated: false, client: null, activeAccountId: null, error: null });
});

it('marks the account impersonated when the server says the session is a handoff', async () => {
  session.extra = { impersonated: true };
  useAccountStore.setState({ accounts: [account] as never, activeAccountId: account.id, defaultAccountId: account.id });
  await useAuthStore.getState().checkAuth();
  expect(useAccountStore.getState().getAccountById(account.id)).toMatchObject({ isConnected: true, impersonated: true });
});

it('clears the mark once the server no longer says so', async () => {
  session.extra = {};
  // Another entry: the first test left its client connected.
  const earlier = { ...account, id: 'alice@x.test@mail2.x.test', impersonated: true };
  useAccountStore.setState({ accounts: [earlier] as never, activeAccountId: earlier.id, defaultAccountId: earlier.id });
  await useAuthStore.getState().checkAuth();
  expect(useAccountStore.getState().getAccountById(earlier.id)).toMatchObject({ isConnected: true, impersonated: false });
});
