import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The mail view rewrites "/" to its folder's address while the page starts, and
// Next prefetches every visible link again when the address changes: rail links
// that prefetched before that sent each route's request twice, while the first
// rows were still on their way. On "/" they wait for the address to move on.

const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('../account-switcher', () => ({ AccountSwitcher: () => null }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/keyboard-shortcuts-modal', () => ({ KeyboardShortcutsModal: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));
vi.mock('@/hooks/use-stalwart-admin', () => ({ useStalwartAdmin: () => false }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  usePathname: () => nav.pathname,
  Link: ({ children, href, prefetch, ...rest }: { children: React.ReactNode; href: string; prefetch?: boolean | null }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>{children}</a>
  ),
}));

const { NavigationRail } = await import('../navigation-rail');
const { useUpdateStore } = await import('@/stores/update-store');
useUpdateStore.setState({ startPolling: vi.fn() } as never);

// Every link the rail draws, by its prefetch setting.
const allPrefetch = () => [...new Set([...document.querySelectorAll('a[data-prefetch]')].map((a) => a.getAttribute('data-prefetch')))];

describe('rail links while the page starts on "/"', () => {
  it('leave prefetching off until the mail view has moved the address on, then prefetch as before', () => {
    const { rerender, unmount } = render(<NavigationRail orientation="vertical" collapsed />);
    expect(document.querySelectorAll('a[data-prefetch]').length).toBeGreaterThan(1);
    expect(allPrefetch()).toEqual(['false']);

    nav.pathname = '/mail/folder/inbox';
    rerender(<NavigationRail orientation="vertical" collapsed />);
    expect(allPrefetch()).toEqual(['undefined']);
    unmount();
  });

  it('prefetch at once in a rail mounted after the start, even on "/"', () => {
    nav.pathname = '/';
    render(<NavigationRail orientation="vertical" collapsed />);
    expect(allPrefetch()).toEqual(['undefined']);
  });
});
