import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/locales/en/common.json';

// settings-p3-18: "/" (the mail search's key) and Ctrl+F did nothing on a settings
// page, or opened the browser's find bar. They go to "Search settings" now, and so
// does the desktop app's Edit > Search (edit.search), which used to leave for mail.

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
  useMessages: () => en,
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: String, relativeTime: String, number: String }),
}));
vi.mock('@/hooks/use-media-query', () => ({
  useIsDesktop: () => true,
  useIsMobile: () => false,
  useMediaQuery: () => false,
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
}));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail', stalwartFeaturesEnabled: false }) }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/sidebar-apps-modal', () => ({ SidebarAppsModal: () => null }));
vi.mock('@/components/plugins/app-top-banner-slot', () => ({ AppTopBannerSlot: () => null }));
vi.mock('@/components/settings/appearance-settings', () => ({
  AppearanceSettings: () => <input data-testid="page-field" aria-label="page field" />,
}));

const { SettingsApp } = await import('../settings-app');
const { useAuthStore } = await import('@/stores/auth-store');
const { usePluginStore } = await import('@/stores/plugin-store');
const { useThemeStore } = await import('@/stores/theme-store');
const { runDesktopCommand, resetDesktopCommands } = await import('@/lib/desktop/commands');

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  try { localStorage.setItem('settings-active-tab', 'appearance'); } catch { /* ignore */ }
  const client = new Proxy({}, {
    get: (_t, prop) => (prop === 'then' ? undefined : (prop === 'getAccountId' ? () => 'acc' : () => null)),
  });
  useAuthStore.setState({ isAuthenticated: true, isLoading: false, client: client as never });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) } as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.bulwarkDesktop = undefined;
  resetDesktopCommands();
});

const searchField = () => screen.getByRole('searchbox');

describe('keys for the settings search', () => {
  it('"/" goes to Search settings, but not while typing in a field', () => {
    render(<SettingsApp linkSegments={[]} />);
    const pageField = screen.getByTestId('page-field');
    pageField.focus();
    const typed = fireEvent.keyDown(pageField, { key: '/' });
    expect(typed).toBe(true);
    expect(document.activeElement).toBe(pageField);
    pageField.blur();
    const taken = fireEvent.keyDown(document.body, { key: '/' });
    expect(taken).toBe(false);
    expect(document.activeElement).toBe(searchField());
  });

  it('Ctrl+F goes to Search settings, from a field too, and a second one is the browser\'s', () => {
    render(<SettingsApp linkSegments={[]} />);
    screen.getByTestId('page-field').focus();
    expect(fireEvent.keyDown(screen.getByTestId('page-field'), { key: 'f', ctrlKey: true })).toBe(false);
    expect(document.activeElement).toBe(searchField());
    // Already there: the browser's find bar may have it.
    expect(fireEvent.keyDown(searchField(), { key: 'f', ctrlKey: true })).toBe(true);
  });

  it('in the desktop app, Edit > Search and its Ctrl+F search the settings, not the mail', () => {
    window.bulwarkDesktop = { version: 1, platform: 'win32', menu: { setState: vi.fn(), onCommand: () => () => {} } } as never;
    render(<SettingsApp linkSegments={[]} />);
    act(() => { expect(runDesktopCommand('edit.search')).toBe(true); });
    expect(document.activeElement).toBe(searchField());
  });
});
