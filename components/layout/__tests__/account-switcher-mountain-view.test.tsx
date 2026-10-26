import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// Mountain View rearranges the account popover: the account you are in
// becomes a card at the top, the others become a list with the unread waiting
// in each, and the merged inbox gets a row of its own. Outside Mountain View the
// popover is the one the rail and the sidebar have always shown.

const { AccountSwitcher } = await import('../account-switcher');
const { useAccountStore } = await import('@/stores/account-store');
const { useAuthStore } = await import('@/stores/auth-store');
const { useEmailStore } = await import('@/stores/email-store');
const { useSettingsStore } = await import('@/stores/settings-store');

const inbox = (unread: number): Mailbox[] =>
  [{ id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 10, unreadEmails: unread }] as unknown as Mailbox[];

function account(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    label: `${id}@example.com`,
    email: `${id}@example.com`,
    username: `${id}@example.com`,
    displayName: id.toUpperCase(),
    serverUrl: 'https://mail.example.com',
    avatarColor: '#336699',
    cookieSlot: 0,
    isConnected: true,
    isDefault: id === 'a',
    ...overrides,
  };
}

const openPopover = () => fireEvent.click(screen.getByTestId('account-switcher'));

describe('AccountSwitcher under Mountain View', () => {
  beforeEach(() => {
    useAccountStore.setState({ accounts: [account('a'), account('b')] } as never);
    useAuthStore.setState({ activeAccountId: 'a' } as never);
    useEmailStore.setState({ mailboxes: inbox(3), accountMailboxes: { b: inbox(5) } } as never);
    useSettingsStore.setState({ interfaceLayout: 'mountain-view' } as never);
  });

  it('leads with the active account and does not repeat it in the list', () => {
    render(<AccountSwitcher variant="header" />);
    openPopover();

    const options = screen.getAllByTestId('account-option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveAttribute('data-account-id', 'b');
    // The active address is still on screen - as the card, not as a row.
    expect(screen.getAllByText('a@example.com').length).toBeGreaterThan(0);
  });

  it('draws plain rows: no colour stripe, no server line', () => {
    render(<AccountSwitcher variant="header" />);
    openPopover();

    const row = screen.getByTestId('account-option');
    expect(row.getAttribute('style') ?? '').not.toMatch(/border/);
    // Tailwind's `hidden`: jsdom has no style sheet to compute visibility from.
    expect(within(row).getByText('mail.example.com').closest('.hidden')).not.toBeNull();
  });

  it('keeps the server line for an account in trouble', () => {
    useAccountStore.setState({ accounts: [account('a'), account('b', { hasError: true })] } as never);
    render(<AccountSwitcher variant="header" />);
    openPopover();

    expect(within(screen.getByTestId('account-option')).getByText('mail.example.com').closest('.hidden')).toBeNull();
  });

  it('keeps a signed-out account selectable with a sign-in label and no stale unread count', () => {
    useAccountStore.setState({ accounts: [account('a'), account('b', { awaitingSignIn: true, isConnected: false })] } as never);
    render(<AccountSwitcher variant="header" />);
    openPopover();
    const row = screen.getByTestId('account-option');
    expect(within(row).getByText('sign_in')).toBeInTheDocument();
    expect(within(row).getByText('mail.example.com').closest('.hidden')).toBeNull();
    expect(within(row).queryByText('5')).toBeNull();
    expect(row).not.toBeDisabled();
  });

  it("closes the account card with Gmail's rows: add another, sign out of this one, sign out of all", () => {
    render(<AccountSwitcher variant="header" />);
    openPopover();

    const actions = document.querySelector('[data-mv-account-actions]');
    expect(actions).not.toBeNull();
    expect(within(actions as HTMLElement).getByText('mv_add_another_account')).toBeInTheDocument();
    expect(within(actions as HTMLElement).getByText('sign_out_all')).toBeInTheDocument();
    expect(screen.getAllByTestId('add-account')).toHaveLength(1);
  });

  it('offers Manage your account and a close button', () => {
    render(<AccountSwitcher variant="header" />);
    openPopover();

    expect(document.querySelector('[data-mv-manage-account]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(document.querySelector('[data-mv-account-popover]')).toBeNull();
  });

  it('puts the unread waiting in the other account next to it', () => {
    render(<AccountSwitcher variant="header" />);
    openPopover();

    expect(within(screen.getByTestId('account-option')).getByText('5')).toBeInTheDocument();
  });

  it('offers the merged inbox, totalling every connected account, when one is reachable', () => {
    const onSelectAllInboxes = vi.fn();
    render(<AccountSwitcher variant="header" onSelectAllInboxes={onSelectAllInboxes} />);
    openPopover();

    const row = screen.getByTestId('all-inboxes');
    expect(within(row).getByText('8')).toBeInTheDocument();

    fireEvent.click(row);
    expect(onSelectAllInboxes).toHaveBeenCalledOnce();
    // Choosing it closes the popover, as switching account does.
    expect(screen.queryByTestId('all-inboxes')).toBeNull();
  });

  it('draws no merged-inbox row when the caller has nowhere to send it', () => {
    render(<AccountSwitcher variant="header" />);
    openPopover();

    expect(screen.queryByTestId('all-inboxes')).toBeNull();
  });

  it('leaves the default layout listing every account, unread-free', () => {
    useSettingsStore.setState({ interfaceLayout: 'default' } as never);
    render(<AccountSwitcher variant="header" onSelectAllInboxes={vi.fn()} />);
    openPopover();

    expect(screen.getAllByTestId('account-option')).toHaveLength(2);
    expect(screen.queryByTestId('all-inboxes')).toBeNull();
    expect(screen.queryByText('5')).toBeNull();
  });
});
