import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// On the phone the tab list is a screen of its own. A link to
// /settings/<tab> (the mail drawer's folder gear, quick-rule "edit in
// settings", the OAuth redirect) must open that page, with the list one Back
// below it.

const media = vi.hoisted(() => ({ desktop: false }));

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
  useMessages: () => ({}),
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: String, relativeTime: String, number: String }),
}));
vi.mock('@/hooks/use-media-query', async (importOriginal) => ({
  atLeast: (await importOriginal<typeof import('@/hooks/use-media-query')>()).atLeast,
  useIsDesktop: () => media.desktop,
  useIsMobile: () => true,
  useMediaQuery: () => false,
  useDeviceDetection: () => ({ isMobile: true, isTablet: false, isDesktop: false }),
}));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail', stalwartFeaturesEnabled: false }) }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/sidebar-apps-modal', () => ({ SidebarAppsModal: () => null }));
vi.mock('@/components/plugins/app-top-banner-slot', () => ({ AppTopBannerSlot: () => null }));
vi.mock('@/components/settings/appearance-settings', () => ({ AppearanceSettings: () => <div>appearance pane</div> }));
vi.mock('@/components/settings/accessibility-settings', () => ({ AccessibilitySettings: () => <div>accessibility pane</div> }));
vi.mock('@/components/settings/organize-settings', () => ({ OrganizeSettings: () => <div>organize pane</div> }));

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
  media.desktop = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Settings deep links on the phone', () => {
  it('opens the page a /settings/<tab> link names, with the list below it in history', () => {
    window.history.replaceState(null, '', '/settings/organize/folders');
    const push = vi.spyOn(window.history, 'pushState');

    render(<SettingsApp linkSegments={['organize', 'folders']} />);

    expect(screen.getByText('organize pane')).toBeTruthy();
    expect(screen.queryByTestId('settings-tab-appearance')).toBeNull();
    // The entry below is the list; the page sits on top under its own URL.
    expect(push).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe('/settings/organize');

    act(() => {
      window.history.replaceState(null, '', '/settings');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.getByTestId('settings-tab-appearance')).toBeTruthy();
  });

  it('opens the page a settings-tab-change event names', () => {
    window.history.replaceState(null, '', '/settings');
    render(<SettingsApp linkSegments={[]} />);
    expect(screen.getByTestId('settings-tab-organize')).toBeTruthy();

    act(() => {
      window.dispatchEvent(new CustomEvent('settings-tab-change', { detail: 'organize' }));
    });

    expect(screen.getByText('organize pane')).toBeTruthy();
  });

  it('still opens on the list without a link', () => {
    window.history.replaceState(null, '', '/settings');
    render(<SettingsApp linkSegments={[]} />);
    expect(screen.getByTestId('settings-tab-appearance')).toBeTruthy();
    expect(screen.queryByText('appearance pane')).toBeNull();
  });

  it('keeps the open page when a desktop window narrows to the phone layout', () => {
    window.history.replaceState(null, '', '/settings');
    media.desktop = true;
    const { rerender } = render(<SettingsApp linkSegments={[]} />);
    expect(screen.getByText('appearance pane')).toBeTruthy();

    media.desktop = false;
    rerender(<SettingsApp linkSegments={[]} />);

    expect(screen.getByText('appearance pane')).toBeTruthy();
  });

  it('opens a page at its top and keeps the place in the list', () => {
    window.history.replaceState(null, '', '/settings');
    render(<SettingsApp linkSegments={[]} />);
    const list = document.querySelector('main') as HTMLElement;
    list.scrollTop = 400;
    fireEvent.scroll(list);

    fireEvent.click(screen.getByTestId('settings-tab-organize'));
    expect(screen.getByText('organize pane')).toBeTruthy();
    const page = document.querySelector('main') as HTMLElement;
    expect(page.scrollTop).toBe(0);

    page.scrollTop = 900;
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.getByTestId('settings-tab-organize')).toBeTruthy();
    expect((document.querySelector('main') as HTMLElement).scrollTop).toBe(400);
  });
});
