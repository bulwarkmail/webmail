import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FolderSettings } from '../folder-settings';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { Mailbox } from '@/lib/jmap/types';

// #1398: Settings > Folders hides unsubscribed folders on request, and shows
// or hides each folder by its subscription on the server.

vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const rights = {
  mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true,
  mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true,
};

const folder = (id: string, extra: Partial<Mailbox> = {}): Mailbox => ({
  id, name: id, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
  myRights: rights, isSubscribed: true, isShared: false, ...extra,
} as Mailbox);

const updateMailbox = vi.fn(async () => {});

describe('FolderSettings subscriptions', () => {
  beforeEach(() => {
    updateMailbox.mockClear();
    useAuthStore.setState({ client: { updateMailbox, getAccountId: () => 'acc' } } as never);
    useSettingsStore.setState({ folderCountModes: {}, hideUnsubscribedFolders: false } as never);
    useEmailStore.setState({
      mailboxes: [folder('Inbox', { role: 'inbox' }), folder('Projects'), folder('Old', { isSubscribed: false })],
      viewingAccountId: null,
      fetchMailboxes: vi.fn(),
    } as never);
  });

  it('turns hiding on from its switch', () => {
    render(<FolderSettings />);
    expect(screen.queryByRole('button', { name: 'hide_folder_named' })).toBeNull();
    const row = screen.getByText('hide_unsubscribed.label').closest('[data-search-label]') as HTMLElement;
    fireEvent.click(within(row).getByRole('switch'));
    expect(useSettingsStore.getState().hideUnsubscribedFolders).toBe(true);
  });

  it('hides a folder and shows a hidden one by its subscription', async () => {
    useSettingsStore.setState({ hideUnsubscribedFolders: true } as never);
    render(<FolderSettings />);
    // Projects is shown, Old is hidden; the Inbox can't be hidden.
    expect(screen.getAllByRole('button', { name: 'hide_folder_named' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'show_folder_named' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'hide_folder_named' }));
    await waitFor(() => expect(updateMailbox).toHaveBeenCalledWith('Projects', { isSubscribed: false }, undefined));
    expect(screen.getAllByRole('button', { name: 'show_folder_named' })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: 'show_folder_named' })[0]);
    await waitFor(() => expect(updateMailbox).toHaveBeenCalledTimes(2));
    expect(updateMailbox.mock.calls.map((c) => (c as unknown[])[1])).toContainEqual({ isSubscribed: true });
  });

  it('shows the folder again when the server refuses', async () => {
    useSettingsStore.setState({ hideUnsubscribedFolders: true } as never);
    updateMailbox.mockRejectedValueOnce(new Error('forbidden'));
    render(<FolderSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'hide_folder_named' }));
    await waitFor(() => expect(useEmailStore.getState().mailboxes.find((m) => m.id === 'Projects')?.isSubscribed).toBe(true));
    expect(updateMailbox).toHaveBeenCalledTimes(1);
  });
});
