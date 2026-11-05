import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/locales/en/common.json';

// desktop-p3-16: Edit > Search (Ctrl+E) in Settings searched mail, while Settings has a
// search box of its own. Calendar, Contacts and Files already search themselves.

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => `${ns ? `${ns}.` : ''}${key}`,
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
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail', stalwartFeaturesEnabled: true }) }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/sidebar-apps-modal', () => ({ SidebarAppsModal: () => null }));
vi.mock('@/components/plugins/app-top-banner-slot', () => ({ AppTopBannerSlot: () => null }));
vi.mock('@/components/settings/appearance-settings', () => ({ AppearanceSettings: () => null }));
vi.mock('@/components/settings/accessibility-settings', () => ({ AccessibilitySettings: () => null }));

const { SettingsApp } = await import('../settings-app');
const { useAuthStore } = await import('@/stores/auth-store');
const { usePluginStore } = await import('@/stores/plugin-store');
const { useThemeStore } = await import('@/stores/theme-store');
const { runDesktopCommand, resetDesktopCommands } = await import('@/lib/desktop/commands');

let reported: Record<string, unknown> = {};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  const client = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'then') return undefined;
      if (prop === 'getAccountId') return () => 'acc';
      if (typeof prop === 'string' && prop.startsWith('supports')) return () => true;
      return () => null;
    },
  });
  reported = {};
  (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = {
    version: 1,
    platform: 'win32',
    menu: { setState: (state: Record<string, unknown>) => { reported = state; }, onCommand: () => () => {} },
    windows: { setMenuName: () => {} },
  };
  useAuthStore.setState({ isAuthenticated: true, isLoading: false, client: client as never });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) } as never);
  try { localStorage.setItem('settings-active-tab', 'appearance'); } catch { /* ignore */ }
});
afterEach(() => {
  resetDesktopCommands();
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Edit > Search in Settings', () => {
  it('goes to the settings search box, not to the mail search', async () => {
    render(<SettingsApp linkSegments={[]} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(reported['edit.search']).toBe(true);
    let ran = false;
    act(() => { ran = runDesktopCommand('edit.search'); });
    expect(ran).toBe(true);
    const active = document.activeElement as HTMLInputElement | null;
    expect(active?.tagName).toBe('INPUT');
    expect(active?.placeholder).toBe('settings.search_placeholder');
  });
});
