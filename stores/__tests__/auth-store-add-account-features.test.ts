import { beforeEach, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// #1618: an account added second over OAuth or server-side SSO had no
// calendar until a reload. The sign-in set the new account's capability
// flags (calendars, contacts, vacation, filters) and then cleared the stores
// for the account it was replacing, which reset the flags to "not
// supported" and dropped the fetches it had just started. The switch away
// snapshotted that cleared state, and every later switch back restored it.
vi.mock('@/lib/jmap/client', () => {
  class JMAPClient {
    constructor(public serverUrl: string, public username: string, public password: string) {}
    // The test's token is the account's address.
    static withBearer(serverUrl: string, token: string) { return new JMAPClient(serverUrl, token, ''); }
    async connect() {}
    getSessionUsername() { return this.username; }
    getUsername() { return this.username; }
    async getIdentities() { return [{ id: 'i', email: this.username, name: this.username, mayDelete: false }]; }
    getAuthHeader() { return 'Basic eA=='; }
    onConnectionChange() {}
    onRateLimit() {}
    getRateLimitRemainingMs() { return 0; }
    supportsContacts() { return true; }
    supportsPrincipals() { return false; }
    supportsVacationResponse() { return true; }
    supportsCalendars() { return true; }
    supportsSieve() { return true; }
    disconnect() {}
    getAccountId() { return `acct-${this.username}`; }
  }
  class RateLimitError extends Error {}
  return { JMAPClient, RateLimitError };
});
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: async () => null }));

import * as nav from '@/lib/browser-navigation';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useContactStore } from '@/stores/contact-store';
import { useVacationStore } from '@/stores/vacation-store';
import { useFilterStore } from '@/stores/filter-store';

const SERVER = 'https://mail.example.com';
const noop = async () => {};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  useAuthStore.setState({ isAuthenticated: false, client: null, activeAccountId: null });
  vi.spyOn(nav, 'replaceWindowLocation').mockImplementation(() => {});
  // The stores' loads talk to the server; only the capability flags matter here.
  useEmailStore.setState({ prefetchInitialData: noop } as never);
  useCalendarStore.setState({ fetchCalendars: noop } as never);
  useContactStore.setState({ fetchAddressBooks: noop, fetchContacts: noop } as never);
  useVacationStore.setState({ fetchVacationResponse: noop } as never);
  useFilterStore.setState({ fetchFilters: noop } as never);
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === '/api/auth/verify') return new Response(JSON.stringify({ result: 'ok' }), { status: 200 });
    if (url.startsWith('/api/auth/token') || url === '/api/auth/sso/complete') {
      return new Response(JSON.stringify({ access_token: 'b@example.com', expires_in: 3600 }), { status: 200 });
    }
    if (url.includes('/api/config')) return new Response(JSON.stringify(createConfig()), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
});

function featureFlags() {
  return {
    calendar: useCalendarStore.getState().supportsCalendar,
    contacts: useContactStore.getState().supportsSync,
    vacation: useVacationStore.getState().isSupported,
    filters: useFilterStore.getState().isSupported,
  };
}
const ALL_ON = { calendar: true, contacts: true, vacation: true, filters: true };

const ADD_ACCOUNT = {
  OAuth: () => useAuthStore.getState().loginWithOAuth(SERVER, 'code', 'verifier', `${SERVER}/callback`),
  'server-side SSO': () => useAuthStore.getState().loginWithServerSso('code', 'state'),
};

it.each(Object.entries(ADD_ACCOUNT))('gives an account added second over %s its calendar, also after switching back to it', async (_, addAccount) => {
  expect(await useAuthStore.getState().login(SERVER, 'a@example.com', 'pw', undefined, true)).toBe(true);
  const accountA = useAuthStore.getState().activeAccountId!;
  expect(featureFlags()).toEqual(ALL_ON);

  // "Add account": the second account signs in with the provider.
  expect(await addAccount()).toBe(true);
  const accountB = useAuthStore.getState().activeAccountId!;
  expect(accountB).not.toBe(accountA);
  expect(featureFlags()).toEqual(ALL_ON);

  // Both clients are connected, so these switches restore the snapshots.
  await useAuthStore.getState().switchAccount(accountA);
  expect(useAuthStore.getState().activeAccountId).toBe(accountA);
  expect(featureFlags()).toEqual(ALL_ON);

  await useAuthStore.getState().switchAccount(accountB);
  expect(useAuthStore.getState().activeAccountId).toBe(accountB);
  expect(featureFlags()).toEqual(ALL_ON);
});

it.each(Object.entries(ADD_ACCOUNT))('keeps the retained login name and feature flags when signing in again over %s', async (kind, signIn) => {
  expect(await useAuthStore.getState().login(SERVER, 'active@example.com', 'pw', undefined, true)).toBe(true);
  const activeId = useAuthStore.getState().activeAccountId!;
  const accountStore = useAccountStore.getState();
  // The login name differs from the server's primary identity address.
  const username = kind === 'OAuth' ? 'alias-oauth@example.com' : 'alias-sso@example.com';
  const targetId = accountStore.addAccount({
    label: 'Retained account', serverUrl: SERVER, username, authMode: 'oauth',
    rememberMe: true, displayName: 'B', email: 'b@example.com', lastLoginAt: 1,
    isConnected: false, hasError: false, isDefault: false,
  });
  accountStore.updateAccount(targetId, { awaitingSignIn: true });
  const slot = accountStore.getAccountById(targetId)!.cookieSlot;
  sessionStorage.setItem('oauth_reauthenticate_account', targetId);

  expect(await signIn()).toBe(true);
  expect(useAuthStore.getState().activeAccountId).toBe(targetId);
  expect(accountStore.getAccountById(targetId)).toMatchObject({ username, cookieSlot: slot });
  expect(accountStore.getAccountById(targetId)?.awaitingSignIn).not.toBe(true);
  expect(useAccountStore.getState().accounts).toHaveLength(2);
  expect(featureFlags()).toEqual(ALL_ON);
  await useAuthStore.getState().switchAccount(activeId);
  await useAuthStore.getState().switchAccount(targetId);
  expect(featureFlags()).toEqual(ALL_ON);
});
