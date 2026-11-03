import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every plugin page gets an entry in the navigation, after the built-in apps:
// the rail (desktop), the bottom bar (phones) and Mountain View's app grid.

vi.mock('../account-switcher', () => ({ AccountSwitcher: () => null }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/keyboard-shortcuts-modal', () => ({ KeyboardShortcutsModal: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));
vi.mock('@/hooks/use-stalwart-admin', () => ({ useStalwartAdmin: () => false }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/apps/kanban/board',
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a>,
}));

const { NavigationRail } = await import('../navigation-rail');
const { MvTopBar } = await import('../mv-top-bar');
const pages = await import('@/lib/plugin-sandbox/pages');
const { useUpdateStore } = await import('@/stores/update-store');

beforeEach(() => {
  useUpdateStore.setState({ startPolling: vi.fn() } as never);
});
afterEach(() => pages.resetPages());

const register = () => act(() => pages.setPluginPages('kanban', 'Kanban', [
  { id: 'board', title: 'Board', icon: 'LayoutGrid' },
  { id: 'stats', title: 'Stats' },
]));

describe.each(['vertical', 'horizontal'] as const)('navigation rail (%s)', (orientation) => {
  it('lists no plugin pages when none are registered', () => {
    const { container } = render(<NavigationRail orientation={orientation} />);
    expect(container.querySelector('[data-plugin-page-link]')).toBeNull();
  });

  it('links each page after the built-in apps and marks the open one', () => {
    register();
    const { container } = render(<NavigationRail orientation={orientation} />);

    const links = [...container.querySelectorAll('[data-plugin-page-link]')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/apps/kanban/board', '/apps/kanban/stats']);
    const mail = container.querySelector('a[href="/"]')!;
    expect(mail.compareDocumentPosition(links[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(links[0]).toHaveAttribute('aria-current', 'page');
    expect(links[1]).not.toHaveAttribute('aria-current');
    // Title in the entry (as label on the collapsed rail).
    expect(screen.getAllByText('Board').length + screen.queryAllByLabelText('Board').length).toBeGreaterThan(0);
  });
});

describe('phone tab bar with plugin pages', () => {
  it('keeps Settings out of the part that scrolls and scrolls to the open page', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    register();
    const { container } = render(<NavigationRail orientation="horizontal" />);

    const scroller = container.querySelector('[data-mobile-navigation-scroll]')!;
    expect(scroller.querySelector('a[href="/apps/kanban/board"]')).not.toBeNull();
    const settings = container.querySelector('a[href="/settings"]')!;
    expect(scroller.contains(settings)).toBe(false);
    expect(scrollIntoView.mock.instances[0]).toBe(scroller.querySelector('[aria-current="page"]'));
  });
});

describe('Mountain View app grid', () => {
  it('offers plugin pages next to the built-in apps', () => {
    register();
    const { container } = render(<MvTopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'add_app' }));

    const links = [...container.querySelectorAll('[data-plugin-page-link]')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/apps/kanban/board', '/apps/kanban/stats']);
    expect(links[0]).toHaveAttribute('role', 'menuitem');
    expect(screen.getByText('Stats')).toBeInTheDocument();
  });
});
