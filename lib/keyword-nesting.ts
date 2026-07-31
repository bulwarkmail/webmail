/**
 * Tag nesting.
 *
 * A tag is stored on the server as the JMAP keyword `$label:<id>`, where `id`
 * is a slug derived from the display name. Nesting reuses that single id: the
 * levels are joined with a forward slash, so `$label:work/clients` is the child
 * of `$label:work`. Keeping the hierarchy inside the id means the server stays
 * the source of truth for tag membership and existing lookups by keyword keep
 * working.
 *
 * RFC 8621 section 4.1.1 allows a keyword of 1-255 characters from the ASCII
 * range %x21-%x7e minus `( ) { ] % * " \`, so the separator is legal but the
 * length of a deep id is not free - `MAX_KEYWORD_ID_LENGTH` is the budget a
 * composed id has to stay within.
 *
 * Turning any of this into text for the screen lives in `keyword-format`.
 */
import type { KeywordDefinition } from "@/stores/settings-store";
import { KEYWORD_PREFIX } from "./thread-utils";

/** Separates parent from child inside a tag id. */
export const KEYWORD_SEPARATOR = "/";

/** Longest keyword a JMAP server has to accept (RFC 8621, section 4.1.1). */
export const MAX_KEYWORD_LENGTH = 255;

/** What is left for the id once the `$label:` prefix is spent. */
export const MAX_KEYWORD_ID_LENGTH = MAX_KEYWORD_LENGTH - KEYWORD_PREFIX.length;

/** A tag definition placed in the hierarchy its id describes. */
export interface KeywordNode extends KeywordDefinition {
  children: KeywordNode[];
  depth: number;
}

/**
 * Reduces a display name to one level of an id: lowercase, and everything
 * outside `[a-z0-9_-]` folded to a single dash. The separator is not exempt -
 * a slash typed into the name is a literal part of that name, not a level.
 * The only slug function for tag ids; keep it the only one.
 */
export function normalizeKeywordLevel(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Builds the id a tag named `name` gets under `parentId` (null = top level). */
export function composeKeywordId(parentId: string | null, name: string): string {
  const level = normalizeKeywordLevel(name);
  if (!parentId || !level) return level;
  return `${parentId}${KEYWORD_SEPARATOR}${level}`;
}

/** Splits `work/clients/acme` into `["work", "clients", "acme"]`. */
export function keywordLevels(id: string): string[] {
  return id.split(KEYWORD_SEPARATOR).filter(Boolean);
}

/** The id of the tag one level up, or null for a top-level tag. */
export function getParentKeywordId(id: string): string | null {
  const index = id.lastIndexOf(KEYWORD_SEPARATOR);
  return index === -1 ? null : id.slice(0, index);
}

/** True when `candidateId` sits anywhere below `ancestorId`. */
export function isKeywordDescendant(candidateId: string, ancestorId: string): boolean {
  return candidateId.startsWith(`${ancestorId}${KEYWORD_SEPARATOR}`);
}

/** True when any defined tag sits below `id`. */
export function hasChildKeywords(id: string, keywords: KeywordDefinition[]): boolean {
  return keywords.some((keyword) => isKeywordDescendant(keyword.id, id));
}

/**
 * Arranges tag definitions into the tree their ids describe, preserving the
 * user's manual order within each level.
 *
 * A tag whose direct parent is not defined stays at the root rather than being
 * hidden or grafted onto a grandparent; callers name such a root in full so the
 * missing level is still visible.
 */
export function buildKeywordTree(keywords: KeywordDefinition[]): KeywordNode[] {
  const nodes = new Map<string, KeywordNode>();
  for (const keyword of keywords) {
    nodes.set(keyword.id, { ...keyword, children: [], depth: 0 });
  }

  const roots: KeywordNode[] = [];
  for (const keyword of keywords) {
    const node = nodes.get(keyword.id)!;
    const parentId = getParentKeywordId(keyword.id);
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const setDepth = (node: KeywordNode, depth: number) => {
    node.depth = depth;
    node.children.forEach((child) => setDepth(child, depth + 1));
  };
  roots.forEach((root) => setDepth(root, 0));

  return roots;
}

/**
 * Prunes a tag tree down to the nodes worth showing.
 *
 * A node survives when the predicate accepts it or when any of its descendants
 * survives, so hiding a parent never strands the children below it. Depths are
 * left untouched: a kept node keeps the indentation of its original level even
 * when the level above it is only there to carry it.
 */
export function filterKeywordTree(
  nodes: KeywordNode[],
  isVisible: (node: KeywordNode) => boolean,
): KeywordNode[] {
  const kept: KeywordNode[] = [];
  for (const node of nodes) {
    const children = filterKeywordTree(node.children, isVisible);
    if (children.length > 0 || isVisible(node)) {
      kept.push({ ...node, children });
    }
  }
  return kept;
}

/** Total number of nodes in a tag tree, at every level. */
export function countKeywordNodes(nodes: KeywordNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countKeywordNodes(node.children), 0);
}
