import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';

// Usability pass 2, 2026-11-04: Notifications, Privacy, Backup & reset and
// Troubleshooting in the desktop app and in a browser (settings-p2-4, -9,
// -18; desktop-p2-4). Labels are keys here (next-intl mock).

const config = vi.hoisted(() => ({ settingsSyncEnabled: true }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Bulwark', settingsSyncEnabled: config.settingsSyncEnabled }) }));
vi.mock('../desktop-telemetry-settings', () => ({ DesktopTelemetrySettings: () => null }));
vi.mock('@/components/mail-transfer/mail-backup-settings', () => ({ MailBackupSettings: () => null }));
vi.mock('../debug-settings', () => ({ DebugSettings: () => null }));
vi.mock('@/lib/web-push', () => ({
  WebPushUnsupportedError: class WebPushUnsupportedError extends Error {},
  isWebPushSupported: () => false,
  isWebPushEnabled: vi.fn(async () => false),
  enableWebPush: vi.fn(),
  enableWebPushForAccounts: vi.fn(),
  disableWebPush: vi.fn(),
  listPushDevices: vi.fn(async () => []),
  mailAccountsWithoutPush: vi.fn(() => []),
  revokePushDevice: vi.fn(),
  serverSupportsEmailPush: vi.fn(() => false),
}));

const { NotificationSettings } = await import('../notification-settings');
const { PrivacySettings } = await import('../privacy-settings');
const { AboutDataSettings } = await import('../about-data-settings');
const { DesktopDevToolsSettings } = await import('../desktop-devtools-settings');
const { AdvancedSettingsProvider } = await import('../settings-section');

const osStatus = {
  settings: {
    closeToTray: true, startAtLogin: false, startMinimized: false, attentionOnNewMail: true,
    quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '07:00', showShortcut: null,
  },
  pausedUntil: null,
  shortcutActive: false,
};

function installBridge() {
  (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = {
    version: 1,
    platform: 'win32',
    os: {
      getStatus: vi.fn(async () => osStatus),
      defaultAppStatus: vi.fn(async () => ({ mailto: false })),
      onStatusChange: vi.fn(() => () => {}),
      setSettings: vi.fn(async () => osStatus),
      openDefaultAppSettings: vi.fn(),
    },
    devTools: {
      get: vi.fn(async () => ({ on: false, forcedOff: false, locked: false })),
      set: vi.fn(),
      onChange: vi.fn(() => () => {}),
    },
  };
}

async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

const realUserAgent = navigator.userAgent;
function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
}

beforeEach(() => {
  usePolicyStore.setState({
    ...usePolicyStore.getState(),
    policy: {},
    isSettingLocked: () => false,
    isSettingHidden: () => false,
    isFeatureEnabled: () => true,
  } as never);
  useAuthStore.setState({ client: null, username: null } as never);
  useSettingsStore.setState({ showAdvancedSettings: false, settingsSyncDisabled: false });
  config.settingsSyncEnabled = true;
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
  setUserAgent(realUserAgent);
});

describe('Notifications when the app is closed', () => {
  it('in the desktop app: no browser push section, one line about the tray instead', async () => {
    installBridge();
    render(<NotificationSettings />);
    await settle();
    expect(screen.queryByText('push.title')).toBeNull();
    expect(screen.queryByText('push.enable')).toBeNull();
    expect(screen.queryByText(/ios_hint|status_unsupported|push_unsupported/)).toBeNull();
    expect(screen.getByText('closed_label')).toBeTruthy();
    expect(screen.getByText('closed_description')).toBeTruthy();
    // The section with the taskbar and quiet hours isn't called "Desktop app", like General's.
    expect(screen.getByText('title')).toBeTruthy();
  });

  it('in a browser that can\'t: one sentence, without the iPhone hint off iOS', async () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/140.0');
    render(<NotificationSettings />);
    await settle();
    expect(screen.getByText('push_unsupported')).toBeTruthy();
    expect(screen.queryByText(/push\.ios_hint/)).toBeNull();
    expect(screen.queryByText(/status_unsupported/)).toBeNull();
  });

  it('on an iPhone: the home screen hint after it, as its own sentence', async () => {
    setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1');
    render(<NotificationSettings />);
    await settle();
    expect(screen.getByText('push_unsupported push.ios_hint')).toBeTruthy();
  });
});

describe('Privacy', () => {
  it('links to the push relay in a browser only', async () => {
    const browser = render(<PrivacySettings />);
    await settle();
    expect(screen.getByText('push_title')).toBeTruthy();
    browser.unmount();

    installBridge();
    render(<PrivacySettings />);
    await settle();
    expect(screen.queryByText('push_title')).toBeNull();
  });
});

describe('Backup & reset', () => {
  it('says "other devices" in the app, not "other browsers"', async () => {
    installBridge();
    render(<AboutDataSettings />);
    await settle();
    expect(screen.getByText('backup_description_app')).toBeTruthy();
    expect(screen.queryByText('sections.backup_description')).toBeNull();
  });

  it('says what a reset keeps, and whether other devices change', async () => {
    render(<AboutDataSettings />);
    await settle();
    fireEvent.click(screen.getByText('reset_settings.button'));
    expect(screen.getByText('reset.message reset.sync_on')).toBeTruthy();
    cleanup();

    useSettingsStore.setState({ settingsSyncDisabled: true });
    render(<AboutDataSettings />);
    await settle();
    fireEvent.click(screen.getByText('reset_settings.button'));
    expect(screen.getByText('reset.message reset.sync_off')).toBeTruthy();
  });

  it('keeps the choice to sync settings through a reset', () => {
    useSettingsStore.setState({ settingsSyncDisabled: true, showAdvancedSettings: true });
    useSettingsStore.getState().resetToDefaults();
    expect(useSettingsStore.getState().settingsSyncDisabled).toBe(true);
    expect(useSettingsStore.getState().showAdvancedSettings).toBe(false);
  });
});

describe('Developer tools in the desktop app', () => {
  it('show only with advanced settings on', async () => {
    installBridge();
    const page = () => (
      <AdvancedSettingsProvider>
        <DesktopDevToolsSettings />
      </AdvancedSettingsProvider>
    );
    render(page());
    await settle();
    expect(screen.queryByTestId('desktop-devtools-toggle')).toBeNull();
    cleanup();

    useSettingsStore.setState({ showAdvancedSettings: true });
    render(page());
    await settle();
    expect(screen.getByTestId('desktop-devtools-toggle')).toBeTruthy();
  });
});
