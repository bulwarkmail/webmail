import { describe, expect, it } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { groupSearchScopeFolders } from '@/lib/search-scope-folders';

// The search panel's Folder dropdown lists the shared/group folders under
// their owner account instead of as bare names among the own ones (#1082).

const mb = (over: Partial<Mailbox> & { id: string }): Mailbox =>
  ({ name: over.id, isShared: false, ...over } as Mailbox);

describe('groupSearchScopeFolders', () => {
  it('keeps the own folders flat and groups shared folders by owner', () => {
    const folders = [
      mb({ id: 'inbox', name: 'Inbox' }),
      mb({ id: 'g1:inbox', name: 'Inbox', isShared: true, accountId: 'g1', accountName: 'chamados@server.tld' }),
      mb({ id: 'sent', name: 'Sent' }),
      mb({ id: 'g2:inbox', name: 'Inbox', isShared: true, accountId: 'g2', accountName: 'vendas@server.tld' }),
      mb({ id: 'g1:done', name: 'Done', isShared: true, accountId: 'g1', accountName: 'chamados@server.tld' }),
    ];

    const { own, shared } = groupSearchScopeFolders(folders);

    expect(own.map((m) => m.id)).toEqual(['inbox', 'sent']);
    expect(shared).toEqual([
      { ownerId: 'g1', label: 'chamados@server.tld', mailboxes: [folders[1], folders[4]] },
      { ownerId: 'g2', label: 'vendas@server.tld', mailboxes: [folders[3]] },
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
