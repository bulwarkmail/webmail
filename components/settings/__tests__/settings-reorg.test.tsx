import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Settings reorg 2026-11-05: every setting where people look first. The desktop
// app's updates are on About & updates, its developer tools on Troubleshooting
// (listed only with advanced settings on), the app lock on Privacy & security,
// the app's own rows on a Desktop app page that only the app has, and old links
// to the sections that moved land on their new page.

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
  useMessages: () => ({}),
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: String, relativeTime: String, number: String }),
}));
vi.mock('@/hooks/use-media-query', async (importOriginal) => ({
  atLeast: (await importOriginal<typeof import('@/hooks/use-media-query')>()).atLeast,
  useIsDesktop: () => true,
  useIsMobile: () => false,
  useMediaQuery: () => false,
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
}));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail', stalwartFeaturesEnabled: true, settingsSyncEnabled: true }) }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/sidebar-apps-modal', () => ({ SidebarAppsModal: () => null }));
vi.mock('@/components/plugins/app-top-banner-slot', () => ({ AppTopBannerSlot: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ startTour: vi.fn(), resetTourCompletion: vi.fn() }),
}));
// The pages themselves are tested below; in the app only the nav and which page opens count.
vi.mock('@/components/settings/about-data-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../about-data-settings')>()),
  AboutSettings: () => <div data-testid="page-about" />,
  AboutDataSettings: () => <div data-testid="page-backup" />,
}));

const { SettingsApp } = await import('../settings-app');
const { GeneralSettings } = await import('../general-settings');
const { PrivacySettings } = await import('../privacy-settings');
const { DesktopAppSettings } = await import('../desktop-app-settings');
const aboutModule = await vi.importActual<typeof import('../about-data-settings')>('../about-data-settings');
const { AdvancedSettingsProvider } = await import('../settings-section');
const { useAuthStore } = await import('@/stores/auth-store');
const { usePluginStore } = await import('@/stores/plugin-store');
const { useThemeStore } = await import('@/stores/theme-store');
const { useSettingsStore } = await import('@/stores/settings-store');
const { usePolicyStore } = await import('@/stores/policy-store');

/** A client that supports everything it is asked about. */
const fullClient = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === 'then') return undefined;
    if (prop === 'getAccountId') return () => 'acc';
    if (typeof prop === 'string' && prop.startsWith('supports')) return () => true;
    if (prop === 'getShareTargets') return () => Promise.resolve([]);
    return () => null;
  },
});

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
    mode: 'standalone',
    windows: {},
    os: {
      getStatus: vi.fn(async () => osStatus),
      defaultAppStatus: vi.fn(async () => ({ mailto: false })),
      onStatusChange: vi.fn(() => () => {}),
      setSettings: vi.fn(async () => osStatus),
      openDefaultAppSettings: vi.fn(),
    },
    updates: {
      state: vi.fn(async () => ({ version: '1.0.0', channel: 'stable', channelLocked: false, allowed: true, ability: 'install', perMachine: false, status: 'idle' })),
      onChanged: vi.fn(() => () => {}),
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

const navTabs = () => [...document.querySelectorAll('[data-testid^="settings-tab-"]')]
  .map((el) => el.getAttribute('data-testid')!.slice('settings-tab-'.length));
const openTab = () => document.querySelector('[data-testid^="settings-tab-"][aria-current="page"]')
  ?.getAttribute('data-testid')?.slice('settings-tab-'.length) ?? null;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  localStorage.clear();
  localStorage.setItem('settings-active-tab', 'appearance');
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) } as never);
  useAuthStore.setState({ isAuthenticated: true, isLoading: false, client: fullClient as never, checkAuth: vi.fn(async () => {}) } as never);
  useSettingsStore.setState({ showAdvancedSettings: false });
  usePolicyStore.setState({ isSettingLocked: () => false, isSettingHidden: () => false } as never);
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
  vi.unstubAllGlobals();
});

describe('About & updates', () => {
  it('has the desktop app\'s updates; General has none', async () => {
    installBridge();
    render(<aboutModule.AboutSettings />);
    await settle();
    expect(screen.getByText('ux_p3_search.updates_label')).toBeTruthy();
    expect(screen.getByText('desktop_updates.channel_label')).toBeTruthy();
    cleanup();

    render(<GeneralSettings supportsCalendar />);
    await settle();
    expect(screen.queryByText('ux_p3_search.updates_label')).toBeNull();
  });

  it('is called "About & updates" in the desktop app and "About" in a browser', async () => {
    render(<SettingsApp linkSegments={[]} />);
    expect(screen.getByTestId('settings-tab-about').textContent).toBe('uxs_structure.tabs.about');
    cleanup();
    installBridge();
    render(<SettingsApp linkSegments={[]} />);
    expect(screen.getByTestId('settings-tab-about').textContent).toBe('settings_reorg.tabs.about_updates');
  });
});

describe('Troubleshooting', () => {
  it('has the developer tools, only with advanced settings on; General has none', async () => {
    installBridge();
    useSettingsStore.setState({ showAdvancedSettings: true });
    render(<GeneralSettings supportsCalendar />);
    await settle();
    expect(screen.queryByTestId('desktop-devtools-toggle')).toBeNull();
    cleanup();

    const page = () => (
      <AdvancedSettingsProvider>
        <aboutModule.TroubleshootingSettings />
      </AdvancedSettingsProvider>
    );
    render(page());
    await settle();
    expect(screen.getByTestId('desktop-devtools-toggle')).toBeTruthy();
    expect(screen.getByText('settings.advanced.reset_settings.label')).toBeTruthy();
    cleanup();

    useSettingsStore.setState({ showAdvancedSettings: false });
    render(page());
    await settle();
    expect(screen.queryByTestId('desktop-devtools-toggle')).toBeNull();
    expect(screen.queryByText('settings.advanced.reset_settings.label')).toBeNull();
  });

  it('is in the list only with advanced settings on', () => {
    render(<SettingsApp linkSegments={[]} />);
    expect(navTabs()).not.toContain('troubleshooting');
    cleanup();
    useSettingsStore.setState({ showAdvancedSettings: true });
    render(<SettingsApp linkSegments={[]} />);
    expect(navTabs()).toContain('troubleshooting');
  });
});

describe('Privacy & security', () => {
  it('has the app lock; General has not', async () => {
    render(<PrivacySettings />);
    await settle();
    expect(document.querySelector('[data-settings-section="app-lock"]')).not.toBeNull();
    cleanup();
    render(<GeneralSettings supportsCalendar />);
    await settle();
    expect(document.querySelector('[data-settings-section="app-lock"]')).toBeNull();
  });
});

describe('Desktop app page', () => {
  it('is in the list in the desktop app only', () => {
    render(<SettingsApp linkSegments={[]} />);
    expect(navTabs()).not.toContain('desktop');
    cleanup();
    installBridge();
    render(<SettingsApp linkSegments={[]} />);
    expect(navTabs()).toContain('desktop');
  });

  it('has the tray, start at sign-in, shortcut and default mail app rows that General had', async () => {
    installBridge();
    render(<DesktopAppSettings />);
    await settle();
    for (const label of ['desktopOs.close_to_tray_label', 'desktopOs.start_at_login_label', 'desktopOs.show_shortcut_label', 'desktopOs.default_app_label']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    cleanup();
    render(<GeneralSettings supportsCalendar />);
    await settle();
    expect(screen.queryByText('desktopOs.close_to_tray_label')).toBeNull();
    expect(screen.queryByText('desktopOs.default_app_label')).toBeNull();
  });
});

describe('old links', () => {
  it.each([
    [['general', 'desktop-updates'], 'about'],
    [['general', 'app-lock'], 'privacy'],
    [['general', 'desktop-app'], 'desktop'],
    [['backup', 'debug'], 'troubleshooting'],
    [['backup', 'fix'], 'troubleshooting'],
    [['debug'], 'troubleshooting'],
  ])('/settings/%s opens %s', (segments, tab) => {
    installBridge();
    render(<SettingsApp linkSegments={segments} />);
    expect(openTab()).toBe(tab);
  });

  it('a link to General itself stays on General', () => {
    installBridge();
    render(<SettingsApp linkSegments={['general']} />);
    expect(openTab()).toBe('general');
  });
});
