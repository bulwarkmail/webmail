import { beforeEach, describe, expect, it, vi } from 'vitest';
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', () => ({ apiFetch }));
import { useSettingsStore, migrateSettings } from '../settings-store';
import { usePolicyStore } from '../policy-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import type { SmartFolder } from '@/lib/smart-folder-types';

const folder: SmartFolder = { id: 'attachments', name: 'Attachments', enabled: true, order: 0,
  scope: 'active-account', match: 'all', conditions: [{ field: 'hasAttachment', value: true }] };
const settings = () => useSettingsStore.getState();
beforeEach(() => {
  localStorage.clear();
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY }, loaded: false });
  settings().disableSync(); settings().resetToDefaults(); apiFetch.mockReset();
});

describe('smart folder settings persistence', () => {
  it('creates, edits and deletes without touching built-in settings', () => {
    settings().updateSetting('enableCrossUnreadView', false);
    settings().updateSetting('enableCrossStarredView', false);
    expect(settings().saveSmartFolder(folder)).toBe(true);
    expect(settings().saveSmartFolder({ ...folder, name: 'Invoices', conditions: [{ field: 'subject', value: 'Rechnung' }] })).toBe(true);
    expect(settings().smartFolders).toHaveLength(1);
    expect(settings().smartFolders[0].name).toBe('Invoices');
    settings().removeSmartFolder(folder.id);
    expect(settings().smartFolders).toEqual([]);
    expect(settings().enableCrossUnreadView).toBe(false); expect(settings().enableCrossStarredView).toBe(false);
    expect(settings().enableUnifiedMailbox).toBe(false);
  });
  it('survives actual local persist rehydration', async () => {
    settings().saveSmartFolder(folder);
    const saved = localStorage.getItem('settings-storage')!;
    settings().resetToDefaults(); localStorage.setItem('settings-storage', saved);
    await useSettingsStore.persist.rehydrate();
    expect(settings().smartFolders).toEqual([folder]); expect(settings().smartFoldersVersion).toBe(1);
  });
  it('round-trips through export/import and the real server settings load path', async () => {
    settings().saveSmartFolder(folder);
    const exported = settings().exportSettings({ forSync: true });
    settings().resetToDefaults();
    expect(settings().importSettings(exported)).toBe(true);
    expect(settings().smartFolders).toEqual([folder]);
    // A fresh browser has no newer local setting stamps.
    settings().resetToDefaults(); localStorage.clear();
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ settings: JSON.parse(exported) }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await settings().loadFromServer('tester@example.org', 'https://mail.example.org');
    expect(settings().smartFolders).toEqual([folder]);
    expect(settings().enableUnifiedMailbox).toBe(false);
    expect(settings().enableCrossUnreadView).toBe(true); expect(settings().enableCrossStarredView).toBe(true);
  });
  it('adds only an empty collection migrating phase 2 and preserves explicit OFF', () => {
    const state = migrateSettings({ enableCrossUnreadView: false, enableCrossStarredView: false,
      explicitSettings: ['enableCrossUnreadView', 'enableCrossStarredView'] }, 17);
    expect(state.smartFolders).toEqual([]); expect(state.smartFoldersVersion).toBe(1);
    expect(state.enableCrossUnreadView).toBe(false); expect(state.enableCrossStarredView).toBe(false);
  });
  it('rejects malformed imports, generic writes and CRUD without weakening a saved filter', () => {
    settings().saveSmartFolder(folder);
    expect(settings().saveSmartFolder({ ...folder, conditions: [] })).toBe(false);
    settings().updateSetting('smartFolders', [{ ...folder, scope: 'all-accounts' }] as never);
    settings().importSettings(JSON.stringify({ smartFoldersVersion: 1, smartFolders: [{ ...folder, conditions: [{ field: 'script', value: 'x' }] }] }));
    expect(settings().smartFolders).toEqual([folder]);
    settings().importSettings(JSON.stringify({ smartFoldersVersion: 999, smartFolders: [] }));
    expect(settings().smartFolders).toEqual([folder]); expect(settings().smartFoldersVersion).toBe(1);
  });
});
