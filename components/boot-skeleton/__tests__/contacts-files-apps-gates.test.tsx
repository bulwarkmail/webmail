import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Contacts, Files and plugin pages until the session is restored: each draws
// the page skeleton the server drew (not a blank page or a spinner), and the
// first screens after it keep that shape.

const nav = vi.hoisted(() => ({ suspend: false }));
const never = new Promise<never>(() => {});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ locale: 'en' }),
  usePathname: () => '/en/contacts',
  useSearchParams: () => {
    // The static Lite export prerenders without search params: the hook
    // suspends there and the Suspense fallback is what lands in the HTML.
    if (nav.suspend) throw never;
    return new URLSearchParams();
  },
}));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/contacts/contact-activity', () => ({ ContactActivity: () => null }));
vi.mock('@/components/layout/navigation-rail', () => ({ NavigationRail: () => <nav data-testid="rail" /> }));
vi.mock('@/components/layout/sidebar-apps-modal', () => ({ SidebarAppsModal: () => null }));
vi.mock('@/components/layout/inline-app-view', () => ({ InlineAppView: () => null }));
vi.mock('@/components/layout/mv-top-bar', () => ({ MvTopBar: () => null }));
vi.mock('@/components/plugins/app-top-banner-slot', () => ({ AppTopBannerSlot: () => null }));
vi.mock('@/hooks/use-sidebar-apps', () => ({
  useSidebarApps: () => ({
    showAppsModal: false, inlineApp: null, loadedApps: [], handleManageApps: vi.fn(),
    handleInlineApp: vi.fn(), closeInlineApp: vi.fn(), closeAppsModal: vi.fn(),
  }),
}));

const { ContactsApp } = await import('@/components/contacts/contacts-app');
const { FilesApp } = await import('@/components/files/files-app');
const { PluginPageApp } = await import('@/components/plugins/plugin-page-app');
const { useAuthStore } = await import('@/stores/auth-store');
const { useContactStore } = await import('@/stores/contact-store');
const { usePluginStore } = await import('@/stores/plugin-store');

/** Signed out as far as the page knows, with checkAuth still running. */
function restoring() {
  act(() => {
    useAuthStore.setState({ isAuthenticated: false, client: null, isLoading: true, checkAuth: () => never });
  });
}

const skeleton = (container: HTMLElement, surface: string) => container.querySelector(`[data-boot-skeleton="${surface}"]`);

beforeEach(() => {
  localStorage.clear();
  nav.suspend = false;
});
afterEach(() => {
  act(() => {
    useAuthStore.setState({ isAuthenticated: false, client: null, isLoading: false });
    useContactStore.setState({ contacts: [], supportsSync: false, contactsLoaded: false });
  });
});

describe('gates draw the page skeleton while the session is restored', () => {
  it('contacts', () => {
    restoring();
    const { container } = render(<ContactsApp />);
    expect(skeleton(container, 'contacts')).not.toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('files', () => {
    restoring();
    const { container } = render(<FilesApp />);
    expect(skeleton(container, 'files')).not.toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('plugin pages', () => {
    restoring();
    const { container } = render(<PluginPageApp linkSegments={['kanban', 'board']} />);
    expect(skeleton(container, 'apps')).not.toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
  });
});

describe('contacts', () => {
  it('puts the skeleton, not nothing, into a prerendered page whose search params suspend', () => {
    nav.suspend = true;
    restoring();
    const { container } = render(<ContactsApp />);
    expect(skeleton(container, 'contacts')).not.toBeNull();
  });

  it('shows the rows loading, not an empty address book, before the session is back', () => {
    // A remembered session: signed in from storage, no client yet, and on a
    // first visit nothing stored about the server's contacts support.
    act(() => {
      useAuthStore.setState({ isAuthenticated: true, client: null, isLoading: true, checkAuth: () => never });
      useContactStore.setState({ contacts: [], supportsSync: false, contactsLoaded: false });
    });
    render(<ContactsApp />);
    expect(screen.getByTestId('contact-list-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('empty_state_title')).toBeNull();
  });

  it('still says the book is empty once a server without contacts is known', () => {
    const client = { supportsPrincipals: () => false } as unknown as IJMAPClient;
    act(() => {
      useAuthStore.setState({ isAuthenticated: true, client, isLoading: false });
      useContactStore.setState({ contacts: [], supportsSync: false, contactsLoaded: false });
    });
    render(<ContactsApp />);
    expect(screen.queryByTestId('contact-list-skeleton')).toBeNull();
    expect(screen.getByText('empty_state_title')).toBeInTheDocument();
  });
});

describe('plugin pages', () => {
  it('keeps the empty content area, not a spinner, while the plugins start', () => {
    act(() => {
      useAuthStore.setState({ isAuthenticated: true, client: {} as never, isLoading: false });
      usePluginStore.setState({ initialized: false, initializePlugins: vi.fn().mockResolvedValue(undefined) });
    });
    const { container } = render(<PluginPageApp linkSegments={['kanban', 'board']} />);
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('loading');
    expect(screen.queryByText('not_available_title')).toBeNull();
  });
});
