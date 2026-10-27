import { beforeAll, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// An OAuth account that cannot be restored is dropped from the list. Only its
// session cookie was cleared: the refresh token stayed in the browser for its
// full lifetime, unrevoked, for an account the app no longer shows.
vi.mock('@/lib/jmap/client', () => {
  class JMAPClient {
    constructor(public serverUrl: string, public username: string, public password: string) {}
    static withBearer(serverUrl: string, _token: string, username: string) { return new JMAPClient(serverUrl, username, ''); }
    async connect() { throw new Error('Authentication failed'); }
    getAuthHeader() { return 'Bearer at'; }
    onConnectionChange() {}
    onRateLimit() {}
    getRateLimitRemainingMs() { return 0; }
    disconnect() {}
  }
  class RateLimitError extends Error {}
  class RequestTimeoutError extends Error {}
  return { JMAPClient, RateLimitError, RequestTimeoutError };
});

import * as nav from '@/lib/browser-navigation';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';

const ssoAccount = {
  id: 'bob@x.test@mail.x.test', label: 'Bob', serverUrl: 'https://mail.x.test', username: 'bob@x.test', authMode: 'oauth' as const,
  rememberMe: true, providerSession: true, cookieSlot: 2, displayName: 'Bob', email: 'bob@x.test', isConnected: false,
  hasError: false, lastLoginAt: 1, avatarColor: '#000000', isDefault: true,
};
const requests: string[] = [];

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.includes('/api/config')) return new Response(JSON.stringify(createConfig()), { status: 200 });
    if (url.includes('/api/auth/token') && init?.method === 'PUT') {
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
  vi.spyOn(nav, 'replaceWindowLocation').mockImplementation(() => {});
});

it('clears the refresh token of an OAuth account it could not restore', async () => {
  useAccountStore.setState({ accounts: [ssoAccount] as never, activeAccountId: ssoAccount.id, defaultAccountId: ssoAccount.id });

  await useAuthStore.getState().checkAuth();
  await vi.waitFor(() => expect(requests).toContain('DELETE /api/auth/session?slot=2'));

  expect(useAccountStore.getState().accounts).toHaveLength(0);
  expect(requests).toContain('DELETE /api/auth/token?slot=2');
});
