import { beforeEach, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// The server refuses to restore a session older than the organisation's
// maximum session length (lib/auth/session-age.ts). The login page then says
// why the user has to sign in again.
vi.mock('@/lib/jmap/client', () => {
  class JMAPClient {
    constructor(public serverUrl: string, public username: string, public password: string) {}
    static withBearer(serverUrl: string, _token: string, username: string) { return new JMAPClient(serverUrl, username, ''); }
    async connect() {}
    getAuthHeader() { return 'Basic x'; }
    onConnectionChange() {}
    onRateLimit() {}
    getRateLimitRemainingMs() { return 0; }
    disconnect() {}
    getUsername() { return this.username; }
    async getIdentities() { return []; }
    supportsContacts() { return false; }
    supportsPrincipals() { return false; }
    supportsVacationResponse() { return false; }
    supportsCalendars() { return false; }
    supportsSieve() { return false; }
    getSharedAccounts() { return []; }
    getAccountInfo() { return undefined; }
  }
  class RateLimitError extends Error {}
  class RequestTimeoutError extends Error {}
  return { JMAPClient, RateLimitError, RequestTimeoutError };
});

import * as nav from '@/lib/browser-navigation';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { consumeSessionEnd } from '@/lib/session-policy/sign-out-reason';

const account = (authMode: 'basic' | 'oauth') => ({
  id: 'alice@example.org@mail.example.org', label: 'Alice', serverUrl: 'https://mail.example.org', username: 'alice@example.org', authMode,
  rememberMe: true, providerSession: authMode === 'oauth', cookieSlot: 0, displayName: 'Alice', email: 'alice@example.org', isConnected: false,
  hasError: false, lastLoginAt: 1, avatarColor: '#000000', isDefault: true,
});

const tooOld = () => new Response(JSON.stringify({ error: 'session_expired', maxHours: 8 }), { status: 401 });

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    if (url.includes('/api/config')) return new Response(JSON.stringify(createConfig()), { status: 200 });
    if (url.includes('/api/auth/session') && init?.method === 'PUT') return tooOld();
    if (url.includes('/api/auth/token') && init?.method === 'PUT') return tooOld();
    return new Response('{}', { status: 200 });
  }));
  vi.spyOn(nav, 'replaceWindowLocation').mockImplementation(() => {});
});

it('says on the login page that a remembered session reached its maximum length', async () => {
  useAccountStore.setState({ accounts: [account('basic')] as never, activeAccountId: account('basic').id, defaultAccountId: account('basic').id });

  await useAuthStore.getState().checkAuth();
  await vi.waitFor(() => expect(useAccountStore.getState().getAccountById(account('basic').id)).toMatchObject({ awaitingSignIn: true, isConnected: false }));

  expect(consumeSessionEnd()).toEqual({ kind: 'max', hours: 8 });
});

it('says so for a provider sign-in whose renewal the server refused', async () => {
  useAccountStore.setState({ accounts: [account('oauth')] as never, activeAccountId: account('oauth').id, defaultAccountId: account('oauth').id });

  await useAuthStore.getState().checkAuth();
  await vi.waitFor(() => expect(useAccountStore.getState().getAccountById(account('oauth').id)).toMatchObject({ awaitingSignIn: true, isConnected: false }));

  expect(consumeSessionEnd()).toEqual({ kind: 'max', hours: 8 });
});

it('says nothing when another account comes back, and takes the server sign-in time', async () => {
  const bob = {
    ...account('basic'), id: 'bob@example.org@mail.example.org', username: 'bob@example.org', email: 'bob@example.org', cookieSlot: 1, isDefault: false,
  };
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    if (url.includes('/api/config')) return new Response(JSON.stringify(createConfig()), { status: 200 });
    if (url.includes('/api/auth/session?slot=1') && init?.method === 'PUT') {
      return new Response(JSON.stringify({ serverUrl: 'https://mail.example.org', username: 'bob@example.org', password: 'pw', signedInAt: 1234 }), { status: 200 });
    }
    if (url.includes('/api/auth/session') && init?.method === 'PUT') return tooOld();
    return new Response('{}', { status: 200 });
  }));
  useAccountStore.setState({ accounts: [account('basic'), bob] as never, activeAccountId: account('basic').id, defaultAccountId: account('basic').id });

  await useAuthStore.getState().checkAuth();
  expect(useAccountStore.getState().getAccountById(account('basic').id)?.awaitingSignIn).toBe(true);
  await vi.waitFor(() => expect(useAccountStore.getState().getAccountById(bob.id)?.signedInAt).toBe(1234));
  expect(useAuthStore.getState().activeAccountId).toBe(bob.id);

  expect(consumeSessionEnd()).toBeNull();
});
