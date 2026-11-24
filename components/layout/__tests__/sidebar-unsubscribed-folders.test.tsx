import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

// #1398: folders unsubscribed on the server (as Roundcube and Thunderbird set
// it) leave the sidebar once "Hide unsubscribed folders" is on, and a folder
// can be hidden from its menu, which unsubscribes it.

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
vi.mock('@/components/email/rules-menu', () => ({ FolderRulesSubMenu: () => null }));

const { Sidebar } = await import('../sidebar');
const { useAuthStore } = await import('@/stores/auth-store');
const { useEmailStore } = await import('@/stores/email-store');
const { useSettingsStore } = await import('@/stores/settings-store');

const folder = (id: string, extra: Partial<Mailbox> = {}): Mailbox => ({
  id, name: id, parentId: null, totalEmails: 0, unreadEmails: 0, myRights: { mayAddItems: true }, isSubscribed: true, ...extra,
} as unknown as Mailbox);

const mailboxes: Mailbox[] = [
  folder('Inbox', { role: 'inbox' }),
  folder('Projects'),
  folder('Old projects', { isSubscribed: false }),
];

const shown = (name: string) => screen.queryAllByText(name).length > 0;

describe('Sidebar unsubscribed folders (#1398)', () => {
  beforeEach(() => {
    useAuthStore.setState({ activeAccountId: 'login-a' } as never);
    useSettingsStore.setState({ hideAccountSwitcher: true, hideUnsubscribedFolders: false } as never);
  });

  it('shows every folder by default', () => {
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="Inbox" />);
    expect(shown('Projects')).toBe(true);
    expect(shown('Old projects')).toBe(true);
    expect(screen.queryByTestId('mailbox-hide-folder')).toBeNull();
  });

  it('leaves out unsubscribed folders when they are hidden', () => {
    useSettingsStore.setState({ hideUnsubscribedFolders: true } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="Inbox" />);
    expect(shown('Projects')).toBe(true);
    expect(shown('Old projects')).toBe(false);
  });

  it('hides a folder from its menu by unsubscribing it', async () => {
    useSettingsStore.setState({ hideUnsubscribedFolders: true } as never);
    const updateMailbox = vi.fn(async () => {});
    const client = { updateMailbox, getAccountId: () => 'acc' };
    useAuthStore.setState({ client } as never);
    useEmailStore.setState({ mailboxes, viewingAccountId: null } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="Inbox" />);

    fireEvent.contextMenu(screen.getByText('Projects'));
    fireEvent.click(screen.getByTestId('mailbox-hide-folder'));

    await waitFor(() => expect(updateMailbox).toHaveBeenCalledWith('Projects', { isSubscribed: false }, undefined));
    expect(useEmailStore.getState().mailboxes.find((m) => m.id === 'Projects')?.isSubscribed).toBe(false);
  });

  it('offers no hiding for the Inbox', () => {
    useSettingsStore.setState({ hideUnsubscribedFolders: true } as never);
    render(<Sidebar mailboxes={mailboxes} selectedMailbox="Inbox" />);
    fireEvent.contextMenu(screen.getAllByTestId('folder-row').find((el) => el.getAttribute('data-mailbox-id') === 'Inbox')!);
    // The menu did open, for a folder without the hide item.
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.queryByTestId('mailbox-hide-folder')).toBeNull();
  });
});
