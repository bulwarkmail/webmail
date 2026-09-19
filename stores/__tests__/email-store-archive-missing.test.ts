import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore, ArchiveMailboxNotFoundError } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// #578: archiving with no archive folder used to return silently, leaving the
// user with a shortcut/button that did nothing. The store must now report it.

function makeMailbox(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: 'inbox',
    name: 'Inbox',
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

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'email-1',
    threadId: 'thread-1',
    subject: 'Hi',
    receivedAt: new Date().toISOString(),
    keywords: {},
    mailboxIds: {},
    ...overrides,
  } as Email;
}

describe('batchArchive without an archive mailbox (#578)', () => {
  let client: IJMAPClient;

  beforeEach(() => {
    client = {
      batchArchiveEmails: vi.fn().mockResolvedValue(undefined),
      getEmails: vi.fn().mockResolvedValue({ emails: [], hasMore: false, total: 0 }),
      getMailboxes: vi.fn().mockResolvedValue([]),
    } as unknown as IJMAPClient;

    useAuthStore.setState({
      activeAccountId: 'account-a',
      getClientForAccount: (id: string) => (id === 'account-a' ? client : undefined) as never,
    } as never);
    useSettingsStore.setState({ archiveMode: 'single' } as never);

    useEmailStore.setState({
      isUnifiedView: false,
      unifiedRole: null,
      viewingAccountId: null,
      selectedMailbox: 'a-inbox',
      error: null,
      mailboxes: [
        makeMailbox({ id: 'a-inbox', role: 'inbox' }),
        makeMailbox({ id: 'a-trash', name: 'Trash', role: 'trash' }),
      ],
      accountMailboxes: {},
      emails: [makeEmail({ id: 'e1', mailboxIds: { 'a-inbox': true } })],
      selectedEmailKeys: new Set(['e1']),
    });
  });

  it('rejects with ArchiveMailboxNotFoundError and records the error', async () => {
    await expect(useEmailStore.getState().batchArchive(client)).rejects.toBeInstanceOf(
      ArchiveMailboxNotFoundError,
    );

    expect(useEmailStore.getState().error).toMatch(/archive mailbox not found/i);
    expect(client.batchArchiveEmails).not.toHaveBeenCalled();
    // Nothing was archived, so the selection must survive.
    expect(useEmailStore.getState().selectedEmailKeys.has('e1')).toBe(true);
  });
});
