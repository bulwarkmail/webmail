import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore, buildUnifiedAccountClients, ArchiveMailboxNotFoundError } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';
import { useSettingsStore } from '../settings-store';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { UnifiedAccountClient } from '@/lib/unified-mailbox';
import { jmapError } from '@/lib/jmap/jmap-error';
import { emailKeyFor, threadKeyFor } from '@/lib/thread-utils';

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

/** The selection key of a row stamped with `login` and `account` (emailKeyFor). */
function keyOf(login: string, account: string, id: string): string {
  return emailKeyFor({ id, sourceClientAccountId: login, sourceAccountId: account });
}

function makeClient() {
  return {
    markAsRead: vi.fn().mockResolvedValue(undefined),
    toggleStar: vi.fn().mockResolvedValue(undefined),
    moveEmail: vi.fn().mockResolvedValue(undefined),
    moveToTrash: vi.fn().mockResolvedValue(undefined),
    batchMarkAsRead: vi.fn().mockResolvedValue(undefined),
    batchDeleteEmails: vi.fn().mockResolvedValue(undefined),
    batchMoveEmails: vi.fn().mockResolvedValue(undefined),
    batchArchiveEmails: vi.fn().mockResolvedValue(undefined),
    markAsSpam: vi.fn().mockResolvedValue(undefined),
    undoSpam: vi.fn().mockResolvedValue(undefined),
    getMailboxes: vi.fn().mockResolvedValue([]),
  } as unknown as IJMAPClient;
}

/** What `client` reads with Mailbox/get, by account (bulk archive reads its folders live). */
function servesFolders(client: IJMAPClient, byAccount: Record<string, Mailbox[]>): IJMAPClient {
  (client.getMailboxes as ReturnType<typeof vi.fn>).mockImplementation(async (accountId: string) => byAccount[accountId] ?? []);
  return client;
}

/** An account without an Archive gets one, unless the server refuses it. */
function refuseArchiveCreation(client: IJMAPClient): void {
  Object.assign(client, { getAccountCapability: () => ({ mayCreateTopLevelMailbox: false }) });
}

// Some tests replace these with spies.
const realCrossAccountMoveEmails = useEmailStore.getState().crossAccountMoveEmails;
const realRefreshCurrentMailbox = useEmailStore.getState().refreshCurrentMailbox;

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

  describe('when the server refuses part of a selection (read-only shared folder, Stalwart 0.16 and 1.0)', () => {
    // What JMAPClient.batchMarkAsRead throws for a `notUpdated` answer: the
    // refused ids ride on the error, the rest of the batch was written.
    const refusal = () => {
      const error = jmapError('Failed to mark as read: forbidden', { type: 'forbidden' });
      error.jmapFailedIds = ['x2'];
      return error;
    };

    const selection = [keyOf('account-a', 'account-a', 'a1'), keyOf('account-a', 'owner-x', 'x1'), keyOf('account-a', 'owner-x', 'x2')];

    beforeEach(() => {
      useEmailStore.setState({
        emails: [
          makeEmail({ id: 'a1', sourceClientAccountId: 'account-a', sourceAccountId: 'account-a', keywords: {}, mailboxIds: { inbox: true } }),
          makeEmail({ id: 'x1', sourceClientAccountId: 'account-a', sourceAccountId: 'owner-x', keywords: {}, mailboxIds: { 'x-inbox': true } }),
          makeEmail({ id: 'x2', sourceClientAccountId: 'account-a', sourceAccountId: 'owner-x', keywords: {}, mailboxIds: { 'x-inbox': true } }),
        ],
        selectedEmailKeys: new Set(selection),
      });
    });

    const seen = (id: string) => useEmailStore.getState().emails.find((e) => e.id === id)?.keywords?.$seen;

    it('marks what the server accepted and reports the rest', async () => {
      (activeClient.batchMarkAsRead as ReturnType<typeof vi.fn>).mockImplementation(
        async (_ids: string[], _read: boolean, accountId?: string) => {
          if (accountId === 'owner-x') throw refusal();
        },
      );

      await useEmailStore.getState().batchMarkAsRead(activeClient, true);

      expect([seen('a1'), seen('x1'), seen('x2')]).toEqual([true, true, undefined]);
      const s = useEmailStore.getState();
      expect(s.error).toBe('Failed to mark as read: forbidden');
      expect(s.selectedEmailKeys.size).toBe(0);
    });

    it('changes nothing and keeps the selection when every message is refused', async () => {
      (activeClient.batchMarkAsRead as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError('Failed to fetch'));

      await useEmailStore.getState().batchMarkAsRead(activeClient, true);

      expect([seen('a1'), seen('x1'), seen('x2')]).toEqual([undefined, undefined, undefined]);
      const s = useEmailStore.getState();
      expect(s.error).toBe('Failed to fetch');
      expect(s.selectedEmailKeys).toEqual(new Set(selection));
    });
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

// JMAP account ids are only unique per server. Stalwart numbers accounts the
// same way on every install: userb logged in to the Stalwart 0.16.23 and the
// 1.0 test server is account `e` on both, and the team group is `c` on both
// (message ids repeat too). Batch writes in the unified view used to be
// grouped by account id alone, so both logins' messages went into one group
// and out through whichever login's client came first - to a server where the
// same ids name other messages.
describe('unified-view batch actions with two logins that share account ids', () => {
  let client016: IJMAPClient; // userb on 0.16.23, the active login
  let client10: IJMAPClient;  // userb on 1.0

  // Two installs need not number their folders alike: here the 1.0 login's
  // Deleted Items are `k` (own) and `q` (team), the 0.16.23 login's `b`.
  // Folders the users made get the next free id of their account: the
  // 0.16.23 login's own Archive is `f`, and so is the team's "Projects".
  const own016 = [
    makeMailbox({ id: 'a', role: 'inbox', accountId: 'e' }),
    makeMailbox({ id: 'b', name: 'Deleted Items', role: 'trash', accountId: 'e' }),
    makeMailbox({ id: 'c', name: 'Junk Mail', role: 'junk', accountId: 'e' }),
    makeMailbox({ id: 'f', name: 'Archive', role: 'archive', accountId: 'e' }),
  ];
  const own10 = [
    makeMailbox({ id: 'a', role: 'inbox', accountId: 'e' }),
    makeMailbox({ id: 'k', name: 'Deleted Items', role: 'trash', accountId: 'e' }),
    makeMailbox({ id: 'c', name: 'Junk Mail', role: 'junk', accountId: 'e' }),
    makeMailbox({ id: 'h', name: 'Archive', role: 'archive', accountId: 'e' }),
  ];
  const team016 = [
    makeMailbox({ id: 'c:a', originalId: 'a', name: 'Inbox', role: 'inbox', isShared: true, accountId: 'c' }),
    makeMailbox({ id: 'c:b', originalId: 'b', name: 'Deleted Items', role: 'trash', isShared: true, accountId: 'c' }),
    makeMailbox({ id: 'c:f', originalId: 'f', name: 'Projects', isShared: true, accountId: 'c' }),
    makeMailbox({ id: 'c:g', originalId: 'g', name: 'Archive', role: 'archive', isShared: true, accountId: 'c' }),
  ];
  const team10 = [
    makeMailbox({ id: 'c:a', originalId: 'a', name: 'Inbox', role: 'inbox', isShared: true, accountId: 'c' }),
    makeMailbox({ id: 'c:q', originalId: 'q', name: 'Deleted Items', role: 'trash', isShared: true, accountId: 'c' }),
    makeMailbox({ id: 'c:i', originalId: 'i', name: 'Archive', role: 'archive', isShared: true, accountId: 'c' }),
  ];

  beforeEach(() => {
    client016 = servesFolders(makeClient(), { e: own016, c: team016 });
    client10 = servesFolders(makeClient(), { e: own10, c: team10 });
    useAuthStore.setState({
      activeAccountId: 'userb@v016',
      getClientForAccount: (id: string) =>
        (id === 'userb@v016' ? client016 : id === 'userb@v10' ? client10 : undefined) as never,
    } as never);
    useEmailStore.setState({
      isUnifiedView: true,
      unifiedRole: 'inbox',
      viewingAccountId: null,
      selectedMailbox: '',
      selectedKeyword: null,
      mailboxes: own016,
      // What buildUnifiedAccountClients leaves behind: the bare account ids
      // hold the list of the login fetched last.
      accountMailboxes: {
        'userb@v016': own016,
        'userb@v10': own10,
        e: own10,
        c: team10,
        'userb@v016|e': own016,
        'userb@v10|e': own10,
        'userb@v016|c': team016,
        'userb@v10|c': team10,
      },
      emails: [
        makeEmail({ id: 'm016', sourceClientAccountId: 'userb@v016', sourceAccountId: 'e', mailboxIds: { a: true } }),
        makeEmail({ id: 'm10', sourceClientAccountId: 'userb@v10', sourceAccountId: 'e', mailboxIds: { a: true } }),
        makeEmail({ id: 't016', sourceClientAccountId: 'userb@v016', sourceAccountId: 'c', mailboxIds: { a: true } }),
        makeEmail({ id: 't10', sourceClientAccountId: 'userb@v10', sourceAccountId: 'c', mailboxIds: { a: true } }),
      ],
      selectedEmail: null,
      selectedEmailKeys: new Set([
        keyOf('userb@v016', 'e', 'm016'), keyOf('userb@v10', 'e', 'm10'),
        keyOf('userb@v016', 'c', 't016'), keyOf('userb@v10', 'c', 't10'),
      ]),
      processingReadStatus: new Set(),
      unifiedScope: [],
      unifiedCounts: [],
      crossUnreadCount: 0,
      error: null,
      // The cross-account move and the list refresh have tests of their own.
      crossAccountMoveEmails: vi.fn().mockResolvedValue(undefined) as never,
      refreshCurrentMailbox: vi.fn().mockResolvedValue(undefined) as never,
    });
  });

  afterEach(() => {
    useEmailStore.setState({ crossAccountMoveEmails: realCrossAccountMoveEmails, refreshCurrentMailbox: realRefreshCurrentMailbox });
  });

  const callsOf = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls;
  const crossMoves = () => callsOf(useEmailStore.getState().crossAccountMoveEmails);
  const listed = () => useEmailStore.getState().emails.map((e) => `${e.sourceClientAccountId}/${e.sourceAccountId}/${e.id}`);

  it('marks each login\'s messages read through its own client', async () => {
    await useEmailStore.getState().batchMarkAsRead(client016, true);

    expect(callsOf(client016.batchMarkAsRead)).toEqual([[['m016'], true, 'e'], [['t016'], true, 'c']]);
    expect(callsOf(client10.batchMarkAsRead)).toEqual([[['m10'], true, 'e'], [['t10'], true, 'c']]);
  });

  it('destroys each login\'s messages through its own client', async () => {
    await useEmailStore.getState().batchDelete(client016, true);

    expect(callsOf(client016.batchDeleteEmails)).toEqual([[['m016'], 'e'], [['t016'], 'c']]);
    expect(callsOf(client10.batchDeleteEmails)).toEqual([[['m10'], 'e'], [['t10'], 'c']]);
  });

  it('moves each login\'s messages to that login\'s own Deleted Items', async () => {
    await useEmailStore.getState().batchDelete(client016, false);

    expect(callsOf(client016.batchMoveEmails)).toEqual([[['m016'], 'b', 'e', false], [['t016'], 'b', 'c', false]]);
    expect(callsOf(client10.batchMoveEmails)).toEqual([[['m10'], 'k', 'e', false], [['t10'], 'q', 'c', false]]);
  });

  // "Move to" offers the viewed login's folders. A folder id means nothing in
  // another account: the team's `f` is its "Projects", and the 1.0 server's
  // `e` has folders of its own.
  it('moves a selection in place only in the folder\'s own login and account (0.16.23 and 1.0 logins)', async () => {
    await useEmailStore.getState().batchMoveToMailbox(client016, 'f');

    expect(callsOf(client016.batchMoveEmails)).toEqual([[['m016'], 'f', 'e']]);
    expect(callsOf(client10.batchMoveEmails)).toEqual([]);
    // The others are moved across accounts, each from its own login and account.
    expect(crossMoves()).toEqual([
      [new Map([['userb@v10', ['m10']]]), 'userb@v016', 'f', undefined, 'e'],
      [new Map([['userb@v016', ['t016']]]), 'userb@v016', 'f', undefined, 'c'],
      [new Map([['userb@v10', ['t10']]]), 'userb@v016', 'f', undefined, 'c'],
    ]);
    expect(listed()).not.toContain('userb@v016/e/m016');
    expect(useEmailStore.getState().error).toBeNull();
  });

  it('moves a selection into a group folder in place only in that group account of the same login', async () => {
    useEmailStore.setState({ mailboxes: [...own016, ...team016] });

    await useEmailStore.getState().batchMoveToMailbox(client016, 'c:g');

    expect(callsOf(client016.batchMoveEmails)).toEqual([[['t016'], 'g', 'c']]);
    expect(callsOf(client10.batchMoveEmails)).toEqual([]);
    expect(crossMoves()).toEqual([
      [new Map([['userb@v016', ['m016']]]), 'userb@v016', 'g', 'c', 'e'],
      [new Map([['userb@v10', ['m10']]]), 'userb@v016', 'g', 'c', 'e'],
      [new Map([['userb@v10', ['t10']]]), 'userb@v016', 'g', 'c', 'c'],
    ]);
  });

  it('keeps what could not be moved listed and selected, and says why', async () => {
    const refusal = jmapError('Failed to move emails: forbidden', { type: 'forbidden' });
    refusal.jmapFailedIds = ['m016'];
    (client016.batchMoveEmails as ReturnType<typeof vi.fn>).mockRejectedValue(refusal);
    // As crossAccountMoveEmails does: what it moved leaves the list and the selection.
    useEmailStore.setState({
      crossAccountMoveEmails: vi.fn(async (bySource: Map<string, string[]>) => {
        const [[login, ids]] = [...bySource];
        if (login === 'userb@v10' && ids.includes('m10')) throw new Error('Failed to move email: Failed to import email');
        useEmailStore.setState((s) => {
          const gone = new Set(s.emails.filter((e) => e.sourceClientAccountId === login && ids.includes(e.id)).map(emailKeyFor));
          return {
            emails: s.emails.filter((e) => !gone.has(emailKeyFor(e))),
            selectedEmailKeys: new Set([...s.selectedEmailKeys].filter((key) => !gone.has(key))),
          };
        });
      }) as never,
    });

    await useEmailStore.getState().batchMoveToMailbox(client016, 'f');

    const s = useEmailStore.getState();
    expect(listed()).toEqual(['userb@v016/e/m016', 'userb@v10/e/m10']);
    expect(s.selectedEmailKeys).toEqual(new Set([keyOf('userb@v016', 'e', 'm016'), keyOf('userb@v10', 'e', 'm10')]));
    expect(s.error).toBe('Failed to move 2 emails; first error: Failed to move emails: forbidden');
  });

  it('moves dropped messages in place only in the login the folder is listed under', async () => {
    // Dropped on the 1.0 login's Archive (`h`) in the multi-account sidebar.
    await useEmailStore.getState().moveEmailsToMailbox(client016, ['m016', 'm10', 't10'], 'h', 'userb@v10');

    expect(callsOf(client10.batchMoveEmails)).toEqual([[['m10'], 'h', 'e']]);
    expect(callsOf(client016.batchMoveEmails)).toEqual([]);
    expect(crossMoves()).toEqual([
      [new Map([['userb@v016', ['m016']]]), 'userb@v10', 'h', undefined, 'e'],
      [new Map([['userb@v10', ['t10']]]), 'userb@v10', 'h', undefined, 'c'],
    ]);
    expect(listed()).toEqual(['userb@v016/e/m016', 'userb@v016/c/t016', 'userb@v10/c/t10']);
  });

  it('moves one dropped group message across accounts, not into the group folder with the same id', async () => {
    await useEmailStore.getState().moveEmailsToMailbox(client016, ['t016'], 'f');

    expect(callsOf(client016.moveEmail)).toEqual([]);
    expect(callsOf(client016.batchMoveEmails)).toEqual([]);
    expect(crossMoves()).toEqual([[new Map([['userb@v016', ['t016']]]), 'userb@v016', 'f', undefined, 'c']]);
  });

  it('throws for a drop that left messages where they were, keeping their rows', async () => {
    (client10.batchMoveEmails as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(useEmailStore.getState().moveEmailsToMailbox(client016, ['m10'], 'h', 'userb@v10'))
      .rejects.toThrow('Failed to fetch');
    expect(listed()).toContain('userb@v10/e/m10');
  });

  it('"Move to" on one group message moves it across accounts, and on an own one in place', async () => {
    await useEmailStore.getState().moveToMailboxCrossAware(client016, 't016', 'f');
    await useEmailStore.getState().moveToMailboxCrossAware(client016, 'm016', 'f');

    expect(callsOf(client016.moveEmail)).toEqual([]);
    expect(crossMoves()).toEqual([[new Map([['userb@v016', ['t016']]]), 'userb@v016', 'f', undefined, 'c']]);
    expect(callsOf(client016.batchMoveEmails)).toEqual([[['m016'], 'f', 'e']]);
  });

  const archiveCalls = (client: IJMAPClient) => callsOf(client.batchArchiveEmails)
    .map(([emails, archiveId, mode, , accountId]) => [(emails as Array<{ id: string }>).map((e) => e.id), archiveId, mode, accountId]);

  it('archives each login\'s and account\'s messages into their own Archive (0.16.23 and 1.0 logins)', async () => {
    useSettingsStore.setState({ archiveMode: 'single' } as never);

    await useEmailStore.getState().batchArchive(client016);

    expect(archiveCalls(client016)).toEqual([[['m016'], 'f', 'single', 'e'], [['t016'], 'g', 'single', 'c']]);
    expect(archiveCalls(client10)).toEqual([[['m10'], 'h', 'single', 'e'], [['t10'], 'i', 'single', 'c']]);
    expect(listed()).toEqual([]);
    expect(useEmailStore.getState().selectedEmailKeys.size).toBe(0);
  });

  it('archives in a tag view by each message\'s account, not by the group folder still selected underneath', async () => {
    useSettingsStore.setState({ archiveMode: 'single' } as never);
    useEmailStore.setState({ isUnifiedView: false, unifiedRole: null, selectedKeyword: 'work', selectedMailbox: 'c:a', mailboxes: [...own016, ...team016] });

    await useEmailStore.getState().batchArchive(client016);

    expect(archiveCalls(client016)).toEqual([[['m016'], 'f', 'single', 'e'], [['t016'], 'g', 'single', 'c']]);
    expect(archiveCalls(client10)).toEqual([[['m10'], 'h', 'single', 'e'], [['t10'], 'i', 'single', 'c']]);
  });

  it('keeps the messages of an account without an Archive listed and selected, archiving the others', async () => {
    useSettingsStore.setState({ archiveMode: 'single' } as never);
    servesFolders(client10, { e: own10, c: team10.filter((m) => m.role !== 'archive') });
    refuseArchiveCreation(client10);
    useEmailStore.setState((s) => ({
      accountMailboxes: { ...s.accountMailboxes, 'userb@v10|c': team10.filter((m) => m.role !== 'archive') },
    }));

    await useEmailStore.getState().batchArchive(client016);

    const s = useEmailStore.getState();
    expect(listed()).toEqual(['userb@v10/c/t10']);
    expect(s.selectedEmailKeys).toEqual(new Set([keyOf('userb@v10', 'c', 't10')]));
    expect(s.error).toMatch(/archive mailbox not found/i);
  });

  it('rejects with ArchiveMailboxNotFoundError when no message could be archived', async () => {
    servesFolders(client10, { e: own10.filter((m) => m.role !== 'archive') });
    refuseArchiveCreation(client10);
    useEmailStore.setState({
      accountMailboxes: {},
      selectedEmailKeys: new Set([keyOf('userb@v10', 'e', 'm10')]),
    });

    await expect(useEmailStore.getState().batchArchive(client016)).rejects.toBeInstanceOf(ArchiveMailboxNotFoundError);
    expect(callsOf(client10.batchArchiveEmails)).toEqual([]);
    expect(listed()).toContain('userb@v10/e/m10');
    expect(useEmailStore.getState().selectedEmailKeys).toEqual(new Set([keyOf('userb@v10', 'e', 'm10')]));
  });

  it('marks each message as spam in its own login and account', async () => {
    useSettingsStore.setState({ deleteAction: 'trash' } as never);

    await useEmailStore.getState().batchMarkAsSpam(client016, ['m016', 'm10', 't016', 't10']);

    expect(callsOf(client016.markAsSpam)).toEqual([['m016', 'e', false], ['t016', 'c', false]]);
    expect(callsOf(client10.markAsSpam)).toEqual([['m10', 'e', false], ['t10', 'c', false]]);
    expect(listed()).toEqual([]);
  });

  it('rejects for a message the server would not mark as spam and keeps it, moving the others', async () => {
    useSettingsStore.setState({ deleteAction: 'trash' } as never);
    (client10.markAsSpam as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Failed to mark as spam: forbidden'));

    await expect(useEmailStore.getState().batchMarkAsSpam(client016, ['m016', 'm10'])).rejects.toThrow('Failed to mark as spam: forbidden');

    expect(listed()).toEqual(['userb@v10/e/m10', 'userb@v016/c/t016', 'userb@v10/c/t10']);
  });

  it('puts each message back in the Inbox of its own login and account ("All Junk")', async () => {
    useEmailStore.setState({ unifiedRole: 'junk' });

    await useEmailStore.getState().batchUndoSpam(client016, ['m016', 'm10', 't016', 't10']);

    expect(callsOf(client016.undoSpam)).toEqual([['m016', 'a', 'e'], ['t016', 'a', 'c']]);
    expect(callsOf(client10.undoSpam)).toEqual([['m10', 'a', 'e'], ['t10', 'a', 'c']]);
    expect(listed()).toEqual([]);
  });

  it('deletes a single message into its own login\'s Deleted Items', async () => {
    // The bare `e` entry holds the 1.0 login's folders; this is the other one's.
    await useEmailStore.getState().deleteEmail(client016, 'm016');

    expect(client016.moveToTrash).toHaveBeenCalledWith('m016', 'b', 'e', false);
    expect(client10.moveToTrash).not.toHaveBeenCalled();
  });

  it('caches each login\'s folder lists apart when building the unified view', async () => {
    Object.assign(client016, { getAccountId: () => 'e', getAllMailboxes: vi.fn().mockResolvedValue([...own016, ...team016]) });
    Object.assign(client10, { getAccountId: () => 'e', getAllMailboxes: vi.fn().mockResolvedValue([...own10, ...team10]) });
    useAccountStore.setState({
      accounts: [
        { id: 'userb@v016', label: 'userb (0.16)', email: 'userb@example.org', isConnected: true },
        { id: 'userb@v10', label: 'userb (1.0)', email: 'userb@example.org', isConnected: true },
      ],
    } as never);
    useAuthStore.setState({
      getAllConnectedClients: () => new Map([['userb@v016', client016], ['userb@v10', client10]]),
    } as never);
    useEmailStore.setState({ accountMailboxes: {} });

    await buildUnifiedAccountClients({ includeGroup: true });

    const cached = useEmailStore.getState().accountMailboxes;
    expect(cached['userb@v016|e']).toEqual(own016);
    expect(cached['userb@v10|e']).toEqual(own10);
    expect(cached['userb@v016|c']).toEqual(team016);
    expect(cached['userb@v10|c']).toEqual(team10);
  });
});

// A tag view and the default "All folders" search stamp their rows with
// login and account like the unified views, but only the unified views cache
// their sources' folder lists; the Pro shell keeps the login browsed before a
// list that mixes accounts opens; and a selected id can be a member of an
// expanded thread only, or name rows of two accounts.
describe('lists that mix accounts, without the unified views\' cache and after browsing another login', () => {
  let client016: IJMAPClient; // usera on 0.16.23, the active login
  let client10: IJMAPClient;  // usera on 1.0

  // usera is account `d` on both servers, with the team `c` on 0.16.23.
  // Folder ids repeat across servers: `f` is the 0.16.23 login's Archive and
  // the 1.0 login's "Old stuff".
  const own016 = [
    makeMailbox({ id: 'a', role: 'inbox', accountId: 'd' }),
    makeMailbox({ id: 'b', name: 'Deleted Items', role: 'trash', accountId: 'd' }),
    makeMailbox({ id: 'c', name: 'Junk Mail', role: 'junk', accountId: 'd' }),
    makeMailbox({ id: 'f', name: 'Archive', role: 'archive', accountId: 'd' }),
  ];
  const team016 = [
    makeMailbox({ id: 'c:a', originalId: 'a', name: 'Inbox', role: 'inbox', isShared: true, accountId: 'c' }),
    makeMailbox({ id: 'c:b', originalId: 'b', name: 'Deleted Items', role: 'trash', isShared: true, accountId: 'c' }),
    makeMailbox({ id: 'c:c', originalId: 'c', name: 'Junk Mail', role: 'junk', isShared: true, accountId: 'c' }),
    makeMailbox({ id: 'c:g', originalId: 'g', name: 'Archive', role: 'archive', isShared: true, accountId: 'c' }),
  ];
  const own10 = [
    makeMailbox({ id: 'a', role: 'inbox', accountId: 'd' }),
    makeMailbox({ id: 'k', name: 'Deleted Items', role: 'trash', accountId: 'd' }),
    makeMailbox({ id: 'f', name: 'Old stuff', accountId: 'd' }),
    makeMailbox({ id: 'h', name: 'Archive', role: 'archive', accountId: 'd' }),
  ];
  const row = (id: string, login: string, account: string, extra: Partial<Email> = {}) =>
    makeEmail({ id, sourceClientAccountId: login, sourceAccountId: account, mailboxIds: { a: true }, ...extra });

  beforeEach(() => {
    client016 = servesFolders(Object.assign(makeClient(), { getAccountId: () => 'd' }), { d: own016, c: team016 });
    client10 = servesFolders(Object.assign(makeClient(), { getAccountId: () => 'd' }), { d: own10 });
    useSettingsStore.setState({ archiveMode: 'single', deleteAction: 'trash' } as never);
    useAuthStore.setState({
      activeAccountId: 'usera@v016',
      getClientForAccount: (id: string) =>
        (id === 'usera@v016' ? client016 : id === 'usera@v10' ? client10 : undefined) as never,
    } as never);
    useEmailStore.setState({
      isUnifiedView: false,
      unifiedRole: null,
      crossView: null,
      viewingAccountId: null,
      selectedMailbox: 'a',
      selectedKeyword: null,
      searchQuery: '',
      searchMailboxId: '',
      mailboxes: [...own016, ...team016],
      // Nothing cached by login and account: no unified view was built. The
      // Pro sidebar holds the 1.0 login's folders under its login.
      accountMailboxes: { 'usera@v10': own10 },
      emails: [row('m1', 'usera@v016', 'd'), row('m2', 'usera@v016', 'd')],
      threadEmailsCache: new Map(),
      expandedThreadIds: new Set(),
      selectedEmail: null,
      selectedEmailKeys: new Set([keyOf('usera@v016', 'd', 'm1'), keyOf('usera@v016', 'd', 'm2')]),
      error: null,
      isLoading: false,
      crossAccountMoveEmails: vi.fn().mockResolvedValue(undefined) as never,
      refreshCurrentMailbox: vi.fn().mockResolvedValue(undefined) as never,
    });
  });

  afterEach(() => {
    useEmailStore.setState({ crossAccountMoveEmails: realCrossAccountMoveEmails, refreshCurrentMailbox: realRefreshCurrentMailbox });
  });

  const callsOf = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls;
  const archiveCalls = (client: IJMAPClient) => callsOf(client.batchArchiveEmails)
    .map(([emails, archiveId, , , accountId]) => [(emails as Array<{ id: string }>).map((e) => e.id), archiveId, accountId]);
  const listed = () => useEmailStore.getState().emails.map((e) => `${e.sourceClientAccountId}/${e.sourceAccountId}/${e.id}`);

  it('archives an "All folders" search\'s own messages into the own Archive', async () => {
    useEmailStore.setState({ searchQuery: 'invoice' });

    await useEmailStore.getState().batchArchive(client016);

    expect(archiveCalls(client016)).toEqual([[['m1', 'm2'], 'f', 'd']]);
    expect(listed()).toEqual([]);
    expect(useEmailStore.getState().error).toBeNull();
  });

  it('archives a tag view\'s own messages into the own Archive', async () => {
    useEmailStore.setState({ selectedKeyword: 'work' });

    await useEmailStore.getState().batchArchive(client016);

    expect(archiveCalls(client016)).toEqual([[['m1', 'm2'], 'f', 'd']]);
  });

  it('puts a tag view\'s messages back in their own Inbox with "Not spam", entered from Junk', async () => {
    useEmailStore.setState({ selectedKeyword: 'work', selectedMailbox: 'c' });

    await useEmailStore.getState().batchUndoSpam(client016, ['m1', 'm2']);

    expect(callsOf(client016.undoSpam)).toEqual([['m1', 'a', 'd'], ['m2', 'a', 'd']]);
  });

  // Pro shell: a folder of the 1.0 login browsed, then a tag. A unified view
  // built earlier left the 0.16.23 login's list under the bare account id `d`.
  describe('in a tag view of the 1.0 login browsed in the Pro shell', () => {
    beforeEach(() => {
      useEmailStore.setState({
        viewingAccountId: 'usera@v10',
        selectedKeyword: 'work',
        accountMailboxes: { 'usera@v10': own10, 'usera@v016|d': own016, d: own016 },
        emails: [row('m10', 'usera@v10', 'd')],
        selectedEmailKeys: new Set([keyOf('usera@v10', 'd', 'm10')]),
      });
    });

    it('archives into that login\'s own Archive, not the folder with the other server\'s Archive id', async () => {
      await useEmailStore.getState().batchArchive(client016);

      expect(archiveCalls(client016)).toEqual([]);
      expect(archiveCalls(client10)).toEqual([[['m10'], 'h', 'd']]);
    });

    it('deletes into that login\'s own Deleted Items', async () => {
      await useEmailStore.getState().batchDelete(client016, false);

      expect(callsOf(client10.batchMoveEmails)).toEqual([[['m10'], 'k', 'd', false]]);
      expect(callsOf(client016.batchMoveEmails)).toEqual([]);
    });
  });

  // Pro shell: a folder of the 1.0 login browsed, then "All Inboxes". The
  // "Move to" menus list the active login's folders.
  it('moves into the folder "Move to" offers, the active login\'s, after another login was browsed', async () => {
    useEmailStore.setState({
      isUnifiedView: true,
      unifiedRole: 'inbox',
      selectedMailbox: '__unified_inbox',
      viewingAccountId: 'usera@v10',
      emails: [row('m016', 'usera@v016', 'd'), row('m10', 'usera@v10', 'd')],
      selectedEmailKeys: new Set([keyOf('usera@v016', 'd', 'm016'), keyOf('usera@v10', 'd', 'm10')]),
    });

    await useEmailStore.getState().batchMoveToMailbox(client016, 'f');

    expect(callsOf(client016.batchMoveEmails)).toEqual([[['m016'], 'f', 'd']]);
    expect(callsOf(client10.batchMoveEmails)).toEqual([]);
    expect(callsOf(useEmailStore.getState().crossAccountMoveEmails)).toEqual([
      [new Map([['usera@v10', ['m10']]]), 'usera@v016', 'f', undefined, 'd'],
    ]);
  });

  it('moves one dragged row, not the team\'s unrelated message with the same id', async () => {
    const own = row('x', 'usera@v016', 'd');
    useEmailStore.setState({
      isUnifiedView: true,
      unifiedRole: 'inbox',
      selectedMailbox: '__unified_inbox',
      emails: [own, row('x', 'usera@v016', 'c', { mailboxIds: { 'c:a': true } })],
      selectedEmailKeys: new Set(),
    });

    await useEmailStore.getState().moveEmailsToMailbox(client016, ['x'], 'f', 'usera@v016', [own]);

    expect(callsOf(client016.batchMoveEmails)).toEqual([[['x'], 'f', 'd']]);
    expect(callsOf(useEmailStore.getState().crossAccountMoveEmails)).toEqual([]);
    expect(listed()).toEqual(['usera@v016/c/x']);
  });

  // A thread of the team is expanded and one of its members that is not a
  // row of the list is selected. Its id also names usera's own first message
  // (`eaaaaab` on both test servers).
  describe('with a selected member of an expanded thread', () => {
    const member = row('eaaaaab', 'usera@v016', 'c', { threadId: 'tt', mailboxIds: { 'c:a': true } });
    const teamThread = threadKeyFor(member);

    beforeEach(() => {
      useEmailStore.setState({
        isUnifiedView: true,
        unifiedRole: 'inbox',
        selectedMailbox: '__unified_inbox',
        emails: [row('other', 'usera@v016', 'c', { threadId: 'tt', mailboxIds: { 'c:a': true } })],
        threadEmailsCache: new Map([[teamThread, [member]]]),
        expandedThreadIds: new Set([teamThread]),
        selectedEmailKeys: new Set([emailKeyFor(member)]),
      });
    });

    it('marks it as spam in the team account', async () => {
      await useEmailStore.getState().batchMarkAsSpam(client016, ['eaaaaab']);

      expect(callsOf(client016.markAsSpam)).toEqual([['eaaaaab', 'c', false]]);
    });

    it('puts it back in the team\'s Inbox with "Not spam" in "All Junk"', async () => {
      useEmailStore.setState({ unifiedRole: 'junk', selectedMailbox: '__unified_junk' });

      await useEmailStore.getState().batchUndoSpam(client016, ['eaaaaab']);

      expect(callsOf(client016.undoSpam)).toEqual([['eaaaaab', 'a', 'c']]);
    });

    it('reports a selected id found neither listed nor in a thread, and writes nothing for it', async () => {
      useEmailStore.setState({ selectedEmailKeys: new Set([keyOf('usera@v016', 'c', 'gone')]) });

      await expect(useEmailStore.getState().batchMarkAsSpam(client016, ['gone'])).rejects.toThrow(/not found/);

      expect(callsOf(client016.markAsSpam)).toEqual([]);
      expect(useEmailStore.getState().selectedEmailKeys).toEqual(new Set([keyOf('usera@v016', 'c', 'gone')]));
    });

    // The id with no account went to the account the list is reached
    // through, where it names usera's own message.
    it('deletes it into the team\'s Deleted Items, not the own account\'s', async () => {
      await useEmailStore.getState().batchDelete(client016, false);

      expect(callsOf(client016.batchMoveEmails)).toEqual([[['eaaaaab'], 'b', 'c', false]]);
      expect(useEmailStore.getState().error).toBeNull();
    });

    it('destroys it in the team account', async () => {
      await useEmailStore.getState().batchDelete(client016, true);

      expect(callsOf(client016.batchDeleteEmails)).toEqual([[['eaaaaab'], 'c']]);
    });

    it('marks it read in the team account and shows it read in the thread', async () => {
      await useEmailStore.getState().batchMarkAsRead(client016, true);

      expect(callsOf(client016.batchMarkAsRead)).toEqual([[['eaaaaab'], true, 'c']]);
      expect(useEmailStore.getState().threadEmailsCache.get(teamThread)?.[0].keywords.$seen).toBe(true);
    });

    it('archives it into the team\'s Archive', async () => {
      await useEmailStore.getState().batchArchive(client016);

      expect(archiveCalls(client016)).toEqual([[['eaaaaab'], 'g', 'c']]);
    });

    it('moves it out of the team account into the folder "Move to" offers', async () => {
      await useEmailStore.getState().batchMoveToMailbox(client016, 'f');

      expect(callsOf(client016.batchMoveEmails)).toEqual([]);
      expect(callsOf(useEmailStore.getState().crossAccountMoveEmails)).toEqual([
        [new Map([['usera@v016', ['eaaaaab']]]), 'usera@v016', 'f', undefined, 'c'],
      ]);
    });

    it('reports an id found neither listed nor in an expanded thread to every batch action, writing nothing', async () => {
      useEmailStore.setState({ selectedEmailKeys: new Set([keyOf('usera@v016', 'c', 'gone')]) });
      const error = () => useEmailStore.getState().error;

      await useEmailStore.getState().batchMarkAsRead(client016, true);
      expect(error()).toBe('Message not found in the list');
      await useEmailStore.getState().batchDelete(client016, false);
      expect(error()).toBe('Message not found in the list');
      await useEmailStore.getState().batchMoveToMailbox(client016, 'f');
      expect(error()).toBe('Message not found in the list');
      await expect(useEmailStore.getState().batchArchive(client016)).rejects.toThrow('Message not found in the list');

      for (const write of [client016.batchMarkAsRead, client016.batchMoveEmails, client016.batchDeleteEmails, client016.batchArchiveEmails]) {
        expect(callsOf(write)).toEqual([]);
      }
      expect(callsOf(useEmailStore.getState().crossAccountMoveEmails)).toEqual([]);
      expect(useEmailStore.getState().selectedEmailKeys).toEqual(new Set([keyOf('usera@v016', 'c', 'gone')]));
    });

    // A listed row can share a thread member's id; the selection is keyed by
    // account, so ticking the row leaves the member alone.
    it('acts on a ticked row, not on a thread member with the same id', async () => {
      const own = row('eaaaaab', 'usera@v016', 'd');
      useEmailStore.setState({ emails: [own], selectedEmailKeys: new Set([emailKeyFor(own)]) });

      await useEmailStore.getState().batchMarkAsSpam(client016, ['eaaaaab']);
      expect(callsOf(client016.markAsSpam)).toEqual([['eaaaaab', 'd', false]]);

      useEmailStore.setState({ emails: [own], selectedEmailKeys: new Set([emailKeyFor(own)]) });
      await useEmailStore.getState().batchDelete(client016, false);
      expect(callsOf(client016.batchMoveEmails)).toEqual([[['eaaaaab'], 'b', 'd', false]]);
    });
  });
});
