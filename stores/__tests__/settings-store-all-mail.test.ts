import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from '../settings-store';

describe('settings-store per-account allMailFolderIds', () => {
  beforeEach(() => {
    useSettingsStore.setState({ allMailFolderIds: {} });
  });

  it('defaults to an empty record (every account "not configured")', () => {
    expect(useSettingsStore.getState().allMailFolderIds).toEqual({});
  });

  it('keeps each account selection independent', () => {
    useSettingsStore.setState({
      allMailFolderIds: { 'acct-1': ['inbox', 'archive'], 'acct-2': ['sent'] },
    });
    const map = useSettingsStore.getState().allMailFolderIds;
    expect(map['acct-1']).toEqual(['inbox', 'archive']);
    expect(map['acct-2']).toEqual(['sent']);
    // A third account remains unconfigured (no entry).
    expect(map['acct-3']).toBeUndefined();
  });

  it('distinguishes explicit-empty ([] = no folders) from not-configured (undefined)', () => {
    useSettingsStore.setState({ allMailFolderIds: { 'acct-1': [] } });
    const map = useSettingsStore.getState().allMailFolderIds;
    expect(map['acct-1']).toEqual([]);          // explicit "no folders"
    expect(map['acct-2']).toBeUndefined();      // never configured
  });

  describe('importSettings legacy-shape guard', () => {
    it('ignores a legacy global array shape', () => {
      useSettingsStore.setState({ allMailFolderIds: { 'acct-1': ['inbox'] } });
      const ok = useSettingsStore.getState().importSettings(
        JSON.stringify({ allMailFolderIds: ['inbox', 'sent'] }),
      );
      expect(ok).toBe(true);
      // unchanged - the array shape was rejected
      expect(useSettingsStore.getState().allMailFolderIds).toEqual({ 'acct-1': ['inbox'] });
    });

    it('ignores a null legacy value', () => {
      useSettingsStore.setState({ allMailFolderIds: { 'acct-1': ['inbox'] } });
      useSettingsStore.getState().importSettings(JSON.stringify({ allMailFolderIds: null }));
      expect(useSettingsStore.getState().allMailFolderIds).toEqual({ 'acct-1': ['inbox'] });
    });

    it('accepts a proper per-account record', () => {
      useSettingsStore.getState().importSettings(
        JSON.stringify({ allMailFolderIds: { 'acct-9': ['inbox', 'spam'] } }),
      );
      expect(useSettingsStore.getState().allMailFolderIds).toEqual({ 'acct-9': ['inbox', 'spam'] });
    });
  });
});
