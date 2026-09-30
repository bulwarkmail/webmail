import { describe, expect, it } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { groupSearchScopeFolders } from '@/lib/search-scope-folders';

// The search panel's Folder dropdown lists the shared/group folders under
// their owner account instead of as bare names among the own ones (#1082),
// and shows the folder hierarchy: each subfolder right after its parent,
// with its nesting depth for the indent.

const mb = (over: Partial<Mailbox> & { id: string }): Mailbox =>
  ({ name: over.id, isShared: false, sortOrder: 0, totalEmails: 0, unreadEmails: 0, ...over } as Mailbox);

const rows = (list: { id: string; depth: number }[]) => list.map(({ id, depth }) => [id, depth]);

describe('groupSearchScopeFolders', () => {
  it('keeps the own folders ungrouped and groups shared folders by owner', () => {
    const folders = [
      mb({ id: 'inbox', name: 'Inbox', role: 'inbox' }),
      mb({ id: 'g1:inbox', name: 'Inbox', isShared: true, accountId: 'g1', accountName: 'chamados@server.tld' }),
      mb({ id: 'sent', name: 'Sent', role: 'sent' }),
      mb({ id: 'g2:inbox', name: 'Inbox', isShared: true, accountId: 'g2', accountName: 'vendas@server.tld' }),
      mb({ id: 'g1:done', name: 'Done', isShared: true, accountId: 'g1', accountName: 'chamados@server.tld' }),
    ];

    const { own, shared } = groupSearchScopeFolders(folders);

    expect(own.map((m) => m.id)).toEqual(['inbox', 'sent']);
    expect(shared.map(({ ownerId, label, mailboxes }) => ({ ownerId, label, ids: mailboxes.map((m) => m.id) }))).toEqual([
      { ownerId: 'g1', label: 'chamados@server.tld', ids: ['g1:done', 'g1:inbox'] },
      { ownerId: 'g2', label: 'vendas@server.tld', ids: ['g2:inbox'] },
    ]);
  });

  it('lists each subfolder right after its parent with its depth', () => {
    const { own } = groupSearchScopeFolders([
      mb({ id: 'projects', name: 'Projects' }),
      mb({ id: 'client-b', name: 'Client B', parentId: 'projects' }),
      mb({ id: 'inbox', name: 'Inbox', role: 'inbox' }),
      mb({ id: 'invoices', name: 'Invoices', parentId: 'client-b' }),
      mb({ id: 'client-a', name: 'Client A', parentId: 'projects' }),
      mb({ id: 'archive', name: 'Archive', role: 'archive' }),
    ]);

    expect(rows(own)).toEqual([
      ['inbox', 0],
      ['archive', 0],
      ['projects', 0],
      ['client-a', 1],
      ['client-b', 1],
      ['invoices', 2],
    ]);
  });

  it('nests shared subfolders from the owner account top level', () => {
    const { shared } = groupSearchScopeFolders([
      mb({ id: 'g1:inbox', name: 'Inbox', role: 'inbox', isShared: true, accountId: 'g1', accountName: 'team' }),
      mb({ id: 'g1:open', name: 'Open', parentId: 'g1:inbox', isShared: true, accountId: 'g1', accountName: 'team' }),
    ]);

    expect(shared).toHaveLength(1);
    expect(rows(shared[0].mailboxes)).toEqual([
      ['g1:inbox', 0],
      ['g1:open', 1],
    ]);
  });

  it('falls back to the owner id when the shared folder carries no account name', () => {
    const { shared } = groupSearchScopeFolders([
      mb({ id: 'g1:inbox', name: 'Inbox', isShared: true, accountId: 'g1' }),
    ]);

    expect(shared).toEqual([{ ownerId: 'g1', label: 'g1', mailboxes: [expect.objectContaining({ id: 'g1:inbox' })] }]);
  });

  it('returns no groups for a login without shared folders', () => {
    const { own, shared } = groupSearchScopeFolders([mb({ id: 'inbox' })]);

    expect(own).toHaveLength(1);
    expect(shared).toEqual([]);
  });
});
