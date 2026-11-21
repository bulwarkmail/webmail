import { describe, expect, it } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { unifiedEmptySummary, type UnifiedAccountClient } from '@/lib/unified-mailbox';

// "Empty trash (all accounts)" also empties the Trash of group and shared
// accounts the user may delete from. Its question counts their messages and
// names them, and names the ones it leaves alone (#1738).

const trash = (id: string, totalEmails: number, extra: Partial<Mailbox> = {}): Mailbox => ({
  id, name: 'Trash', role: 'trash', totalEmails, unreadEmails: 0, totalThreads: totalEmails, unreadThreads: 0,
  myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true },
  ...extra,
} as Mailbox);

const entry = (accountId: string, accountLabel: string, mailboxes: Mailbox[], isShared = false): UnifiedAccountClient => ({
  accountId, accountLabel, client: {} as IJMAPClient, mailboxes,
  clientAccountId: 'login-a', jmapAccountId: accountId, isShared,
});

describe('unifiedEmptySummary', () => {
  it('counts the shared accounts it empties and names them and the ones it keeps', () => {
    const accounts = [
      // The shared Trash in the login's own list belongs to the owner's entry: counted once.
      entry('login-a', 'Me', [trash('a-trash', 3), trash('team:trash', 4, { isShared: true, accountId: 'team' })]),
      entry('team', 'Team', [trash('team:trash', 4, { isShared: true, accountId: 'team' })], true),
      entry('boss', 'Boss', [trash('boss:trash', 9, { isShared: true, accountId: 'boss',
        myRights: { mayReadItems: true, mayAddItems: false, mayRemoveItems: false } as Mailbox['myRights'] })], true),
    ];
    expect(unifiedEmptySummary(accounts, 'trash')).toEqual({ count: 7, shared: ['Team'], kept: ['Boss'] });
  });

  it('keeps a shared Trash whose rights it does not know', () => {
    const accounts = [entry('team', 'Team', [trash('team:trash', 4, { isShared: true, myRights: undefined })], true)];
    expect(unifiedEmptySummary(accounts, 'trash')).toEqual({ count: 0, shared: [], kept: ['Team'] });
  });

  it('names no account when only the user’s own logins have a Trash', () => {
    expect(unifiedEmptySummary([entry('login-a', 'Me', [trash('a-trash', 2)])], 'trash'))
      .toEqual({ count: 2, shared: [], kept: [] });
  });
});
