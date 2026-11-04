import { fireEvent, render, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationSettings } from '../notification-settings';
import { useSettingsStore } from '@/stores/settings-store';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useEmailStore } from '@/stores/email-store';
import { useIdentityStore } from '@/stores/identity-store';
import { jmapSetError } from '@/lib/jmap/jmap-error';
import type { Mailbox } from '@/lib/jmap/types';
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
  mailAccountsWithoutPush: vi.fn(() => []),
  revokePushDevice: vi.fn(async () => undefined),
  serverSupportsEmailPush: vi.fn(() => true),
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

  it('shows the toggle when the server supports emailPush filters', async () => {
    const { findByText } = render(<NotificationSettings />);
    await findByText('email.inbox_only');
  });

  it('hides the toggle when the server cannot filter pushes', async () => {
    (webPush.serverSupportsEmailPush as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const { findByText, queryByText } = render(<NotificationSettings />);
    await findByText('email.sound');
    expect(queryByText('email.inbox_only')).toBeNull();
    (webPush.serverSupportsEmailPush as ReturnType<typeof vi.fn>).mockReturnValue(true);
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

  it('checks push again when the user comes back to the tab', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    const { findByText } = render(<NotificationSettings />);
    await findByText('email.inbox_only');
    const check = webPush.isWebPushEnabled as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(check).toHaveBeenCalled());
    const before = check.mock.calls.length;

    // Push may have been turned off elsewhere (site settings, another tab) meanwhile.
    await act(async () => { window.dispatchEvent(new Event('focus')); });

    await waitFor(() => expect(check.mock.calls.length).toBeGreaterThan(before));
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

describe('NotificationSettings - demo mode', () => {
  beforeEach(() => {
    useAuthStore.setState({ client: fakeClient, username: 'me@example.com', isDemoMode: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    useAuthStore.setState({ isDemoMode: false });
  });

  it('says push is not available and offers no switch that would call the relay', async () => {
    const { findByText, getAllByRole } = render(<NotificationSettings />);
    await findByText('push.status_demo');
    const pushSwitch = getAllByRole('switch').find((el) => (el as HTMLButtonElement).disabled);
    expect(pushSwitch).toBeTruthy();
    expect(webPush.enableWebPush).not.toHaveBeenCalled();
  });
});

describe('NotificationSettings - mailboxes shared by ACL', () => {
  const mailbox = (id: string, accountId: string, isShared: boolean) =>
    ({ id, originalId: id, name: id, accountId, isShared }) as unknown as Mailbox;

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
    useEmailStore.setState({
      mailboxes: [
        mailbox('inbox', 'acct-1', false),
        mailbox('acct-group:inbox', 'acct-group', true),
        mailbox('acct-acl:projects', 'acct-acl', true),
      ],
    });
    // Stalwart 0.16 gives a group's members an identity with its address.
    useIdentityStore.setState({
      identities: [
        { id: 'i-own', name: 'Me', email: 'me@example.com', mayDelete: false },
        { id: 'i-group', name: 'Team', email: 'team@example.com', mayDelete: true },
      ],
    });
  });

  it('says that mailboxes shared by other users send no background notifications', async () => {
    (webPush.mailAccountsWithoutPush as ReturnType<typeof vi.fn>).mockReturnValue(['acct-acl']);

    const { findByText } = render(<NotificationSettings />);

    await findByText('push.shared_mailboxes_no_push');
    // The identities tell the user's groups apart on Stalwart 0.16.
    expect(webPush.mailAccountsWithoutPush).toHaveBeenCalledWith(
      fakeClient,
      ['acct-group', 'acct-acl'],
      ['me@example.com', 'team@example.com'],
    );
  });

  it('says nothing when every shared mailbox is covered', async () => {
    (webPush.mailAccountsWithoutPush as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const { findByText, queryByText } = render(<NotificationSettings />);

    await findByText('push.status_active');
    expect(queryByText('push.shared_mailboxes_no_push')).toBeNull();
  });
});

describe('NotificationSettings - push errors', () => {
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
    (webPush.isWebPushEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(false);
  });

  async function enableAndFail(error: unknown) {
    (webPush.enableWebPush as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);
    const view = render(<NotificationSettings />);
    await view.findByText('push.status_inactive');
    fireEvent.click(view.getByRole('switch', { name: 'push.enable' }));
    return (await view.findByRole('alert')).textContent;
  }

  it('explains a forbidden refusal instead of showing the raw server error', async () => {
    const text = await enableAndFail(jmapSetError('PushSubscription/set create failed: forbidden', {
      type: 'forbidden',
      description: 'No access to one of the accounts in the emailPush map.',
    }));

    expect(text).toBe('push.error_forbidden');
  });

  it('explains the subscription limit on overQuota', async () => {
    const text = await enableAndFail(jmapSetError('PushSubscription/set create failed', {
      type: 'overQuota',
      description: 'There are too many subscriptions, please delete some before adding a new one.',
    }));

    expect(text).toBe('push.error_over_quota');
  });

  it('keeps the message of any other failure', async () => {
    const text = await enableAndFail(new Error('Relay register failed: 502'));

    expect(text).toBe('Relay register failed: 502');
  });
});

// settings-p2-17 (2026-11-04): with several accounts the page had one switch
// for the account on screen and, below it, a checklist with bulk buttons.
describe('NotificationSettings - several accounts', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { useAccountStore } = await import('@/stores/account-store');
    const clients: Record<string, unknown> = { a: fakeClient, b: { getAccountId: () => 'acct-2' } };
    useAccountStore.setState({
      accounts: [
        { id: 'a', username: 'a', email: 'a@example.com', displayName: 'Alice', isConnected: true },
        { id: 'b', username: 'b', email: 'b@example.com', displayName: 'Bob', isConnected: true },
      ] as never,
    });
    useAuthStore.setState({ client: fakeClient, username: 'a@example.com', isDemoMode: false, getClientForAccount: ((id: string) => clients[id]) as never });
    usePolicyStore.setState({
      ...usePolicyStore.getState(),
      policy: {},
      isSettingLocked: () => false,
      isSettingHidden: () => false,
    } as never);
  });

  afterEach(async () => {
    const { useAccountStore } = await import('@/stores/account-store');
    useAccountStore.setState({ accounts: [] });
  });

  it('has one switch per account instead of the switch for this account and a checklist', async () => {
    const { findByRole, queryByText, queryByRole } = render(<NotificationSettings />);
    expect(await findByRole('switch', { name: 'Alice (a@example.com)' })).toBeTruthy();
    expect(await findByRole('switch', { name: 'Bob (b@example.com)' })).toBeTruthy();
    expect(queryByText('push.enable')).toBeNull();
    expect(queryByText('select_all')).toBeNull();
    expect(queryByRole('checkbox')).toBeNull();
  });
});
