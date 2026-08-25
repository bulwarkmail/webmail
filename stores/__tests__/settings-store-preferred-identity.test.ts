import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore, migrateSettings } from '../settings-store';

describe('settings-store per-account preferredIdentityIds (issue #507)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ preferredIdentityIds: {} });
  });

  it('defaults to an empty record (no account has a synced default)', () => {
    expect(useSettingsStore.getState().preferredIdentityIds).toEqual({});
  });

  it('keeps each account default independent', () => {
    useSettingsStore.setState({
      preferredIdentityIds: { 'acct-1': 'b', 'acct-2': 'c' },
    });
    const map = useSettingsStore.getState().preferredIdentityIds;
    expect(map['acct-1']).toBe('b');
    expect(map['acct-2']).toBe('c');
    expect(map['acct-3']).toBeUndefined();
  });

  it('round-trips through export -> import so the choice survives clearing site data', () => {
    useSettingsStore.setState({ preferredIdentityIds: { 'acct-1': 'b' } });
    const json = useSettingsStore.getState().exportSettings();
    // Appears in exported JSON (issue #507 acceptance criterion).
    expect(JSON.parse(json).preferredIdentityIds).toEqual({ 'acct-1': 'b' });

    // Simulate a fresh browser: clear, then import the exported settings.
    useSettingsStore.setState({ preferredIdentityIds: {} });
    expect(useSettingsStore.getState().importSettings(json)).toBe(true);
    expect(useSettingsStore.getState().preferredIdentityIds).toEqual({ 'acct-1': 'b' });
  });

  describe('importSettings non-record guard', () => {
    it('ignores a legacy array shape', () => {
      useSettingsStore.setState({ preferredIdentityIds: { 'acct-1': 'b' } });
      const ok = useSettingsStore.getState().importSettings(
        JSON.stringify({ preferredIdentityIds: ['b'] }),
      );
      expect(ok).toBe(true);
      expect(useSettingsStore.getState().preferredIdentityIds).toEqual({ 'acct-1': 'b' });
    });

    it('ignores a null value', () => {
      useSettingsStore.setState({ preferredIdentityIds: { 'acct-1': 'b' } });
      useSettingsStore.getState().importSettings(JSON.stringify({ preferredIdentityIds: null }));
      expect(useSettingsStore.getState().preferredIdentityIds).toEqual({ 'acct-1': 'b' });
    });

    it('accepts a proper per-account record', () => {
      useSettingsStore.getState().importSettings(
        JSON.stringify({ preferredIdentityIds: { 'acct-9': 'a' } }),
      );
      expect(useSettingsStore.getState().preferredIdentityIds).toEqual({ 'acct-9': 'a' });
    });
  });

  // Regression: multi-account logins used to clobber the per-account map. Each
  // account's server load must merge only its OWN entry, preserving the others,
  // so the composer's default sender no longer depends on login order.
  describe('importSettings per-account merge (multi-account login order)', () => {
    beforeEach(() => useSettingsStore.setState({ preferredIdentityIds: {}, allMailFolderIds: {} }));

    it('a per-account server load updates only its own entry, preserving others', () => {
      useSettingsStore.setState({ preferredIdentityIds: { 'a@h': 'idA', 'b@h': 'idB' } });
      // Account B's server blob carries a STALE entry for A plus B's own value.
      useSettingsStore.getState().importSettings(
        JSON.stringify({ preferredIdentityIds: { 'a@h': 'STALE', 'b@h': 'idB2' } }),
        { serverAccountId: 'b@h' },
      );
      const map = useSettingsStore.getState().preferredIdentityIds;
      expect(map['a@h']).toBe('idA');  // preserved, not clobbered by B's stale copy
      expect(map['b@h']).toBe('idB2'); // B is authoritative for itself
    });

    it('fills the loading account entry when the map had none, without importing others', () => {
      useSettingsStore.setState({ preferredIdentityIds: { 'a@h': 'idA' } });
      useSettingsStore.getState().importSettings(
        JSON.stringify({ preferredIdentityIds: { 'a@h': 'x', 'b@h': 'idB' } }),
        { serverAccountId: 'b@h' },
      );
      // Only b@h (the loading account) is trusted; a@h keeps its local value.
      expect(useSettingsStore.getState().preferredIdentityIds).toEqual({ 'a@h': 'idA', 'b@h': 'idB' });
    });

    it('a file import (no serverAccountId) still replaces the whole map', () => {
      useSettingsStore.setState({ preferredIdentityIds: { 'a@h': 'idA' } });
      useSettingsStore.getState().importSettings(
        JSON.stringify({ preferredIdentityIds: { 'b@h': 'idB' } }),
      );
      expect(useSettingsStore.getState().preferredIdentityIds).toEqual({ 'b@h': 'idB' });
    });

    it('applies the same per-account merge to allMailFolderIds', () => {
      useSettingsStore.setState({ allMailFolderIds: { 'a@h': ['x'], 'b@h': ['y'] } });
      useSettingsStore.getState().importSettings(
        JSON.stringify({ allMailFolderIds: { 'a@h': ['STALE'], 'b@h': ['y2'] } }),
        { serverAccountId: 'b@h' },
      );
      const map = useSettingsStore.getState().allMailFolderIds;
      expect(map['a@h']).toEqual(['x']);
      expect(map['b@h']).toEqual(['y2']);
    });
  });

  describe('migrateSettings identity map', () => {
    it('adds an empty preferredIdentityIds map for pre-v6 users', () => {
      const out = migrateSettings({ allMailFolderIds: {} }, 6) as unknown as Record<string, unknown>;
      expect(out.preferredIdentityIds).toEqual({});
    });

    it('coerces a non-record preferredIdentityIds to an empty map', () => {
      const out = migrateSettings(
        { allMailFolderIds: {}, preferredIdentityIds: ['b'] },
        7,
      ) as unknown as Record<string, unknown>;
      expect(out.preferredIdentityIds).toEqual({});
    });

    it('preserves a valid per-account map across migration', () => {
      const out = migrateSettings(
        { allMailFolderIds: {}, preferredIdentityIds: { 'acct-1': 'b' } },
        7,
      ) as unknown as Record<string, unknown>;
      expect(out.preferredIdentityIds).toEqual({ 'acct-1': 'b' });
    });
  });
});
