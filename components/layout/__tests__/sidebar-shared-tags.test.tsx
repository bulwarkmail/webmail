import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// A group account's shared tags under its folders in the Shared section:
// counted in that account only, and picking one lists that account's mail
// with the tag, without selecting the user's own tag of the same id.

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
const { useEmailStore } = await import('@/stores/email-store');
const { useSettingsStore } = await import('@/stores/settings-store');
const { usePolicyStore } = await import('@/stores/policy-store');
const { DEFAULT_POLICY } = await import('@/lib/admin/types');
const { loadSharedTags, resetSharedTags, sharedTagsKey } = await import('@/stores/shared-tags-store');

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, totalEmails: 0, unreadEmails: 0, myRights: { mayAddItems: true } },
  { id: 'team:a', originalId: 'a', name: 'Inbox', role: 'inbox', parentId: null, totalEmails: 0, unreadEmails: 0, myRights: { mayAddItems: true }, accountId: 'team', accountName: 'org-team@example.org', isShared: true },
  { id: 'team:t', originalId: 't', name: 'Trash', role: 'trash', parentId: null, totalEmails: 0, unreadEmails: 0, myRights: { mayAddItems: true }, accountId: 'team', accountName: 'org-team@example.org', isShared: true },
] as unknown as Mailbox[];

const client = {
  getAccountId: () => 'me',
  getAccountInfo: () => ({ isPersonal: false }),
  getPrincipalTypes: async () => ({ team: 'group' }),
  advertisesBulwarkMetadata: () => true,
  supportsBulwarkMetadata: () => true,
  getBulwarkMetadata: async () => ({ tags: { tags: { urgent: { label: 'Team urgent', color: 'red' } } } }),
  discoverKeywords: async () => ({ keywords: {}, scanned: 0, total: 0, complete: true }),
  getTagCounts: vi.fn(async () => ({ urgent: { total: 5, unread: 2 } })),
};

async function renderSidebar(onTagSelect = vi.fn()) {
  render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" selectedKeyword={useEmailStore.getState().selectedKeyword} onTagSelect={onTagSelect} />);
  const account = screen.getByTestId('section-shared-account');
  if (account.getAttribute('data-expanded') !== 'true') fireEvent.click(account);
  return within(await screen.findByTestId('shared-account-tags'));
}

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem('sidebarSharedExpanded', 'true');
  resetSharedTags();
  client.getTagCounts.mockClear();
  useAuthStore.setState({
    client: client as never,
    activeAccountId: 'login-1',
    getClientForAccount: ((id: string) => (id === 'login-1' ? client : undefined)) as never,
    getAllConnectedClients: (() => new Map([['login-1', client]])) as never,
  });
  useEmailStore.setState({ mailboxes, selectedKeyword: null, selectedKeywordAccountId: null, tagCounts: {} });
  useSettingsStore.setState({
    hideAccountSwitcher: true,
    enableUnifiedMailbox: false,
    showSharedMailAccounts: true,
    hiddenSharedMailAccounts: {},
    nestedTags: false,
    emailKeywords: [{ id: 'urgent', label: 'My urgent', color: 'blue' }],
  } as never);
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY } });
  await loadSharedTags(sharedTagsKey('login-1', 'team'), 'team', client);
});
afterEach(() => resetSharedTags());

describe('Sidebar shared tags', () => {
  it('counts a shared tag in its group account only, outside Trash', async () => {
    const tags = await renderSidebar();
    expect(tags.getByText('Team urgent')).toBeInTheDocument();
    await waitFor(() => expect(client.getTagCounts).toHaveBeenCalledWith(['urgent'], 'team', ['t']));
    await waitFor(() => expect(tags.getByText('2')).toBeInTheDocument());
  });

  it('opens the tag view of that account and leaves the own tag of the same id unselected', async () => {
    const onTagSelect = vi.fn();
    const tags = await renderSidebar(onTagSelect);
    fireEvent.click(tags.getByText('Team urgent'));
    expect(onTagSelect).toHaveBeenCalledWith('urgent', 'team');

    // The store now lists that account only; the sidebar marks the group's row.
    act(() => useEmailStore.getState().selectKeyword('urgent', 'team'));
    expect(useEmailStore.getState().selectedKeywordAccountId).toBe('team');
    cleanup();
    const after = await renderSidebar(onTagSelect);
    expect(after.getByText('Team urgent').closest('[data-testid="folder-row"]')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByText('My urgent').closest('[data-testid="folder-row"]')).not.toHaveAttribute('data-selected');

    // The own tag picked from the own list: the other way round.
    act(() => useEmailStore.getState().selectKeyword('urgent'));
    cleanup();
    const own = await renderSidebar(onTagSelect);
    expect(own.getByText('Team urgent').closest('[data-testid="folder-row"]')).not.toHaveAttribute('data-selected');
    expect(screen.getByText('My urgent').closest('[data-testid="folder-row"]')).toHaveAttribute('data-selected', 'true');
  });

  it('lists the shared tags under a compact shared mailbox too (#1342)', async () => {
    useSettingsStore.setState({ compactSharedMailboxes: true } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="inbox" selectedKeyword={null} onTagSelect={vi.fn()} />);

    const row = screen.getByTestId('compact-shared-mailbox');
    expect(await within(row).findByText('Team urgent')).toBeInTheDocument();
  });
});
