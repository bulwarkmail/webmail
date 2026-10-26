import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAccountStore } from '../account-store';
import { useAccountListPreferencesStore } from '../account-list-preferences-store';
import { purgeSignedOutData } from '@/lib/sign-out-cleanup';

beforeEach(() => {
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  useAccountListPreferencesStore.setState({ rememberAccountList: null });
  localStorage.clear();
});

afterEach(() => vi.useRealTimers());

it('defaults to the existing cleanup policy until a deployment default or local choice exists', () => {
  expect(useAccountListPreferencesStore.getState().rememberAccountList).not.toBe(true);
  useAccountListPreferencesStore.getState().initialize(false);
  expect(useAccountListPreferencesStore.getState().rememberAccountList).toBe(false);
});

it('adopts an enabled deployment default without overriding an explicit device opt-out', () => {
  useAccountListPreferencesStore.getState().initialize(true);
  expect(useAccountListPreferencesStore.getState().rememberAccountList).toBe(true);
  useAccountListPreferencesStore.getState().setRememberAccountList(false);
  useAccountListPreferencesStore.getState().initialize(true);
  expect(useAccountListPreferencesStore.getState().rememberAccountList).toBe(false);
});

it('preserves an explicit opt-in when the deployment default is off', async () => {
  useAccountListPreferencesStore.getState().setRememberAccountList(true);
  await useAccountListPreferencesStore.persist.rehydrate();
  useAccountListPreferencesStore.getState().initialize(false);
  expect(useAccountListPreferencesStore.getState().rememberAccountList).toBe(true);
});

it('forgets signed-out entries on opt-out while keeping live accounts signed in', () => {
  useAccountStore.setState({ accounts: [
    { id: 'saved', awaitingSignIn: true, isConnected: false },
    { id: 'live', isConnected: true },
  ] } as never);
  useAccountListPreferencesStore.getState().setRememberAccountList(false);
  expect(useAccountStore.getState().accounts.map((account) => account.id)).toEqual(['live']);
});

it('keeps only a device-local boolean across sign-out cleanup', async () => {
  useAccountListPreferencesStore.getState().setRememberAccountList(true);
  purgeSignedOutData();
  await useAccountListPreferencesStore.persist.rehydrate();
  const stored = JSON.parse(localStorage.getItem('account-list-preferences')!);
  expect(stored.state).toEqual({ rememberAccountList: true });
});

it('does not interpret malformed local storage as consent to remember account names', async () => {
  localStorage.setItem('account-list-preferences', JSON.stringify({ version: 0, state: { rememberAccountList: 'true' } }));
  await useAccountListPreferencesStore.persist.rehydrate();
  expect(useAccountListPreferencesStore.getState().rememberAccountList).toBeNull();
  useAccountListPreferencesStore.getState().initialize(false);
  expect(useAccountListPreferencesStore.getState().rememberAccountList).toBe(false);
});

it('does not assign an expiry to saved account metadata', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T00:00:00Z'));
  useAccountListPreferencesStore.getState().setRememberAccountList(true);
  const id = useAccountStore.getState().addAccount({
    username: 'user@example.com', serverUrl: 'https://mail.example.com', label: 'Saved account',
    email: 'user@example.com', displayName: 'Saved account', authMode: 'basic', rememberMe: false,
    isConnected: false, hasError: false, isDefault: true, awaitingSignIn: true, lastLoginAt: Date.now(),
  });
  vi.setSystemTime(new Date('2040-01-01T00:00:00Z'));
  await useAccountStore.persist.rehydrate();
  expect(useAccountStore.getState().getAccountById(id)).toMatchObject({ awaitingSignIn: true, label: 'Saved account' });
  expect(useAccountStore.getState().getAccountById(id)).not.toHaveProperty('listRetainedUntil');
});
