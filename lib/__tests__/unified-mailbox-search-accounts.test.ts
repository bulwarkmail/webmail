import { describe, it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { advancedSearchAcrossAccounts, searchAcrossAccounts, type UnifiedAccountClient } from '@/lib/unified-mailbox';

// The "All folders" search scope spans the login's own account and every
// group/shared account it reaches: one folder-less query per account, the
// pages merged newest first and every hit stamped with its source (#1082).

const mb = (id: string, name: string, originalId?: string): Mailbox =>
  ({ id, name, role: 'inbox', unreadEmails: 0, totalEmails: 0, originalId } as unknown as Mailbox);

function email(id: string, receivedAt: string, mailbox: string): Email {
  return {
    id, threadId: `t-${id}`, mailboxIds: { [mailbox]: true }, keywords: {},
    subject: id, receivedAt, from: [], to: [], preview: '', size: 1, hasAttachment: false,
  } as Email;
}

type Page = { emails: Email[]; total: number; hasMore: boolean };
const page = (emails: Email[], total = emails.length, hasMore = false): Page => ({ emails, total, hasMore });

const makeAccount = (
  over: Partial<UnifiedAccountClient> & { accountId: string },
  client: Partial<IJMAPClient>,
): UnifiedAccountClient => ({
  accountLabel: over.accountId,
  mailboxes: [],
  client: client as IJMAPClient,
  clientAccountId: 'login',
  jmapAccountId: over.accountId,
  ...over,
});

const ownMailboxes = [mb('inbox', 'Inbox')];
const groupMailboxes = [mb('group:g-inbox', 'Abrir Chamados', 'g-inbox')];

describe('searchAcrossAccounts', () => {
  it('asks every account without a folder constraint and merges newest first', async () => {
    const ownSearch = vi.fn(async () => page([email('own-1', '2026-09-10T00:00:00Z', 'inbox')]));
    const groupSearch = vi.fn(async () => page([email('grp-1', '2026-09-12T00:00:00Z', 'group:g-inbox')], 7, true));
    const own = makeAccount({ accountId: 'login', jmapAccountId: 'me', mailboxes: ownMailboxes }, { searchEmails: ownSearch });
    const group = makeAccount(
      { accountId: 'group', isShared: true, accountLabel: 'Team', mailboxes: groupMailboxes },
      { searchEmails: groupSearch },
    );

    const result = await searchAcrossAccounts([own, group], 'acesso', 50, 0);

    expect(ownSearch).toHaveBeenCalledWith('acesso', undefined, undefined, 50, 0);
    expect(groupSearch).toHaveBeenCalledWith('acesso', undefined, 'group', 50, 0);
    expect(result.emails.map((e) => e.id)).toEqual(['grp-1', 'own-1']);
    expect(result.total).toBe(8);
    expect(result.hasMore).toBe(true);
    expect(result.errors.size).toBe(0);
  });

  it('stamps each hit with its source account and folder so opening it routes to the owner', async () => {
    const own = makeAccount({ accountId: 'login', jmapAccountId: 'me', mailboxes: ownMailboxes },
      { searchEmails: vi.fn(async () => page([email('own-1', '2026-09-10T00:00:00Z', 'inbox')])) });
    const group = makeAccount(
      { accountId: 'group', isShared: true, accountLabel: 'Team', mailboxes: groupMailboxes },
      { searchEmails: vi.fn(async () => page([email('grp-1', '2026-09-12T00:00:00Z', 'group:g-inbox')])) },
    );

    const { emails } = await searchAcrossAccounts([own, group], 'x', 50, 0);
    const byId = Object.fromEntries(emails.map((e) => [e.id, e]));

    expect(byId['own-1']).toMatchObject({
      accountId: 'login', sourceClientAccountId: 'login', sourceAccountId: 'me', sourceFolder: 'Inbox',
    });
    expect(byId['grp-1']).toMatchObject({
      accountId: 'group', accountLabel: 'Team', sourceClientAccountId: 'login', sourceAccountId: 'group',
      sourceFolder: 'Abrir Chamados',
    });
  });

  it('keeps the other accounts\' hits and records the failure when one account fails', async () => {
    const own = makeAccount({ accountId: 'login', jmapAccountId: 'me' },
      { searchEmails: vi.fn(async () => { throw new Error('boom'); }) });
    const group = makeAccount({ accountId: 'group', isShared: true },
      { searchEmails: vi.fn(async () => page([email('grp-1', '2026-09-12T00:00:00Z', 'group:g-inbox')])) });

    const result = await searchAcrossAccounts([own, group], 'x', 50, 0);

    expect(result.emails.map((e) => e.id)).toEqual(['grp-1']);
    expect(result.errors.get('login')).toBe('boom');
  });
});

describe('advancedSearchAcrossAccounts', () => {
  it('sends the same folder-less filter to every account at the requested page', async () => {
    const filter = { operator: 'AND', conditions: [{ text: 'acesso*' }, { from: 'bob@example.com' }] };
    const ownSearch = vi.fn(async () => page([email('own-1', '2026-09-10T00:00:00Z', 'inbox')]));
    const groupSearch = vi.fn(async () => page([email('grp-1', '2026-09-12T00:00:00Z', 'group:g-inbox')]));
    const own = makeAccount({ accountId: 'login', jmapAccountId: 'me', mailboxes: ownMailboxes }, { advancedSearchEmails: ownSearch });
    const group = makeAccount({ accountId: 'group', isShared: true, mailboxes: groupMailboxes }, { advancedSearchEmails: groupSearch });

    const result = await advancedSearchAcrossAccounts([own, group], filter, 25, 50);

    expect(ownSearch).toHaveBeenCalledWith(filter, undefined, 25, 50);
    expect(groupSearch).toHaveBeenCalledWith(filter, 'group', 25, 50);
    expect(result.emails.map((e) => e.id)).toEqual(['grp-1', 'own-1']);
    expect(result.emails[0]).toMatchObject({ sourceAccountId: 'group', sourceFolder: 'Abrir Chamados' });
  });
});
