import { describe, it, expect } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { dedupeUnifiedAccounts, getCrossUnreadTotal, type UnifiedAccountClient } from '@/lib/unified-mailbox';

const mb = (id: string, role: string | undefined, unread = 0, originalId?: string): Mailbox =>
  ({ id, name: id, role, unreadEmails: unread, totalEmails: 0, originalId } as unknown as Mailbox);

const makeAccount = (over: Partial<UnifiedAccountClient> & { accountId: string }): UnifiedAccountClient => ({
  accountLabel: over.accountId,
  mailboxes: [],
  client: {} as unknown as IJMAPClient,
  clientAccountId: over.accountId,
  jmapAccountId: over.accountId,
  ...over,
});

// A folder of JMAP account `owner`, as seen through the login `via`.
const sharedEntry = (owner: string, via: string, mailboxes: Mailbox[]) =>
  makeAccount({ accountId: owner, jmapAccountId: owner, clientAccountId: via, isShared: true, mailboxes });

describe('dedupeUnifiedAccounts', () => {
  it('drops a shared entry whose folders the owner login already covers', () => {
    const alice = makeAccount({ accountId: 'login-a', jmapAccountId: 'A', mailboxes: [mb('inbox', 'inbox'), mb('f1', undefined, 1)] });
    const carolSeesAlice = sharedEntry('A', 'login-c', [mb('A:f1', undefined, 1, 'f1')]);
    const carol = makeAccount({ accountId: 'login-c', jmapAccountId: 'C', mailboxes: [mb('inbox', 'inbox')] });

    // The grantee's login may come first - the owner's own entry still wins.
    const out = dedupeUnifiedAccounts([carol, carolSeesAlice, alice]);
    expect(out).toEqual([carol, alice]);
    expect(getCrossUnreadTotal(out)).toBe(1);
  });

  it('keeps one copy when two grantee logins reach the same shared folder', () => {
    const viaBob = sharedEntry('A', 'login-b', [mb('A:f1', undefined, 1, 'f1')]);
    const viaCarol = sharedEntry('A', 'login-c', [mb('A:f1', undefined, 1, 'f1')]);
    const out = dedupeUnifiedAccounts([viaBob, viaCarol]);
    expect(out).toEqual([viaBob]);
    expect(getCrossUnreadTotal(out)).toBe(1);
  });

  it('keeps folders only one of the grantees can reach', () => {
    const viaBob = sharedEntry('A', 'login-b', [mb('A:f1', undefined, 1, 'f1')]);
    const viaCarol = sharedEntry('A', 'login-c', [mb('A:f1', undefined, 1, 'f1'), mb('A:f2', undefined, 2, 'f2')]);
    const out = dedupeUnifiedAccounts([viaBob, viaCarol]);
    expect(out.map((a) => a.mailboxes.map((m) => m.id))).toEqual([['A:f1'], ['A:f2']]);
    expect(out[1].clientAccountId).toBe('login-c');
    expect(getCrossUnreadTotal(out)).toBe(3);
  });

  it('does not merge distinct owners or personal accounts with equal mailbox ids', () => {
    const a = makeAccount({ accountId: 'login-a', jmapAccountId: 'A', mailboxes: [mb('inbox', 'inbox', 1)] });
    const b = makeAccount({ accountId: 'login-b', jmapAccountId: 'B', mailboxes: [mb('inbox', 'inbox', 1)] });
    const group = sharedEntry('G', 'login-a', [mb('G:inbox', 'inbox', 1, 'inbox')]);
    expect(dedupeUnifiedAccounts([a, b, group])).toEqual([a, b, group]);
  });
});
