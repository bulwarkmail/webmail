import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';
import type { Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { UnifiedAccountClient } from '@/lib/unified-mailbox';

/**
 * "All Trash" (the unified sidebar row) had no context menu at all, so there
 * was no way to empty trash across every connected account short of doing it
 * one account at a time. emptyUnifiedMailbox is the store action behind the
 * new "Empty trash (all accounts)" menu item: it must call emptyMailbox on
 * each account's OWN client with that account's own mailbox id (never the
 * active client, whose id namespace is meaningless for another account), and
 * keep going even if one account's request throws.
 */

function makeMailbox(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: 'trash',
    name: 'Trash',
    role: 'trash',
    sortOrder: 0,
    totalEmails: 3,
    unreadEmails: 0,
    totalThreads: 3,
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

function makeClient(emptyMailboxImpl: IJMAPClient['emptyMailbox']) {
  return { emptyMailbox: emptyMailboxImpl } as unknown as IJMAPClient;
}

describe('emptyUnifiedMailbox ("All Trash" empty-across-accounts)', () => {
  beforeEach(() => {
    useEmailStore.setState({
      isUnifiedView: false,
      unifiedRole: null,
      selectedMailbox: '',
      mailboxes: [],
      accountMailboxes: {},
    });
    useAuthStore.setState({ activeAccountId: 'account-a' } as never);
    clearAllHooks();
  });

  afterEach(() => clearAllHooks());

  it('empties every account’s trash through its own client and own mailbox id', async () => {
    const clientA = makeClient(vi.fn().mockResolvedValue(2));
    const clientB = makeClient(vi.fn().mockResolvedValue(5));

    const accounts: UnifiedAccountClient[] = [
      {
        accountId: 'account-a',
        accountLabel: 'A',
        client: clientA,
        mailboxes: [makeMailbox({ id: 'a-trash' })],
        clientAccountId: 'account-a',
        jmapAccountId: 'account-a',
      },
      {
        accountId: 'account-b',
        accountLabel: 'B',
        client: clientB,
        mailboxes: [makeMailbox({ id: 'b-trash' })],
        clientAccountId: 'account-b',
        jmapAccountId: 'account-b',
      },
    ];

    const { total, errors } = await useEmailStore.getState().emptyUnifiedMailbox(accounts, 'trash');

    expect(clientA.emptyMailbox).toHaveBeenCalledWith('a-trash', undefined);
    expect(clientB.emptyMailbox).toHaveBeenCalledWith('b-trash', undefined);
    expect(total).toBe(7);
    expect(errors.size).toBe(0);
  });

  // With "include group accounts" the unified scope also lists group and
  // delegated owners. Their Trash is someone else's and must stay as it is.
  it('leaves a group or delegated owner’s Trash alone', async () => {
    const client = makeClient(vi.fn().mockResolvedValue(1));

    const accounts: UnifiedAccountClient[] = [
      {
        accountId: 'account-a',
        accountLabel: 'A',
        client,
        // A shared Trash in a login's own list is passed over too.
        mailboxes: [
          makeMailbox({ id: 'owner-y:y-trash', originalId: 'y-trash', isShared: true, accountId: 'owner-y' }),
          makeMailbox({ id: 'a-trash' }),
        ],
        clientAccountId: 'account-a',
        jmapAccountId: 'account-a',
      },
      {
        accountId: 'owner-x',
        accountLabel: 'Owner X',
        client,
        mailboxes: [makeMailbox({ id: 'owner-x:x-trash', originalId: 'x-trash', isShared: true, accountId: 'owner-x' })],
        clientAccountId: 'account-a',
        jmapAccountId: 'owner-x',
        isShared: true,
      },
    ];

    const { total } = await useEmailStore.getState().emptyUnifiedMailbox(accounts, 'trash');

    expect(client.emptyMailbox).toHaveBeenCalledTimes(1);
    expect(client.emptyMailbox).toHaveBeenCalledWith('a-trash', undefined);
    expect(total).toBe(1);
  });

  it('collects a per-account failure instead of aborting the whole batch', async () => {
    const clientA = makeClient(vi.fn().mockRejectedValue(new Error('boom')));
    const clientB = makeClient(vi.fn().mockResolvedValue(4));

    const accounts: UnifiedAccountClient[] = [
      {
        accountId: 'account-a',
        accountLabel: 'A',
        client: clientA,
        mailboxes: [makeMailbox({ id: 'a-trash' })],
        clientAccountId: 'account-a',
        jmapAccountId: 'account-a',
      },
      {
        accountId: 'account-b',
        accountLabel: 'B',
        client: clientB,
        mailboxes: [makeMailbox({ id: 'b-trash' })],
        clientAccountId: 'account-b',
        jmapAccountId: 'account-b',
      },
    ];

    const { total, errors } = await useEmailStore.getState().emptyUnifiedMailbox(accounts, 'trash');

    expect(total).toBe(4);
    expect(errors.get('account-a')).toBe('boom');
    expect(errors.has('account-b')).toBe(false);
  });

  it('skips an account with no mailbox for that role', async () => {
    const client = makeClient(vi.fn().mockResolvedValue(9));

    const accounts: UnifiedAccountClient[] = [
      {
        accountId: 'account-a',
        accountLabel: 'A',
        client,
        mailboxes: [makeMailbox({ id: 'a-inbox', role: 'inbox' })], // no trash
        clientAccountId: 'account-a',
        jmapAccountId: 'account-a',
      },
    ];

    const { total, errors } = await useEmailStore.getState().emptyUnifiedMailbox(accounts, 'trash');

    expect(client.emptyMailbox).not.toHaveBeenCalled();
    expect(total).toBe(0);
    expect(errors.size).toBe(0);
  });

  it('zeroes the live counters so the sidebar badge updates without a refetch', async () => {
    const clientA = makeClient(vi.fn().mockResolvedValue(2));
    const clientB = makeClient(vi.fn().mockResolvedValue(5));

    useEmailStore.setState({
      mailboxes: [makeMailbox({ id: 'a-trash', totalEmails: 2, unreadEmails: 1 })],
      accountMailboxes: {
        'account-b': [makeMailbox({ id: 'b-trash', totalEmails: 5, unreadEmails: 0 })],
      },
    });

    const accounts: UnifiedAccountClient[] = [
      {
        accountId: 'account-a',
        accountLabel: 'A',
        client: clientA,
        mailboxes: [makeMailbox({ id: 'a-trash', totalEmails: 2, unreadEmails: 1 })],
        clientAccountId: 'account-a', // matches active id -> lives in `mailboxes`
        jmapAccountId: 'account-a',
      },
      {
        accountId: 'account-b',
        accountLabel: 'B',
        client: clientB,
        mailboxes: [makeMailbox({ id: 'b-trash', totalEmails: 5, unreadEmails: 0 })],
        clientAccountId: 'account-b', // not active -> lives in accountMailboxes
        jmapAccountId: 'account-b',
      },
    ];

    await useEmailStore.getState().emptyUnifiedMailbox(accounts, 'trash');

    const s = useEmailStore.getState();
    expect(s.mailboxes[0].totalEmails).toBe(0);
    expect(s.mailboxes[0].unreadEmails).toBe(0);
    expect(s.accountMailboxes['account-b'][0].totalEmails).toBe(0);
  });

  it('clears the visible email list when currently viewing the unified role that was emptied', async () => {
    const client = makeClient(vi.fn().mockResolvedValue(1));
    const e1 = { id: 'e1', sourceClientAccountId: 'account-a', sourceAccountId: 'account-a' };
    useEmailStore.setState({
      isUnifiedView: true,
      unifiedRole: 'trash',
      emails: [e1 as never],
      selectedEmail: e1 as never,
      totalEmails: 1,
      hasMoreEmails: true,
    });

    const accounts: UnifiedAccountClient[] = [
      {
        accountId: 'account-a',
        accountLabel: 'A',
        client,
        mailboxes: [makeMailbox({ id: 'a-trash' })],
        clientAccountId: 'account-a',
        jmapAccountId: 'account-a',
      },
    ];

    await useEmailStore.getState().emptyUnifiedMailbox(accounts, 'trash');

    const s = useEmailStore.getState();
    expect(s.emails).toEqual([]);
    expect(s.selectedEmail).toBeNull();
    expect(s.hasMoreEmails).toBe(false);
  });

  it('keeps the messages of an account that failed in the open list', async () => {
    const clientA = makeClient(vi.fn().mockRejectedValue(new Error('boom')));
    const clientB = makeClient(vi.fn().mockResolvedValue(1));
    const fromA = { id: 'a1', sourceClientAccountId: 'account-a', sourceAccountId: 'account-a' };
    const fromB = { id: 'b1', sourceClientAccountId: 'account-b', sourceAccountId: 'account-b' };
    useEmailStore.setState({
      isUnifiedView: true,
      unifiedRole: 'trash',
      emails: [fromA, fromB] as never,
      selectedEmail: fromA as never,
      totalEmails: 3,
      hasMoreEmails: true,
    });

    const accounts: UnifiedAccountClient[] = [
      {
        accountId: 'account-a',
        accountLabel: 'A',
        client: clientA,
        mailboxes: [makeMailbox({ id: 'a-trash' })],
        clientAccountId: 'account-a',
        jmapAccountId: 'account-a',
      },
      {
        accountId: 'account-b',
        accountLabel: 'B',
        client: clientB,
        mailboxes: [makeMailbox({ id: 'b-trash' })],
        clientAccountId: 'account-b',
        jmapAccountId: 'account-b',
      },
    ];

    const { emptied } = await useEmailStore.getState().emptyUnifiedMailbox(accounts, 'trash');

    const s = useEmailStore.getState();
    expect(emptied).toEqual(['account-b']);
    expect(s.emails.map((e) => e.id)).toEqual(['a1']);
    expect(s.selectedEmail?.id).toBe('a1');
    expect(s.totalEmails).toBe(2);
    expect(s.hasMoreEmails).toBe(true);
  });

  it('does not invent a folder list for a login that had none', async () => {
    const client = makeClient(vi.fn().mockResolvedValue(1));
    const accounts: UnifiedAccountClient[] = [
      {
        accountId: 'account-b',
        accountLabel: 'B',
        client,
        mailboxes: [makeMailbox({ id: 'b-trash' })],
        clientAccountId: 'account-b',
        jmapAccountId: 'account-b',
      },
    ];

    await useEmailStore.getState().emptyUnifiedMailbox(accounts, 'trash');

    expect('account-b' in useEmailStore.getState().accountMailboxes).toBe(false);
  });

  // Emptying one folder asks plugins first and tells them afterwards; the
  // all-accounts empty has to do the same for each account's Trash.
  it('asks plugins per account and skips an account whose Trash a plugin keeps', async () => {
    const clientA = makeClient(vi.fn().mockResolvedValue(2));
    const clientB = makeClient(vi.fn().mockResolvedValue(5));
    const before = vi.fn(({ mailboxId }: { mailboxId: string }) => mailboxId !== 'a-trash');
    const after = vi.fn();
    emailHooks.onBeforeMailboxEmpty.register('t', before);
    emailHooks.onMailboxEmpty.register('t', after);

    const accounts: UnifiedAccountClient[] = [
      {
        accountId: 'account-a',
        accountLabel: 'A',
        client: clientA,
        mailboxes: [makeMailbox({ id: 'a-trash', totalEmails: 2 })],
        clientAccountId: 'account-a',
        jmapAccountId: 'account-a',
      },
      {
        accountId: 'account-b',
        accountLabel: 'B',
        client: clientB,
        mailboxes: [makeMailbox({ id: 'b-trash', totalEmails: 5 })],
        clientAccountId: 'account-b',
        jmapAccountId: 'account-b',
      },
    ];

    const { total, errors } = await useEmailStore.getState().emptyUnifiedMailbox(accounts, 'trash');

    expect(before).toHaveBeenCalledWith({ mailboxId: 'a-trash', role: 'trash' });
    expect(before).toHaveBeenCalledWith({ mailboxId: 'b-trash', role: 'trash' });
    expect(clientA.emptyMailbox).not.toHaveBeenCalled();
    expect(clientB.emptyMailbox).toHaveBeenCalledWith('b-trash', undefined);
    expect(total).toBe(5);
    expect(errors.size).toBe(0);
    expect(after).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith({ mailboxId: 'b-trash', role: 'trash', count: 5 });
  });
});
