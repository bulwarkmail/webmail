import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '@/lib/xenaxio/api';

// xenaxio: under Mountain View the top bar replaces the navigation rail, so it
// carries the entry into the company workspace too ("Administration" for
// admins, "Account" for everyone else).

vi.mock('@/lib/xenaxio/bff', async (orig) => ({ ...(await orig<typeof import('@/lib/xenaxio/bff')>()), XENAXIO_BFF: true }));
// A real anchor, so the test sees the link's attributes and clicks.
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
  Link: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => <a href={href} {...props}>{children}</a>,
}));
vi.mock('../account-switcher', () => ({ AccountSwitcher: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => <input data-testid="search" /> }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));
vi.mock('@/hooks/use-stalwart-admin', () => ({ useStalwartAdmin: () => false }));

const { MvTopBar } = await import('../mv-top-bar');
const { useXenaxioMeStore } = await import('@/lib/xenaxio/me-store');

function signIn(role: 'admin' | 'user', domain: 'pending' | 'active') {
  const me: Me = {
    user: { id: 'u1', email: 'max@acme.de', displayName: 'Max', role, mustChangePassword: false },
    tenant: { id: 't1', name: 'Acme', status: 'active' },
    edition: 'cloud',
    domain: { name: 'acme.de', status: domain },
  };
  // loadedAt now: the store does not fetch /api/me in the test.
  act(() => useXenaxioMeStore.setState({ me, loadedAt: Date.now(), loading: false }));
}

describe('Mountain View top bar: company workspace', () => {
  beforeEach(() => act(() => useXenaxioMeStore.setState({ me: null, loadedAt: Date.now(), loading: false })));

  it('shows "Administration" next to the settings for an admin, with a dot while the domain is pending', () => {
    signIn('admin', 'pending');
    render(<MvTopBar />);
    const link = screen.getByTestId('workspace-link-top');
    expect(link).toHaveAttribute('aria-label', 'Administration');
    expect(link.getAttribute('href')).toContain('/workspace');
    expect(link.querySelector('.bg-amber-500')).not.toBeNull();
    // Right before the settings button.
    const settings = screen.getByRole('link', { name: 'settings' });
    expect(link.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows "Account" without a dot for an employee', () => {
    signIn('user', 'active');
    render(<MvTopBar />);
    const link = screen.getByTestId('workspace-link-top');
    expect(link).toHaveAttribute('aria-label', 'Account');
    expect(link.querySelector('.bg-amber-500')).toBeNull();
  });

  it('is in the app grid too, and the grid closes on the click', () => {
    signIn('admin', 'active');
    render(<MvTopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'add_app' }));
    const item = screen.getByRole('menuitem', { name: 'Administration' });
    fireEvent.click(item);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows nothing before the user is known', () => {
    render(<MvTopBar />);
    expect(screen.queryByTestId('workspace-link-top')).toBeNull();
  });
});
