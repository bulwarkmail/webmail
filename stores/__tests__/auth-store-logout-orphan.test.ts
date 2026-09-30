import { beforeAll, expect, it, vi } from 'vitest';

// Signing out of the active account when the next registered account has no
// live client (its restore failed at boot) takes the full-logout path. That
// path used to clear only the signed-out slot and drop only that next
// account, so the other account's remembered session survived and the
// next visit to the browser adopted it and signed straight back in.
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
    if (url.includes('/api/config')) return new Response(JSON.stringify({ settingsSyncEnabled: false }), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
  vi.spyOn(nav, 'replaceWindowLocation').mockImplementation(() => {});
});

it('signing out leaves no other account resumable', async () => {
  // Boot: A (active) connected; B's restore failed transiently -> kept, no client.
  useAccountStore.setState({ accounts: [B, A] as never, activeAccountId: B.id, defaultAccountId: B.id });
  useAuthStore.setState({ isAuthenticated: true, activeAccountId: B.id, client: null });
  await useAuthStore.getState().switchAccount(A.id);
  useAccountStore.getState().updateAccount(B.id, { hasError: true, errorMessage: 'Server unreachable' });

  await useAuthStore.getState().logout(); // "Sign out"
  expect(useAccountStore.getState().accounts).toEqual([]);
  expect(jar.size).toBe(0);

  // Next visitor opens the app in the same browser.
  await useAuthStore.getState().checkAuth();
  const s = useAuthStore.getState();
  expect(s.isAuthenticated).toBe(false);
  expect(s.activeAccountId).toBeNull();
});
