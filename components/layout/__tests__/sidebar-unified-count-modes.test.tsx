import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UNIFIED_MAILBOX_IDS, type Mailbox } from '@/lib/jmap/types';

// #1691: "No counter" on each account's Trash and Junk hid their counts, but
// the unified "All Trash" and "All Junk" rows kept theirs. A unified row now
// takes the counter setting its folders share.

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ startTour: vi.fn(), resetTourCompletion: vi.fn(), activeTour: null, endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/contexts/drag-drop-context', () => ({
  useDragDropContext: () => ({ isDragging: false }),
}));
vi.mock('@/hooks/use-mailbox-drop', () => ({
  useMailboxDrop: () => ({ dropHandlers: {}, isValidDropTarget: false, isInvalidDropTarget: false }),
}));
vi.mock('@/hooks/use-tag-drop', () => ({
  useTagDrop: () => ({ dropHandlers: {}, isValidDropTarget: false }),
}));
vi.mock('../account-switcher', () => ({ AccountSwitcher: () => null }));

const { Sidebar } = await import('../sidebar');
const { useAccountStore } = await import('@/stores/account-store');
const { useSettingsStore } = await import('@/stores/settings-store');
const { useEmailStore } = await import('@/stores/email-store');

const box = (id: string, name: string, role: string | null, unreadEmails = 0) => ({
  id, name, role, parentId: null, totalEmails: unreadEmails + 1, unreadEmails, myRights: { mayAddItems: true },
}) as unknown as Mailbox;

const mailboxes: Mailbox[] = [box('inbox', 'Inbox', 'inbox')];

function account(id: string) {
  return {
    id,
    label: `${id}@example.com`,
    email: `${id}@example.com`,
    username: `${id}@example.com`,
    cookieSlot: id === 'a' ? 0 : 1,
    isConnected: true,
  };
}

// Two logins, each with its own Trash and Junk. The store adds up the
// unified counts from these folders.
const scope = () => [
  { accountId: 'a', accountLabel: 'a', clientAccountId: 'a', mailboxes: [box('a-inbox', 'Inbox', 'inbox', 1), box('a-trash', 'Trash', 'trash', 1), box('a-junk', 'Junk', 'junk', 2)] },
  { accountId: 'b', accountLabel: 'b', clientAccountId: 'b', mailboxes: [box('b-inbox', 'Inbox', 'inbox', 2), box('b-trash', 'Trash', 'trash', 1), box('b-junk', 'Junk', 'junk', 2)] },
];

const counts = (mailboxId: string) => {
  const row = screen.getAllByTestId('folder-row').find((el) => el.getAttribute('data-mailbox-id') === mailboxId)!;
  expect(row).toBeTruthy();
  const el = row.querySelector('[data-testid="folder-counts"]');
  return el ? el.getAttribute('data-unread') : null;
};

describe('unified rows follow the per-folder counter setting (#1691)', () => {
  beforeEach(() => {
    useAccountStore.setState({ accounts: [account('a'), account('b')] } as never);
    useSettingsStore.setState({
      enableUnifiedMailbox: true,
      includeGroupInUnified: false,
      hideAccountSwitcher: true,
      interfaceLayout: 'default',
      showFolderTotalCount: false,
      unreadCountStyle: 'number',
      folderCountModes: {},
    } as never);
    useEmailStore.setState({ unifiedScope: [], unifiedCounts: [] } as never);
    useEmailStore.setState({ unifiedScope: scope() } as never);
    expect(useEmailStore.getState().unifiedCounts.map((c) => [c.role, c.unreadEmails])).toEqual([
      ['inbox', 3], ['trash', 2], ['junk', 4],
    ]);
  });

  it('hides All Trash and All Junk when every Trash and Junk has no counter', () => {
    useSettingsStore.setState({
      folderCountModes: { 'a-trash': 'none', 'b-trash': 'none', 'a-junk': 'none', 'b-junk': 'none' },
    } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" crossAccountActive />);

    expect(counts(UNIFIED_MAILBOX_IDS.trash)).toBeNull();
    expect(counts(UNIFIED_MAILBOX_IDS.junk)).toBeNull();
    expect(counts(UNIFIED_MAILBOX_IDS.inbox)).toBe('3');
    // Nor is the hidden count said in the row's name.
    expect(screen.getByRole('button', { name: 'unified_trash' })).toBeInTheDocument();
  });

  it('keeps the count while one account still shows it', () => {
    useSettingsStore.setState({ folderCountModes: { 'a-trash': 'none' } } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" crossAccountActive />);

    expect(counts(UNIFIED_MAILBOX_IDS.trash)).toBe('2');
    expect(counts(UNIFIED_MAILBOX_IDS.junk)).toBe('4');
  });
});
