import { describe, it, expect, beforeEach } from 'vitest';
import { applyPreferredIdentity, useAuthStore } from '../auth-store';
import { useIdentityStore } from '../identity-store';
import { useAccountStore } from '../account-store';
import { useSettingsStore } from '../settings-store';
import type { Identity } from '@/lib/jmap/types';

const makeIdentity = (overrides: Partial<Identity> = {}): Identity => ({
  id: 'id-1',
  name: 'Test User',
  email: 'test@example.com',
  mayDelete: true,
  ...overrides,
});

const IDS = [
  makeIdentity({ id: 'id-1', name: 'Alice', email: 'alice@example.com' }),
  makeIdentity({ id: 'id-2', name: 'Bob', email: 'bob@example.com' }),
  makeIdentity({ id: 'id-3', name: 'Carol', email: 'carol@example.com' }),
];

/**
 * applyPreferredIdentity() is the single mechanism that honours the synced,
 * per-account default sender identity (#507). These tests drive the real
 * zustand stores directly (as the other auth-store tests do).
 */
describe('applyPreferredIdentity (issue #507)', () => {
  beforeEach(() => {
    useIdentityStore.setState({ identities: [...IDS], preferredPrimaryId: null });
    useAuthStore.setState({ identities: [...IDS], primaryIdentity: IDS[0] });
    useAccountStore.setState({ activeAccountId: 'acc-1' });
    useSettingsStore.setState({ preferredIdentityIds: {} });
  });

  it('reorders the active account so the synced preferred identity is primary', () => {
    useSettingsStore.setState({ preferredIdentityIds: { 'acc-1': 'id-3' } });

    applyPreferredIdentity('acc-1');

    expect(useAuthStore.getState().identities.map((i) => i.id)).toEqual(['id-3', 'id-1', 'id-2']);
    expect(useAuthStore.getState().primaryIdentity?.id).toBe('id-3');
    expect(useIdentityStore.getState().preferredPrimaryId).toBe('id-3');
  });

  it('defaults to the active account when no accountId is passed', () => {
    useSettingsStore.setState({ preferredIdentityIds: { 'acc-1': 'id-2' } });

    applyPreferredIdentity();

    expect(useAuthStore.getState().identities[0].id).toBe('id-2');
  });

  it('is a no-op when the target is not the active account', () => {
    useSettingsStore.setState({ preferredIdentityIds: { 'acc-2': 'id-3' } });

    applyPreferredIdentity('acc-2');

    // active account's live ordering must be untouched
    expect(useAuthStore.getState().identities.map((i) => i.id)).toEqual(['id-1', 'id-2', 'id-3']);
  });

  it('is a no-op when the account has no synced default and no local fallback', () => {
    applyPreferredIdentity('acc-1');

    expect(useAuthStore.getState().identities.map((i) => i.id)).toEqual(['id-1', 'id-2', 'id-3']);
    expect(useSettingsStore.getState().preferredIdentityIds).toEqual({});
  });

  it('migrates the pre-#507 browser-local default into the synced map, keyed by accountId', () => {
    // No synced entry, but a local (identity-storage) preferred primary exists.
    useIdentityStore.setState({ preferredPrimaryId: 'id-2' });

    applyPreferredIdentity('acc-1');

    // adopted, persisted per account, and applied to the live ordering
    expect(useSettingsStore.getState().preferredIdentityIds).toEqual({ 'acc-1': 'id-2' });
    expect(useAuthStore.getState().identities[0].id).toBe('id-2');
  });

  it('prefers the synced value over the local fallback', () => {
    useIdentityStore.setState({ preferredPrimaryId: 'id-2' });
    useSettingsStore.setState({ preferredIdentityIds: { 'acc-1': 'id-3' } });

    applyPreferredIdentity('acc-1');

    expect(useAuthStore.getState().identities[0].id).toBe('id-3');
    // the synced value is not overwritten by the migration
    expect(useSettingsStore.getState().preferredIdentityIds).toEqual({ 'acc-1': 'id-3' });
  });
});

// #1644: the browser-local default is one value for the whole browser, and
// identity ids repeat across accounts ("b", "c"). Another account's "c" made
// an alias the default of a newly added account.
describe('the browser-local default of another account (#1644)', () => {
  const account = (id: string, username: string) => ({ id, username, email: username, displayName: '', label: '' });
  const own = makeIdentity({ id: 'b', name: 'Mikrotik', email: 'mikrotik@example.com' });
  const alias = makeIdentity({ id: 'c', name: 'Cristi', email: 'x.cristi@example.com' });

  beforeEach(() => {
    useIdentityStore.setState({ identities: [own, alias], preferredPrimaryId: null, preferredPrimaryAccountId: null });
    useAuthStore.setState({ identities: [own, alias], primaryIdentity: own });
    useAccountStore.setState({
      accounts: [account('acc-a', 'me@example.com'), account('acc-b', 'mikrotik@example.com')] as never,
      activeAccountId: 'acc-b',
    });
    useSettingsStore.setState({ preferredIdentityIds: {} });
  });

  it('is not taken over by an account it was not chosen for', () => {
    useIdentityStore.setState({ preferredPrimaryId: 'c', preferredPrimaryAccountId: 'acc-a' });
    applyPreferredIdentity('acc-b');
    expect(useAuthStore.getState().primaryIdentity?.id).toBe('b');
    expect(useSettingsStore.getState().preferredIdentityIds).toEqual({});
  });

  it('is not taken over while several logins are in the browser and its account is unknown', () => {
    useIdentityStore.setState({ preferredPrimaryId: 'c', preferredPrimaryAccountId: null });
    applyPreferredIdentity('acc-b');
    expect(useAuthStore.getState().primaryIdentity?.id).toBe('b');
    expect(useSettingsStore.getState().preferredIdentityIds).toEqual({});
  });

  it('is taken over by the account it was chosen for', () => {
    useIdentityStore.setState({ preferredPrimaryId: 'c', preferredPrimaryAccountId: 'acc-b' });
    applyPreferredIdentity('acc-b');
    expect(useAuthStore.getState().primaryIdentity?.id).toBe('c');
    expect(useSettingsStore.getState().preferredIdentityIds).toEqual({ 'acc-b': 'c' });
  });

  it('does not order a newly added account\'s identities', async () => {
    useIdentityStore.setState({ preferredPrimaryId: 'c', preferredPrimaryAccountId: 'acc-a' });
    useAuthStore.setState({ client: { getIdentities: async () => [alias, own] } as never, username: 'mikrotik@example.com' });
    await useAuthStore.getState().refreshIdentities();
    expect(useAuthStore.getState().primaryIdentity?.id).toBe('b');
    // Gone for this account, so nothing else (a plugin's From) picks it up.
    expect(useIdentityStore.getState().preferredPrimaryId).toBeNull();
    useAuthStore.setState({ client: null });
  });

  it('still orders the identities of the account it was chosen for', async () => {
    useIdentityStore.setState({ preferredPrimaryId: 'c', preferredPrimaryAccountId: 'acc-b' });
    useAuthStore.setState({ client: { getIdentities: async () => [own, alias] } as never, username: 'mikrotik@example.com' });
    await useAuthStore.getState().refreshIdentities();
    expect(useAuthStore.getState().primaryIdentity?.id).toBe('c');
    useAuthStore.setState({ client: null });
  });

  it('puts the new default\'s address on the account, for the account switcher', () => {
    useSettingsStore.setState({ preferredIdentityIds: { 'acc-b': 'c' } });
    applyPreferredIdentity('acc-b');
    expect(useAccountStore.getState().getAccountById('acc-b')?.email).toBe('x.cristi@example.com');

    useIdentityStore.setState({ identities: [own, alias] });
    useAuthStore.setState({ client: {} as never, activeAccountId: 'acc-b' });
    useAuthStore.getState().syncIdentities();
    expect(useAccountStore.getState().getAccountById('acc-b')?.email).toBe('mikrotik@example.com');
    useAuthStore.setState({ client: null });
  });
});
