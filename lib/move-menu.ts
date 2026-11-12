/**
 * What every "Move to" list shows: the context menu (and the desktop app's
 * native copy of it), the reader's Move button, the phone panel, the
 * selection toolbar and the Move dialog. One model, so they can't drift.
 *
 * - The message's own account at the top. Other accounts a move can reach
 *   (shared ones) come after it, each under its own name.
 * - System folders first, in the order mail clients use (Inbox, Drafts,
 *   Sent, Archive, Spam, Trash), then the user's folders in the sidebar's
 *   order: an order the user set, year folders newest first, then by name
 *   for the interface language (usability test 2026-11-04, p2-18). The
 *   server's sortOrder doesn't put a user's folder above the Inbox here.
 * - Not Drafts or Sent: mail isn't moved into either (pass-1 mail-12).
 * - Nesting kept. The open folder stays in the list, disabled, when the
 *   messages are all in it (#1452: a search hit from elsewhere can move in).
 * - The last few folders moved to, per account, as "Recent".
 */

import type { Email, Mailbox } from "./jmap/types";
import { emailInMailbox } from "./move-targets";

export const SYSTEM_FOLDER_ORDER = ["inbox", "drafts", "sent", "archive", "junk", "trash"] as const;

/** Past this many folders to pick from, the list gets a filter field. */
export const MOVE_FILTER_THRESHOLD = 12;

/** How many recent folders show. */
export const MOVE_RECENT_SHOWN = 3;

export interface MoveMenuNode {
  /** The mailbox id, as the store knows it. */
  id: string;
  name: string;
  role?: string | null;
  /** Can be picked. */
  enabled: boolean;
  /** The open folder, which the messages are already in. */
  current: boolean;
  /** Names of the folders above it, outermost first. */
  path: string[];
  children: MoveMenuNode[];
  /** The folder's sortOrder, which orders the user's folders as the sidebar does. */
  sortOrder?: number;
}

export interface MoveMenuAccount {
  accountId: string;
  name: string;
  nodes: MoveMenuNode[];
}

export interface MoveMenuModel {
  /** The account the messages are in; recents are kept per account. */
  accountId?: string;
  nodes: MoveMenuNode[];
  /** Other accounts the messages can be moved to, each a submenu. */
  others: MoveMenuAccount[];
  recent: MoveMenuNode[];
  /** Pickable folders in the own account. */
  targetCount: number;
  /**
   * Whose folders these are, when they aren't the active login's: that
   * login's address (moveFoldersFor's `owner`), shown above them. Two logins'
   * "Inbox" look the same otherwise.
   */
  heading?: string;
}

export interface MoveMenuOptions {
  currentMailboxId?: string | null;
  /** The account the messages are in (resolveMoveOwnerAccountId). */
  ownerAccountId?: string;
  /** The messages being moved; without them the open folder counts as theirs. */
  emails?: Array<Pick<Email, "mailboxIds" | "sourceAccountId">>;
  /** The folders last moved to in an account, most recent first (readRecentMoveTargets). */
  recentIds?: (accountId: string | undefined) => string[];
  /** The interface language, for sorting names. */
  locale?: string;
}

function rolePosition(role: string | null | undefined): number {
  if (!role) return SYSTEM_FOLDER_ORDER.length;
  const normal = role === "spam" ? "junk" : role;
  const at = (SYSTEM_FOLDER_ORDER as readonly string[]).indexOf(normal);
  return at < 0 ? SYSTEM_FOLDER_ORDER.length : at;
}

const YEAR = /^\d{4}$/;

type Sortable = Pick<MoveMenuNode, "role" | "name"> & { sortOrder?: number };

export function compareMoveNodes(collator: Intl.Collator) {
  return (a: Sortable, b: Sortable): number => {
    const byRole = rolePosition(a.role) - rolePosition(b.role);
    if (byRole !== 0) return byRole;
    // The user's own folders as the sidebar lists them (lib/utils.ts
    // buildMailboxTree): a set order first, then years newest first.
    if (!a.role && !b.role) {
      const byOrder = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
      if (byOrder !== 0) return byOrder;
      if (YEAR.test(a.name) && YEAR.test(b.name)) return Number(b.name) - Number(a.name);
    }
    return collator.compare(a.name, b.name);
  };
}

function makeCollator(locale?: string): Intl.Collator {
  try {
    return new Intl.Collator(locale || undefined, { numeric: true, sensitivity: "base" });
  } catch {
    return new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  }
}

/** A target: may take mail, isn't Drafts or Sent, isn't a virtual header. */
function isTarget(mailbox: Mailbox): boolean {
  return mailbox.role !== "drafts" && mailbox.role !== "sent" && !mailbox.id.startsWith("shared-") && !!mailbox.myRights?.mayAddItems;
}

/** One account's folders as a sorted tree, with only the branches that lead somewhere. */
function accountTree(
  boxes: Mailbox[],
  currentId: string | undefined,
  hideCurrent: boolean,
  collator: Intl.Collator,
): MoveMenuNode[] {
  const ids = new Set(boxes.map((m) => m.id));
  const childrenOf = new Map<string, Mailbox[]>();
  const roots: Mailbox[] = [];
  for (const box of boxes) {
    if (box.parentId && ids.has(box.parentId) && box.parentId !== box.id) {
      const list = childrenOf.get(box.parentId) ?? [];
      list.push(box);
      childrenOf.set(box.parentId, list);
    } else {
      roots.push(box);
    }
  }
  const compare = compareMoveNodes(collator);
  const seen = new Set<string>();
  const build = (list: Mailbox[], path: string[]): MoveMenuNode[] => {
    const out: MoveMenuNode[] = [];
    for (const box of list) {
      if (seen.has(box.id)) continue;
      seen.add(box.id);
      const current = box.id === currentId;
      const children = build(childrenOf.get(box.id) ?? [], [...path, box.name]);
      const enabled = isTarget(box) && !(current && hideCurrent);
      // A folder that can't take mail stays as a step to the ones below it;
      // the open folder stays so the list reads like the sidebar.
      if (!enabled && !children.length && !(current && isTarget(box))) continue;
      out.push({ id: box.id, name: box.name, role: box.role ?? null, enabled, current, path, children, sortOrder: box.sortOrder });
    }
    return out.sort(compare);
  };
  return build(roots, []);
}

function walk(nodes: MoveMenuNode[], visit: (node: MoveMenuNode) => void): void {
  for (const node of nodes) {
    visit(node);
    walk(node.children, visit);
  }
}

export function countTargets(nodes: MoveMenuNode[]): number {
  let count = 0;
  walk(nodes, (node) => {
    if (node.enabled) count++;
  });
  return count;
}

export function buildMoveMenu(mailboxes: Mailbox[], opts: MoveMenuOptions = {}): MoveMenuModel {
  const collator = makeCollator(opts.locale);
  const current = mailboxes.find((m) => m.id === opts.currentMailboxId);
  const emails = opts.emails ?? [];
  const hideCurrent = !!current && (emails.length === 0 || emails.every((e) => emailInMailbox(e, current)));

  // Folders by account: the login's own, then each shared account.
  const groups = new Map<string, { name: string; shared: boolean; boxes: Mailbox[] }>();
  const OWN = "__own_account__";
  for (const box of mailboxes) {
    if (box.id.startsWith("shared-")) continue;
    const key = box.isShared ? box.accountId ?? "unknown" : OWN;
    let group = groups.get(key);
    if (!group) {
      group = { name: box.accountName || box.accountId || "", shared: !!box.isShared, boxes: [] };
      groups.set(key, group);
    }
    if (!group.name && box.accountName) group.name = box.accountName;
    group.boxes.push(box);
  }
  const ownAccountId = groups.get(OWN)?.boxes.find((m) => m.accountId)?.accountId;
  const ownerKey = opts.ownerAccountId && groups.get(opts.ownerAccountId)?.shared ? opts.ownerAccountId : OWN;

  const treeOf = (key: string) => {
    const group = groups.get(key);
    return group ? accountTree(group.boxes, current?.id, hideCurrent, collator) : [];
  };
  const nodes = treeOf(ownerKey);
  const others: MoveMenuAccount[] = [];
  for (const [key, group] of groups) {
    if (key === ownerKey) continue;
    const tree = treeOf(key);
    if (countTargets(tree) === 0) continue;
    others.push({ accountId: key === OWN ? ownAccountId ?? "" : key, name: group.name, nodes: tree });
  }
  // The login's own account first among the others, then shared ones by name.
  others.sort((a, b) => {
    const aOwn = a.accountId === ownAccountId ? 0 : 1;
    const bOwn = b.accountId === ownAccountId ? 0 : 1;
    return aOwn - bOwn || collator.compare(a.name, b.name);
  });

  const accountId = ownerKey === OWN ? ownAccountId : ownerKey;
  const byId = new Map<string, MoveMenuNode>();
  walk(nodes, (node) => byId.set(node.id, node));
  for (const other of others) walk(other.nodes, (node) => byId.set(node.id, node));
  const recent: MoveMenuNode[] = [];
  for (const id of opts.recentIds?.(accountId) ?? []) {
    const node = byId.get(id);
    if (node?.enabled && !recent.includes(node)) recent.push(node);
    if (recent.length >= MOVE_RECENT_SHOWN) break;
  }

  return { accountId, nodes, others, recent, targetCount: countTargets(nodes) };
}

/**
 * The nodes whose name has the query in it, with the folders above them kept
 * so a match still shows where it lives. Case and accents don't count.
 */
export function filterMoveNodes(nodes: MoveMenuNode[], query: string, labelOf: (node: MoveMenuNode) => string, locale?: string): MoveMenuNode[] {
  const q = fold(query.trim(), locale);
  if (!q) return nodes;
  const keep = (list: MoveMenuNode[]): MoveMenuNode[] =>
    list.reduce<MoveMenuNode[]>((acc, node) => {
      const children = keep(node.children);
      if (fold(labelOf(node), locale).includes(q) || children.length) acc.push({ ...node, children });
      return acc;
    }, []);
  return keep(nodes);
}

function fold(text: string, locale?: string): string {
  let lower: string;
  try {
    lower = text.toLocaleLowerCase(locale || undefined);
  } catch {
    lower = text.toLowerCase();
  }
  return lower.normalize("NFD").replace(/\p{M}/gu, "");
}

/** The first folder that can be picked, in list order. */
export function firstEnabled(nodes: MoveMenuNode[]): MoveMenuNode | undefined {
  for (const node of nodes) {
    if (node.enabled) return node;
    const below = firstEnabled(node.children);
    if (below) return below;
  }
  return undefined;
}

/**
 * Any folder tree in Move-list order (system folders first, then by name),
 * for pickers that build their own tree, such as the Rules menu's.
 */
export function sortFolderTree<T extends { role?: string | null; name: string; children: T[] }>(nodes: T[], locale?: string): T[] {
  const compare = compareMoveNodes(makeCollator(locale));
  const sort = (list: T[]): T[] => [...list].map((node) => ({ ...node, children: sort(node.children) })).sort(compare);
  return sort(nodes);
}
