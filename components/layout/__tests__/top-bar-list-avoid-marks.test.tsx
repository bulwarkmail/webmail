// The app's own top bars and the account switcher carry `data-plugin-list-avoid`, so a list a
// plugin frame asks for never covers them (components/plugins/plugin-iframe-slot.tsx).
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/components/search/search-box', () => ({ SearchBox: () => <input data-testid="search" /> }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));
vi.mock('@/hooks/use-stalwart-admin', () => ({ useStalwartAdmin: () => false }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en',
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

const { MvTopBar } = await import('../mv-top-bar');
const { MobileHeader } = await import('../mobile-header');
const { AccountSwitcher } = await import('../account-switcher');
const { useAccountStore } = await import('@/stores/account-store');
const { useAuthStore } = await import('@/stores/auth-store');

const marked = (el: Element | null) => !!el?.closest('[data-plugin-list-avoid]');

beforeEach(() => {
  useAccountStore.setState({
    accounts: [{
      id: 'a', label: 'a@example.com', email: 'a@example.com', username: 'a@example.com', displayName: 'Person A',
      serverUrl: 'https://mail.example.com', avatarColor: '#336699', cookieSlot: 0, isConnected: true, isDefault: true,
    }],
  } as never);
  useAuthStore.setState({ activeAccountId: 'a' } as never);
});

describe('the app\'s top bars', () => {
  it('marks the Mountain View top bar, the account switcher in it included', () => {
    const { container } = render(<MvTopBar showMenuButton={false} />);
    expect(marked(container.querySelector('[data-mv-topbar]'))).toBe(true);
    expect(marked(screen.getByTestId('account-switcher'))).toBe(true);
  });

  it('marks the phone\'s mail header', () => {
    const { container } = render(<MobileHeader title="Inbox" />);
    expect(marked(container.querySelector('[data-mobile-mail-header]'))).toBe(true);
  });

  it('marks the account switcher where it stands on its own (the sidebar)', () => {
    render(<AccountSwitcher variant="expanded" />);
    expect(marked(screen.getByTestId('account-switcher'))).toBe(true);
  });
});
