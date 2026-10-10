import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// Accounts restored from the account list backup carry no credentials. They
// must stay listed until signed in, and opening one must lead to the sign-in
// form instead of dropping it like an account whose session ran out.
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
import { collectAccounts, restoreAccounts } from '@/lib/account-archive-client';

const signedIn = {
  id: 'bob@x.test@mail.x.test', label: 'Bob', serverUrl: 'https://mail.x.test', username: 'bob@x.test', authMode: 'basic' as const,
  rememberMe: true, cookieSlot: 0, displayName: 'Bob', email: 'bob@x.test', isConnected: false, hasError: false,
  lastLoginAt: 1, avatarColor: '#000000', isDefault: true,
};
const archived = [
  { username: 'bob@x.test', serverUrl: 'https://mail.x.test', label: 'Bob at work', avatarColor: '#2563eb' },
  { username: 'alice@x.test', serverUrl: 'https://mail.x.test', label: 'Alice', avatarColor: '#16a34a' },
];
const redirect = vi.fn();

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/auth/session')) {
      return new Response(JSON.stringify({ serverUrl: signedIn.serverUrl, username: signedIn.username, password: 'x' }), { status: 200 });
    }
    if (url.includes('/api/config')) return new Response(JSON.stringify(createConfig()), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
  vi.spyOn(nav, 'replaceWindowLocation').mockImplementation(redirect);
});

beforeEach(() => {
  redirect.mockClear();
  useAccountStore.setState({ accounts: [signedIn] as never, activeAccountId: signedIn.id, defaultAccountId: signedIn.id });
});

it('adds missing accounts awaiting sign-in and relabels the ones already here', () => {
  expect(collectAccounts()).toEqual([
    { username: signedIn.username, serverUrl: signedIn.serverUrl, label: 'Bob', avatarColor: '#000000' },
  ]);
  expect(restoreAccounts(archived)).toEqual({ added: 1, updated: 1, skipped: 0 });
  const [bob, alice] = useAccountStore.getState().accounts;
  expect(bob).toMatchObject({ label: 'Bob at work', avatarColor: '#2563eb', isDefault: true });
  expect(bob.awaitingSignIn).toBeUndefined();
  expect(alice).toMatchObject({ id: 'alice@x.test@mail.x.test', label: 'Alice', avatarColor: '#16a34a', awaitingSignIn: true, rememberMe: false });
});

it('keeps a restored account through a reload and sends it to the sign-in form', async () => {
  restoreAccounts(archived);
  await useAuthStore.getState().checkAuth();
  expect(useAuthStore.getState().activeAccountId).toBe(signedIn.id);
  expect(useAccountStore.getState().accounts.map(a => a.id)).toEqual([signedIn.id, 'alice@x.test@mail.x.test']);

  await useAuthStore.getState().switchAccount('alice@x.test@mail.x.test');
  expect(redirect).toHaveBeenCalledWith(expect.stringMatching(/\/login\?mode=add-account&username=alice%40x\.test$/));
  expect(useAccountStore.getState().accounts).toHaveLength(2);
  expect(useAuthStore.getState().activeAccountId).toBe(signedIn.id);
});

it('stops waiting once the account is signed in', () => {
  restoreAccounts(archived);
  useAccountStore.getState().addAccount({
    username: 'alice@x.test', serverUrl: 'https://mail.x.test', authMode: 'basic', rememberMe: true, label: 'alice',
    displayName: 'alice', email: 'alice@x.test', lastLoginAt: 2, isConnected: true, hasError: false, isDefault: false,
  });
  const alice = useAccountStore.getState().getAccountById('alice@x.test@mail.x.test');
  expect(alice).toMatchObject({ label: 'Alice', avatarColor: '#16a34a', isConnected: true });
  expect(alice?.awaitingSignIn).toBeUndefined();
});

it('signs out to an account that is signed in, not to one awaiting sign-in', async () => {
  restoreAccounts(archived);
  useAccountStore.setState((s) => ({
    accounts: [...s.accounts, { ...signedIn, id: 'carol@x.test@mail.x.test', username: 'carol@x.test', email: 'carol@x.test', label: 'Carol', cookieSlot: 2, isDefault: false }] as never,
  }));
  await useAuthStore.getState().checkAuth();
  // Wait for the background restore of the other remembered account.
  await vi.waitFor(() => expect(useAccountStore.getState().getAccountById('carol@x.test@mail.x.test')?.isConnected).toBe(true));

  await useAuthStore.getState().logout();
  expect(useAuthStore.getState().activeAccountId).toBe('carol@x.test@mail.x.test');
  expect(useAuthStore.getState().isAuthenticated).toBe(true);
  expect(useAccountStore.getState().accounts.map(a => a.id)).toEqual(['alice@x.test@mail.x.test', 'carol@x.test@mail.x.test']);
});

it('treats a browser left with only accounts awaiting sign-in as signed out, not as a connection failure', async () => {
  useAccountStore.setState({ accounts: [{ ...signedIn, rememberMe: false }] as never });
  restoreAccounts(archived.slice(1));
  await useAuthStore.getState().checkAuth();
  expect(useAuthStore.getState().isAuthenticated).toBe(false);
  expect(useAuthStore.getState().error).not.toBe('connection_failed');
  expect(useAccountStore.getState().accounts.map(a => a.id)).toEqual(['alice@x.test@mail.x.test']);
});
