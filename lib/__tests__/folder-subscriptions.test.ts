import { describe, expect, it } from 'vitest';
import { withoutUnsubscribed } from '@/lib/folder-subscriptions';
import { buildMailboxTree, type MailboxNode } from '@/lib/utils';
import type { Mailbox } from '@/lib/jmap/types';

// #1398: with "Hide unsubscribed folders" on, the sidebar leaves out folders
// unsubscribed on the server.

const mb = (id: string, extra: Partial<Mailbox> = {}): Mailbox => ({
  id, name: id, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
  myRights: {}, isSubscribed: true, ...extra,
} as Mailbox);

const names = (nodes: MailboxNode[]): string[] =>
  nodes.flatMap((n) => [n.name, ...names(n.children).map((c) => `${n.name}/${c}`)]);

describe('withoutUnsubscribed', () => {
  it('leaves out an unsubscribed folder and keeps the subscribed ones', () => {
    const tree = buildMailboxTree([mb('Inbox', { role: 'inbox' }), mb('Projects'), mb('Old', { isSubscribed: false })]);
    expect(names(withoutUnsubscribed(tree))).toEqual(['Inbox', 'Projects']);
  });

  it('keeps folders with a role even when unsubscribed', () => {
    const tree = buildMailboxTree([mb('Inbox', { role: 'inbox', isSubscribed: false }), mb('Trash', { role: 'trash', isSubscribed: false })]);
    expect(names(withoutUnsubscribed(tree))).toEqual(['Inbox', 'Trash']);
  });

  it('keeps an unsubscribed parent of a subscribed subfolder and drops its unsubscribed ones', () => {
    const tree = buildMailboxTree([
      mb('Archive', { isSubscribed: false }),
      mb('2024', { parentId: 'Archive' }),
      mb('2019', { parentId: 'Archive', isSubscribed: false }),
    ]);
    expect(names(withoutUnsubscribed(tree))).toEqual(['Archive', 'Archive/2024']);
  });

  it('returns the same tree when nothing is hidden', () => {
    const tree = buildMailboxTree([mb('Inbox', { role: 'inbox' }), mb('Projects')]);
    expect(withoutUnsubscribed(tree)).toBe(tree);
  });
});
