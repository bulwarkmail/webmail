import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { FaviconBadge } from '@/components/favicon-badge';
import { useFaviconBadge } from '@/hooks/use-favicon-badge';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { Mailbox } from '@/lib/jmap/types';

vi.mock('@/hooks/use-favicon-badge', () => ({
  useFaviconBadge: vi.fn(),
}));

const useFaviconBadgeMock = vi.mocked(useFaviconBadge);

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
    expect(container.firstChild).toBeNull(); // renders no markup
  });

  it('disables the badge when the setting is off', () => {
    useSettingsStore.setState({ faviconUnreadBadge: false });
    useEmailStore.setState({
      mailboxes: [mailbox({ id: 'inbox', role: 'inbox', unreadEmails: 7 })],
    });

    render(<FaviconBadge />);

    expect(useFaviconBadgeMock).toHaveBeenCalledWith(7, false);
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
  });

  it('badges zero when there is no inbox yet', () => {
    useEmailStore.setState({ mailboxes: [] });

    render(<FaviconBadge />);

    expect(useFaviconBadgeMock).toHaveBeenCalledWith(0, true);
  });
});
