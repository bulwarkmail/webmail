import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// settings-14 (usability pass 2026-11-04): each account row says name,
// address and unread count; the server only when it tells two rows apart;
// the default account says what "default" means; "Manage accounts…" leads
// to Settings › Account; the sidebar button keeps its name.

const push = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push, back: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/en',
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

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
    displayName: `Person ${id.toUpperCase()}`,
    serverUrl: 'https://mail.example.com',
    avatarColor: '#336699',
    cookieSlot: 0,
    isConnected: true,
    isDefault: id === 'a',
    ...overrides,
  };
}

const openPopover = () => fireEvent.click(screen.getByTestId('account-switcher'));
const rowFor = (id: string) => screen.getAllByTestId('account-option').find((r) => r.dataset.accountId === id)!;

describe('the account switcher rows', () => {
  beforeEach(() => {
    push.mockClear();
    useAccountStore.setState({ accounts: [account('a'), account('b')] } as never);
    useAuthStore.setState({ activeAccountId: 'a' } as never);
    useEmailStore.setState({ mailboxes: inbox(3), accountMailboxes: { b: inbox(5) } } as never);
    useSettingsStore.setState({ interfaceLayout: 'default' } as never);
  });

  it('shows each account with its name, address and unread count', () => {
    render(<AccountSwitcher variant="expanded" />);
    openPopover();
    const a = within(rowFor('a'));
    expect(a.getByText('Person A')).toBeInTheDocument();
    expect(a.getByText('a@example.com')).toBeInTheDocument();
    expect(a.getByText('3')).toBeInTheDocument();
    expect(within(rowFor('b')).getByText('5')).toBeInTheDocument();
  });

  it('leaves out the server unless two accounts share an address', () => {
    render(<AccountSwitcher variant="expanded" />);
    openPopover();
    expect(screen.queryByText('mail.example.com')).toBeNull();
  });

  it('names the server when two accounts have the same address', () => {
    useAccountStore.setState({
      accounts: [account('a'), account('b', { email: 'a@example.com', username: 'a@example.com', serverUrl: 'https://other.example.net' })],
    } as never);
    render(<AccountSwitcher variant="expanded" />);
    openPopover();
    expect(within(rowFor('a')).getByText('mail.example.com')).toBeInTheDocument();
    expect(within(rowFor('b')).getByText('other.example.net')).toBeInTheDocument();
  });

  it('says what the default account is', () => {
    render(<AccountSwitcher variant="expanded" />);
    openPopover();
    expect(within(rowFor('a')).getByTitle('default_badge')).toBeInTheDocument();
    expect(within(rowFor('b')).queryByTitle('default_badge')).toBeNull();
  });

  it('opens Settings › Account from "Manage accounts…"', () => {
    render(<AccountSwitcher variant="expanded" />);
    openPopover();
    fireEvent.click(screen.getByTestId('manage-accounts'));
    expect(push).toHaveBeenCalledWith('/settings/account/browser');
  });

  it('keeps the name in the sidebar button when another account has the same one', () => {
    useAccountStore.setState({
      accounts: [account('a', { displayName: 'Sam' }), account('b', { displayName: 'Sam' })],
    } as never);
    render(<AccountSwitcher variant="expanded" />);
    const button = within(screen.getByTestId('account-switcher'));
    expect(button.getByText('Sam')).toBeInTheDocument();
    expect(button.getByText('a@example.com')).toBeInTheDocument();
  });
});
