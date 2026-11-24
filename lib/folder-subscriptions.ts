import type { MailboxNode } from '@/lib/utils';

/**
 * Folder subscriptions (#1398): with "Hide unsubscribed folders" on, an own
 * folder unsubscribed on the server (JMAP isSubscribed, IMAP SUBSCRIBE, as
 * Thunderbird and Roundcube set it) leaves the sidebar. Its mail stays where
 * it is.
 *
 * Folders with a role (Inbox, Sent, Trash...) always stay, as do shared ones:
 * their subscription is whatever the server starts them with, not a choice.
 */
export function canHideFolder(mailbox: { role?: string | null; isShared?: boolean }): boolean {
  return !mailbox.role && !mailbox.isShared;
}

/**
 * The tree without its unsubscribed folders. A hidden folder with a
 * subscribed subfolder stays, as the way to that subfolder. Unchanged nodes
 * keep their identity, since the sidebar memoises its rows on them.
 */
export function withoutUnsubscribed(nodes: MailboxNode[]): MailboxNode[] {
  let changed = false;
  const out: MailboxNode[] = [];
  for (const node of nodes) {
    const children = withoutUnsubscribed(node.children);
    if (node.isSubscribed === false && canHideFolder(node) && children.length === 0) {
      changed = true;
      continue;
    }
    if (children !== node.children) {
      changed = true;
      out.push({ ...node, children });
    } else {
      out.push(node);
    }
  }
  return changed ? out : nodes;
}
