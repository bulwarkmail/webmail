import { describe, it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import {
  getCrossIncludedMailboxes,
  buildCrossFilter,
  getCrossUnreadTotal,
  fetchCrossViewEmails,
  resolveSourceFolderName,
  type UnifiedAccountClient,
} from '@/lib/unified-mailbox';

const mb = (id: string, role: string | undefined, unread = 0, originalId?: string): Mailbox =>
  ({ id, name: id, role, unreadEmails: unread, totalEmails: 0, originalId } as unknown as Mailbox);

const makeAccount = (
  over: Partial<UnifiedAccountClient> & { accountId: string },
  clientImpl: Partial<IJMAPClient> = {},
): UnifiedAccountClient => ({
  accountLabel: over.accountId,
  mailboxes: [],
  client: clientImpl as unknown as IJMAPClient,
  clientAccountId: over.accountId,
  jmapAccountId: over.accountId,
  ...over,
});

describe('getCrossIncludedMailboxes', () => {
  it('excludes junk/sent/archive/trash/drafts, keeps inbox + custom folders', () => {
    const account = makeAccount({
      accountId: 'a',
      mailboxes: [
        mb('inbox', 'inbox'),
        mb('projects', undefined),
        mb('junk', 'junk'),
        mb('sent', 'sent'),
        mb('archive', 'archive'),
        mb('trash', 'trash'),
        mb('drafts', 'drafts'),
      ],
    });
    const ids = getCrossIncludedMailboxes(account).map((m) => m.id);
    expect(ids).toEqual(['inbox', 'projects']);
  });
});

describe('buildCrossFilter', () => {
  it('all → single inMailbox for one folder', () => {
    expect(buildCrossFilter('all', ['m1'])).toEqual({ inMailbox: 'm1' });
  });

  it('all → OR of inMailbox for multiple folders', () => {
    expect(buildCrossFilter('all', ['m1', 'm2'])).toEqual({
      operator: 'OR',
      conditions: [{ inMailbox: 'm1' }, { inMailbox: 'm2' }],
    });
  });

  it('unread → AND(membership, notKeyword $seen)', () => {
    expect(buildCrossFilter('unread', ['m1', 'm2'])).toEqual({
      operator: 'AND',
      conditions: [
        { operator: 'OR', conditions: [{ inMailbox: 'm1' }, { inMailbox: 'm2' }] },
        { notKeyword: '$seen' },
      ],
    });
  });

  it('starred → AND(membership, hasKeyword $flagged)', () => {
    expect(buildCrossFilter('starred', ['m1'])).toEqual({
      operator: 'AND',
      conditions: [{ inMailbox: 'm1' }, { hasKeyword: '$flagged' }],
    });
  });
});

describe('getCrossUnreadTotal', () => {
  it('sums unread across included folders of every account, ignoring excluded roles', () => {
    const a = makeAccount({
      accountId: 'a',
      mailboxes: [mb('inbox', 'inbox', 3), mb('proj', undefined, 2), mb('junk', 'junk', 50)],
    });
    const b = makeAccount({
      accountId: 'b',
      mailboxes: [mb('inbox', 'inbox', 5), mb('sent', 'sent', 99)],
    });
    expect(getCrossUnreadTotal([a, b])).toBe(10);
  });
});

describe('resolveSourceFolderName', () => {
  const emailIn = (ids: string[]): Email =>
    ({ mailboxIds: Object.fromEntries(ids.map((id) => [id, true])) } as unknown as Email);

  it('returns the name of the folder the email is in (personal account)', () => {
    const boxes = [mb('inbox', 'inbox'), mb('proj', undefined)];
    expect(resolveSourceFolderName(emailIn(['proj']), boxes)).toBe('proj');
  });

  it('matches shared mailboxes by originalId (email keyed by owner-side id)', () => {
    // shared mailbox: namespaced store id, but email.mailboxIds uses originalId
    const shared = { id: 'owner:inbox', role: 'inbox', unreadEmails: 0, totalEmails: 0, originalId: 'orig-inbox', name: 'Team Inbox' } as unknown as Mailbox;
    expect(resolveSourceFolderName(emailIn(['orig-inbox']), [shared])).toBe('Team Inbox');
  });

  it('returns undefined when no known folder contains the email', () => {
    expect(resolveSourceFolderName(emailIn(['unknown']), [mb('inbox', 'inbox')])).toBeUndefined();
  });
});

describe('fetchCrossViewEmails', () => {
  it('merges + date-sorts across accounts and stamps account info', async () => {
    const clientA = {
      advancedSearchEmails: vi.fn().mockResolvedValue({
        emails: [{ id: 'a1', receivedAt: '2026-01-01T10:00:00Z' } as Email],
        total: 1,
        hasMore: false,
      }),
    };
    const clientB = {
      advancedSearchEmails: vi.fn().mockResolvedValue({
        emails: [{ id: 'b1', receivedAt: '2026-01-02T10:00:00Z' } as Email],
        total: 1,
        hasMore: true,
      }),
    };
    const a = makeAccount({ accountId: 'a', accountLabel: 'A', mailboxes: [mb('inbox', 'inbox')] }, clientA);
    const b = makeAccount({ accountId: 'b', accountLabel: 'B', mailboxes: [mb('inbox', 'inbox')] }, clientB);

    const result = await fetchCrossViewEmails([a, b], 'all', 50, 0);

    expect(result.emails.map((e) => e.id)).toEqual(['b1', 'a1']); // newest first
    expect(result.emails[0].accountId).toBe('b');
    expect(result.emails[1].accountLabel).toBe('A');
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(true);
  });

  it('resolves shared folders via originalId + owner accountId', async () => {
    const advancedSearchEmails = vi.fn().mockResolvedValue({ emails: [], total: 0, hasMore: false });
    const shared = makeAccount(
      { accountId: 'owner-1', accountLabel: 'Shared', isShared: true, mailboxes: [mb('ns:inbox', 'inbox', 0, 'orig-inbox')] },
      { advancedSearchEmails },
    );

    await fetchCrossViewEmails([shared], 'unread', 50, 0);

    const [filter, accountId] = advancedSearchEmails.mock.calls[0];
    expect(accountId).toBe('owner-1');
    // filter membership uses the originalId, not the namespaced id
    expect(JSON.stringify(filter)).toContain('orig-inbox');
    expect(JSON.stringify(filter)).not.toContain('ns:inbox');
  });

  it('collects per-account errors without failing the whole fan-out', async () => {
    const ok = makeAccount(
      { accountId: 'ok', mailboxes: [mb('inbox', 'inbox')] },
      { advancedSearchEmails: vi.fn().mockResolvedValue({ emails: [{ id: 'x', receivedAt: '2026-01-01T00:00:00Z' } as Email], total: 1, hasMore: false }) },
    );
    const bad = makeAccount(
      { accountId: 'bad', mailboxes: [mb('inbox', 'inbox')] },
      { advancedSearchEmails: vi.fn().mockRejectedValue(new Error('boom')) },
    );

    const result = await fetchCrossViewEmails([ok, bad], 'all', 50, 0);
    expect(result.emails.map((e) => e.id)).toEqual(['x']);
    expect(result.errors.get('bad')).toBe('boom');
  });
});
