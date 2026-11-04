import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Until the session is up, Settings draws its page skeleton (the one the
// server drew before any script ran) instead of nothing, and the nav waits
// for the client so it renders once with the account's pages.

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
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail', stalwartFeaturesEnabled: true }) }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/sidebar-apps-modal', () => ({ SidebarAppsModal: () => null }));
vi.mock('@/components/plugins/app-top-banner-slot', () => ({ AppTopBannerSlot: () => null }));
vi.mock('@/components/settings/appearance-settings', () => ({
  AppearanceSettings: () => <div data-settings-section="theme">appearance pane</div>,
}));

const { SettingsApp } = await import('../settings-app');
const { useAuthStore } = await import('@/stores/auth-store');
const { usePluginStore } = await import('@/stores/plugin-store');
const { useThemeStore } = await import('@/stores/theme-store');
const { useSettingsStore } = await import('@/stores/settings-store');
const { SETTINGS_NAV_GROUPS } = await import('../settings-tab-icons');
const { BOOT_HINTS_KEY } = await import('@/lib/boot-skeleton/keys');
const { resetRailHintsMemo } = await import('@/lib/boot-skeleton/hints');
const { useFilesSyncStore } = await import('@/stores/files-sync-store');

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
/** A client with none of the optional capabilities. */
const bareClient = new Proxy({}, {
  get: (_t, prop) => (prop === 'then' ? undefined : prop === 'getAccountId' ? () => 'acc' : () => null),
});

const skeleton = () => document.querySelector('[data-boot-skeleton="settings"]');

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  localStorage.clear();
  resetRailHintsMemo();
  localStorage.setItem('settings-active-tab', 'appearance');
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) } as never);
  // The restore stays pending: the page is still waiting for the session.
  useAuthStore.setState({ checkAuth: vi.fn(() => new Promise<void>(() => {})) } as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Settings while the session restores', () => {
  it('draws the settings skeleton when signed out', () => {
    useAuthStore.setState({ isAuthenticated: false, isLoading: true, client: null });
    render(<SettingsApp linkSegments={[]} />);
    expect(skeleton()).not.toBeNull();
    expect(skeleton()!.getAttribute('aria-busy')).toBe('true');
    expect(skeleton()!.querySelector('[role="status"]')!.textContent).toBe('common.loading');
  });

  it('keeps the skeleton and no nav while the persisted sign-in waits for its client', () => {
    useAuthStore.setState({ isAuthenticated: true, isLoading: true, client: null });
    render(<SettingsApp linkSegments={[]} />);
    expect(skeleton()).not.toBeNull();
    expect(screen.queryByTestId('settings-tab-appearance')).toBeNull();
    expect(screen.queryByText('appearance pane')).toBeNull();
  });

  it('renders the nav once the client is up, in the order the skeleton draws it', () => {
    useAuthStore.setState({ isAuthenticated: true, isLoading: false, client: fullClient as never });
    render(<SettingsApp linkSegments={[]} />);
    expect(skeleton()).toBeNull();
    const shown = [...document.querySelectorAll('[data-testid^="settings-tab-"]')]
      .map((el) => el.getAttribute('data-testid')!.slice('settings-tab-'.length));
    // Recovery waits for a server probe this test doesn't answer; Files on
    // this computer for the desktop app's sync engine.
    const drawn = SETTINGS_NAV_GROUPS.flatMap((g) => g.tabs).filter((tab) => tab !== 'recovery' && tab !== 'files_sync');
    expect(shown).toEqual(drawn);
  });

  it('lists Files on this computer after Files only while the desktop sync engine runs', () => {
    useAuthStore.setState({ isAuthenticated: true, isLoading: false, client: fullClient as never });
    useFilesSyncStore.setState({ available: true });
    try {
      render(<SettingsApp linkSegments={[]} />);
      const shown = [...document.querySelectorAll('[data-testid^="settings-tab-"]')]
        .map((el) => el.getAttribute('data-testid')!.slice('settings-tab-'.length));
      expect(shown.slice(shown.indexOf('files'), shown.indexOf('files') + 2)).toEqual(['files', 'files_sync']);
    } finally {
      useFilesSyncStore.getState().reset();
    }
  });

  it('leaves the next load the pages this account has', () => {
    useAuthStore.setState({ isAuthenticated: true, isLoading: false, client: bareClient as never });
    render(<SettingsApp linkSegments={[]} />);
    const hints = JSON.parse(localStorage.getItem(BOOT_HINTS_KEY) ?? 'null');
    expect(hints?.settings).toContain('appearance');
    expect(hints?.settings).not.toContain('filters');
    expect(hints?.settings).not.toContain('vacation');
  });
});

describe('a link to a section while the session restores', () => {
  it('scrolls once the page is drawn, without switching Advanced on meanwhile', async () => {
    vi.useFakeTimers();
    try {
      const scroll = vi.fn();
      Element.prototype.scrollIntoView = scroll;
      useSettingsStore.setState({ showAdvancedSettings: false });
      useAuthStore.setState({ isAuthenticated: true, isLoading: true, client: null });
      render(<SettingsApp linkSegments={['appearance', 'theme']} />);
      await act(async () => { vi.advanceTimersByTime(3000); });
      // The skeleton has no sections; nothing to find is not a hidden section.
      expect(useSettingsStore.getState().showAdvancedSettings).toBe(false);
      expect(scroll).not.toHaveBeenCalled();

      act(() => { useAuthStore.setState({ isLoading: false, client: fullClient as never }); });
      await act(async () => { vi.advanceTimersByTime(200); });
      expect(scroll).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
