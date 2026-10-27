import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// A password + TOTP sign-in runs on tokens (authMode 'oauth'), and restore
// resumed every 'oauth' account from its refresh-token cookie. So a TOTP
// sign-in without "Remember me" came back on the next visit, unlike a
// password sign-in without it.
vi.mock('@/lib/jmap/client', () => {
  class JMAPClient {
    constructor(public serverUrl: string, public username: string, public password: string) {}
    static withBearer(serverUrl: string, _token: string, username: string) { return new JMAPClient(serverUrl, username, ''); }
    async connect() {}
    getSessionUsername() { return this.username; }
    getUsername() { return this.username; }
    async getIdentities() { return [{ id: 'a', email: this.username, name: this.username, mayDelete: false }]; }
    getAuthHeader() { return 'Bearer at'; }
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
import { useAccountStore } from '@/stores/account-store';

const totpAccount = {
  id: 'bob@x.test@mail.x.test', label: 'Bob', serverUrl: 'https://mail.x.test', username: 'bob@x.test', authMode: 'oauth' as const,
  rememberMe: false, providerSession: false, cookieSlot: 0, displayName: 'Bob', email: 'bob@x.test', isConnected: false,
  hasError: false, lastLoginAt: 1, avatarColor: '#000000', isDefault: true,
};
const requests: string[] = [];

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.includes('/api/config')) return new Response(JSON.stringify(createConfig()), { status: 200 });
    // The refresh-token cookie is still there.
    if (url.includes('/api/auth/token') && init?.method === 'PUT') {
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
  vi.spyOn(nav, 'replaceWindowLocation').mockImplementation(() => {});
});

beforeEach(() => {
  requests.length = 0;
  sessionStorage.clear();
  useAuthStore.setState({ isAuthenticated: false, client: null, activeAccountId: null });
});

it('does not resume a TOTP sign-in made without Remember me', async () => {
  useAccountStore.setState({ accounts: [totpAccount] as never, activeAccountId: totpAccount.id, defaultAccountId: totpAccount.id });

  await useAuthStore.getState().checkAuth();
  await vi.waitFor(() => expect(requests).toContain('DELETE /api/auth/token?slot=0'));

  expect(useAuthStore.getState().isAuthenticated).toBe(false);
  expect(requests).not.toContain('PUT /api/auth/token?slot=0');
  expect(sessionStorage.getItem('session_expired')).toBeNull();
});

it('still resumes a remembered TOTP sign-in', async () => {
  useAccountStore.setState({
    accounts: [{ ...totpAccount, rememberMe: true }] as never, activeAccountId: totpAccount.id, defaultAccountId: totpAccount.id,
  });

  await useAuthStore.getState().checkAuth();

  expect(useAuthStore.getState().isAuthenticated).toBe(true);
});
