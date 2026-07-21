import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Regression coverage for batch actions performed while viewing a shared/group
// mailbox DIRECTLY (the "Shared" sidebar section), not through the unified inbox.
//
// In this view the emails are undecorated (no `sourceAccountId`): they are
// fetched from the owner account through the active login client, and only their
// `mailboxIds` are namespaced. The batch actions grouped such emails under the
// `'__default__'` bucket and dispatched them to the *user's own* account with no
// JMAP accountId. Stalwart then returns the ids as `updated: null` with an
// unchanged state (a silent no-op, no `notUpdated`), so the UI drops the rows
// optimistically and they reappear on the next reload. The action must instead
// carry the viewed shared folder's owner accountId (reached via the active
// client), exactly like the single-email path and `fetchEmails` already do.

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
  };
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

function makeClient() {
  return {
    markAsRead: vi.fn().mockResolvedValue(undefined),
    toggleStar: vi.fn().mockResolvedValue(undefined),
    moveEmail: vi.fn().mockResolvedValue(undefined),
    batchMarkAsRead: vi.fn().mockResolvedValue(undefined),
    batchDeleteEmails: vi.fn().mockResolvedValue(undefined),
    batchMoveEmails: vi.fn().mockResolvedValue(undefined),
    batchArchiveEmails: vi.fn().mockResolvedValue(undefined),
    getEmails: vi.fn().mockResolvedValue({ emails: [], hasMore: false, total: 0 }),
    getMailboxes: vi.fn().mockResolvedValue([]),
  } as unknown as IJMAPClient;
}

describe('non-unified shared-folder batch action routing', () => {
  let activeClient: IJMAPClient; // account-a, the logged-in user, also reaches owner-x

  beforeEach(() => {
    activeClient = makeClient();

    // Only the active login exists; the shared owner 'owner-x' is reached
    // THROUGH it (there is no separate login client for a group mailbox).
    useAuthStore.setState({
      activeAccountId: 'account-a',
      getClientForAccount: (id: string) => (id === 'account-a' ? activeClient : undefined) as never,
    } as never);

    useSettingsStore.setState({ deleteAction: 'trash', permanentlyDeleteJunk: false } as never);

    // Viewing the shared inbox directly: not unified, no viewingAccountId set (the
    // "Shared" section selects the namespaced folder id through handleMailboxSelect).
    // `mailboxes` is the merged own+shared list the sidebar renders, so it contains
    // BOTH the user's own trash and the shared folders.
    useEmailStore.setState({
      isUnifiedView: false,
      unifiedRole: null,
      viewingAccountId: null,
      selectedMailbox: 'owner-x:x-inbox',
      mailboxes: [
        // Own folders are listed first (as getMailboxes emits them), so an
        // unscoped `find(role==='archive'|'trash')` would wrongly pick these.
        makeMailbox({ id: 'a-inbox', role: 'inbox' }),
        makeMailbox({ id: 'a-trash', name: 'Deleted Items', role: 'trash' }),
        makeMailbox({ id: 'a-archive', name: 'Archive', role: 'archive' }),
        makeMailbox({ id: 'owner-x:x-inbox', originalId: 'x-inbox', name: 'Shared Inbox', role: 'inbox', isShared: true, accountId: 'owner-x', unreadEmails: 2, totalEmails: 5 }),
        makeMailbox({ id: 'owner-x:x-trash', originalId: 'x-trash', name: 'Deleted Items', role: 'trash', isShared: true, accountId: 'owner-x' }),
        makeMailbox({ id: 'owner-x:x-archive', originalId: 'x-archive', name: 'Archive', role: 'archive', isShared: true, accountId: 'owner-x' }),
      ],
      accountMailboxes: {
        'owner-x': [
          makeMailbox({ id: 'owner-x:x-inbox', originalId: 'x-inbox', role: 'inbox', isShared: true, accountId: 'owner-x' }),
          makeMailbox({ id: 'owner-x:x-trash', originalId: 'x-trash', role: 'trash', isShared: true, accountId: 'owner-x' }),
          makeMailbox({ id: 'owner-x:x-archive', originalId: 'x-archive', role: 'archive', isShared: true, accountId: 'owner-x' }),
        ],
      },
      processingReadStatus: new Set(),
      selectedEmail: null,
      emails: [
        makeEmail({ id: 'e1', keywords: {}, mailboxIds: { 'owner-x:x-inbox': true } }),
        makeEmail({ id: 'e2', keywords: {}, mailboxIds: { 'owner-x:x-inbox': true } }),
      ],
      selectedEmailIds: new Set(['e1', 'e2']),
    });
  });

  it('batchDelete moves shared emails to the SHARED trash on the owner account', async () => {
    await useEmailStore.getState().batchDelete(activeClient, false);

    // Owner account + owner's trash id, reached via the active client — NOT the
    // user's own trash on their own account.
    expect(activeClient.batchMoveEmails).toHaveBeenCalledWith(['e1', 'e2'], 'x-trash', 'owner-x', false);
  });

  it('batchMoveToMailbox moves shared emails within the owner account', async () => {
    await useEmailStore.getState().batchMoveToMailbox(activeClient, 'owner-x:x-archive');

    expect(activeClient.batchMoveEmails).toHaveBeenCalledWith(['e1', 'e2'], 'x-archive', 'owner-x');
  });

  it('batchMarkAsRead marks shared emails read on the owner account', async () => {
    await useEmailStore.getState().batchMarkAsRead(activeClient, true);

    expect(activeClient.batchMarkAsRead).toHaveBeenCalledWith(['e1', 'e2'], true, 'owner-x');
  });

  it('batchArchive archives shared emails into the SHARED archive on the owner account', async () => {
    await useEmailStore.getState().batchArchive(activeClient);

    // Owner archive id + owner accountId — not the user's own archive/account.
    expect(activeClient.batchArchiveEmails).toHaveBeenCalledWith(
      [{ id: 'e1', receivedAt: expect.any(String) }, { id: 'e2', receivedAt: expect.any(String) }],
      'x-archive',
      'single',
      expect.anything(),
      'owner-x',
    );
  });

  it('leaves own-account batch delete untouched (no owner accountId)', async () => {
    // Selecting the user's own inbox: undecorated emails must still route to the
    // own account with no JMAP accountId (undefined), moving to the own trash.
    useEmailStore.setState({
      selectedMailbox: 'a-inbox',
      emails: [
        makeEmail({ id: 'o1', keywords: {}, mailboxIds: { 'a-inbox': true } }),
        makeEmail({ id: 'o2', keywords: {}, mailboxIds: { 'a-inbox': true } }),
      ],
      selectedEmailIds: new Set(['o1', 'o2']),
    });

    await useEmailStore.getState().batchDelete(activeClient, false);

    expect(activeClient.batchMoveEmails).toHaveBeenCalledWith(['o1', 'o2'], 'a-trash', undefined, false);
  });
});
