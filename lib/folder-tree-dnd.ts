import type { MailboxNode } from '@/lib/utils';

/**
 * Helpers for drag & drop of the folder tree in Settings → Folders.
 *
 * The tree is rendered as a single flattened sortable list; while dragging,
 * the pointer's vertical position picks the insertion point and its horizontal
 * offset picks the nesting depth (dnd-kit's sortable-tree projection model).
 * This is what lets a drag both reorder folders and move them under a
 * different parent (GitHub #855).
 */

export interface FlatFolder {
  id: string;
  /** Normalized: null for root-level folders. */
  parentId: string | null;
  depth: number;
  node: MailboxNode;
}

export interface Projection {
  depth: number;
  parentId: string | null;
}

function arrayMove<T>(array: T[], from: number, to: number): T[] {
  const result = array.slice();
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}

/**
 * Flattens the visible part of the tree (collapsed folders contribute only
 * themselves, not their children) in rendering order.
 *
 * parentId is taken from the tree structure, not from the raw mailbox data:
 * a folder whose real parent is missing from the server response is rendered
 * at root level, and reordering must treat it as a root sibling.
 */
export function flattenVisibleTree(
  nodes: MailboxNode[],
  expandedIds: Set<string>,
): FlatFolder[] {
  const result: FlatFolder[] = [];
  const walk = (items: MailboxNode[], parentId: string | null, depth: number) => {
    for (const node of items) {
      result.push({ id: node.id, parentId, depth, node });
      if (node.children.length > 0 && expandedIds.has(node.id)) {
        walk(node.children, node.id, depth + 1);
      }
    }
  };
  walk(nodes, null, 0);
  return result;
}

/**
 * Removes the descendants of `rootId` (but not `rootId` itself). Used while
 * dragging so a folder's subtree travels with it and can never become its own
 * drop target (which would create a cycle).
 */
export function removeSubtree(items: FlatFolder[], rootId: string): FlatFolder[] {
  const excluded = new Set<string>([rootId]);
  return items.filter(item => {
    if (item.parentId !== null && excluded.has(item.parentId)) {
      excluded.add(item.id);
      return false;
    }
    return true;
  });
}

/**
 * Computes where the dragged folder would land: its new depth (clamped to the
 * depths that are structurally valid at that position) and the parent that
 * depth implies. `dragOffset` is the horizontal pointer delta since drag
 * start; each `indentationWidth` of it shifts the target depth by one level.
 */
export function getProjection(
  items: FlatFolder[],
  activeId: string,
  overId: string,
  dragOffset: number,
  indentationWidth: number,
): Projection | null {
  const overItemIndex = items.findIndex(i => i.id === overId);
  const activeItemIndex = items.findIndex(i => i.id === activeId);
  if (overItemIndex < 0 || activeItemIndex < 0) return null;

  const activeItem = items[activeItemIndex];
  const newItems = arrayMove(items, activeItemIndex, overItemIndex);
  const previousItem = newItems[overItemIndex - 1];
  const nextItem = newItems[overItemIndex + 1];

  const dragDepth = Math.round(dragOffset / indentationWidth);
  const projectedDepth = activeItem.depth + dragDepth;
  // Can nest at most one level under the item above; can't out-dent past the
  // item below (that would split its sibling group).
  const maxDepth = previousItem ? previousItem.depth + 1 : 0;
  const minDepth = nextItem ? nextItem.depth : 0;
  const depth = Math.min(Math.max(projectedDepth, minDepth), maxDepth);

  let parentId: string | null = null;
  if (depth > 0 && previousItem) {
    if (depth === previousItem.depth) {
      parentId = previousItem.parentId;
    } else if (depth > previousItem.depth) {
      parentId = previousItem.id;
    } else {
      // Out-dented below a deeper item: adopt the parent of the nearest
      // preceding item at the target depth.
      parentId = newItems
        .slice(0, overItemIndex)
        .reverse()
        .find(item => item.depth === depth)?.parentId ?? null;
    }
  }

  return { depth, parentId };
}

export interface DropPlan {
  parentId: string | null;
  parentChanged: boolean;
  /** The new parent's sibling group in its new order, including the dragged folder. */
  orderedSiblingIds: string[];
}

/**
 * Turns a projection into the concrete mutation to perform: the (possibly
 * unchanged) parent and the new ordering of that parent's visible children.
 */
export function getDropPlan(
  items: FlatFolder[],
  activeId: string,
  overId: string,
  projection: Projection,
): DropPlan | null {
  const activeIndex = items.findIndex(i => i.id === activeId);
  const overIndex = items.findIndex(i => i.id === overId);
  if (activeIndex < 0 || overIndex < 0) return null;

  const activeItem = items[activeIndex];
  const newItems = arrayMove(items, activeIndex, overIndex);
  const orderedSiblingIds = newItems
    .filter(i => (i.id === activeId ? projection.parentId : i.parentId) === projection.parentId)
    .map(i => i.id);

  return {
    parentId: projection.parentId,
    parentChanged: activeItem.parentId !== projection.parentId,
    orderedSiblingIds,
  };
}
