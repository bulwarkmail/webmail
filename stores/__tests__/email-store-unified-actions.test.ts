import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Regression coverage for issue #281: single-email actions performed in the
// unified inbox must be routed to the *email's own account* client, not the
// active account's. Sending them to the active account silently no-ops
// server-side (JMAP returns notUpdated without throwing), so the change is lost
// on the next reload.

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
  } as unknown as IJMAPClient;
}

describe('unified-view single-email action routing (#281)', () => {
  let activeClient: IJMAPClient; // account-a, also the "passed" client
  let accountBClient: IJMAPClient;

  beforeEach(() => {
    activeClient = makeClient();
    accountBClient = makeClient();

    // Route each login by its AccountEntry.id (the `sourceClientAccountId` key).
    // account-a is the active login; account-b is a second direct login; the
    // active login (account-a) also delegates access to the shared owner 'owner-x'.
    useAuthStore.setState({
      activeAccountId: 'account-a',
      getClientForAccount: (id: string) =>
        (id === 'account-b' ? accountBClient : id === 'account-a' ? activeClient : undefined) as never,
    } as never);

    useEmailStore.setState({
      isUnifiedView: true,
      unifiedRole: 'inbox',
      viewingAccountId: null,
      selectedMailbox: '',
      mailboxes: [makeMailbox({ id: 'a-inbox', role: 'inbox' })],
      // Owner mailbox lists are cached by their JMAP id (`sourceAccountId`).
      accountMailboxes: {
        'account-a': [makeMailbox({ id: 'a-inbox', role: 'inbox' })],
        'account-b': [
          makeMailbox({ id: 'b-inbox', role: 'inbox' }),
          makeMailbox({ id: 'b-archive', name: 'Archive', role: 'archive' }),
        ],
        // Shared owner reached through account-a's client.
        'owner-x': [
          makeMailbox({ id: 'owner-x:x-inbox', originalId: 'x-inbox', role: 'inbox', isShared: true, accountId: 'owner-x' }),
          makeMailbox({ id: 'owner-x:x-trash', originalId: 'x-trash', name: 'Trash', role: 'trash', isShared: true, accountId: 'owner-x' }),
        ],
      },
      processingReadStatus: new Set(),
      selectedEmail: null,
      selectedEmailIds: new Set(),
      emails: [
        // Second direct login: sourceClientAccountId === sourceAccountId === 'account-b'.
        makeEmail({ id: 'email-b', accountId: 'account-b', sourceClientAccountId: 'account-b', sourceAccountId: 'account-b', keywords: {}, mailboxIds: { 'b-inbox': true } }),
        // Shared/group source: reached via account-a's client, owned by 'owner-x'.
        makeEmail({ id: 'email-shared', accountId: 'owner-x', sourceClientAccountId: 'account-a', sourceAccountId: 'owner-x', keywords: {}, mailboxIds: { 'owner-x:x-inbox': true } }),
      ],
    });
  });

  it('routes markAsRead to the email’s account client', async () => {
    await useEmailStore.getState().markAsRead(activeClient, 'email-b', true);

    expect(accountBClient.markAsRead).toHaveBeenCalledWith('email-b', true, 'account-b');
    expect(activeClient.markAsRead).not.toHaveBeenCalled();
  });

  it('routes toggleStar to the email’s account client with the owner accountId', async () => {
    await useEmailStore.getState().toggleStar(activeClient, 'email-b');

    expect(accountBClient.toggleStar).toHaveBeenCalledWith('email-b', true, 'account-b');
    expect(activeClient.toggleStar).not.toHaveBeenCalled();
  });

  it('routes moveToMailbox to the email’s account client with that account’s destination', async () => {
    await useEmailStore.getState().moveToMailbox(activeClient, 'email-b', 'b-archive');

    expect(accountBClient.moveEmail).toHaveBeenCalledWith('email-b', 'b-archive', 'account-b');
    expect(activeClient.moveEmail).not.toHaveBeenCalled();
  });

  it('updates the unread counter on the email’s own account, not the active one (id collision)', async () => {
    // Real per-account JMAP ids can collide; here both inboxes use the same id.
    useEmailStore.setState({
      mailboxes: [makeMailbox({ id: 'inbox', role: 'inbox', unreadEmails: 5 })],
      accountMailboxes: {
        'account-a': [makeMailbox({ id: 'inbox', role: 'inbox', unreadEmails: 5 })],
        'account-b': [makeMailbox({ id: 'inbox', role: 'inbox', unreadEmails: 3 })],
      },
      emails: [
        makeEmail({ id: 'b1', sourceClientAccountId: 'account-b', sourceAccountId: 'account-b', keywords: {}, mailboxIds: { inbox: true } }),
      ],
    });

    await useEmailStore.getState().markAsRead(activeClient, 'b1', true);

    const s = useEmailStore.getState();
    expect(s.accountMailboxes['account-b'][0].unreadEmails).toBe(2); // account-b decremented
    expect(s.mailboxes[0].unreadEmails).toBe(5);                     // active account untouched
    expect(s.accountMailboxes['account-a'][0].unreadEmails).toBe(5); // active list untouched
  });

  it('batchMarkAsRead adjusts each email’s own account counter (cross-account)', async () => {
    useEmailStore.setState({
      mailboxes: [makeMailbox({ id: 'inbox', role: 'inbox', unreadEmails: 5 })],
      accountMailboxes: {
        'account-a': [makeMailbox({ id: 'inbox', role: 'inbox', unreadEmails: 5 })],
        'account-b': [makeMailbox({ id: 'inbox', role: 'inbox', unreadEmails: 3 })],
      },
      emails: [
        makeEmail({ id: 'a1', sourceClientAccountId: 'account-a', sourceAccountId: 'account-a', keywords: {}, mailboxIds: { inbox: true } }),
        makeEmail({ id: 'b1', sourceClientAccountId: 'account-b', sourceAccountId: 'account-b', keywords: {}, mailboxIds: { inbox: true } }),
      ],
      selectedEmailIds: new Set(['a1', 'b1']),
    });

    await useEmailStore.getState().batchMarkAsRead(activeClient, true);

    const s = useEmailStore.getState();
    expect(s.mailboxes[0].unreadEmails).toBe(4);                     // active account: -1
    expect(s.accountMailboxes['account-b'][0].unreadEmails).toBe(2); // account-b: -1
  });

  it('routes a shared/group email through the delegating login client + owner accountId', async () => {
    await useEmailStore.getState().markAsRead(activeClient, 'email-shared', true);
    // Reached via account-a's client (the active one), targeting the owner account.
    expect(activeClient.markAsRead).toHaveBeenCalledWith('email-shared', true, 'owner-x');
    expect(accountBClient.markAsRead).not.toHaveBeenCalled();
  });

  it('stars a shared/group email via the delegating client + owner accountId', async () => {
    await useEmailStore.getState().toggleStar(activeClient, 'email-shared');
    expect(activeClient.toggleStar).toHaveBeenCalledWith('email-shared', true, 'owner-x');
  });

  it('still uses the active/passed client outside unified view', async () => {
    useEmailStore.setState({
      isUnifiedView: false,
      emails: [makeEmail({ id: 'email-a', accountId: 'account-a', mailboxIds: { 'a-inbox': true } })],
    });

    await useEmailStore.getState().markAsRead(activeClient, 'email-a', true);

    expect(activeClient.markAsRead).toHaveBeenCalledWith('email-a', true, undefined);
    expect(accountBClient.markAsRead).not.toHaveBeenCalled();
  });
});
