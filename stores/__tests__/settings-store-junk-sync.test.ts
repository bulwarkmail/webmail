import { beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '../settings-store';

// "Permanently delete junk" is a choice on the Message list page; it has to
// reach the server copy like the rest, or another device (or a restore)
// quietly goes back to moving junk to the trash.
describe('settings-store permanentlyDeleteJunk sync', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetToDefaults();
  });

  it('is in the snapshot pushed to the server and in a file export', () => {
    useSettingsStore.getState().updateSetting('permanentlyDeleteJunk', true);
    expect(JSON.parse(useSettingsStore.getState().exportSettings({ forSync: true })).permanentlyDeleteJunk).toBe(true);
    expect(JSON.parse(useSettingsStore.getState().exportSettings()).permanentlyDeleteJunk).toBe(true);
  });

  it('comes back from a synced copy', () => {
    useSettingsStore.getState().updateSetting('permanentlyDeleteJunk', true);
    const blob = useSettingsStore.getState().exportSettings({ forSync: true });
    useSettingsStore.getState().resetToDefaults();
    expect(useSettingsStore.getState().permanentlyDeleteJunk).toBe(false);
    expect(useSettingsStore.getState().importSettings(blob)).toBe(true);
    expect(useSettingsStore.getState().permanentlyDeleteJunk).toBe(true);
  });

  it('ignores a value that is not a boolean', () => {
    expect(useSettingsStore.getState().importSettings(JSON.stringify({ permanentlyDeleteJunk: 'yes' }))).toBe(true);
    expect(useSettingsStore.getState().permanentlyDeleteJunk).toBe(false);
  });
});
