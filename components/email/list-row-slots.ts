import { useRef } from "react";

interface SlotState {
  slotOf: Map<string, string>;
  atIndex: Map<number, string>;
  next: number;
}

/**
 * React keys for the list's rows, so that a row on screen is updated rather
 * than replaced when another message takes its place.
 *
 * A row that stays listed keeps its key wherever it moves, so new mail at the
 * top or a row leaving touches nothing else. A message that wasn't on screen
 * takes the key of the row drawn at its position before, when that row is no
 * longer listed: after a folder switch or a search, React updates the
 * fourteen rows on screen with the new messages instead of taking them down
 * and building fourteen new ones, which was most of the work of drawing the
 * new list. Parts of a row that hold state about its message are keyed by the
 * message inside the row (see SingleEmailItem).
 */
export function useRowSlots(items: ReadonlyArray<{ index: number; key: string }>): Map<string, string> {
  const ref = useRef<SlotState | null>(null);
  if (!ref.current) ref.current = { slotOf: new Map(), atIndex: new Map(), next: 0 };
  const state = ref.current;
  const claimed = new Set<string>();
  const unplaced: Array<{ index: number; key: string }> = [];
  // Rows already drawn keep their slots.
  for (const item of items) {
    const slot = state.slotOf.get(item.key);
    if (slot !== undefined && !claimed.has(slot)) claimed.add(slot);
    else unplaced.push(item);
  }
  // New ones take the free slot at their position, else a new one.
  for (const { index, key } of unplaced) {
    const previous = state.atIndex.get(index);
    let slot: string;
    if (previous !== undefined && !claimed.has(previous)) slot = previous;
    else slot = `row-${state.next++}`;
    state.slotOf.set(key, slot);
    claimed.add(slot);
  }
  const atIndex = new Map<number, string>();
  for (const { index, key } of items) atIndex.set(index, state.slotOf.get(key)!);
  state.atIndex = atIndex;
  // Forget rows far from the screen: the map would otherwise grow with every
  // row scrolled past in a large folder.
  if (state.slotOf.size > 4 * items.length + 200) {
    const keep = new Set(items.map((item) => item.key));
    for (const key of state.slotOf.keys()) if (!keep.has(key)) state.slotOf.delete(key);
  }
  return state.slotOf;
}
