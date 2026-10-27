import { beforeAll, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// Signing out of the active account when the next registered account was
// signed in before this page load and has no client yet must not sign out
// every account: the page reloads and restores the remaining one as usual.
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
  }
  class RateLimitError extends Error {}
  return { JMAPClient, RateLimitError };
});
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null }));

import * as nav from '@/lib/browser-navigation';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';

const acct = (username: string, host: string, slot: number) => ({
  id: `${username}@${host}`, label: username, serverUrl: `https://${host}`, username, authMode: 'basic' as const,
  rememberMe: true, cookieSlot: slot, displayName: username, email: username, isConnected: false, hasError: false,
  lastLoginAt: 1, avatarColor: '#000', isDefault: slot === 0,
});
const B = acct('bob@x.test', 'mail.x.test', 0);   // first login, slot 0
const A = acct('alice@x.test', 'mail.x.test', 1); // added later, slot 1
// Server-side cookie jar: slot -> remembered credentials.
const jar = new Map<number, { serverUrl: string; username: string; password: string }>([
  [0, { serverUrl: B.serverUrl, username: B.username, password: 'bob-secret' }],
  [1, { serverUrl: A.serverUrl, username: A.username, password: 'alice-secret' }],
]);
const deletes: string[] = [];

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/auth/session')) {
      const m = url.match(/slot=(\d)/);
      const slot = m ? Number(m[1]) : 0;
      if (method === 'DELETE') { deletes.push(url); if (url.includes('all=true')) jar.clear(); else jar.delete(slot); return new Response('{}', { status: 200 }); }
      if (method === 'PUT') {
        const c = jar.get(slot);
        return c ? new Response(JSON.stringify(c), { status: 200 }) : new Response('{"error":"No session"}', { status: 401 });
      }
    }
    if (url.includes('/api/auth/token') && method === 'DELETE') { deletes.push(url); return new Response('{}', { status: 200 }); }
    if (url.includes('/api/config')) return new Response(JSON.stringify(createConfig()), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
  vi.spyOn(nav, 'replaceWindowLocation').mockImplementation(() => {});
});

it('reloads into the remaining account when it was signed in before this page load', async () => {
  // B signed in earlier; A was added after a full page load (an OAuth
  // redirect, or the add-account page opened directly), so only A has a
  // client here and B was never restored on this page.
  useAccountStore.setState({ accounts: [B, A] as never, activeAccountId: B.id, defaultAccountId: B.id });
  useAuthStore.setState({ isAuthenticated: true, activeAccountId: B.id, client: null });
  await useAuthStore.getState().switchAccount(A.id);
  const replace = vi.mocked(nav.replaceWindowLocation);
  replace.mockClear();

  await useAuthStore.getState().logout(); // "Sign out of alice"

  expect(useAccountStore.getState().accounts.map((a) => a.id)).toEqual([B.id]);
  expect(useAccountStore.getState().activeAccountId).toBe(B.id);
  expect(useAuthStore.getState().activeAccountId).toBe(B.id);
  expect([...jar.keys()]).toEqual([0]);
  expect(replace).toHaveBeenCalledTimes(1);
  expect(replace.mock.calls[0][0]).not.toMatch(/\/login$/);
});
