import { describe, it, expect } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { buildMoveMenu, filterMoveNodes, type MoveMenuNode } from '../move-menu';

const writable = { mayAddItems: true } as Mailbox['myRights'];
const readOnly = { mayAddItems: false } as Mailbox['myRights'];

function own(id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox {
  return {
    id, originalId: id, name, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
    myRights: writable, isSubscribed: true, accountId: 'A', accountName: 'me@example.org', isShared: false, ...extra,
  } as Mailbox;
}

function shared(account: string, id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox {
  return own(`${account}:${id}`, name, { originalId: id, accountId: account, accountName: `${account.toLowerCase()}@example.org`, isShared: true, ...extra });
}

// What a real server hands over: system folders with a high sortOrder, the
// user's folders in creation order, nesting three deep.
const mailboxes = [
  own('zzz', 'Zettelkasten'),
  own('trash', 'Trash', { role: 'trash', sortOrder: 50 }),
  own('work', 'Work'),
  own('inbox', 'Inbox', { role: 'inbox', sortOrder: 10 }),
  own('y10', '10', { parentId: 'receipts' }),
  own('y9', '9', { parentId: 'receipts' }),
  own('junk', 'Junk Mail', { role: 'junk', sortOrder: 40 }),
  own('receipts', 'Receipts'),
  own('sent', 'Sent Items', { role: 'sent', sortOrder: 30 }),
  own('drafts', 'Drafts', { role: 'drafts', sortOrder: 20 }),
  own('archive', 'Archive', { role: 'archive', sortOrder: 35 }),
  own('clients', 'Clients', { parentId: 'work' }),
  own('acme', 'Acme', { parentId: 'clients' }),
  own('apple', 'apple'),
  own('ro', 'Read only', { myRights: readOnly }),
  own('ro-child', 'Below read only', { parentId: 'ro' }),
  shared('S', 'inbox', 'Inbox', { role: 'inbox' }),
  shared('S', 'projects', 'Projects'),
  shared('T', 'x', 'Nothing writable', { myRights: readOnly }),
];

const names = (nodes: MoveMenuNode[]) => nodes.map((n) => n.name);
const ids = (nodes: MoveMenuNode[]): string[] => nodes.flatMap((n) => [n.id, ...ids(n.children)]);

describe('buildMoveMenu', () => {
  it('lists system folders first in mail-client order, then the rest by name', () => {
    const { nodes } = buildMoveMenu(mailboxes, { currentMailboxId: 'work', ownerAccountId: 'A', locale: 'en' });
    // Drafts and Sent can't take a moved message (pass 2 p2-18 for Sent);
    // the server's sortOrder doesn't put a folder above the Inbox.
    expect(names(nodes)).toEqual(['Inbox', 'Archive', 'Junk Mail', 'Trash', 'apple', 'Read only', 'Receipts', 'Work', 'Zettelkasten']);
  });

  // p2-18: the sidebar showed Receipts > 2026, 2025, the Move list 2025, 2026.
  it("orders the user's folders as the sidebar does: set order, then years newest first", () => {
    const boxes = [
      own('inbox', 'Inbox', { role: 'inbox', sortOrder: 10 }),
      own('receipts', 'Receipts'),
      own('y2025', '2025', { parentId: 'receipts' }),
      own('y2026', '2026', { parentId: 'receipts' }),
      own('b', 'Beta', { sortOrder: 2 }),
      own('a', 'Alpha', { sortOrder: 3 }),
    ];
    const { nodes } = buildMoveMenu(boxes, { ownerAccountId: 'A', locale: 'en' });
    expect(names(nodes)).toEqual(['Inbox', 'Receipts', 'Beta', 'Alpha']);
    expect(names(nodes.find((n) => n.id === 'receipts')!.children)).toEqual(['2026', '2025']);
  });

  it('keeps the nesting, sorts numbers as numbers, and keeps a read-only parent as a step', () => {
    const { nodes } = buildMoveMenu(mailboxes, { ownerAccountId: 'A', locale: 'en' });
    const receipts = nodes.find((n) => n.id === 'receipts')!;
    expect(names(receipts.children)).toEqual(['9', '10']);
    const work = nodes.find((n) => n.id === 'work')!;
    expect(work.children[0].children[0]).toMatchObject({ id: 'acme', path: ['Work', 'Clients'] });
    const ro = nodes.find((n) => n.id === 'ro')!;
    expect(ro.enabled).toBe(false);
    expect(ro.children.map((n) => n.id)).toEqual(['ro-child']);
  });

  it('shows the open folder greyed when the messages are all in it', () => {
    const inInbox = { mailboxIds: { inbox: true } } as unknown as Email;
    const { nodes, targetCount } = buildMoveMenu(mailboxes, { currentMailboxId: 'inbox', ownerAccountId: 'A', emails: [inInbox] });
    expect(nodes[0]).toMatchObject({ id: 'inbox', enabled: false, current: true });
    expect(targetCount).toBe(12);
  });

  it('lets a search hit from another folder move into the open one (#1452)', () => {
    const elsewhere = { mailboxIds: { work: true } } as unknown as Email;
    const { nodes } = buildMoveMenu(mailboxes, { currentMailboxId: 'inbox', ownerAccountId: 'A', emails: [elsewhere] });
    expect(nodes[0]).toMatchObject({ id: 'inbox', enabled: true, current: true });
  });

  it('keeps only the message\'s own account at the top, the others under their names', () => {
    const own = buildMoveMenu(mailboxes, { ownerAccountId: 'A' });
    expect(ids(own.nodes).some((id) => id.startsWith('S:'))).toBe(false);
    // An account with nothing writable isn't offered.
    expect(own.others.map((a) => [a.accountId, a.name])).toEqual([['S', 's@example.org']]);

    const inShared = buildMoveMenu(mailboxes, { ownerAccountId: 'S', currentMailboxId: 'S:inbox' });
    expect(inShared.accountId).toBe('S');
    expect(names(inShared.nodes)).toEqual(['Inbox', 'Projects']);
    expect(inShared.others.map((a) => [a.accountId, a.name])).toEqual([['A', 'me@example.org']]);
  });

  it('offers the last folders moved to that are still there and can still be picked', () => {
    const inInbox = { mailboxIds: { inbox: true } } as unknown as Email;
    const recentIds = (account: string | undefined) => (account === 'A' ? ['gone', 'inbox', 'acme', 'S:projects', 'sent', 'trash'] : []);
    const { recent } = buildMoveMenu(mailboxes, { currentMailboxId: 'inbox', ownerAccountId: 'A', emails: [inInbox], recentIds });
    // A deleted folder, the open one and Sent drop out; three show.
    expect(recent.map((n) => n.id)).toEqual(['acme', 'S:projects', 'trash']);
  });
});

describe('filterMoveNodes', () => {
  it('keeps the matches with the folders above them, ignoring case and accents', () => {
    const { nodes } = buildMoveMenu([...mailboxes, own('kueche', 'Küche')], { ownerAccountId: 'A', locale: 'de' });
    const label = (n: MoveMenuNode) => n.name;
    expect(ids(filterMoveNodes(nodes, 'ACM', label))).toEqual(['work', 'clients', 'acme']);
    expect(ids(filterMoveNodes(nodes, 'kuche', label))).toEqual(['kueche']);
    expect(filterMoveNodes(nodes, '  ', label)).toBe(nodes);
  });
});
