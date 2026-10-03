import { beforeAll, expect, it, vi } from 'vitest';

// With settingsFromMainAccount on, settings are one set kept on the main
// (default) account: switching to another account must neither load that
// account's stored copy nor save edits to it. Off, each account keeps its own.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
// Settings sync only needs to be switched on; the full config shape is not the point here.
vi.mock('@/hooks/use-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-config')>()),
  fetchConfig: async () => ({ settingsSyncEnabled: true }),
}));
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null }));

import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useSettingsStore } from '@/stores/settings-store';

const acct = (username: string, host: string, slot: number) => ({
  id: `${username}@${host}`, label: username, serverUrl: `https://${host}`, username, authMode: 'basic' as const,
  rememberMe: true, cookieSlot: slot, displayName: username, email: username, isConnected: false, hasError: false,
  lastLoginAt: 1, avatarColor: '#000', isDefault: slot === 0,
});
const A = acct('a@x.test', 'mail.x.test', 0);
const B = acct('b@x.test', 'mail.x.test', 1);
const posts: string[] = [];
const loads: string[] = [];

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const m = url.match(/\/api\/auth\/session\?slot=(\d)/);
    if (m && init?.method === 'PUT') {
      const a = [A, B][Number(m[1])];
      return new Response(JSON.stringify({ serverUrl: a.serverUrl, username: a.username, password: 'pw' }), { status: 200 });
    }
    if (url.includes('/api/config')) return new Response(JSON.stringify({ settingsSyncEnabled: true }), { status: 200 });
    if (url.includes('/api/settings') && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)).username);
      return new Response('{}', { status: 200 });
    }
    if (url.includes('/api/settings')) {
      loads.push(new Headers(init?.headers).get('x-settings-username') ?? '');
      return new Response(JSON.stringify({ settings: null }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
});

async function switchToB(fromMain: boolean) {
  useSettingsStore.getState().disableSync();
  useSettingsStore.setState({ settingsFromMainAccount: fromMain });
  useAccountStore.setState({ accounts: [A, B] as never, activeAccountId: A.id, defaultAccountId: A.id });
  useAuthStore.setState({ isAuthenticated: true, activeAccountId: A.id, client: null });
  loads.length = 0;
  await useAuthStore.getState().switchAccount(B.id);
  expect(useAuthStore.getState().activeAccountId).toBe(B.id);
  // Settings load after the config fetch, off the switch's own promise.
  await vi.waitFor(() => expect(loads.length).toBeGreaterThan(0), { timeout: 10000 });
  await sleep(50);
  posts.length = 0;
  useSettingsStore.getState().updateSetting('fontSize', fromMain ? 'large' as never : 'small' as never);
  await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0), { timeout: 10000 });
}

it('loads and saves the main account\'s settings whichever account is active, when asked to', async () => {
  await switchToB(true);
  expect(loads.length).toBeGreaterThan(0);
  expect(loads.every((u) => u === 'a@x.test')).toBe(true);
  expect(posts).toEqual(['a@x.test']);
}, 15000);

it('keeps each account\'s own settings by default', async () => {
  await switchToB(false);
  expect(loads).toContain('b@x.test');
  expect(posts).toEqual(['b@x.test']);
}, 15000);
