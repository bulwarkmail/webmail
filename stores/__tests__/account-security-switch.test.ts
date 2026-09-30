import { beforeAll, expect, it, vi } from 'vitest';

// The Account Security store was never reset on an account switch, and the
// settings page only fetches while isStalwart is null. After switching from
// A to B the page kept showing A's 2FA state and app passwords, and
// "Remove" sent A's credential id to B.
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
    hasAccountCapability() { return true; }
    disconnect() {}
    getAccountId() { return this.username.startsWith('a') ? 'jmapA' : 'jmapB'; }
  }
  class RateLimitError extends Error {}
  return { JMAPClient, RateLimitError };
});
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null, isStalwartJmapPassthroughEnabled: async () => true }));

import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useAccountSecurityStore } from '@/stores/account-security-store';

const acct = (username: string, host: string, slot: number) => ({
  id: `${username}@${host}`, label: username, serverUrl: `https://${host}`, username, authMode: 'basic' as const,
  rememberMe: true, cookieSlot: slot, displayName: username, email: username, isConnected: false, hasError: false,
  lastLoginAt: 1, avatarColor: '#000', isDefault: slot === 0,
});
const A = acct('a@x.test', 'mail.x.test', 0);
const B = acct('b@x.test', 'mail.x.test', 1);
const passthrough: Array<{ slot: string | null; body: unknown }> = [];

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const m = url.match(/\/api\/auth\/session\?slot=(\d)/);
    if (m && init?.method === 'PUT') {
      const a = [A, B][Number(m[1])];
      return new Response(JSON.stringify({ serverUrl: a.serverUrl, username: a.username, password: 'pw' }), { status: 200 });
    }
    if (url.includes('/api/account/stalwart/jmap')) {
      const h = new Headers(init?.headers);
      passthrough.push({ slot: h.get('X-JMAP-Cookie-Slot'), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ methodResponses: [['x:AppPassword/set', { destroyed: ['a'] }, '0'], ['x:AccountPassword/get', { list: [{}] }, '0'], ['x:AppPassword/query', { ids: [] }, '1'], ['x:ApiKey/query', { ids: [] }, '2']] }), { status: 200 });
    }
    if (url.includes('/api/config')) return new Response(JSON.stringify({ settingsSyncEnabled: false }), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
});

it('switching accounts resets the security page', async () => {
  useAccountStore.setState({ accounts: [A, B] as never, activeAccountId: A.id, defaultAccountId: A.id });
  useAuthStore.setState({ isAuthenticated: true, activeAccountId: A.id, client: null });
  const sw = (id: string) => useAuthStore.getState().switchAccount(id);
  await sw(B.id); await sw(A.id);

  // Settings > Security loaded while A was active.
  useAccountSecurityStore.setState({
    isStalwart: true, otpEnabled: true,
    appPasswords: [{ id: 'a', description: 'A: Thunderbird laptop' }] as never,
  });

  await sw(B.id);
  const s = useAccountSecurityStore.getState();
  expect(s.isStalwart).toBeNull();
  expect(s.otpEnabled).toBe(false);
  expect(s.appPasswords).toEqual([]);
});
