import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Mail entry shows the Inbox's unread count as a badge. On the collapsed
// rail the entry has no visible text, so the badge digits used to become the
// link's whole accessible name ("2" instead of "Mail").

// "Mail, 3 unread" (SR-10): the count is said with the name.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    key === 'name_unread' && params ? `${params.name}, ${params.count} unread` : key,
  useLocale: () => 'en',
}));
vi.mock('../account-switcher', () => ({ AccountSwitcher: () => null }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/keyboard-shortcuts-modal', () => ({ KeyboardShortcutsModal: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));
vi.mock('@/hooks/use-stalwart-admin', () => ({ useStalwartAdmin: () => false }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/files',
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a>,
}));

const { NavigationRail } = await import('../navigation-rail');
const { useUpdateStore } = await import('@/stores/update-store');
const { useEmailStore } = await import('@/stores/email-store');
const { useSettingsStore } = await import('@/stores/settings-store');

beforeEach(() => {
  useUpdateStore.setState({ startPolling: vi.fn() } as never);
  useEmailStore.setState({ mailboxes: [{ id: 'a', role: 'inbox', unreadEmails: 2 }] } as never);
  useSettingsStore.setState({ unreadCountStyle: 'count' });
});

describe.each([
  ['collapsed rail', { orientation: 'vertical', collapsed: true }],
  ['expanded rail', { orientation: 'vertical', collapsed: false }],
  ['bottom bar', { orientation: 'horizontal', collapsed: false }],
] as const)('%s', (_name, props) => {
  it('names the Mail entry by its label and its unread count', () => {
    render(<NavigationRail {...props} />);
    const link = screen.getAllByRole('link', { name: 'mail, 2 unread' })[0];
    expect(screen.queryByRole('link', { name: '2' })).toBeNull();
    expect(link.textContent).toContain('2');
  });

  it('shows a dot instead of the number and keeps the count in the name', () => {
    useSettingsStore.setState({ unreadCountStyle: 'dot' });
    render(<NavigationRail {...props} />);
    const link = screen.getAllByRole('link', { name: 'mail, 2 unread' })[0];
    expect(link.querySelector('[data-testid="rail-unread-dot"]')).not.toBeNull();
    expect(link.textContent).not.toContain('2');
  });

  it('hides the count, and drops it from the name, when counts are hidden', () => {
    useSettingsStore.setState({ unreadCountStyle: 'hidden' });
    render(<NavigationRail {...props} />);
    const link = screen.getAllByRole('link', { name: 'mail' })[0];
    expect(screen.queryByTestId('rail-unread-dot')).toBeNull();
    expect(link.textContent).not.toContain('2');
  });
});

// Usability test 2026-11-04, mail-6: with two accounts the rail said 10 while
// 30 were unread in all; the favicon already counted every account.
describe('Mail entry with several accounts', () => {
  const twoAccounts = async () => {
    const { useAccountStore } = await import('@/stores/account-store');
    const { useAuthStore } = await import('@/stores/auth-store');
    useAccountStore.setState({ accounts: [{ id: 'acc-a', isConnected: true }, { id: 'acc-b', isConnected: true }] } as never);
    useAuthStore.setState({ activeAccountId: 'acc-a' } as never);
    useEmailStore.setState({ accountMailboxes: { 'acc-b': [{ id: 'b-in', role: 'inbox', unreadEmails: 5 }] } } as never);
  };

  it('counts the other accounts\' inboxes too', async () => {
    await twoAccounts();
    useSettingsStore.setState({ unreadBadgeAllAccounts: true });
    render(<NavigationRail orientation="vertical" collapsed />);
    expect(screen.getAllByRole('link', { name: 'mail, 7 unread' }).length).toBeGreaterThan(0);
  });

  it('counts the open account only when Notifications says so', async () => {
    await twoAccounts();
    useSettingsStore.setState({ unreadBadgeAllAccounts: false });
    render(<NavigationRail orientation="vertical" collapsed />);
    expect(screen.getAllByRole('link', { name: 'mail, 2 unread' }).length).toBeGreaterThan(0);
  });
});
