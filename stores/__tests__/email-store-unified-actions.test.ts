import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { emailKeyFor } from '@/lib/thread-utils';
import { useAuthStore } from '../auth-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { UnifiedAccountClient } from '@/lib/unified-mailbox';

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
    batchDeleteEmails: vi.fn().mockResolvedValue(undefined),
    batchMoveEmails: vi.fn().mockResolvedValue(undefined),
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
      selectedEmailKeys: new Set(),
      unifiedScope: [],
      unifiedCounts: [],
      crossUnreadCount: 0,
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
      selectedEmailKeys: new Set([
        emailKeyFor({ id: 'a1', sourceClientAccountId: 'account-a', sourceAccountId: 'account-a' }),
        emailKeyFor({ id: 'b1', sourceClientAccountId: 'account-b', sourceAccountId: 'account-b' }),
      ]),
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

  it('decrements a shared/group folder counter when deleting from the unified view', async () => {
    // Real app: the active account's `mailboxes` includes its delegated shared
    // folders (namespaced id + originalId + owner accountId). Unified-fetched
    // shared emails carry the owner's BARE mailboxIds and sourceAccountId=owner.
    // Regression: emailInMailbox missed these, so the shared folder's badge
    // stayed at its old value after deleting in All mail / All unread.
    useEmailStore.setState({
      mailboxes: [
        makeMailbox({ id: 'a-inbox', role: 'inbox', unreadEmails: 2, totalEmails: 5 }),
        makeMailbox({
          id: 'owner-x:x-inbox', originalId: 'x-inbox', name: 'Shared Inbox',
          role: 'inbox', isShared: true, accountId: 'owner-x',
          unreadEmails: 4, totalEmails: 10,
        }),
      ],
      emails: [
        makeEmail({
          id: 'email-shared', accountId: 'owner-x',
          sourceClientAccountId: 'account-a', sourceAccountId: 'owner-x',
          keywords: {}, // unread
          mailboxIds: { 'x-inbox': true }, // BARE owner id (not namespaced)
        }),
      ],
      selectedEmailKeys: new Set([
        emailKeyFor({ id: 'email-shared', sourceClientAccountId: 'account-a', sourceAccountId: 'owner-x' }),
      ]),
    });

    await useEmailStore.getState().batchDelete(activeClient, true);

    expect(activeClient.batchDeleteEmails).toHaveBeenCalledWith(['email-shared'], 'owner-x');
    const shared = useEmailStore.getState().mailboxes.find(m => m.id === 'owner-x:x-inbox')!;
    expect(shared.unreadEmails).toBe(3); // was 4
    expect(shared.totalEmails).toBe(9);  // was 10
  });

  it('decrements the unified-section badges when deleting from the unified view (live projection)', async () => {
    // The unified-section badges (unifiedCounts / crossUnreadCount) must be a
    // live projection of the per-account mailbox lists, NOT a stale server
    // snapshot. Deleting a message in the unified view patches the folder's
    // counter; the badge must follow in lockstep without a re-fetch.
    const scope: UnifiedAccountClient[] = [
      {
        accountId: 'account-a', accountLabel: 'A', client: activeClient,
        clientAccountId: 'account-a', jmapAccountId: 'account-a', isShared: false,
        mailboxes: [makeMailbox({ id: 'a-inbox', role: 'inbox' })],
      },
      {
        accountId: 'owner-x', accountLabel: 'Shared', client: activeClient,
        clientAccountId: 'account-a', jmapAccountId: 'owner-x', isShared: true,
        mailboxes: [makeMailbox({ id: 'owner-x:x-inbox', originalId: 'x-inbox', role: 'inbox', isShared: true, accountId: 'owner-x' })],
      },
    ];

    useEmailStore.setState({
      mailboxes: [
        makeMailbox({ id: 'a-inbox', role: 'inbox', unreadEmails: 2, totalEmails: 5 }),
        makeMailbox({
          id: 'owner-x:x-inbox', originalId: 'x-inbox', name: 'Shared Inbox',
          role: 'inbox', isShared: true, accountId: 'owner-x',
          unreadEmails: 4, totalEmails: 10,
        }),
      ],
      emails: [
        makeEmail({
          id: 'email-shared', accountId: 'owner-x',
          sourceClientAccountId: 'account-a', sourceAccountId: 'owner-x',
          keywords: {}, // unread
          mailboxIds: { 'x-inbox': true }, // BARE owner id (not namespaced)
        }),
      ],
      selectedEmailKeys: new Set([
        emailKeyFor({ id: 'email-shared', sourceClientAccountId: 'account-a', sourceAccountId: 'owner-x' }),
      ]),
    });

    // Seed the badges from the scope (also stores unifiedScope).
    useEmailStore.getState().refreshUnifiedCounts(scope);
    useEmailStore.getState().refreshCrossCounts(scope);

    const before = useEmailStore.getState();
    expect(before.unifiedCounts.find(c => c.role === 'inbox')).toMatchObject({ unreadEmails: 6, totalEmails: 15 });
    expect(before.crossUnreadCount).toBe(6);

    await useEmailStore.getState().batchDelete(activeClient, true);

    const after = useEmailStore.getState();
    // Underlying folder counter dropped...
    expect(after.mailboxes.find(m => m.id === 'owner-x:x-inbox')!.unreadEmails).toBe(3);
    // ...and the unified-section badges followed via the live projection.
    expect(after.unifiedCounts.find(c => c.role === 'inbox')).toMatchObject({ unreadEmails: 5, totalEmails: 14 });
    expect(after.crossUnreadCount).toBe(5);
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
