import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FolderSettings } from '../folder-settings';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import type { Mailbox } from '@/lib/jmap/types';

// Folders with a role are named as in the sidebar (settings-9, 2026-11-04):
// the server's "Sent Items" or "Junk Mail" never shows, and no second chip
// repeats the role next to the name.

vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function makeMailbox(overrides: Partial<Mailbox>): Mailbox {
  return {
    id: 'mb',
    name: 'Folder',
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
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
    isSubscribed: true,
    isShared: false,
    ...overrides,
  } as Mailbox;
}

describe('FolderSettings names role folders as the sidebar does', () => {
  beforeEach(() => {
    useAuthStore.setState({ client: null } as never);
    useEmailStore.setState({
      mailboxes: [
        makeMailbox({ id: 'inbox', name: 'Inbox', role: 'inbox' }),
        makeMailbox({ id: 'sent', name: 'Sent Items', role: 'sent', sortOrder: 1 }),
        makeMailbox({ id: 'junk', name: 'Junk Mail', role: 'junk', sortOrder: 2 }),
        makeMailbox({ id: 'trash', name: 'Deleted Items', role: 'trash', sortOrder: 3 }),
        makeMailbox({ id: 'sched', name: 'Scheduled', role: 'scheduled' as never, sortOrder: 4 }),
        makeMailbox({ id: 'work', name: 'Work', sortOrder: 5 }),
      ],
      fetchMailboxes: vi.fn(),
    } as never);
  });

  it('shows the sidebar name for role folders, never the server name', () => {
    render(<FolderSettings />);
    // The test i18n mock echoes the key: the sidebar's mailboxes.<role> keys.
    const rowName = (text: string) => screen.getAllByText(text).find(el => el.tagName === 'SPAN');
    expect(rowName('mailboxes.sent')).toBeTruthy();
    expect(rowName('mailboxes.spam')).toBeTruthy();
    expect(rowName('mailboxes.trash')).toBeTruthy();
    for (const serverName of ['Sent Items', 'Junk Mail', 'Deleted Items']) {
      expect(screen.queryByText(serverName)).toBeNull();
      expect(screen.queryByTitle(serverName)).toBeNull();
    }
    // Folders the sidebar has no name for keep their own.
    expect(rowName('Work')).toBeTruthy();
    expect(rowName('Scheduled')).toBeTruthy();
  });

  it('draws no role chip next to the name', () => {
    render(<FolderSettings />);
    // role_<role> is only the label of its row in Standard folder roles.
    for (const role of ['inbox', 'sent', 'junk', 'trash']) {
      expect(screen.getAllByText(`role_${role}`)).toHaveLength(1);
    }
    expect(screen.queryByText('role_scheduled')).toBeNull();
  });

  it('offers the sidebar names in the move-to and role pickers', () => {
    render(<FolderSettings />);
    const options = Array.from(document.querySelectorAll('option')).map(o => o.textContent);
    expect(options).not.toContain('Sent Items');
    expect(options).not.toContain('Junk Mail');
  });
});
