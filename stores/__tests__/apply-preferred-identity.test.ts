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
