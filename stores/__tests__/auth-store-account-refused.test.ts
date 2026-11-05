import { beforeAll, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// An account deleted on the server while signed in here: Stalwart answers 403
// to everything it sends (#1539). A switch to it must not start the folder,
// list and identity loads, each of which the server would refuse again.

const REFUSED = new Set<string>();
const IDS: Record<string, Array<{ id: string; email: string; name: string; mayDelete: boolean }>> = {
  'a@x.test': [{ id: 'a', email: 'a@x.test', name: 'Alice', mayDelete: false }],
  'b@y.test': [{ id: 'a', email: 'b@y.test', name: 'Bob', mayDelete: false }],
};
const refusedCallbacks = new Map<string, () => void>();

vi.mock('@/lib/jmap/client', () => {
  class JMAPClient {
    private refused = false;
    constructor(public serverUrl: string, public username: string, public password: string) {}
    static withBearer() { throw new Error('not used'); }
    async connect() {}
    getSessionUsername() { return this.username; }
    getUsername() { return this.username; }
    // The switch's session check is the first request after the deletion.
    async getIdentities() {
      if (REFUSED.has(this.username) && !this.refused) {
        this.refused = true;
        refusedCallbacks.get(this.username)?.();
      }
      return this.refused ? [] : IDS[this.username];
    }
    isAccessRefused() { return this.refused; }
    onAccessRefused(callback: () => void) { refusedCallbacks.set(this.username, callback); }
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
const navigation = vi.hoisted(() => ({ replaced: [] as string[] }));
vi.mock('@/lib/browser-navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/browser-navigation')>()),
  replaceWindowLocation: (url: string) => { navigation.replaced.push(url); },
}));

import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useIdentityStore } from '@/stores/identity-store';

const acct = (username: string, host: string, slot: number) => ({
  id: `${username}@${host}`, label: username, serverUrl: `https://${host}`, username, authMode: 'basic' as const,
  rememberMe: true, cookieSlot: slot, displayName: username, email: username, isConnected: false, hasError: false,
  lastLoginAt: 1, avatarColor: '#000', isDefault: slot === 0,
});
const A = acct('a@x.test', 'mail.x.test', 0);
const B = acct('b@y.test', 'mail.y.test', 1);

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    const m = url.match(/\/api\/auth\/session\?slot=(\d)/);
    if (m) {
      const a = [A, B][Number(m[1])];
      return new Response(JSON.stringify({ serverUrl: a.serverUrl, username: a.username, password: 'pw' }), { status: 200 });
    }
    if (url.includes('/api/config')) return new Response(JSON.stringify(createConfig()), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
});

it('asks for a sign-in instead of switching to an account the server refuses', async () => {
  useAccountStore.setState({ accounts: [A, B] as never, activeAccountId: A.id, defaultAccountId: A.id });
  useAuthStore.setState({ isAuthenticated: true, activeAccountId: A.id, client: null });
  const sw = (id: string) => useAuthStore.getState().switchAccount(id);
  // Both signed in, A on screen.
  await sw(B.id); await sw(A.id);
  expect(useAuthStore.getState().activeAccountId).toBe(A.id);
  const identitiesOnScreen = useIdentityStore.getState().identities;

  // B is deleted on the server.
  REFUSED.add(B.username);
  await sw(B.id);

  const auth = useAuthStore.getState();
  expect(auth.activeAccountId).toBe(A.id);
  expect((auth.client as unknown as { username: string }).username).toBe(A.username);
  expect(useIdentityStore.getState().identities).toBe(identitiesOnScreen);
  const entry = useAccountStore.getState().getAccountById(B.id);
  expect(entry?.hasError).toBe(true);
  expect(entry?.isConnected).toBe(false);
  expect(navigation.replaced.at(-1)).toMatch(/\/login\?mode=add-account&username=b%40y\.test$/);
});
