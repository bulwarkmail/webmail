import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// #1342: with compact shared mailboxes, each shared account is one row that is
// its inbox, its folders below it and its empty standard folders left out.

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
const { useAuthStore } = await import('@/stores/auth-store');
const { useSettingsStore } = await import('@/stores/settings-store');

function shared(accountId: string, accountName: string, id: string, extra: Partial<Mailbox>): Mailbox {
  return {
    id: `${accountId}-${id}`, name: id, role: undefined, parentId: null, totalEmails: 0, unreadEmails: 0,
    myRights: { mayAddItems: true }, accountId, accountName, isShared: true, ...extra,
  } as unknown as Mailbox;
}

const mailboxes: Mailbox[] = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, totalEmails: 0, unreadEmails: 0, myRights: { mayAddItems: true } } as unknown as Mailbox,
  shared('g1', 'sales@example.com', 'inbox', { name: 'Inbox', role: 'inbox', totalEmails: 340, unreadEmails: 5 }),
  shared('g1', 'sales@example.com', 'requests', { name: 'Requests', parentId: 'g1-inbox', totalEmails: 120, unreadEmails: 3 }),
  shared('g1', 'sales@example.com', 'drafts', { name: 'Drafts', role: 'drafts' }),
  shared('g1', 'sales@example.com', 'sent', { name: 'Sent', role: 'sent', totalEmails: 512 }),
  shared('g1', 'sales@example.com', 'junk', { name: 'Junk', role: 'junk', totalEmails: 1, unreadEmails: 1 }),
  shared('g1', 'sales@example.com', 'trash', { name: 'Trash', role: 'trash' }),
  shared('g2', 'support@example.com', 'inbox', { name: 'Inbox', role: 'inbox', totalEmails: 38 }),
];

const compactRows = () => screen.queryAllByTestId('compact-shared-mailbox');
const sales = () => compactRows()[0];
const folderNames = (el: HTMLElement) =>
  within(el).getAllByTestId('folder-row').map((row) => row.getAttribute('data-folder-name'));

describe('Sidebar compact shared mailboxes (#1342)', () => {
  beforeEach(() => {
    localStorage.setItem('sidebarSharedExpanded', 'true');
    // Without a stored state the sidebar opens every folder that has some.
    localStorage.setItem('expandedMailboxes', '[]');
    useAuthStore.setState({ activeAccountId: 'login-a' } as never);
    useSettingsStore.setState({
      hideAccountSwitcher: true,
      showSharedMailAccounts: true,
      hiddenSharedMailAccounts: {},
      compactSharedMailboxes: true,
    } as never);
  });

  it('keeps the header rows while the setting is off', () => {
    useSettingsStore.setState({ compactSharedMailboxes: false } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);

    expect(screen.getAllByTestId('section-shared-account')).toHaveLength(2);
    expect(compactRows()).toHaveLength(0);
  });

  it('shows each shared account as one row named after it, with its inbox counter', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);

    expect(screen.queryAllByTestId('section-shared-account')).toHaveLength(0);
    expect(compactRows().map((el) => el.textContent)).toEqual([
      expect.stringContaining('sales@example.com'),
      expect.stringContaining('support@example.com'),
    ]);
    const counts = within(sales()).getByTestId('folder-counts');
    expect(counts.getAttribute('data-unread')).toBe('5');
  });

  it('opens the inbox when the row is clicked', () => {
    const onMailboxSelect = vi.fn();
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" onMailboxSelect={onMailboxSelect} />);

    fireEvent.click(within(sales()).getByText('sales@example.com'));

    expect(onMailboxSelect).toHaveBeenCalledWith('g1-inbox');
  });

  it('lists the folders below it and leaves out its empty Drafts and Trash', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);

    fireEvent.click(within(sales()).getByTestId('folder-expand-toggle'));

    expect(folderNames(sales())).toEqual(['Inbox', 'Requests', 'Sent', 'Junk']);
  });

  it('offers the account entries on the row, and hides the account from there', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);

    fireEvent.contextMenu(within(sales()).getAllByTestId('folder-row')[0]);
    expect(screen.getByTitle('sales@example.com')).toBeTruthy();
    expect(screen.getByTestId('mailbox-new-subfolder')).toBeTruthy();
    fireEvent.click(screen.getByTestId('mailbox-hide-shared-account'));

    expect(useSettingsStore.getState().hiddenSharedMailAccounts).toEqual({ 'login-a': ['g1'] });
    expect(compactRows().map((el) => el.textContent)).toEqual([expect.stringContaining('support@example.com')]);
  });

  it('keeps the account entries off the folders below the row', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" />);

    fireEvent.click(within(sales()).getByTestId('folder-expand-toggle'));
    fireEvent.contextMenu(within(sales()).getAllByTestId('folder-row')[1]);

    expect(screen.getByTestId('mailbox-new-subfolder')).toBeTruthy();
    expect(screen.queryByTestId('mailbox-hide-shared-account')).toBeNull();
  });

  it('lists Scheduled right after Drafts', () => {
    const withDrafts = mailboxes.map((mb) => (mb.id === 'g1-drafts' ? { ...mb, totalEmails: 2 } : mb));
    render(
      <Sidebar mailboxes={withDrafts} selectedMailbox="inbox" showScheduledMailbox scheduledTotalByAccount={{ g1: 3 }} />,
    );

    fireEvent.click(within(sales()).getByTestId('folder-expand-toggle'));

    const names = folderNames(sales());
    expect(names[names.indexOf('Drafts') + 1]).toBe('scheduled');
  });

  it('lists Scheduled after the other folders when Drafts is left out', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" showScheduledMailbox scheduledTotalByAccount={{ g1: 3 }} />);

    fireEvent.click(within(sales()).getByTestId('folder-expand-toggle'));

    expect(folderNames(sales())).toEqual(['Inbox', 'Requests', 'Sent', 'Junk', 'scheduled']);
  });

  it('offers marking subfolders read only when the inbox has subfolders of its own', () => {
    const support = [...mailboxes, shared('g2', 'support@example.com', 'sent', { name: 'Sent', role: 'sent', totalEmails: 4 })];
    render(<Sidebar mailboxes={support} selectedMailbox="inbox" />);

    fireEvent.contextMenu(within(compactRows()[1]).getAllByTestId('folder-row')[0]);
    expect(screen.queryByText('mark_folder_tree_read')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.contextMenu(within(sales()).getAllByTestId('folder-row')[0]);
    expect(screen.getByText('mark_folder_tree_read')).toBeTruthy();
  });

  it('keeps the shared mailboxes behind More in Mountain View', () => {
    useSettingsStore.setState({ interfaceLayout: 'mountain-view' } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" mvShell />);

    expect(compactRows()).toHaveLength(0);
    fireEvent.click(screen.getByText('show_more'));
    expect(compactRows()).toHaveLength(2);
  });
});
