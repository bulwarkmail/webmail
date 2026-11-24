import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shell labels come from the translations (keys in tests), and the admin
// entry says that an update is waiting instead of a dot nobody hears.

vi.mock('../account-switcher', () => ({ AccountSwitcher: () => null }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/keyboard-shortcuts-modal', () => ({ KeyboardShortcutsModal: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));
vi.mock('@/hooks/use-stalwart-admin', () => ({ useStalwartAdmin: () => true }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a>,
}));

const { NavigationRail } = await import('../navigation-rail');
const { MvTopBar } = await import('../mv-top-bar');
const { ResizeHandle } = await import('../resize-handle');
const { InlineAppView } = await import('../inline-app-view');
const { useUpdateStore } = await import('@/stores/update-store');

beforeEach(() => {
  useUpdateStore.setState({
    startPolling: vi.fn(),
    status: { updateAvailable: true, severity: 'security', current: process.env.NEXT_PUBLIC_APP_VERSION ?? '', latest: '9.9.9' },
  } as never);
});

describe('shell labels', () => {
  it('names the admin entry with the waiting update, in the rail, the tab bar and Mountain View', () => {
    const { unmount } = render(<NavigationRail collapsed />);
    expect(screen.getByRole('link', { name: 'admin, update_important' })).toBeInTheDocument();
    unmount();
    const bar = render(<NavigationRail orientation="horizontal" />);
    expect(screen.getByRole('link', { name: /update_important/ })).toBeInTheDocument();
    bar.unmount();
    render(<MvTopBar showMenuButton={false} />);
    expect(screen.getByRole('link', { name: 'admin, update_important' })).toBeInTheDocument();
  });

  it('translates the resize handle and the inline app close button', () => {
    render(
      <>
        <ResizeHandle onResize={() => {}} />
        <InlineAppView app={{ id: "x", name: "X", url: "https://x.example.com/" }} onClose={() => {}} />
      </>
    );
    expect(screen.getByRole('separator', { name: 'resize' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'close' })).toBeInTheDocument();
  });
});
