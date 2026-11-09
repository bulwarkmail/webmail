import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Section deep links: `/settings/<tab>/<section>` and the ids of retired tabs
// land on the page and section that hold the setting now. The jump row at the
// top of a page lists its sections.

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
  useMessages: () => ({}),
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
vi.mock('@/components/settings/about-data-settings', () => ({
  AboutDataSettings: () => null,
  AboutFooter: () => <div data-testid="about-footer" />,
  AboutSettings: () => <div data-testid="about-footer" />,
}));
vi.mock('@/components/offline/offline-settings', () => ({
  OfflineSettings: () => (
    <div>
      <div data-settings-section="offline"><h3>Offline</h3></div>
      <div data-settings-section="outbox"><h3>Outbox</h3></div>
    </div>
  ),
}));
vi.mock('@/components/settings/privacy-settings', () => ({
  PrivacyLinkRow: () => null,
  PrivacySettings: () => (
    <div>
      <div data-settings-section="images"><h3>Images</h3></div>
      <div data-settings-section="receipts"><h3>Read receipts</h3></div>
    </div>
  ),
}));
vi.mock('@/components/settings/appearance-settings',() => ({ AppearanceSettings: () => <div>appearance pane</div> }));
vi.mock('@/components/settings/accessibility-settings', () => ({ AccessibilitySettings: () => <div>accessibility pane</div> }));
vi.mock('@/components/settings/organize-settings', () => ({
  OrganizeSettings: () => (
    <div>
      <div data-settings-section="folders"><h3>Folders</h3></div>
      <div data-settings-section="tags"><h3>Tags</h3></div>
    </div>
  ),
}));
vi.mock('@/components/settings/account-settings', () => ({
  AccountSettings: () => (
    <div>
      <div data-settings-section="profile"><h3>Profile</h3></div>
      <div data-settings-section="addresses"><h3>Email addresses</h3></div>
    </div>
  ),
}));

const { SettingsApp } = await import('../settings-app');
const { useAuthStore } = await import('@/stores/auth-store');
const { usePluginStore } = await import('@/stores/plugin-store');
const { useThemeStore } = await import('@/stores/theme-store');
const { useSettingsStore } = await import('@/stores/settings-store');
const { SettingsSection } = await import('../settings-section');

const scrolled: string[] = [];

beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push((this as HTMLElement).dataset.settingsSection ?? this.tagName);
  };
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
  try { localStorage.setItem('settings-active-tab', 'appearance'); } catch { /* ignore */ }
  const client = new Proxy({}, {
    get: (_t, prop) => (prop === 'then' ? undefined : (prop === 'getAccountId' ? () => 'acc' : () => null)),
  });
  useAuthStore.setState({ isAuthenticated: true, isLoading: false, client: client as never });
  usePluginStore.setState({ initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) } as never);
  act(() => { useSettingsStore.setState({ showAdvancedSettings: false }); });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('settings section links', () => {
  it('lands an old /settings/keywords link on the tags section of Folders & tags', async () => {
    render(<SettingsApp linkSegments={['keywords']} />);
    expect(screen.getByTestId('settings-tab-organize')).toHaveAttribute('aria-current', 'page');
    await waitFor(() => expect(scrolled).toContain('tags'));
  });

  it('lands /settings/organize/folders on that section', async () => {
    render(<SettingsApp linkSegments={['organize', 'folders']} />);
    await waitFor(() => expect(scrolled).toContain('folders'));
    expect(scrolled).not.toContain('tags');
  });

  it('lists the sections of the open page in the jump row', async () => {
    render(<SettingsApp linkSegments={['organize']} />);
    const nav = screen.getByTestId('settings-section-nav');
    await waitFor(() => expect(nav).not.toHaveAttribute('hidden'));
    fireEvent.click(screen.getByRole('button', { name: 'Tags' }));
    expect(scrolled).toContain('tags');
  });

  it('flashes the section a jump-row button scrolls to', async () => {
    const { container } = render(<SettingsApp linkSegments={['organize']} />);
    const nav = screen.getByTestId('settings-section-nav');
    await waitFor(() => expect(nav).not.toHaveAttribute('hidden'));
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Tags' }));
      const tags = container.querySelector('[data-settings-section="tags"]')!;
      const folders = container.querySelector('[data-settings-section="folders"]')!;
      expect(tags).toHaveClass('settings-search-highlight');
      expect(folders).not.toHaveClass('settings-search-highlight');
      act(() => { vi.advanceTimersByTime(1800); });
      expect(tags).not.toHaveClass('settings-search-highlight');
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows a tab-change event that names a retired tab to its new section', async () => {
    render(<SettingsApp linkSegments={[]} />);
    act(() => { window.dispatchEvent(new CustomEvent('settings-tab-change', { detail: 'identities' })); });
    expect(screen.getByTestId('settings-tab-account')).toHaveAttribute('aria-current', 'page');
    await waitFor(() => expect(scrolled).toContain('addresses'));
  });

  // settings-p3-7: it used to turn the Advanced switch on for every page; now the
  // page shows that section alone, once, and the switch stays off.
  it('shows a section a link names by itself, with the Advanced switch left off', async () => {
    function AdvancedPage() {
      return (
        <SettingsSection id="downloads" title="Downloads" advanced>
          <span>rows</span>
        </SettingsSection>
      );
    }
    vi.doMock('@/components/settings/reading-settings', () => ({ ReadingSettings: AdvancedPage }));
    const { SettingsApp: App } = await import('../settings-app');
    render(<App linkSegments={['downloads']} />);
    expect(screen.getByTestId('settings-tab-reading')).toHaveAttribute('aria-current', 'page');
    await waitFor(() => expect(scrolled).toContain('downloads'), { timeout: 3000 });
    expect(document.querySelector('[data-settings-section="downloads"]')).not.toBeNull();
    expect(useSettingsStore.getState().showAdvancedSettings).toBe(false);
  });

  // settings-32 (2026-11-04): the version card in the sidebar's footer took
  // room from the page list on short screens; it's a page at the end now.
  it('shows the version on an About page, not in the sidebar footer', () => {
    render(<SettingsApp />);
    fireEvent.click(screen.getByTestId('settings-advanced-switch'));
    expect(screen.queryByTestId('about-footer')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-tab-about'));
    expect(screen.getByTestId('settings-tab-about')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('about-footer')).toBeInTheDocument();
  });

  // settings-7 and settings-24 (2026-11-04): Offline is a page of its own and
  // remote images, read receipts and sender pictures moved to Privacy. Old
  // links, from notices and bookmarks, land there.
  it('lands an old /settings/backup/offline link on the Offline page', async () => {
    render(<SettingsApp linkSegments={['backup', 'offline']} />);
    expect(screen.getByTestId('settings-tab-offline')).toHaveAttribute('aria-current', 'page');
    await waitFor(() => expect(scrolled).toContain('offline'));
  });

  it('lands old links to remote images and read receipts on Privacy', async () => {
    const first = render(<SettingsApp linkSegments={['reading', 'images']} />);
    expect(screen.getByTestId('settings-tab-privacy')).toHaveAttribute('aria-current', 'page');
    await waitFor(() => expect(scrolled).toContain('images'));
    first.unmount();
    render(<SettingsApp linkSegments={['content_senders']} />);
    expect(screen.getByTestId('settings-tab-privacy')).toHaveAttribute('aria-current', 'page');
    act(() => { window.dispatchEvent(new CustomEvent('settings-tab-change', { detail: { tab: 'composing', section: 'receipts' } })); });
    expect(screen.getByTestId('settings-tab-privacy')).toHaveAttribute('aria-current', 'page');
    await waitFor(() => expect(scrolled).toContain('receipts'));
  });

  it('lists Offline and Privacy among the first pages, and About last', () => {
    render(<SettingsApp />);
    const ids = Array.from(document.querySelectorAll('[data-testid^="settings-tab-"]')).map((el) => el.getAttribute('data-testid'));
    expect(ids).toContain('settings-tab-offline');
    expect(ids.indexOf('settings-tab-privacy')).toBeLessThan(ids.indexOf('settings-tab-message_list'));
    expect(ids.indexOf('settings-tab-offline')).toBeLessThan(ids.indexOf('settings-tab-message_list'));
    expect(ids[ids.length - 1]).toBe('settings-tab-about');
  });
});
