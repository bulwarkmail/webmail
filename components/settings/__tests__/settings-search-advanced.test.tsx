import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/locales/en/common.json';

// SET-5: a search result whose row the page didn't show turned the synced
// Advanced switch on. Only a row known to be advanced may do that now.

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
vi.mock('@/components/settings/appearance-settings', () => ({ AppearanceSettings: () => null }));
vi.mock('@/components/settings/accessibility-settings', () => ({ AccessibilitySettings: () => null }));
// The page is not drawn here, so no result finds its row.
vi.mock('@/components/settings/message-list-settings', () => ({ MessageListSettings: () => null }));

const { SettingsApp } = await import('../settings-app');
const { useAuthStore } = await import('@/stores/auth-store');
const { usePluginStore } = await import('@/stores/plugin-store');
const { useThemeStore } = await import('@/stores/theme-store');
const { useSettingsStore } = await import('@/stores/settings-store');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  const client = new Proxy({}, {
    get: (_t, prop) => (prop === 'then' ? undefined : (prop === 'getAccountId' ? () => 'acc' : () => null)),
  });
  useAuthStore.setState({ isAuthenticated: true, isLoading: false, client: client as never });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) } as never);
  useSettingsStore.setState({ showAdvancedSettings: false });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openResult(query: string, label: string) {
  render(<SettingsApp linkSegments={[]} />);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: query } });
  fireEvent.click(screen.getByRole('button', { name: label }));
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
}

describe('settings search and the Advanced switch', () => {
  it('leaves Advanced off for a row that is not an advanced one', async () => {
    // settings-p2-18: the row is named like its section now, "Sender pictures".
    await openResult('company websites', 'Pictures from company websites');
    expect(useSettingsStore.getState().showAdvancedSettings).toBe(false);
  });

  // settings-p3-7: an advanced row is found with the switch off, marked as such, and
  // opening it asks its page to show that row alone; the switch stays off. (It used to
  // turn the switch on for every page; settings-search-anchors checks the row shows.)
  it('marks an advanced result and opens it without turning Advanced on', async () => {
    const asked: unknown[] = [];
    const listen = (event: Event) => asked.push((event as CustomEvent).detail);
    window.addEventListener('settings-reveal', listen);
    try {
      render(<SettingsApp linkSegments={[]} />);
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'emails per page' } });
      const result = screen.getByRole('button', { name: /^Emails per page/ });
      expect(within(result).getByTestId('settings-result-advanced')).toBeInTheDocument();
      fireEvent.click(result);
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    } finally {
      window.removeEventListener('settings-reveal', listen);
    }
    expect(asked).toContainEqual({ label: 'Emails per page', advanced: true });
    expect(useSettingsStore.getState().showAdvancedSettings).toBe(false);
  });
});
