import { describe, it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import {
  findMailboxByRole,
  fetchUnifiedEmails,
  searchUnifiedEmails,
  advancedSearchUnifiedEmails,
  fetchUnifiedMailboxCounts,
  getUnifiedRoles,
  type UnifiedAccountClient,
} from '@/lib/unified-mailbox';

// ── factories ────────────────────────────────────────────────────────────────
const makeEmail = (id: string, receivedAt: string): Email =>
  ({ id, receivedAt } as unknown as Email);

const makeMailbox = (over: Partial<Mailbox> & { role: string }): Mailbox =>
  ({ id: `mb-${over.role}`, unreadEmails: 0, totalEmails: 0, ...over } as unknown as Mailbox);

type FetchResult = { emails: Email[]; total: number; hasMore: boolean };

function makeAccount(
  over: Partial<UnifiedAccountClient> & { accountId: string },
  clientImpl: Partial<IJMAPClient> = {},
): UnifiedAccountClient {
  return {
    accountLabel: over.accountId,
    mailboxes: [],
    client: clientImpl as unknown as IJMAPClient,
    clientAccountId: over.accountId,
    jmapAccountId: over.accountId,
    ...over,
  };
}

describe('findMailboxByRole', () => {
  it('returns the first mailbox matching the role', () => {
    const a = makeMailbox({ role: 'inbox', id: 'a' });
    const b = makeMailbox({ role: 'inbox', id: 'b' });
    expect(findMailboxByRole([a, b], 'inbox')).toBe(a);
  });

  it('returns undefined when no mailbox has the role', () => {
    expect(findMailboxByRole([makeMailbox({ role: 'sent' })], 'inbox')).toBeUndefined();
  });
});

describe('fetchUnifiedEmails', () => {
  it('merges across accounts and sorts by receivedAt descending, decorating each email', async () => {
    const acc1 = makeAccount(
      { accountId: 'A', accountLabel: 'Account A', mailboxes: [makeMailbox({ role: 'inbox', id: 'a-in' })] },
      { getEmails: vi.fn(async (): Promise<FetchResult> => ({
        emails: [makeEmail('a1', '2026-01-01T10:00:00Z'), makeEmail('a2', '2026-01-03T10:00:00Z')],
        total: 5, hasMore: false,
      })) },
    );
    const acc2 = makeAccount(
      { accountId: 'B', accountLabel: 'Account B', mailboxes: [makeMailbox({ role: 'inbox', id: 'b-in' })] },
      { getEmails: vi.fn(async (): Promise<FetchResult> => ({
        emails: [makeEmail('b1', '2026-01-02T10:00:00Z')],
        total: 3, hasMore: true,
      })) },
    );

    const result = await fetchUnifiedEmails([acc1, acc2], 'inbox', 20, 0);

    expect(result.emails.map((e) => e.id)).toEqual(['a2', 'b1', 'a1']); // newest first
    expect(result.total).toBe(8); // sum of per-account totals, not merged length
    expect(result.hasMore).toBe(true); // OR across accounts
    expect(result.errors.size).toBe(0);
    // decoration
    const a2 = result.emails.find((e) => e.id === 'a2')!;
    expect(a2.accountId).toBe('A');
    expect(a2.accountLabel).toBe('Account A');
    expect(a2.sourceClientAccountId).toBe('A');
    expect(a2.sourceAccountId).toBe('A');
    // getEmails called with (mailboxId, accountId=undefined for personal, limit, position)
    expect(acc1.client.getEmails).toHaveBeenCalledWith('a-in', undefined, 20, 0);
  });

  it('isolates per-account errors and still returns the rest', async () => {
    const ok = makeAccount(
      { accountId: 'OK', mailboxes: [makeMailbox({ role: 'inbox', id: 'ok-in' })] },
      { getEmails: vi.fn(async (): Promise<FetchResult> => ({ emails: [makeEmail('x', '2026-01-01T00:00:00Z')], total: 1, hasMore: false })) },
    );
    const boom = makeAccount(
      { accountId: 'BOOM', mailboxes: [makeMailbox({ role: 'inbox', id: 'boom-in' })] },
      { getEmails: vi.fn(async (): Promise<FetchResult> => { throw new Error('network down'); }) },
    );

    const result = await fetchUnifiedEmails([ok, boom], 'inbox', 20, 0);
    expect(result.emails.map((e) => e.id)).toEqual(['x']);
    expect(result.total).toBe(1);
    expect(result.errors.get('BOOM')).toBe('network down');
  });

  it('stringifies a non-Error rejection', async () => {
    const acc = makeAccount(
      { accountId: 'S', mailboxes: [makeMailbox({ role: 'inbox' })] },
      { getEmails: vi.fn(async (): Promise<FetchResult> => { throw 'boom-string'; }) },
    );
    const result = await fetchUnifiedEmails([acc], 'inbox', 20, 0);
    expect(result.errors.get('S')).toBe('boom-string');
  });

  it('skips accounts that have no mailbox for the role (no error recorded)', async () => {
    const getEmails = vi.fn(async (): Promise<FetchResult> => ({ emails: [], total: 0, hasMore: false }));
    const acc = makeAccount(
      { accountId: 'NOROLE', mailboxes: [makeMailbox({ role: 'sent' })] },
      { getEmails },
    );
    const result = await fetchUnifiedEmails([acc], 'inbox', 20, 0);
    expect(result).toEqual({ emails: [], total: 0, hasMore: false, errors: new Map() });
    expect(getEmails).not.toHaveBeenCalled();
  });

  it('returns an empty result for no accounts', async () => {
    const result = await fetchUnifiedEmails([], 'inbox', 20, 0);
    expect(result).toEqual({ emails: [], total: 0, hasMore: false, errors: new Map() });
  });

  it('does NOT mutate the source email objects (decorates copies)', async () => {
    const original = makeEmail('m1', '2026-01-01T00:00:00Z');
    const acc = makeAccount(
      { accountId: 'A', accountLabel: 'Label A', mailboxes: [makeMailbox({ role: 'inbox' })] },
      { getEmails: vi.fn(async (): Promise<FetchResult> => ({ emails: [original], total: 1, hasMore: false })) },
    );
    const res = await fetchUnifiedEmails([acc], 'inbox', 20, 0);
    // The returned email carries the account info, but the client's object is untouched.
    expect(res.emails[0]).toMatchObject({ id: 'm1', accountId: 'A', accountLabel: 'Label A' });
    expect('accountId' in original).toBe(false);
    expect('accountLabel' in original).toBe(false);
  });
});

describe('resolveJmapTarget (via searchUnifiedEmails / advancedSearchUnifiedEmails)', () => {
  const empty = async (): Promise<FetchResult> => ({ emails: [], total: 0, hasMore: false });

  it('personal account: uses mailbox.id and undefined accountId', async () => {
    const searchEmails = vi.fn(empty);
    const acc = makeAccount(
      { accountId: 'A', mailboxes: [makeMailbox({ role: 'inbox', id: 'real-id' })] },
      { searchEmails },
    );
    await searchUnifiedEmails([acc], 'inbox', 'hello', 10, 0);
    expect(searchEmails).toHaveBeenCalledWith('hello', 'real-id', undefined, 10, 0);
  });

  it('shared account: uses mailbox.originalId and the owner accountId', async () => {
    const searchEmails = vi.fn(empty);
    const acc = makeAccount(
      { accountId: 'OWNER', isShared: true, mailboxes: [makeMailbox({ role: 'inbox', id: 'OWNER:orig', originalId: 'orig' })] },
      { searchEmails },
    );
    await searchUnifiedEmails([acc], 'inbox', 'q', 10, 5);
    expect(searchEmails).toHaveBeenCalledWith('q', 'orig', 'OWNER', 10, 5);
  });

  it('shared account without originalId: falls back to mailbox.id', async () => {
    const searchEmails = vi.fn(empty);
    const acc = makeAccount(
      { accountId: 'OWNER', isShared: true, mailboxes: [makeMailbox({ role: 'inbox', id: 'just-id' })] },
      { searchEmails },
    );
    await searchUnifiedEmails([acc], 'inbox', 'q', 10, 0);
    expect(searchEmails).toHaveBeenCalledWith('q', 'just-id', 'OWNER', 10, 0);
  });

  it('advancedSearch: builds the filter from the resolved mailbox id and forwards accountId', async () => {
    const advancedSearchEmails = vi.fn(empty);
    const acc = makeAccount(
      { accountId: 'A', mailboxes: [makeMailbox({ role: 'inbox', id: 'mbx' })] },
      { advancedSearchEmails },
    );
    const filterFor = vi.fn((mailboxId: string) => ({ inMailbox: mailboxId, from: 'x' }));
    await advancedSearchUnifiedEmails([acc], 'inbox', filterFor, 10, 0);
    expect(filterFor).toHaveBeenCalledWith('mbx');
    expect(advancedSearchEmails).toHaveBeenCalledWith({ inMailbox: 'mbx', from: 'x' }, undefined, 10, 0);
  });
});

describe('fetchUnifiedMailboxCounts', () => {
  it('aggregates counts per role across accounts, in ALL_UNIFIED_ROLES order, omitting absent roles', () => {
    const acc1 = makeAccount({ accountId: 'A', mailboxes: [
      makeMailbox({ role: 'inbox', unreadEmails: 2, totalEmails: 10 }),
      makeMailbox({ role: 'sent', unreadEmails: 0, totalEmails: 4 }),
    ] });
    const acc2 = makeAccount({ accountId: 'B', mailboxes: [
      makeMailbox({ role: 'inbox', unreadEmails: 3, totalEmails: 7 }),
    ] });

    expect(fetchUnifiedMailboxCounts([acc1, acc2])).toEqual([
      { role: 'inbox', unreadEmails: 5, totalEmails: 17 },
      { role: 'sent', unreadEmails: 0, totalEmails: 4 },
    ]);
  });

  it('returns an empty array when no accounts have mailboxes', () => {
    expect(fetchUnifiedMailboxCounts([makeAccount({ accountId: 'A' })])).toEqual([]);
  });
});

describe('getUnifiedRoles', () => {
  it('lists roles present in at least one account once, in canonical order', () => {
    const acc1 = makeAccount({ accountId: 'A', mailboxes: [makeMailbox({ role: 'drafts' }), makeMailbox({ role: 'inbox' })] });
    const acc2 = makeAccount({ accountId: 'B', mailboxes: [makeMailbox({ role: 'inbox' }), makeMailbox({ role: 'trash' })] });
    expect(getUnifiedRoles([acc1, acc2])).toEqual(['inbox', 'drafts', 'trash']);
  });
});
