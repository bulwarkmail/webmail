import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// Right-clicking the unified "All Trash" sidebar row did nothing at
// all - no context menu, so no way to empty trash across every connected
// account short of doing it one account at a time. This pins that the row
// now gets a context menu with an "empty across all accounts" action wired
// to Sidebar's onEmptyUnifiedMailbox prop.

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

const mailboxes: Mailbox[] = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, totalEmails: 0, unreadEmails: 0, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

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

describe('Sidebar unified "All Trash" context menu', () => {
  beforeEach(() => {
    useAccountStore.setState({ accounts: [account('a'), account('b')] } as never);
    useSettingsStore.setState({
      enableUnifiedMailbox: true,
      includeGroupInUnified: false,
      hideAccountSwitcher: true,
    } as never);
    useEmailStore.setState({
      unifiedCounts: [{ role: 'trash', unreadEmails: 0, totalEmails: 5 }],
    } as never);
  });

  it('opens a context menu with an all-accounts empty action on right-click', () => {
    const onEmptyUnifiedMailbox = vi.fn();
    render(
      <Sidebar
        mailboxes={mailboxes}
        selectedMailbox="inbox"
        crossAccountActive
        onEmptyUnifiedMailbox={onEmptyUnifiedMailbox}
      />
    );

    fireEvent.contextMenu(screen.getByText('unified_trash'));

    const item = screen.getByText('empty_folder_all_accounts');
    expect(item).toBeInTheDocument();
    fireEvent.click(item);
    expect(onEmptyUnifiedMailbox).toHaveBeenCalledWith('trash');
  });

  it('does not render the action when there is nothing to empty', () => {
    useEmailStore.setState({
      unifiedCounts: [{ role: 'trash', unreadEmails: 0, totalEmails: 0 }],
    } as never);
    render(
      <Sidebar
        mailboxes={mailboxes}
        selectedMailbox="inbox"
        crossAccountActive
        onEmptyUnifiedMailbox={vi.fn()}
      />
    );

    fireEvent.contextMenu(screen.getByText('unified_trash'));
    const item = screen.getByText('empty_folder_all_accounts');
    expect(item.closest('button')).toBeDisabled();
  });
});
