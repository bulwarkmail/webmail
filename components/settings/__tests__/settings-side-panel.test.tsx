import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '@/lib/plugin-types';
import { framePropsOf } from '@/components/plugins/__tests__/fake-slot-offer';

// The plugin side panel (app-side-panel) in Settings: on desktop an h-14 row
// over the page and the panel with the page's name and the button at its
// end; below 1024 px Settings is phone-shaped and the panel is a dialog.

const createSlotInstance = vi.fn((..._args: unknown[]) => ({ destroy: vi.fn(), updateProps: vi.fn(), setTheme: vi.fn() }));
vi.mock('@/components/plugins/plugin-iframe-slot', () => import('@/components/plugins/__tests__/fake-slot-offer'));
vi.mock('@/lib/plugin-sandbox/host-bridge', () => ({
  createSlotInstance: (...args: unknown[]) => createSlotInstance(...args),
}));
vi.mock('@/lib/plugin-sandbox/host-theme', () => ({ snapshotHostTheme: () => ({}) }));
vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
  useMessages: () => ({}),
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: String, relativeTime: String, number: String }),
}));
const media = vi.hoisted(() => ({ desktop: true }));
vi.mock('@/hooks/use-media-query', () => ({
  useIsDesktop: () => media.desktop,
  useIsMobile: () => false,
  useMediaQuery: () => false,
  useDeviceDetection: () => ({ isMobile: false, isTablet: !media.desktop, isDesktop: media.desktop }),
}));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail', stalwartFeaturesEnabled: false }) }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => null }));
vi.mock('@/components/layout/sidebar-apps-modal', () => ({ SidebarAppsModal: () => null }));
vi.mock('@/components/plugins/app-top-banner-slot', () => ({ AppTopBannerSlot: () => null }));
vi.mock('@/components/settings/appearance-settings', () => ({ AppearanceSettings: () => <div>appearance pane</div> }));
vi.mock('@/components/settings/accessibility-settings', () => ({ AccessibilitySettings: () => <div>accessibility pane</div> }));

const { SettingsApp } = await import('../settings-app');
const registry = await import('@/lib/plugin-sandbox/registry');
const { useAuthStore } = await import('@/stores/auth-store');
const { usePluginStore } = await import('@/stores/plugin-store');
const { useThemeStore } = await import('@/stores/theme-store');

function activate(id: string, name: string, slots: string[]) {
  const plugin: InstalledPlugin = {
    id, name, version: '1.0.0', author: '', description: '', type: 'ui-extension',
    permissions: ['ui:settings-section', 'ui:side-panel'], grantedPermissions: ['ui:settings-section', 'ui:side-panel'], entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
  registry.register({
    plugin, code: '', tier: 'untrusted',
    background: { evaluateShouldShow: vi.fn(async () => true) } as never,
    slotOffers: slots.map((slot) => ({ name: slot as never, order: 100, hasShouldShow: false })),
    hookDisposables: [],
  });
}

beforeEach(() => {
  media.desktop = true;
  createSlotInstance.mockClear();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  try { localStorage.setItem('settings-active-tab', 'appearance'); } catch { /* ignore */ }
  // Every capability check answers "no"; ids are plain strings.
  const client = new Proxy({}, {
    get: (_t, prop) => (prop === 'then' ? undefined : (prop === 'getAccountId' ? () => 'acc' : () => null)),
  });
  useAuthStore.setState({ isAuthenticated: true, isLoading: false, client: client as never });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) } as never);
});
afterEach(() => {
  for (const p of registry.all()) registry.deregister(p.plugin.id);
  vi.unstubAllGlobals();
});

const { setActionDispatcher } = await import('@/lib/plugin-sandbox/actions');

describe('Settings side panel', () => {
  it('adds no row without a plugin', () => {
    render(<SettingsApp linkSegments={[]} />);
    expect(document.querySelector('[data-settings-panel-row]')).toBeNull();
  });

  it('puts the page name and the button in an h-14 row over the page and the panel', () => {
    activate('assistant', 'Assistant', ['app-side-panel']);
    render(<SettingsApp linkSegments={[]} />);
    const row = document.querySelector<HTMLElement>('[data-settings-panel-row]')!;
    expect(row.className).toContain('h-14');
    const toggle = row.querySelector<HTMLElement>('[data-plugin-panel-toggle]')!;
    expect(row.lastElementChild).toBe(toggle);
    const frame = screen.getByTestId('plugin-frame-app-side-panel');
    const page = (framePropsOf(frame).context as { page: { id: string; label: string } }).page;
    expect(page.id).toBe('appearance');
    expect(row.firstElementChild!.textContent).toBe(page.label);
    expect(page.label).not.toBe('');
    // The page itself (main) and then the panel, in the row under it.
    const panel = document.querySelector<HTMLElement>('[data-app-side-panel]')!;
    expect(panel.parentElement!.lastElementChild).toBe(panel);
    expect(panel.parentElement!.querySelector('main, [role=main]')).not.toBeNull();

    fireEvent.click(screen.getByTestId('settings-tab-accessibility'));
    expect((framePropsOf(screen.getByTestId('plugin-frame-app-side-panel')).context as { page: { id: string } }).page.id).toBe('accessibility');
  });

  it('asks for the dialog below 1024 px, from the phone header', () => {
    media.desktop = false;
    const dispatch = vi.fn().mockResolvedValue(undefined);
    setActionDispatcher(dispatch);
    activate('assistant', 'Assistant', ['app-side-panel']);
    render(<SettingsApp linkSegments={[]} />);
    expect(document.querySelector('[data-settings-panel-row]')).toBeNull();
    expect(document.querySelector('[data-app-side-panel]')).toBeNull();
    const buttons = document.querySelectorAll<HTMLElement>('[data-app-side-panel-phone]');
    expect(buttons.length).toBeGreaterThan(0);
    fireEvent.click(buttons[0]);
    expect(dispatch).toHaveBeenCalledWith('assistant', 'app-side-panel', 'open', expect.objectContaining({ view: 'settings' }));
    setActionDispatcher(null);
  });

  it('keeps the page (and what was typed on it) when the panel starts docking', () => {
    render(<SettingsApp linkSegments={[]} />);
    const pane = screen.getByText('appearance pane');
    act(() => activate('assistant', 'Assistant', ['app-side-panel']));
    expect(document.querySelector('[data-settings-panel-row]')).not.toBeNull();
    expect(pane.isConnected).toBe(true);
  });
});
