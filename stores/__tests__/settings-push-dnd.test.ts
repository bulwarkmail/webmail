import { describe, expect, it, vi } from 'vitest';

const writePushPreferences = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/push-preferences', () => ({ writePushPreferences }));

import { useSettingsStore } from '../settings-store';

describe('do not disturb and push notifications (CO-13)', () => {
  it('keeps pushed notifications silent while do not disturb is on', () => {
    useSettingsStore.setState({ emailNotificationsEnabled: true, emailNotificationSound: true, doNotDisturb: false });
    writePushPreferences.mockClear();
    useSettingsStore.getState().updateSetting('doNotDisturb', true);
    expect(writePushPreferences).toHaveBeenLastCalledWith({ sound: false });
    useSettingsStore.getState().updateSetting('doNotDisturb', false);
    expect(writePushPreferences).toHaveBeenLastCalledWith({ sound: true });
  });
});
