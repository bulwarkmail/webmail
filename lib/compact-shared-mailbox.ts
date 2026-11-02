import type { MailboxNode } from "@/lib/utils";

/** Standard folders a compact shared mailbox lists only while they hold mail. */
const LISTED_WHEN_FILLED = new Set(["drafts", "scheduled", "junk", "trash"]);

const withDepths = (nodes: MailboxNode[], depth: number): MailboxNode[] =>
  nodes.map((node) => ({ ...node, depth, children: withDepths(node.children, depth + 1) }));

/**
 * A shared account's mail as one row (#1342): the account's inbox, with the
 * inbox's own subfolders below it, then the folders the account's owners made,
 * then Sent and the other standard folders, Drafts, Scheduled, Junk and Trash
 * only while they hold mail. The inbox sits at depth 0, where the account's
 * header row was, and everything below it one level further in.
 *
 * Returns null for an account without an inbox; it keeps its header row.
 */
export function compactSharedMailbox(account: MailboxNode): MailboxNode | null {
  const inbox = account.children.find((node) => node.role === "inbox");
  if (!inbox) return null;
  const others = account.children.filter((node) => node !== inbox);
  const own = others.filter((node) => !node.role);
  const standard = others.filter(
    (node) => node.role && !(LISTED_WHEN_FILLED.has(node.role) && node.totalEmails === 0),
  );
  return {
    ...inbox,
    depth: 0,
    children: withDepths([...inbox.children, ...own, ...standard], 1),
  };
}
