import { describe, expect, it, vi } from 'vitest';

const writePushPreferences = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/push-preferences', () => ({ writePushPreferences }));

import { useSettingsStore } from '../settings-store';

describe('do not disturb and push notifications (CO-13)', () => {
  it('keeps pushed notifications off screen while do not disturb is on', () => {
    useSettingsStore.setState({ emailNotificationsEnabled: true, emailNotificationSound: true, doNotDisturb: false });
    writePushPreferences.mockClear();
    useSettingsStore.getState().updateSetting('doNotDisturb', true);
    expect(writePushPreferences).toHaveBeenLastCalledWith({ sound: false, show: false });
    useSettingsStore.getState().updateSetting('doNotDisturb', false);
    expect(writePushPreferences).toHaveBeenLastCalledWith({ sound: true, show: true });
  });

  it('keeps them off screen with email notifications off, and only silent with the sound off', () => {
    useSettingsStore.setState({ emailNotificationsEnabled: true, emailNotificationSound: true, doNotDisturb: false });
    writePushPreferences.mockClear();
    useSettingsStore.getState().updateSetting('emailNotificationsEnabled', false);
    expect(writePushPreferences).toHaveBeenLastCalledWith({ sound: false, show: false });
    useSettingsStore.getState().updateSetting('emailNotificationsEnabled', true);
    useSettingsStore.getState().updateSetting('emailNotificationSound', false);
    expect(writePushPreferences).toHaveBeenLastCalledWith({ sound: false, show: true });
  });
});
