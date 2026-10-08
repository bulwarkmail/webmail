import { describe, it, expect } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { MailboxNode } from '@/lib/utils';
import { buildMoveTargets, resolveMoveOwnerAccountId, OWN_ACCOUNT_MOVE_NODE_PREFIX } from '../move-targets';

const writable = { mayAddItems: true } as Mailbox['myRights'];

function own(id: string, name: string, role?: string): Mailbox {
  return {
    id, originalId: id, name, role, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
    myRights: writable, isSubscribed: true, accountId: 'A', accountName: 'me@example.org', isShared: false,
  } as Mailbox;
}

function shared(id: string, name: string, role?: string): Mailbox {
  return {
    id: `S:${id}`, originalId: id, name, role, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
    myRights: writable, isSubscribed: true, accountId: 'S', accountName: 'info@example.org', isShared: true,
  } as Mailbox;
}

// Same bare ids in both accounts, like a real Stalwart pair.
const mailboxes = [
  own('a', 'Inbox', 'inbox'),
  own('b', 'Junk', 'junk'),
  own('c', 'BELEDİYE'),
  shared('a', 'Inbox', 'inbox'),
  shared('b', 'Junk', 'junk'),
  shared('d', 'Trash', 'trash'),
];

const flat = (nodes: MailboxNode[]): string[] => nodes.flatMap((n) => [n.id, ...flat(n.children)]);

describe('buildMoveTargets', () => {
  it('keeps the own folders first for a message of the own account', () => {
    const { tree, targetIds } = buildMoveTargets(mailboxes, { currentMailboxId: 'a', ownerAccountId: 'A' });
    expect(tree.map((n) => n.id)).toEqual(['b', 'c', 'shared-account-S']);
    expect(targetIds.has('a')).toBe(false);
  });

  it('puts the shared account first for a message in a shared mailbox (#1149)', () => {
    const { tree, targetIds } = buildMoveTargets(mailboxes, { currentMailboxId: 'S:a', ownerAccountId: 'S' });

    expect(tree.map((n) => n.id)).toEqual(['shared-account-S', `${OWN_ACCOUNT_MOVE_NODE_PREFIX}A`]);
    expect(tree[1].name).toBe('me@example.org');
    expect(targetIds.has(tree[1].id)).toBe(false);
    // The shared Junk is the first pickable folder, the open folder is not offered.
    expect(flat(tree).filter((id) => targetIds.has(id))).toEqual(['S:b', 'S:d', 'a', 'b', 'c']);
  });

  it('leaves other shared accounts after the own folders', () => {
    const other = { ...shared('x', 'Inbox', 'inbox'), id: 'T:x', accountId: 'T', accountName: 'team@example.org' };
    const { tree } = buildMoveTargets([...mailboxes, other], { currentMailboxId: 'S:a', ownerAccountId: 'S' });
    expect(tree.map((n) => n.id)).toEqual(['shared-account-S', `${OWN_ACCOUNT_MOVE_NODE_PREFIX}A`, 'shared-account-T']);
  });
});

describe('resolveMoveOwnerAccountId', () => {
  it('reads the account from the namespaced folder the message is in', () => {
    const email = { mailboxIds: { 'S:a': true } } as unknown as Email;
    expect(resolveMoveOwnerAccountId(email, mailboxes, 'a')).toBe('S');
  });

  it('prefers the source stamp of unified and search views', () => {
    const email = { sourceAccountId: 'S', mailboxIds: { a: true } } as unknown as Email;
    expect(resolveMoveOwnerAccountId(email, mailboxes, 'a')).toBe('S');
  });

  it('falls back to the open folder', () => {
    const email = { mailboxIds: { unknown: true } } as unknown as Email;
    expect(resolveMoveOwnerAccountId(email, mailboxes, 'S:d')).toBe('S');
    expect(resolveMoveOwnerAccountId(null, mailboxes, 'b')).toBe('A');
  });
});
