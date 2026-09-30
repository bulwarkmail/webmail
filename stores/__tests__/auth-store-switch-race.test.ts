import { beforeAll, expect, it, vi } from 'vitest';

// Two overlapping switchAccount() calls (click account B, then C before the
// first switch lands) used to snapshot B's live stores under account A's
// key. Switching back to A then restored B's identities - so mail went out
// with B's From - and they were never re-fetched, since the restore
// "succeeded".
const IDS: Record<string, Array<{ id: string; email: string; name: string; mayDelete: boolean }>> = {
  'a@x.test': [{ id: 'a', email: 'a@x.test', name: 'Alice', mayDelete: false }],
  'b@y.test': [{ id: 'a', email: 'b@y.test', name: 'Bob', mayDelete: false }],
  'c@z.test': [{ id: 'a', email: 'c@z.test', name: 'Carol', mayDelete: false }],
};
const DELAY: Record<string, number> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

vi.mock('@/lib/jmap/client', () => {
  class JMAPClient {
    constructor(public serverUrl: string, public username: string, public password: string) {}
    static withBearer() { throw new Error('not used'); }
    async connect() {}
    getSessionUsername() { return this.username; }
    getUsername() { return this.username; }
    async getIdentities() { await sleep(DELAY[this.username] ?? 0); return IDS[this.username]; }
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

import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useIdentityStore } from '@/stores/identity-store';
import { useEmailStore } from '@/stores/email-store';
import { evictAccount } from '@/lib/account-state-manager';

const acct = (username: string, host: string, slot: number) => ({
  id: `${username}@${host}`, label: username, serverUrl: `https://${host}`, username, authMode: 'basic' as const,
  rememberMe: true, cookieSlot: slot, displayName: username, email: username, isConnected: false, hasError: false,
  lastLoginAt: 1, avatarColor: '#000', isDefault: slot === 0,
});
const A = acct('a@x.test', 'mail.x.test', 0);
const B = acct('b@y.test', 'mail.y.test', 1);
const C = acct('c@z.test', 'mail.z.test', 2);

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    const m = url.match(/\/api\/auth\/session\?slot=(\d)/);
    if (m) {
      const a = [A, B, C][Number(m[1])];
      return new Response(JSON.stringify({ serverUrl: a.serverUrl, username: a.username, password: 'pw' }), { status: 200 });
    }
    if (url.includes('/api/config')) return new Response(JSON.stringify({ settingsSyncEnabled: false }), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
});

it("overlapping switches keep every account's data under its own key", async () => {
  useAccountStore.setState({ accounts: [A, B, C] as never, activeAccountId: A.id, defaultAccountId: A.id });
  useAuthStore.setState({ isAuthenticated: true, activeAccountId: A.id, client: null });
  const sw = (id: string) => useAuthStore.getState().switchAccount(id);
  // Connect all three logins (network path), ending on a freshly loaded A.
  await sw(B.id); await sw(C.id); evictAccount(A.id); await sw(A.id);
  useEmailStore.setState({ emails: [{ id: 'mA', subject: 'mail of A' }] as never });

  // Click B, then C while B's session check (getIdentities) is still in flight.
  DELAY['b@y.test'] = 5; DELAY['c@z.test'] = 40;
  await Promise.all([sw(B.id), sw(C.id)]);
  expect(useAuthStore.getState().activeAccountId).toBe(C.id);
  expect(useIdentityStore.getState().identities.map((i) => i.email)).toEqual(['c@z.test']);

  // Later: back to A.
  DELAY['b@y.test'] = 0; DELAY['c@z.test'] = 0;
  await sw(A.id);
  const st = useAuthStore.getState();
  expect((st.client as unknown as { username: string }).username).toBe('a@x.test');
  expect(st.primaryIdentity?.email).toBe('a@x.test');
  expect(useEmailStore.getState().emails.map((e) => e.subject)).toEqual(['mail of A']);
});
