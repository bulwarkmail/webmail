import { describe, it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { advancedSearchAcrossAccounts, searchAcrossAccounts, type UnifiedAccountClient } from '@/lib/unified-mailbox';

// The "All folders" search scope spans the login's own account and every
// group/shared account it reaches: one folder-less query per account, the
// pages merged newest first and every hit stamped with its source (#1082).

const mb = (id: string, name: string, originalId?: string): Mailbox =>
  ({ id, name, role: 'inbox', unreadEmails: 0, totalEmails: 0, originalId } as unknown as Mailbox);
const roleMb = (id: string, role: string, originalId?: string): Mailbox =>
  ({ id, name: role, role, unreadEmails: 0, totalEmails: 0, originalId } as unknown as Mailbox);

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
      // The role lets the chip say the sidebar's name (usability test 2026-11-04, mail-14).
      sourceFolderRole: 'inbox',
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

  it('leaves each account\'s Trash and Junk out when asked, by the owner\'s raw ids', async () => {
    const ownAdvanced = vi.fn(async () => page([]));
    const groupAdvanced = vi.fn(async () => page([]));
    const plainSearch = vi.fn(async () => page([]));
    const own = makeAccount(
      { accountId: 'login', jmapAccountId: 'me', mailboxes: [...ownMailboxes, roleMb('trash', 'trash'), roleMb('junk', 'junk')] },
      { advancedSearchEmails: ownAdvanced, searchEmails: plainSearch },
    );
    const group = makeAccount(
      { accountId: 'group', isShared: true, mailboxes: [...groupMailboxes, roleMb('group:g-trash', 'trash', 'g-trash')] },
      { advancedSearchEmails: groupAdvanced, searchEmails: plainSearch },
    );
    // No Trash or Junk to leave out: the plain text search.
    const bare = makeAccount({ accountId: 'bare', isShared: true, mailboxes: [] }, { searchEmails: plainSearch });

    await searchAcrossAccounts([own, group, bare], ' acesso ', 50, 0, { excludeTrashAndJunk: true });

    expect(ownAdvanced).toHaveBeenCalledWith(
      { operator: 'AND', conditions: [{ text: 'acesso' }, { inMailboxOtherThan: ['trash', 'junk'] }] }, undefined, 50, 0,
    );
    expect(groupAdvanced).toHaveBeenCalledWith(
      { operator: 'AND', conditions: [{ text: 'acesso' }, { inMailboxOtherThan: ['g-trash'] }] }, 'group', 50, 0,
    );
    expect(plainSearch).toHaveBeenCalledTimes(1);
    expect(plainSearch).toHaveBeenCalledWith(' acesso ', undefined, 'bare', 50, 0);
  });
});

describe('deferred snippets across accounts', () => {
  it("asks every account to defer and hands back each account's snippets under its id", async () => {
    const ownSearch = vi.fn(async () => ({ ...page([email('a', '2026-09-10T00:00:00Z', 'inbox')]), snippets: Promise.resolve([{ emailId: 'a', subject: '<mark>own</mark>' }]) }));
    const groupSearch = vi.fn(async () => ({ ...page([email('a', '2026-09-12T00:00:00Z', 'group:g-inbox')]), snippets: Promise.resolve(undefined) }));
    const own = makeAccount({ accountId: 'login', jmapAccountId: 'me', mailboxes: ownMailboxes }, { searchEmails: ownSearch });
    const group = makeAccount({ accountId: 'group', isShared: true, mailboxes: groupMailboxes }, { searchEmails: groupSearch });

    const result = await searchAcrossAccounts([own, group], 'x', 50, 0, { deferSnippets: true });

    expect(ownSearch).toHaveBeenCalledWith('x', undefined, undefined, 50, 0, { deferSnippets: true });
    expect(groupSearch).toHaveBeenCalledWith('x', undefined, 'group', 50, 0, { deferSnippets: true });
    // A failed or empty snippet request of one account drops out.
    expect(await result.snippets).toEqual([{ accountId: 'login', list: [{ emailId: 'a', subject: '<mark>own</mark>' }] }]);
  });

  it('carries no snippets when no account deferred any', async () => {
    const own = makeAccount({ accountId: 'login' }, { searchEmails: vi.fn(async () => page([])) });
    const result = await searchAcrossAccounts([own], 'x', 50, 0);
    expect(result.snippets).toBeUndefined();
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

  it('adds the Trash/Junk exclusion to the filter when asked', async () => {
    const filter = { operator: 'AND', conditions: [{ text: 'acesso' }, { from: 'bob@example.com' }] };
    const search = vi.fn(async () => page([]));
    const own = makeAccount(
      { accountId: 'login', jmapAccountId: 'me', mailboxes: [...ownMailboxes, roleMb('junk', 'junk')] },
      { advancedSearchEmails: search },
    );

    await advancedSearchAcrossAccounts([own], filter, 25, 0, { excludeTrashAndJunk: true });
    await advancedSearchAcrossAccounts([own], filter, 25, 0);

    expect(search).toHaveBeenNthCalledWith(1, {
      operator: 'AND',
      conditions: [{ text: 'acesso' }, { from: 'bob@example.com' }, { inMailboxOtherThan: ['junk'] }],
    }, undefined, 25, 0);
    expect(search).toHaveBeenNthCalledWith(2, filter, undefined, 25, 0);
  });
});
