import { describe, it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { fetchTagEmails, type UnifiedAccountClient } from '@/lib/unified-mailbox';

// A tag keyword sits on messages in the user's own account and in the
// group/shared accounts they can reach. The tag view fans out over all of
// them (#1038).

const keyword = '$label:work';

const mb = (id: string, originalId?: string): Mailbox =>
  ({ id, name: id, role: 'inbox', unreadEmails: 0, totalEmails: 0, originalId } as unknown as Mailbox);

function email(id: string, receivedAt: string, mailbox: string, pinned = false): Email {
  return {
    id, threadId: `t-${id}`, mailboxIds: { [mailbox]: true },
    keywords: pinned ? { [keyword]: true, $pinned: true } : { [keyword]: true },
    subject: id, receivedAt, from: [], to: [], preview: '', size: 1, hasAttachment: false,
  } as Email;
}

const makeAccount = (
  over: Partial<UnifiedAccountClient> & { accountId: string },
  getEmails: IJMAPClient['getEmails'],
): UnifiedAccountClient => ({
  accountLabel: over.accountId,
  mailboxes: [],
  client: { getEmails } as unknown as IJMAPClient,
  clientAccountId: 'login',
  jmapAccountId: over.accountId,
  ...over,
});

describe('fetchTagEmails', () => {
  it('asks every account for the keyword without a folder constraint and merges the pages', async () => {
    const ownGet = vi.fn(async () => ({
      emails: [email('own-1', '2026-09-10T00:00:00Z', 'inbox')], total: 1, hasMore: false,
    }));
    const groupGet = vi.fn(async () => ({
      emails: [email('grp-1', '2026-09-12T00:00:00Z', 'g-inbox')], total: 4, hasMore: true,
    }));
    const own = makeAccount({ accountId: 'login', jmapAccountId: 'me', mailboxes: [mb('inbox')] }, ownGet);
    const group = makeAccount({
      accountId: 'group', isShared: true, accountLabel: 'Team', mailboxes: [mb('group:g-inbox', 'g-inbox')],
    }, groupGet);

    const result = await fetchTagEmails([own, group], keyword, 50, 0);

    expect(ownGet).toHaveBeenCalledWith(undefined, undefined, 50, 0, keyword, true, undefined, []);
    expect(groupGet).toHaveBeenCalledWith(undefined, 'group', 50, 0, keyword, true, undefined, []);
    expect(result.emails.map((e) => e.id)).toEqual(['grp-1', 'own-1']);
    expect(result.total).toBe(5);
    expect(result.hasMore).toBe(true);
    expect(result.errors.size).toBe(0);
  });

  it('stamps each email with its source account so actions route back to the owner', async () => {
    const own = makeAccount({ accountId: 'login', jmapAccountId: 'me', mailboxes: [mb('inbox')] },
      vi.fn(async () => ({ emails: [email('own-1', '2026-09-10T00:00:00Z', 'inbox')], total: 1, hasMore: false })));
    const group = makeAccount({
      accountId: 'group', isShared: true, accountLabel: 'Team', mailboxes: [mb('group:g-inbox', 'g-inbox')],
    }, vi.fn(async () => ({ emails: [email('grp-1', '2026-09-12T00:00:00Z', 'group:g-inbox')], total: 1, hasMore: false })));

    const { emails } = await fetchTagEmails([own, group], keyword, 50, 0);
    const byId = Object.fromEntries(emails.map((e) => [e.id, e]));

    expect(byId['own-1']).toMatchObject({
      accountId: 'login', sourceClientAccountId: 'login', sourceAccountId: 'me', sourceFolder: 'inbox',
    });
    expect(byId['grp-1']).toMatchObject({
      accountId: 'group', accountLabel: 'Team', sourceClientAccountId: 'login', sourceAccountId: 'group',
      sourceFolder: 'group:g-inbox',
    });
  });

  it('keeps pinned messages first across accounts, then newest first', async () => {
    const own = makeAccount({ accountId: 'login' },
      vi.fn(async () => ({ emails: [email('own-new', '2026-09-15T00:00:00Z', 'inbox')], total: 1, hasMore: false })));
    const group = makeAccount({ accountId: 'group', isShared: true },
      vi.fn(async () => ({ emails: [email('grp-pinned', '2026-09-01T00:00:00Z', 'g', true)], total: 1, hasMore: false })));

    const { emails } = await fetchTagEmails([own, group], keyword, 50, 0);
    expect(emails.map((e) => e.id)).toEqual(['grp-pinned', 'own-new']);
  });

  it('passes the requested page and list order through to every account', async () => {
    const order = [{ criterion: 'from', direction: 'asc' } as const];
    const get = vi.fn(async () => ({ emails: [], total: 0, hasMore: false }));
    await fetchTagEmails([makeAccount({ accountId: 'login' }, get), makeAccount({ accountId: 'g', isShared: true }, get)],
      keyword, 25, 50, order);
    expect(get).toHaveBeenNthCalledWith(1, undefined, undefined, 25, 50, keyword, true, undefined, order);
    expect(get).toHaveBeenNthCalledWith(2, undefined, 'g', 25, 50, keyword, true, undefined, order);
  });

  it("leaves each account's Trash and Junk out, ANDed with a search filter (#1156)", async () => {
    const role = (id: string, r: string, originalId?: string) => ({ ...mb(id, originalId), role: r } as Mailbox);
    const ownGet = vi.fn(async () => ({ emails: [], total: 0, hasMore: false }));
    const groupGet = vi.fn(async () => ({ emails: [], total: 0, hasMore: false }));
    const own = makeAccount({
      accountId: 'login', mailboxes: [mb('inbox'), role('trash', 'trash'), role('junk', 'junk')],
    }, ownGet);
    const group = makeAccount({
      accountId: 'group', isShared: true, mailboxes: [mb('group:g-inbox', 'g-inbox'), role('group:g-trash', 'trash', 'g-trash')],
    }, groupGet);

    await fetchTagEmails([own, group], keyword, 50, 0, [], { text: 'invoice' });

    expect(ownGet).toHaveBeenCalledWith(undefined, undefined, 50, 0, keyword, true,
      { operator: 'AND', conditions: [{ text: 'invoice' }, { inMailboxOtherThan: ['trash', 'junk'] }] }, []);
    expect(groupGet).toHaveBeenCalledWith(undefined, 'group', 50, 0, keyword, true,
      { operator: 'AND', conditions: [{ text: 'invoice' }, { inMailboxOtherThan: ['g-trash'] }] }, []);

    await fetchTagEmails([own], keyword, 50, 0);
    expect(ownGet).toHaveBeenLastCalledWith(undefined, undefined, 50, 0, keyword, true,
      { inMailboxOtherThan: ['trash', 'junk'] }, []);
  });

  it('keeps the other accounts when one fails and reports the failure', async () => {
    const own = makeAccount({ accountId: 'login' },
      vi.fn(async () => ({ emails: [email('own-1', '2026-09-10T00:00:00Z', 'inbox')], total: 1, hasMore: false })));
    const group = makeAccount({ accountId: 'group', isShared: true },
      vi.fn(async () => { throw new Error('forbidden'); }));

    const result = await fetchTagEmails([own, group], keyword, 50, 0);
    expect(result.emails.map((e) => e.id)).toEqual(['own-1']);
    expect(result.errors.get('group')).toBe('forbidden');
  });
});
