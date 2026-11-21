import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// An absolutely placed element in a settings page (an sr-only label, the free/busy
// group picker's) takes the nearest positioned ancestor as its box. When that box
// sits outside the page's scroller, the element isn't clipped by it and stretches
// the document to its place far down the page, so the whole app scrolls up off
// the screen. The scroller itself has to be positioned.

const media = vi.hoisted(() => ({ desktop: true }));

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
  useMessages: () => ({}),
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: String, relativeTime: String, number: String }),
}));
vi.mock('@/hooks/use-media-query', async (importOriginal) => ({
  atLeast: (await importOriginal<typeof import('@/hooks/use-media-query')>()).atLeast,
  PHONE_BELOW: (await importOriginal<typeof import('@/hooks/use-media-query')>()).PHONE_BELOW,
  useIsDesktop: () => media.desktop,
  useIsMobile: () => !media.desktop,
  useMediaQuery: () => false,
  useDeviceDetection: () => ({ isMobile: !media.desktop, isCompact: false, isDesktop: media.desktop }),
}));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail', stalwartFeaturesEnabled: false }) }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/sidebar-apps-modal', () => ({ SidebarAppsModal: () => null }));
vi.mock('@/components/plugins/app-top-banner-slot', () => ({ AppTopBannerSlot: () => null }));
vi.mock('@/components/settings/appearance-settings', () => ({ AppearanceSettings: () => <div>appearance pane</div> }));

const { SettingsApp } = await import('../settings-app');
const { useAuthStore } = await import('@/stores/auth-store');
const { usePluginStore } = await import('@/stores/plugin-store');
const { useThemeStore } = await import('@/stores/theme-store');

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
  media.desktop = true;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function scroller(): HTMLElement {
  const main = document.querySelector('main') as HTMLElement;
  expect(main.className).toContain('overflow-y-auto');
  return main;
}

describe('Settings scroller holds its absolutely placed content', () => {
  it('on the desktop page', () => {
    window.history.replaceState(null, '', '/settings/appearance');
    render(<SettingsApp linkSegments={['appearance']} />);
    expect(screen.getByText('appearance pane')).toBeTruthy();
    expect(scroller().classList).toContain('relative');
  });

  it('on a phone page', () => {
    media.desktop = false;
    window.history.replaceState(null, '', '/settings/appearance');
    render(<SettingsApp linkSegments={['appearance']} />);
    expect(screen.getByText('appearance pane')).toBeTruthy();
    expect(scroller().classList).toContain('relative');
  });

  it('on the phone tab list', () => {
    media.desktop = false;
    window.history.replaceState(null, '', '/settings');
    render(<SettingsApp linkSegments={[]} />);
    expect(screen.getByTestId('settings-tab-appearance')).toBeTruthy();
    expect(scroller().classList).toContain('relative');
  });
});
