import { describe, expect, it } from 'vitest';
import { fetchUnifiedEmails, fetchTagEmails, positionsByAccount, type UnifiedAccountClient } from '@/lib/unified-mailbox';
import type { Email } from '@/lib/jmap/types';

// The unified inbox (and the tag and all-folders search views) paged every
// account with the merged list's length as its own position, so each
// account skipped the rows between its own count and the merged length:
// with two accounts of 120 mails, 100 never showed up.

function fakeAccount(name: string, count: number): UnifiedAccountClient {
  // Newest first; receivedAt interleaves the two accounts.
  const all = Array.from({ length: count }, (_, i) => ({
    id: `${name}-${i}`, threadId: `${name}-t${i}`, mailboxIds: { inbox: true }, keywords: {},
    receivedAt: new Date(Date.UTC(2026, 8, 1) - (i * 2 + (name === 'B' ? 1 : 0)) * 60000).toISOString(),
  })) as unknown as Email[];
  const page = (limit: number, position: number) => {
    const emails = all.slice(position, position + limit);
    return { emails, total: count, hasMore: position + emails.length < count };
  };
  return {
    accountId: name, accountLabel: name, clientAccountId: name, isShared: false,
    mailboxes: [{ id: 'inbox', role: 'inbox', name: 'Inbox' }],
    client: {
      getEmails: async (_mb: unknown, _acct: unknown, limit: number, position: number) => page(limit, position),
    },
  } as unknown as UnifiedAccountClient;
}

async function scrollToEnd(fetchPage: (position: Record<string, number> | number) => Promise<{ emails: Email[]; hasMore: boolean }>) {
  let list: Email[] = [];
  let result = await fetchPage(0);
  list = result.emails;
  while (result.hasMore) {
    result = await fetchPage(positionsByAccount(list));
    const seen = new Set(list.map((e) => e.id));
    list = [...list, ...result.emails.filter((e) => !seen.has(e.id))];
  }
  return list;
}

describe('paging a merged list of several accounts', () => {
  const accounts = [fakeAccount('A', 120), fakeAccount('B', 120)];

  it('shows every message of every account in the unified inbox', async () => {
    const list = await scrollToEnd((position) => fetchUnifiedEmails(accounts, 'inbox', 50, position));
    expect(list).toHaveLength(240);
  });

  it('shows every message in a tag view', async () => {
    const list = await scrollToEnd((position) => fetchTagEmails(accounts, '$label:x', 50, position));
    expect(list).toHaveLength(240);
  });

  it('counts each account on its own', () => {
    expect(positionsByAccount([{ accountId: 'A' }, { accountId: 'B' }, { accountId: 'A' }] as Email[]))
      .toEqual({ A: 2, B: 1 });
  });
});
