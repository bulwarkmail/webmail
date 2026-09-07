import { render, waitFor } from '@testing-library/react';
import { act } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationSettings } from '../notification-settings';
import { useSettingsStore } from '@/stores/settings-store';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import * as webPush from '@/lib/web-push';

// next-intl's useTranslations -> identity so labels are their keys.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

// Keep the section wrapper out of the way.
vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/lib/web-push', () => ({
  WebPushUnsupportedError: class WebPushUnsupportedError extends Error {},
  isWebPushSupported: () => true,
  isWebPushEnabled: vi.fn(async () => true),
  enableWebPush: vi.fn(async () => ({ subscriptionId: 'sub-1' })),
  disableWebPush: vi.fn(async () => undefined),
  listPushDevices: vi.fn(async () => []),
  revokePushDevice: vi.fn(async () => undefined),
}));

const fakeClient = { getAccountId: () => 'acct-1' } as unknown as ReturnType<
  typeof useAuthStore.getState
>['client'];

describe('NotificationSettings - pushNotifyInboxOnly', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ emailNotificationsEnabled: true, pushNotifyInboxOnly: false });
    useAuthStore.setState({ client: fakeClient, username: 'me@example.com' });
    usePolicyStore.setState({
      ...usePolicyStore.getState(),
      policy: {},
      isSettingLocked: () => false,
      isSettingHidden: () => false,
    } as never);
  });

  it('does not re-sync push on mount', async () => {
    render(<NotificationSettings />);
    // Let the "is push enabled?" effect settle.
    await waitFor(() => expect(webPush.isWebPushEnabled).toHaveBeenCalled());
    expect(webPush.enableWebPush).not.toHaveBeenCalled();
  });

  it('re-runs enableWebPush with the new flag when the toggle flips while push is on', async () => {
    const { findByText } = render(<NotificationSettings />);
    await findByText('push.status_active');

    act(() => {
      useSettingsStore.getState().updateSetting('pushNotifyInboxOnly', true);
    });

    await waitFor(() => expect(webPush.enableWebPush).toHaveBeenCalledTimes(1));
    expect(webPush.enableWebPush).toHaveBeenCalledWith(
      expect.objectContaining({ client: fakeClient, inboxOnly: true }),
    );
    // forceRecreate stays off - a filter PATCH, not a destroy/recreate.
    expect(
      (webPush.enableWebPush as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).not.toHaveProperty('forceRecreate', true);
  });

  it('does not get stuck on "busy" after the re-sync resolves', async () => {
    const { findByText, queryByText } = render(<NotificationSettings />);
    await findByText('push.status_active');
    const devicesLoadsBefore = (webPush.listPushDevices as ReturnType<typeof vi.fn>).mock.calls.length;

    act(() => {
      useSettingsStore.getState().updateSetting('pushNotifyInboxOnly', true);
    });

    // enableWebPush resolves -> status returns to active, device list refreshes.
    await findByText('push.status_active');
    expect(queryByText('push.status_busy')).toBeNull();
    await waitFor(() =>
      expect(
        (webPush.listPushDevices as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThan(devicesLoadsBefore),
    );
  });

  it('does not re-sync when push is disabled on this device', async () => {
    (webPush.isWebPushEnabled as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    render(<NotificationSettings />);
    await waitFor(() => expect(webPush.isWebPushEnabled).toHaveBeenCalled());

    act(() => {
      useSettingsStore.getState().updateSetting('pushNotifyInboxOnly', true);
    });

    // Give any effect a chance to fire.
    await Promise.resolve();
    expect(webPush.enableWebPush).not.toHaveBeenCalled();
  });
});
