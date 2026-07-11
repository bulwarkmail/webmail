import { beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '../settings-store';

describe('settings-store favicon unread badge', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetToDefaults();
  });

  it('defaults to on', () => {
    expect(useSettingsStore.getState().faviconUnreadBadge).toBe(true);
  });

  it('includes the favicon unread badge in exported settings', () => {
    useSettingsStore.getState().updateSetting('faviconUnreadBadge', false);

    const exported = JSON.parse(useSettingsStore.getState().exportSettings()) as {
      faviconUnreadBadge?: boolean;
    };

    expect(exported.faviconUnreadBadge).toBe(false);
  });
});
