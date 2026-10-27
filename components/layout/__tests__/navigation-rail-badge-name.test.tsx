import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Mail entry shows the Inbox's unread count as a badge. On the collapsed
// rail the entry has no visible text, so the badge digits used to become the
// link's whole accessible name ("2" instead of "Mail").

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

beforeEach(() => {
  useUpdateStore.setState({ startPolling: vi.fn() } as never);
  useEmailStore.setState({ mailboxes: [{ id: 'a', role: 'inbox', unreadEmails: 2 }] } as never);
});

describe.each([
  ['collapsed rail', { orientation: 'vertical', collapsed: true }],
  ['expanded rail', { orientation: 'vertical', collapsed: false }],
  ['bottom bar', { orientation: 'horizontal', collapsed: false }],
] as const)('%s', (_name, props) => {
  it('names the Mail entry by its label, not by its unread count', () => {
    render(<NavigationRail {...props} />);
    expect(screen.getAllByRole('link', { name: 'mail' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: '2' })).toBeNull();
  });
});
