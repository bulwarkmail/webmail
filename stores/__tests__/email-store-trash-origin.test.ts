import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { clearAllHooks } from '@/lib/plugin-hooks';
import { emailKeyFor } from '@/lib/thread-utils';
import { restoreTarget } from '@/lib/trash-origin';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// "Restore" in Trash puts a message back where it was. JMAP doesn't keep that,
// so the store notes it as it moves mail to Trash, one message or a selection.

function makeMailbox(overrides: Partial<Mailbox>): Mailbox {
  return {
    id: 'inbox',
    name: 'Inbox',
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    isSubscribed: true,
    isShared: false,
    ...overrides,
  } as Mailbox;
}

function makeEmail(id: string, overrides: Partial<Email> = {}): Email {
  return {
    id,
    threadId: `t-${id}`,
    subject: id,
    receivedAt: '2026-01-01T00:00:00Z',
    keywords: { $seen: true },
    mailboxIds: { inbox: true },
    ...overrides,
  } as Email;
}

const mailboxes = [
  makeMailbox({ id: 'inbox', role: 'inbox' }),
  makeMailbox({ id: 'custom', name: 'Projects' }),
  makeMailbox({ id: 'archive', name: 'Archive', role: 'archive' }),
  makeMailbox({ id: 'archive-2026', name: '2026', parentId: 'archive' }),
  makeMailbox({ id: 'trash', name: 'Trash', role: 'trash' }),
  makeMailbox({ id: 'junk', name: 'Junk', role: 'junk' }),
];

function makeClient(): IJMAPClient {
  return {
    getAccountId: () => 'me',
    moveToTrash: vi.fn().mockResolvedValue(undefined),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
    batchDeleteEmails: vi.fn().mockResolvedValue(undefined),
    moveEmail: vi.fn().mockResolvedValue(undefined),
    batchMoveEmails: vi.fn().mockResolvedValue(undefined),
    batchArchiveEmails: vi.fn().mockResolvedValue(undefined),
    markAsRead: vi.fn().mockResolvedValue(undefined),
    batchMarkAsRead: vi.fn().mockResolvedValue(undefined),
    toggleStar: vi.fn().mockResolvedValue(undefined),
    batchUpdateKeywords: vi.fn().mockResolvedValue(undefined),
    setKeyword: vi.fn().mockResolvedValue(undefined),
    markAsSpam: vi.fn().mockResolvedValue(undefined),
    undoSpam: vi.fn().mockResolvedValue(undefined),
    getMailboxes: vi.fn().mockResolvedValue(mailboxes),
    getAllMailboxes: vi.fn().mockResolvedValue(mailboxes),
    getEmails: vi.fn().mockResolvedValue({ emails: [], hasMore: false, total: 0 }),
    getMaxObjectsInGet: () => 500,
    getThreads: vi.fn().mockResolvedValue([]),
  } as unknown as IJMAPClient;
}

let client: IJMAPClient;

function openFolder(folderId: string, emails: Email[]) {
  useEmailStore.setState({
    mailboxes,
    accountMailboxes: {},
    viewingAccountId: null,
    selectedMailbox: folderId,
    selectedKeyword: null,
    isUnifiedView: false,
    unifiedRole: null,
    crossView: null,
    searchQuery: '',
    searchMailboxId: folderId,
    emails,
    selectedEmail: null,
    selectedEmailKeys: new Set(),
    threadEmailsCache: new Map(),
    processingReadStatus: new Set(),
    error: null,
  });
}

beforeEach(() => {
  clearAllHooks();
  client = makeClient();
  useAuthStore.setState({
    activeAccountId: 'acct',
    getClientForAccount: () => client as never,
  } as never);
  useSettingsStore.setState({ deleteAction: 'trash', permanentlyDeleteJunk: false, archiveMode: 'single' } as never);
});

afterEach(() => { clearAllHooks(); localStorage.clear(); });

describe('moving to Trash notes where the mail was', () => {
  it('one message', async () => {
    openFolder('custom', [makeEmail('e1', { mailboxIds: { custom: true } })]);
    expect(await useEmailStore.getState().deleteEmail(client, 'e1')).toBe(true);
    expect(restoreTarget({ id: 'e1', mailboxIds: { trash: true } }, mailboxes, 'trash')).toBe('custom');
  });

  it('a selection', async () => {
    const a = makeEmail('a', { mailboxIds: { custom: true } });
    const b = makeEmail('b', { mailboxIds: { custom: true } });
    openFolder('custom', [a, b]);
    useEmailStore.setState({ selectedEmailKeys: new Set([emailKeyFor(a), emailKeyFor(b)]) });
    await useEmailStore.getState().batchDelete(client);
    expect(restoreTarget({ id: 'b', mailboxIds: { trash: true } }, mailboxes, 'trash')).toBe('custom');
  });
});
