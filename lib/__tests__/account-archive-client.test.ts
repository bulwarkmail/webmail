import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  clients: new Map<string, { getBasicPassword: () => string | null }>(),
  signIn: vi.fn(),
}));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: {
    getState: () => ({
      getClientForAccount: (id: string) => auth.clients.get(id),
      signInRestoredAccount: auth.signIn,
    }),
  },
}));

import { collectAccounts, restoreArchive } from '@/lib/account-archive-client';
import { generateAccountId } from '@/lib/account-utils';
import { useAccountStore } from '@/stores/account-store';

const server = 'https://mail.example.com';
const add = (username: string, authMode: 'basic' | 'oauth') => useAccountStore.getState().addAccount({
  username, serverUrl: server, authMode, rememberMe: true, label: username, displayName: username, email: username,
  lastLoginAt: 1, isConnected: true, hasError: false, isDefault: false,
});

beforeEach(() => {
  useAccountStore.setState({ accounts: [], defaultAccountId: null });
  auth.clients.clear();
  auth.signIn.mockReset();
});

describe('collectAccounts', () => {
  it('leaves passwords out unless asked', () => {
    const id = add('a@example.com', 'basic');
    auth.clients.set(id, { getBasicPassword: () => 'secret-a' });
    expect(collectAccounts()[0]).not.toHaveProperty('password');
    expect(collectAccounts(true)[0].password).toBe('secret-a');
  });

  it('takes a password only from a signed-in Basic account', () => {
    const basic = add('a@example.com', 'basic');
    const oauth = add('b@example.com', 'oauth');
    add('c@example.com', 'basic'); // not signed in here
    auth.clients.set(basic, { getBasicPassword: () => null }); // TOTP or bearer
    auth.clients.set(oauth, { getBasicPassword: () => 'never-read' });
    expect(collectAccounts(true).map(a => a.password)).toEqual([undefined, undefined, undefined]);
  });
});

describe('restoreArchive', () => {
  const entry = (username: string, password?: string) => ({ username, serverUrl: server, label: username, avatarColor: '#2563eb', password });

  it('signs in to the accounts saved with a password and leaves the others waiting', async () => {
    auth.signIn.mockImplementation(async (id: string, password: string) => {
      if (password !== 'right') return false;
      useAccountStore.getState().updateAccount(id, { awaitingSignIn: false });
      return true;
    });
    const result = await restoreArchive([entry('a@example.com', 'right'), entry('b@example.com', 'stale'), entry('c@example.com')], true);
    expect(auth.signIn).toHaveBeenCalledTimes(2);
    expect(auth.signIn).toHaveBeenCalledWith(generateAccountId('a@example.com', server), 'right', true);
    expect(result).toMatchObject({ added: 3, signedIn: 1, signInFailed: 1, waiting: 2 });
  });

  it('does not sign in again to an account already connected here', async () => {
    const id = add('a@example.com', 'basic');
    auth.clients.set(id, { getBasicPassword: () => 'right' });
    const result = await restoreArchive([entry('a@example.com', 'right')], true);
    expect(auth.signIn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 1, signedIn: 0, waiting: 0 });
  });
});
