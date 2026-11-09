import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore, migrateSettings } from '../settings-store';

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

describe('migrateSettings v5 -> v6 (Unified Mailbox rework)', () => {
  it('keeps cross-account users cross-account when any cross view was on, and enables shared', () => {
    const out = migrateSettings(
      { allMailFolderIds: {}, enableCrossUnreadView: true, enableAllMailView: false, includeGroupInUnified: false },
      5,
    ) as unknown as Record<string, unknown>;
    expect(out.unifiedCrossAccount).toBe(true);
    // shared inclusion is enabled for every migrated config, even if it was off
    expect(out.includeGroupInUnified).toBe(true);
    expect(out.enableAllMailView).toBeUndefined();
  });

  it('folds a standalone All-Mail user into the account-bounded unified "All mail" entry', () => {
    const out = migrateSettings(
      {
        allMailFolderIds: { 'acct-1': ['inbox', 'projects'] },
        enableAllMailView: true,
        enableUnifiedMailbox: false,
        enableCrossUnreadView: false,
        enableCrossStarredView: false,
        enableCrossAllView: false,
      },
      5,
    ) as unknown as Record<string, unknown>;
    expect(out.enableUnifiedMailbox).toBe(true);
    expect(out.enableCrossAllView).toBe(true);
    expect(out.unifiedCrossAccount).toBe(false);   // new account-bounded default
    expect(out.includeGroupInUnified).toBe(true);
    // folder selection carries over unchanged -> narrows the unified lists
    expect(out.allMailFolderIds).toEqual({ 'acct-1': ['inbox', 'projects'] });
    expect(out.enableAllMailView).toBeUndefined();
  });

  it('a fresh user gets account-bounded defaults', () => {
    const out = migrateSettings({ allMailFolderIds: {} }, 5) as unknown as Record<string, unknown>;
    expect(out.unifiedCrossAccount).toBe(false);
    expect(out.includeGroupInUnified).toBe(true);
  });
});

describe('settings-store autoSaveDraftInterval', () => {
  // Drafts save 2 s after the last change; this interval was never read.
  it('is no longer a setting, nor exported', () => {
    expect('autoSaveDraftInterval' in useSettingsStore.getState()).toBe(false);
    expect(JSON.parse(useSettingsStore.getState().exportSettings())).not.toHaveProperty('autoSaveDraftInterval');
  });

  it('is dropped from persisted settings and ignored in an import', () => {
    expect(migrateSettings({ autoSaveDraftInterval: 60000 }, 10)).not.toHaveProperty('autoSaveDraftInterval');
    useSettingsStore.getState().importSettings(JSON.stringify({ autoSaveDraftInterval: 30000 }));
    expect('autoSaveDraftInterval' in useSettingsStore.getState()).toBe(false);
  });
});
