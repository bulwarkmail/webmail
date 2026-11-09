import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { FaviconBadge } from '@/components/favicon-badge';
import { useFaviconBadge } from '@/hooks/use-favicon-badge';
import { useAppBadge } from '@/hooks/use-app-badge';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import type { Mailbox } from '@/lib/jmap/types';

vi.mock('@/hooks/use-favicon-badge', () => ({
  useFaviconBadge: vi.fn(),
}));
vi.mock('@/hooks/use-app-badge', () => ({
  useAppBadge: vi.fn(),
}));

const useFaviconBadgeMock = vi.mocked(useFaviconBadge);
const useAppBadgeMock = vi.mocked(useAppBadge);

function mailbox(patch: Partial<Mailbox> & { id: string }): Mailbox {
  return {
    name: patch.id,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    isSubscribed: true,
    myRights: {
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: true,
      mayRename: true,
      mayDelete: true,
      maySubmit: true,
    },
    ...patch,
  } as Mailbox;
}

const initialMailboxes = useEmailStore.getState().mailboxes;

beforeEach(() => {
  useEmailStore.setState({ mailboxes: initialMailboxes });
  useSettingsStore.setState({ faviconUnreadBadge: true });
});

afterEach(() => {
  useEmailStore.setState({ mailboxes: initialMailboxes });
  useSettingsStore.setState({ faviconUnreadBadge: true });
  vi.clearAllMocks();
});

describe('FaviconBadge', () => {
  it('badges the unread count of the primary inbox', () => {
    useEmailStore.setState({
      mailboxes: [mailbox({ id: 'inbox', role: 'inbox', unreadEmails: 7 })],
    });

    const { container } = render(<FaviconBadge />);

    expect(useFaviconBadgeMock).toHaveBeenCalledWith(7, true);
    expect(useAppBadgeMock).toHaveBeenCalledWith(7, true);
    expect(container.firstChild).toBeNull(); // renders no markup
  });

  it('disables the badge when the setting is off', () => {
    useSettingsStore.setState({ faviconUnreadBadge: false });
    useEmailStore.setState({
      mailboxes: [mailbox({ id: 'inbox', role: 'inbox', unreadEmails: 7 })],
    });

    render(<FaviconBadge />);

    expect(useFaviconBadgeMock).toHaveBeenCalledWith(7, false);
    expect(useAppBadgeMock).toHaveBeenCalledWith(7, false);
  });

  it('ignores a shared inbox, even when it sorts first', () => {
    // Shared and group inboxes ship in the same `mailboxes` array. A plain
    // `role === 'inbox'` lookup would badge somebody else's inbox on a
    // delegated setup, so the store's canonical `!isShared` filter is required.
    useEmailStore.setState({
      mailboxes: [
        mailbox({ id: 'shared', role: 'inbox', isShared: true, unreadEmails: 99 }),
        mailbox({ id: 'mine', role: 'inbox', unreadEmails: 4 }),
      ],
    });

    render(<FaviconBadge />);

    expect(useFaviconBadgeMock).toHaveBeenCalledWith(4, true);
    expect(useAppBadgeMock).toHaveBeenCalledWith(4, true);
  });

  // Usability test 2026-11-04, mail-6: with two accounts the badge counted
  // only the one on screen (11 instead of 31).
  describe('with several accounts', () => {
    const accounts = (ids: string[], connected = true) =>
      ids.map((id) => ({ id, label: id, email: id, username: id, isConnected: connected }));

    beforeEach(() => {
      useAccountStore.setState({ accounts: accounts(['a', 'b', 'c']) } as never);
      useAuthStore.setState({ activeAccountId: 'a' } as never);
      useEmailStore.setState({
        mailboxes: [mailbox({ id: 'inbox', role: 'inbox', unreadEmails: 11 })],
        accountMailboxes: {
          // The active login's cached copy is older; `mailboxes` is the live one.
          a: [mailbox({ id: 'inbox', role: 'inbox', unreadEmails: 2 })],
          b: [mailbox({ id: 'inbox', role: 'inbox', unreadEmails: 20 }), mailbox({ id: 'shared', role: 'inbox', isShared: true, unreadEmails: 50 })],
        },
      });
    });

    afterEach(() => {
      useAccountStore.setState({ accounts: [] } as never);
      useEmailStore.setState({ accountMailboxes: {} });
      useSettingsStore.setState({ unreadBadgeAllAccounts: true });
    });

    it('adds up the inbox of every signed-in account', () => {
      render(<FaviconBadge />);
      // c's folders are not loaded yet and add nothing.
      expect(useAppBadgeMock).toHaveBeenLastCalledWith(31, true);
      expect(useFaviconBadgeMock).toHaveBeenLastCalledWith(31, true);
    });

    it('counts only the open account when the setting is off', () => {
      useSettingsStore.setState({ unreadBadgeAllAccounts: false });
      render(<FaviconBadge />);
      expect(useAppBadgeMock).toHaveBeenLastCalledWith(11, true);
    });

    it('leaves out an account that is signed out', () => {
      useAccountStore.setState({ accounts: [...accounts(['a']), ...accounts(['b'], false)] } as never);
      render(<FaviconBadge />);
      expect(useAppBadgeMock).toHaveBeenLastCalledWith(11, true);
    });
  });

  it('badges zero when there is no inbox yet', () => {
    useEmailStore.setState({ mailboxes: [] });

    render(<FaviconBadge />);

    expect(useFaviconBadgeMock).toHaveBeenCalledWith(0, true);
    expect(useAppBadgeMock).toHaveBeenCalledWith(0, true);
  });
});
