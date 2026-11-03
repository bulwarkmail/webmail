import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Until the session is up the Pro page draws the same skeleton the server
// sent (the Pro frame), not a spinner and not a blank page, so the first
// paint and the loaded page line up.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => (key === 'common.loading' ? 'Loading…' : key),
}));

const device = vi.hoisted(() => ({ isMobile: false, isTablet: false, isDesktop: true }));
vi.mock('@/hooks/use-media-query', () => ({ useDeviceDetection: () => device, atLeast: (px: number) => `(width >= ${px}px)` }));
const routerReplace = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ replace: routerReplace }) }));

const auth = vi.hoisted(() => ({
  state: {
    isAuthenticated: false,
    client: null as unknown,
    isLoading: false,
    checkAuth: () => new Promise<void>(() => {}),
    logout: () => {},
  },
}));
vi.mock('@/stores/auth-store', () => {
  const useAuthStore = Object.assign(
    (selector: (s: typeof auth.state) => unknown) => selector(auth.state),
    { getState: () => auth.state },
  );
  return { useAuthStore, redirectToLogin: vi.fn() };
});

// The apps the panes host and the shell's dialogs are not under test.
vi.mock('@/components/mail/mail-app', () => ({ MailApp: () => <div data-testid="mail-app" /> }));
vi.mock('@/components/calendar/calendar-app', () => ({ CalendarApp: () => null }));
vi.mock('@/components/contacts/contacts-app', () => ({ ContactsApp: () => null }));
vi.mock('@/components/files/files-app', () => ({ FilesApp: () => null }));
vi.mock('@/components/settings/settings-app', () => ({ SettingsApp: () => null }));
vi.mock('@/components/pro/pro-compose-tab-body', () => ({ ProComposeTabBody: () => null }));
vi.mock('@/components/pro/pro-email-tab-body', () => ({ ProEmailTabBody: () => null }));
vi.mock('@/components/pro/pro-folder-tab-body', () => ({ ProFolderTabBody: () => null }));
vi.mock('@/components/global-search/search-tab-body', () => ({ SearchTabBody: () => null }));
vi.mock('@/components/global-search/global-search-palette', () => ({ GlobalSearchPalette: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => <nav data-testid="rail" /> }));
vi.mock('@/components/keyboard-shortcuts-modal', () => ({ KeyboardShortcutsModal: () => null }));
vi.mock('@/components/layout/sidebar-apps-modal', () => ({ SidebarAppsModal: () => null }));
vi.mock('@/components/layout/inline-app-view', () => ({ InlineAppView: () => null }));
vi.mock('@/components/org/org-announcement', () => ({ OrgAnnouncement: () => null }));
vi.mock('@/components/pro/pro-tab-bar', () => ({ ProTabBar: () => <div role="tablist" /> }));
vi.mock('@/hooks/use-sidebar-apps', () => ({
  useSidebarApps: () => ({
    showAppsModal: false,
    inlineApp: null,
    loadedApps: [],
    handleManageApps: () => {},
    handleInlineApp: () => {},
    closeInlineApp: () => {},
    closeAppsModal: () => {},
  }),
}));
vi.mock('@/hooks/use-deep-link-url', () => ({ useDeepLinkUrl: () => {} }));
const { default: ProHome } = await import('../page');
const { useSettingsStore } = await import('@/stores/settings-store');
const { useProTabStore, takeHandedOffComposeDraft } = await import('@/stores/pro-tab-store');
const { PRO_TAB_DRAG_MIME } = await import('@/components/pro/pro-shell-drop');

const replace = vi.fn();

beforeEach(() => {
  auth.state.isAuthenticated = false;
  auth.state.client = null;
  auth.state.isLoading = false;
  useSettingsStore.setState({ proInterface: true });
  Object.assign(device, { isMobile: false, isTablet: false, isDesktop: true });
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, replace, pathname: '/pro', search: '' },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Pro page gate', () => {
  it('draws the Pro skeleton while the session is restored', async () => {
    const { container } = render(<ProHome />);
    await act(async () => {});
    const region = container.querySelector('[data-boot-skeleton="pro"]');
    expect(region).not.toBeNull();
    expect(region?.querySelector('[data-pro-shell]')).not.toBeNull();
    expect(container.querySelectorAll('[data-sk-pro-pane]')).toHaveLength(2);
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.querySelector('[data-testid="mail-app"]')).toBeNull();
  });

  it('keeps the skeleton up, not a blank page, below desktop width', async () => {
    auth.state.isAuthenticated = true;
    auth.state.client = {};
    Object.assign(device, { isMobile: false, isTablet: true, isDesktop: false });
    const { container } = render(<ProHome />);
    await act(async () => {});
    expect(container.querySelector('[data-boot-skeleton="pro"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mail-app"]')).toBeNull();
  });

  it('marks the loaded shell so a skeleton inside a pane keeps its own frame', async () => {
    auth.state.isAuthenticated = true;
    auth.state.client = {};
    const { container } = render(<ProHome />);
    await act(async () => {});
    expect(container.querySelector('[data-boot-skeleton]')).toBeNull();
    const shell = container.querySelector('[data-pro-shell]');
    expect(shell).not.toBeNull();
    expect(shell?.querySelector('[data-testid="mail-app"]')).not.toBeNull();
  });

  describe('when the device flags say the window is not desktop-wide', () => {
    const setWindowWide = (matches: boolean) => {
      window.matchMedia = vi.fn(() => ({ matches, addEventListener: () => {}, removeEventListener: () => {} })) as never;
    };
    const original = window.matchMedia;
    afterEach(() => { window.matchMedia = original; });

    beforeEach(() => {
      auth.state.isAuthenticated = true;
      auth.state.client = {};
      Object.assign(device, { isMobile: false, isTablet: true, isDesktop: false });
      const compose = { id: 'c1', kind: 'compose' as const, labelKey: '', closeable: true, paneId: 'main' as const, composeData: { sessionId: 1, mode: 'compose' as const, title: 'x', initialData: { subject: 'Typed', mode: 'compose' } as never } };
      useProTabStore.setState({
        tabs: [{ id: 'home-mail', kind: 'mail', labelKey: 'mail', closeable: false, paneId: 'main' }, compose],
        activeTabId: 'c1', activeSplitTabId: null, focusedPaneId: 'main', splitOrientation: null, splitSide: 'right', readerTabId: null, loadedTabIds: ['home-mail', 'c1'],
      });
    });

    it('goes to the standard page without a reload, taking the compose tab in front along', async () => {
      setWindowWide(false);
      render(<ProHome />);
      await act(async () => {});
      expect(routerReplace).toHaveBeenCalledWith('/');
      expect(replace).not.toHaveBeenCalled();
      expect(takeHandedOffComposeDraft()?.draft.subject).toBe('Typed');
      expect(useProTabStore.getState().tabs.some((t) => t.id === 'c1')).toBe(false);
    });

    it('stays when the window is wide and only the flags are behind', async () => {
      setWindowWide(true);
      render(<ProHome />);
      await act(async () => {});
      expect(routerReplace).not.toHaveBeenCalled();
      expect(takeHandedOffComposeDraft()).toBeNull();
    });
  });

  it('moves a tab dropped on a surface that stops every drop', async () => {
    auth.state.isAuthenticated = true;
    auth.state.client = {};
    const main = { id: 'home-mail', kind: 'mail' as const, labelKey: 'mail', closeable: false, paneId: 'main' as const };
    const other = { id: 'cal', kind: 'calendar' as const, labelKey: 'calendar', closeable: true, paneId: 'main' as const };
    const split = { id: 'files', kind: 'files' as const, labelKey: 'files', closeable: true, paneId: 'split' as const };
    useProTabStore.setState({
      tabs: [main, other, split], activeTabId: main.id, activeSplitTabId: split.id, focusedPaneId: 'main',
      splitOrientation: 'vertical', splitSide: 'right', readerTabId: null, loadedTabIds: ['home-mail', 'cal', 'files'],
    });
    const { container } = render(<ProHome />);
    await act(async () => {});
    const surface = container.querySelector('[data-testid="mail-app"]')!;
    for (const type of ['dragover', 'drop']) {
      surface.addEventListener(type, (e) => { e.preventDefault(); e.stopPropagation(); });
    }
    const dataTransfer = { types: [PRO_TAB_DRAG_MIME], getData: () => 'cal', dropEffect: '' };
    // No layout in jsdom: the position resolves to the right half, the split.
    fireEvent.dragOver(surface, { dataTransfer });
    fireEvent.drop(surface, { dataTransfer });
    expect(useProTabStore.getState().tabs.find((t) => t.id === 'cal')?.paneId).toBe('split');
  });

  it('leaves a tab dropped on a tab strip to the strip', async () => {
    auth.state.isAuthenticated = true;
    auth.state.client = {};
    const main = { id: 'home-mail', kind: 'mail' as const, labelKey: 'mail', closeable: false, paneId: 'main' as const };
    const other = { id: 'cal', kind: 'calendar' as const, labelKey: 'calendar', closeable: true, paneId: 'main' as const };
    const split = { id: 'files', kind: 'files' as const, labelKey: 'files', closeable: true, paneId: 'split' as const };
    useProTabStore.setState({
      tabs: [main, other, split], activeTabId: main.id, activeSplitTabId: split.id, focusedPaneId: 'main',
      splitOrientation: 'vertical', splitSide: 'right', readerTabId: null, loadedTabIds: ['home-mail', 'cal', 'files'],
    });
    const { container } = render(<ProHome />);
    await act(async () => {});
    const strip = container.querySelector('[role="tablist"]')!;
    strip.setAttribute('data-pane-strip', 'main');
    const seen = vi.fn((e: Event) => { e.preventDefault(); });
    strip.addEventListener('drop', seen);
    const dataTransfer = { types: [PRO_TAB_DRAG_MIME], getData: () => 'cal', dropEffect: '' };
    fireEvent.drop(strip, { dataTransfer });
    expect(seen).toHaveBeenCalled();
    expect(useProTabStore.getState().tabs.find((t) => t.id === 'cal')?.paneId).toBe('main');
  });
});
