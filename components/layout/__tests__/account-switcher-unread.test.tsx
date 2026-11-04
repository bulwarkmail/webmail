import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// Usability test 2026-11-04, mail-6: with two accounts the new mail in the
// other one was nowhere to be seen. The switcher now lists the unread of every
// account, and the avatar carries a dot while another account has unread mail.

const { AccountSwitcher } = await import('../account-switcher');
const { useAccountStore } = await import('@/stores/account-store');
const { useAuthStore } = await import('@/stores/auth-store');
const { useEmailStore } = await import('@/stores/email-store');
const { useSettingsStore } = await import('@/stores/settings-store');

const inbox = (unread: number): Mailbox[] =>
  [{ id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 40, unreadEmails: unread }] as unknown as Mailbox[];

function account(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label: `${id}@example.com`,
    email: `${id}@example.com`,
    username: `${id}@example.com`,
    displayName: 'Robin Kessler',
    serverUrl: 'https://mail.example.com',
    avatarColor: '#336699',
    cookieSlot: 0,
    isConnected: true,
    isDefault: id === 'work',
    ...overrides,
  };
}

describe('AccountSwitcher unread per account', () => {
  beforeEach(() => {
    useAccountStore.setState({ accounts: [account('work'), account('home')] } as never);
    useAuthStore.setState({ activeAccountId: 'work' } as never);
    useEmailStore.setState({ mailboxes: inbox(11), accountMailboxes: { home: inbox(20) } } as never);
    useSettingsStore.setState({ interfaceLayout: 'default' } as never);
  });

  it('lists the unread of each account in the rail menu', () => {
    render(<AccountSwitcher variant="rail" />);
    fireEvent.click(screen.getByTestId('account-switcher'));

    const [work, home] = screen.getAllByTestId('account-option');
    expect(work).toHaveAttribute('data-account-id', 'work');
    expect(within(work).getByText('11')).toBeInTheDocument();
    expect(within(home).getByText('20')).toBeInTheDocument();
  });

  it('puts a dot on the avatar and says why while another account has unread mail', () => {
    render(<AccountSwitcher variant="rail" />);
    const button = screen.getByTestId('account-switcher');
    expect(within(button).getByTestId('other-accounts-unread')).toBeInTheDocument();
    expect(button.getAttribute('aria-label')).toContain('others');
  });

  it('shows no dot when the other accounts are read', () => {
    useEmailStore.setState({ accountMailboxes: { home: inbox(0) } } as never);
    render(<AccountSwitcher variant="rail" />);
    expect(screen.queryByTestId('other-accounts-unread')).toBeNull();
  });

  it('shows no count with a single account', () => {
    useAccountStore.setState({ accounts: [account('work')] } as never);
    render(<AccountSwitcher variant="rail" />);
    fireEvent.click(screen.getByTestId('account-switcher'));
    expect(within(screen.getByTestId('account-option')).queryByText('11')).toBeNull();
  });

  it('gives two accounts with the same name different initials', () => {
    useAccountStore.setState({
      accounts: [account('work', { email: 'dso-ux-mail@example.org' }), account('home', { email: 'dso-ux-mail-b@example.org' })],
    } as never);
    render(<AccountSwitcher variant="rail" />);
    fireEvent.click(screen.getByTestId('account-switcher'));
    const [work, home] = screen.getAllByTestId('account-option');
    expect(within(work).getByText('DM')).toBeInTheDocument();
    expect(within(home).getByText('DB')).toBeInTheDocument();
  });
});
