import { describe, it, expect } from 'vitest';
import { compactSharedMailbox } from '../compact-shared-mailbox';
import type { MailboxNode } from '../utils';

// #1342: a shared account's mail as one row that is its inbox.

function node(id: string, extra: Partial<MailboxNode> = {}): MailboxNode {
  return {
    id, name: id, role: undefined, totalEmails: 0, unreadEmails: 0, children: [], depth: 0,
    ...extra,
  } as unknown as MailboxNode;
}

function account(children: MailboxNode[]): MailboxNode {
  return node('shared-account-g1', { name: 'sales@example.com', children, isShared: true });
}

const names = (nodes: MailboxNode[]) => nodes.map((n) => n.name);

describe('compactSharedMailbox', () => {
  it('puts the inbox at the top, its subfolders, the own folders, then the standard folders', () => {
    const inbox = node('inbox', { role: 'inbox', children: [node('Requests', { depth: 1 })] });
    const compact = compactSharedMailbox(account([
      inbox,
      node('Sent', { role: 'sent', totalEmails: 3 }),
      node('Trade fairs', { children: [node('Fair 2027', { depth: 1 })] }),
    ]));

    expect(compact?.id).toBe('inbox');
    expect(compact?.depth).toBe(0);
    expect(names(compact!.children)).toEqual(['Requests', 'Trade fairs', 'Sent']);
    expect(compact!.children.map((n) => n.depth)).toEqual([1, 1, 1]);
    expect(compact!.children[1].children[0].depth).toBe(2);
  });

  it('lists Drafts, Scheduled, Junk and Trash only while they hold mail, Sent always', () => {
    const compact = compactSharedMailbox(account([
      node('inbox', { role: 'inbox' }),
      node('Drafts', { role: 'drafts' }),
      node('Scheduled', { role: 'scheduled' }),
      node('Sent', { role: 'sent' }),
      node('Junk', { role: 'junk', totalEmails: 1, unreadEmails: 1 }),
      node('Trash', { role: 'trash' }),
      node('Archive', { role: 'archive' }),
    ]));

    expect(names(compact!.children)).toEqual(['Sent', 'Junk', 'Archive']);
  });

  it('leaves an account without an inbox as it is', () => {
    expect(compactSharedMailbox(account([node('Invoices')]))).toBeNull();
  });

  it('does not change the tree it is given', () => {
    const requests = node('Requests', { depth: 0 });
    const tree = account([node('inbox', { role: 'inbox' }), requests]);
    compactSharedMailbox(tree);

    expect(requests.depth).toBe(0);
    expect(tree.children).toHaveLength(2);
  });
});
