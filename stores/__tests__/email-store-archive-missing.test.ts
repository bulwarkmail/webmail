import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore, ArchiveMailboxNotFoundError } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// #578: archiving with no archive folder used to return silently, leaving the
// user with a shortcut/button that did nothing. The store now creates the
// folder on first use and archives into it; a refused creation is reported.

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
    const archive = makeMailbox({ id: 'a-archive', name: 'Archive', role: 'archive' });
    client = {
      batchArchiveEmails: vi.fn().mockResolvedValue(undefined),
      createMailbox: vi.fn().mockResolvedValue(archive),
      getEmails: vi.fn().mockResolvedValue({ emails: [], hasMore: false, total: 0 }),
      // The reload after creation is what brings the new folder into the store.
      getMailboxes: vi.fn().mockResolvedValue([
        makeMailbox({ id: 'a-inbox', role: 'inbox' }),
        makeMailbox({ id: 'a-trash', name: 'Trash', role: 'trash' }),
        archive,
      ]),
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
      selectedEmailIds: new Set(['e1']),
    });
  });

  it('creates the archive folder and archives into it', async () => {
    await useEmailStore.getState().batchArchive(client);

    expect(client.createMailbox).toHaveBeenCalledWith('Archive', undefined, undefined, { role: 'archive' });
    expect(client.batchArchiveEmails).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'e1' })], 'a-archive', 'single', expect.any(Array), undefined,
    );
    expect(useEmailStore.getState().error).toBeNull();
    expect(useEmailStore.getState().selectedEmailIds.size).toBe(0);
  });

  it('rejects with ArchiveMailboxNotFoundError when the created folder does not come back', async () => {
    (client.getMailboxes as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeMailbox({ id: 'a-inbox', role: 'inbox' }),
    ]);

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toBeInstanceOf(
      ArchiveMailboxNotFoundError,
    );

    expect(useEmailStore.getState().error).toMatch(/archive mailbox not found/i);
    expect(client.batchArchiveEmails).not.toHaveBeenCalled();
    // Nothing was archived, so the selection must survive.
    expect(useEmailStore.getState().selectedEmailIds.has('e1')).toBe(true);
  });

  it('reports a refused creation and keeps the selection', async () => {
    (client.createMailbox as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Failed to create mailbox: forbidden'));

    await expect(useEmailStore.getState().batchArchive(client)).rejects.toThrow('forbidden');
    expect(useEmailStore.getState().error).toMatch(/forbidden/);
    expect(client.batchArchiveEmails).not.toHaveBeenCalled();
    expect(useEmailStore.getState().selectedEmailIds.has('e1')).toBe(true);
  });
});
