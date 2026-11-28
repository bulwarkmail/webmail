/**
 * The mail actions that can still be undone, newest last: the moves, deletes
 * and archives a toast offered Undo for, and the read, flag and tag changes.
 * Ctrl+Z (or `z`) undoes them one after another, newest first, so an Undo
 * isn't lost when the next action's toast replaces it.
 */
export interface UndoEntry {
  id: string;
  /** What was done ("Email archived"), for the record. */
  label: string;
  /** Puts it back. Reports its own outcome (a toast). */
  run: () => void;
  keys?: string[];
  onGone?: () => void;
}

/** How many actions are kept. */
export const MAX_UNDO_HISTORY = 10;

let entries: UndoEntry[] = [];
let nextId = 1;

/** Adds an action that can be undone; the oldest goes when there are too many. */
export function recordUndo(label: string, run: () => void, keys?: string[]): UndoEntry {
  const entry: UndoEntry = { id: `undo-${nextId++}`, label, run, keys };
  const all = [...entries, entry];
  entries = all.slice(-MAX_UNDO_HISTORY);
  for (const dropped of all.slice(0, -MAX_UNDO_HISTORY)) dropped.onGone?.();
  return entry;
}

export function onUndoGone(id: string, listener: () => void): void {
  const entry = entries.find((e) => e.id === id);
  if (entry) entry.onGone = listener;
}

/**
 * Undoes one entry and takes it off the list, so it can't run twice (the
 * toast's Undo after Ctrl+Z, or the other way round). False when it was
 * already undone or dropped.
 */
export function runUndo(id: string): boolean {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return false;
  const keys = new Set(entry.keys ?? []);
  const later = entries.slice(entries.indexOf(entry) + 1);
  const stale = later.filter((e) => e.keys?.some((k) => keys.has(k)));
  entries = entries.filter((e) => e !== entry && !stale.includes(e));
  entry.onGone?.();
  for (const e of stale) e.onGone?.();
  entry.run();
  return true;
}

/** Undoes the newest entry and closes its toast. Null when there is nothing to undo. */
export function undoLatest(): UndoEntry | null {
  const entry = entries.at(-1);
  if (!entry) return null;
  runUndo(entry.id);
  return entry;
}

export function undoHistory(): readonly UndoEntry[] {
  return entries;
}

/** Forgets everything, e.g. after signing out. */
export function clearUndoHistory(): void {
  const gone = entries;
  entries = [];
  for (const e of gone) e.onGone?.();
}
