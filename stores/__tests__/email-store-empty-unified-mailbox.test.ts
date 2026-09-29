import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
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

describe('emptyUnifiedMailbox (#1131: "All Trash" empty-across-accounts)', () => {
  beforeEach(() => {
    useEmailStore.setState({
      isUnifiedView: false,
      unifiedRole: null,
      selectedMailbox: '',
      mailboxes: [],
      accountMailboxes: {},
    });
    useAuthStore.setState({ activeAccountId: 'account-a' } as never);
  });

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

  it('routes a shared account through its owner-scoped originalId + accountId', async () => {
    const client = makeClient(vi.fn().mockResolvedValue(1));

    const accounts: UnifiedAccountClient[] = [
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

    await useEmailStore.getState().emptyUnifiedMailbox(accounts, 'trash');

    expect(client.emptyMailbox).toHaveBeenCalledWith('x-trash', 'owner-x');
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
    useEmailStore.setState({
      isUnifiedView: true,
      unifiedRole: 'trash',
      emails: [{ id: 'e1' } as never],
      selectedEmail: { id: 'e1' } as never,
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
  });
});
