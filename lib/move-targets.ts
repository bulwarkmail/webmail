import type { Email, Mailbox } from "./jmap/types";
import { buildMailboxTree, type MailboxNode } from "./utils";

/** Header node that wraps the user's own folders when another account leads. */
export const OWN_ACCOUNT_MOVE_NODE_PREFIX = "own-account-";

// Whether an email belongs to a given mailbox.
// Own-account emails carry bare ids (equal to both `id` and `originalId`).
// As of #281 V3, EVERY client fetch path (getEmails/getEmail/getThreadEmails/
// searchEmails/advancedSearchEmails) namespaces shared/delegated emails'
// `mailboxIds` to the store id (`${ownerId}:${origId}`), so the `ids[mailbox.id]`
// fast path below matches own and shared mailboxes alike - one id space.
// The `originalId` branches remain as a defensive fallback for any email that
// still carries a bare owner id (scoped to the owning account via
// `sourceAccountId === mailbox.accountId` so a bare owner id can't collide with
// another account's folder). (#281)
export function emailInMailbox(
  email: { mailboxIds?: Record<string, boolean>; sourceAccountId?: string },
  mailbox: Mailbox,
): boolean {
  const ids = email.mailboxIds;
  if (!ids) return false;
  if (ids[mailbox.id]) return true;
  if (!mailbox.isShared && mailbox.originalId) return !!ids[mailbox.originalId];
  if (
    mailbox.isShared &&
    mailbox.originalId &&
    email.sourceAccountId &&
    email.sourceAccountId === mailbox.accountId
  ) {
    return !!ids[mailbox.originalId];
  }
  return false;
}

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
 *
 * The open folder is left out only when the messages being moved are all in
 * it. A search across folders lists messages from other folders while the
 * open one stays selected, and those can be moved into it (#1452).
 */
export function buildMoveTargets(
  mailboxes: Mailbox[],
  opts: {
    currentMailboxId?: string | null;
    ownerAccountId?: string;
    /** The messages being moved; without them the open folder is left out. */
    emails?: Array<Pick<Email, "mailboxIds" | "sourceAccountId">>;
  },
): { tree: MailboxNode[]; targetIds: Set<string> } {
  const current = mailboxes.find((m) => m.id === opts.currentMailboxId);
  const emails = opts.emails ?? [];
  const hiddenId = current && (emails.length === 0 || emails.every((e) => emailInMailbox(e, current)))
    ? current.id
    : undefined;
  const targetIds = new Set(
    mailboxes
      .filter(
        (m) =>
          m.id !== hiddenId &&
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
