import type { Email, Mailbox } from "./jmap/types";
import { buildMailboxTree, type MailboxNode } from "./utils";

/** Header node that wraps the user's own folders when another account leads. */
export const OWN_ACCOUNT_MOVE_NODE_PREFIX = "own-account-";

/**
 * JMAP accountId of the account a message lives in, for scoping its Move menu.
 *
 * Stamped messages (unified and search views) name their account. Otherwise
 * the folders the message is in decide: a shared account's mailboxIds are
 * namespaced exactly like its folders in the merged list. The open folder is
 * the last resort, for a message whose folders are not loaded.
 */
export function resolveMoveOwnerAccountId(
  email: Pick<Email, "sourceAccountId" | "mailboxIds"> | null | undefined,
  mailboxes: Mailbox[],
  selectedMailboxId: string | null | undefined,
): string | undefined {
  if (email?.sourceAccountId) return email.sourceAccountId;
  const inIds = email?.mailboxIds ?? {};
  const container = mailboxes.find((m) => inIds[m.id]);
  if (container?.accountId) return container.accountId;
  return mailboxes.find((m) => m.id === selectedMailboxId)?.accountId;
}

/**
 * The folders a Move menu offers, as a tree, plus the ids that can be picked.
 *
 * The message's own account leads. For a message in a shared/group account the
 * menus used to list the user's own folders first and the shared account's
 * last, under a header below the menu's scroll area, so picking a familiar
 * name like "Spam" moved the message into the personal account and out of the
 * shared one (#1149). The shared account's folders now come first and the
 * user's own folders follow under their account name, so a deliberate
 * cross-account move is still one pick away but no longer the obvious one.
 */
export function buildMoveTargets(
  mailboxes: Mailbox[],
  opts: { currentMailboxId?: string | null; ownerAccountId?: string },
): { tree: MailboxNode[]; targetIds: Set<string> } {
  const targetIds = new Set(
    mailboxes
      .filter(
        (m) =>
          m.id !== opts.currentMailboxId &&
          m.role !== "drafts" &&
          !m.id.startsWith("shared-") &&
          m.myRights?.mayAddItems
      )
      .map((m) => m.id)
  );

  const filterTree = (nodes: MailboxNode[]): MailboxNode[] =>
    nodes.reduce<MailboxNode[]>((acc, node) => {
      const children = filterTree(node.children);
      if (targetIds.has(node.id) || children.length > 0) {
        acc.push({ ...node, children });
      }
      return acc;
    }, []);

  const tree = filterTree(buildMailboxTree(mailboxes));

  const ownerNode = opts.ownerAccountId
    ? tree.find((n) => n.isShared && n.id === `shared-account-${opts.ownerAccountId}`)
    : undefined;
  if (!ownerNode) return { tree, targetIds };

  const own = tree.filter((n) => !n.isShared);
  const otherShared = tree.filter((n) => n.isShared && n !== ownerNode);
  const ordered: MailboxNode[] = [ownerNode];
  if (own.length > 0) {
    const ownAccountId = own[0].accountId ?? "";
    const ownName = mailboxes.find((m) => !m.isShared && m.accountName)?.accountName ?? ownAccountId;
    ordered.push({
      id: `${OWN_ACCOUNT_MOVE_NODE_PREFIX}${ownAccountId}`,
      name: ownName,
      sortOrder: 0,
      totalEmails: 0,
      unreadEmails: 0,
      totalThreads: 0,
      unreadThreads: 0,
      myRights: { ...ownerNode.myRights },
      isSubscribed: true,
      accountId: ownAccountId,
      accountName: ownName,
      isShared: false,
      children: own,
      depth: 0,
    });
  }
  ordered.push(...otherShared);
  return { tree: ordered, targetIds };
}
