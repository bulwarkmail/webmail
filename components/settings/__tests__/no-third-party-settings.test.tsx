import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageListSettings } from '../message-list-settings';
import { NotificationSettings } from '../notification-settings';
import { PluginsSettings } from '../plugins-settings';
import { PrivacySettings } from '../privacy-settings';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useSettingsStore } from '@/stores/settings-store';
import { setNoThirdPartyTraffic } from '@/lib/third-party-mode';
import type { InstalledPlugin } from '@/lib/plugin-types';

// #903: the settings pages hide or explain what the no-third-party mode turns off.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: String, relativeTime: String, number: String }),
}));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ demoMode: false }) }));
vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/web-push', () => ({
  WebPushUnsupportedError: class WebPushUnsupportedError extends Error {},
  isWebPushSupported: () => true,
  isWebPushEnabled: vi.fn(async () => false),
  enableWebPush: vi.fn(async () => ({ subscriptionId: 'sub-1' })),
  disableWebPush: vi.fn(async () => undefined),
  listPushDevices: vi.fn(async () => []),
  mailAccountsWithoutPush: vi.fn(() => []),
  revokePushDevice: vi.fn(async () => undefined),
  serverSupportsEmailPush: vi.fn(() => true),
}));

beforeEach(() => {
  useAuthStore.setState({ client: { getAccountId: () => 'acct-1' } as never, username: 'me@example.com' });
  usePolicyStore.setState({
    ...usePolicyStore.getState(),
    loaded: true,
    policy: {},
    isSettingLocked: () => false,
    isSettingHidden: () => false,
    isFeatureEnabled: () => true,
    isPluginForceEnabled: () => false,
  } as never);
  useSettingsStore.setState({ senderFavicons: true, emailNotificationsEnabled: true });
});
afterEach(() => setNoThirdPartyTraffic(false));

// Sender pictures, remote content and trusted senders moved from Message
// list and Reading to Privacy (settings-24, 2026-11-04).
describe('Settings > Privacy', () => {
  it('offers sender favicons only while third-party traffic is allowed', () => {
    const { unmount } = render(<PrivacySettings />);
    expect(screen.getByText('sender_favicons.label')).toBeInTheDocument();
    unmount();
    setNoThirdPartyTraffic(true);
    render(<PrivacySettings />);
    expect(screen.queryByText('sender_favicons.label')).toBeNull();
  });

  it('leaves a link to Privacy on Message list', () => {
    render(<MessageListSettings />);
    expect(screen.queryByText('sender_favicons.label')).toBeNull();
    expect(screen.getByText('senders_label')).toBeInTheDocument();
  });
});

describe('Settings > Notifications', () => {
  function pushToggle() {
    const row = screen.getByText('push.enable').closest('[data-search-label]') as HTMLElement;
    return row.querySelector('[role="switch"]') as HTMLButtonElement;
  }

  it('says push needs an organisation relay and disables the switch when there is none', async () => {
    setNoThirdPartyTraffic(true);
    render(<NotificationSettings />);
    await waitFor(() => expect(screen.getByText('push_needs_relay')).toBeInTheDocument());
    expect(pushToggle()).toBeDisabled();
  });

  it('keeps the switch with the built-in relay when the mode is off', async () => {
    render(<NotificationSettings />);
    await waitFor(() => expect(screen.getByText('push.status_inactive')).toBeInTheDocument());
    expect(pushToggle()).not.toBeDisabled();
    expect(screen.queryByText('push_needs_relay')).toBeNull();
  });
});

describe('Settings > Plugins', () => {
  it('says why a plugin that declares network access was not started', () => {
    const plugin = {
      id: 'p', name: 'Fetcher', version: '1.0.0', author: 'a', description: 'd', type: 'hook', permissions: ['http:fetch'],
      entrypoint: 'index.js', enabled: true, status: 'error', error: 'third-party-off', managed: true, settings: {},
    } as unknown as InstalledPlugin;
    usePluginStore.setState({ plugins: [plugin], initialized: true, initializePlugins: vi.fn() } as never);
    render(<PluginsSettings />);
    fireEvent.click(screen.getByText('Fetcher'));
    expect(screen.getByText('plugin_refused')).toBeInTheDocument();
  });
});

describe('Settings > Privacy: remote content', () => {
  function externalContentRow() {
    return screen.getByText('external_content.label').closest('[data-search-label]') as HTMLElement;
  }

  it('lets the user pick the external content policy without the mode', () => {
    useSettingsStore.setState({ externalContentPolicy: 'ask' });
    render(<PrivacySettings />);
    expect(externalContentRow().textContent).not.toContain('org_locked');
    expect(externalContentRow().querySelector('select')?.value).toBe('ask');
  });

  it('shows the policy as blocked and set by the organisation in the mode', () => {
    setNoThirdPartyTraffic(true);
    useSettingsStore.setState({ externalContentPolicy: 'allow' });
    render(<PrivacySettings />);
    const row = externalContentRow();
    expect(row.textContent).toContain('org_locked');
    expect(row.querySelector('select')?.value).toBe('block');
    expect(row.querySelector('[inert]')).not.toBeNull();
  });
});
