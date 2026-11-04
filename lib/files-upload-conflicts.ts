/*
 * Uploading something whose name is already taken in the target folder
 * (pim-10). The upload asks first, per name: Replace, Keep both or Skip.
 *
 * - A file over a file: Replace gives the existing node the new content, so
 *   it keeps its id, its shares and its links. Keep both adds "name (1).ext".
 * - A folder over a folder (folder upload): Replace puts the folder's content
 *   into the existing folder and replaces files of the same name in it, as a
 *   file manager's "merge" does. Keep both makes "Folder (1)".
 * - A file and a folder of the same name can't replace each other: the new
 *   one is kept beside it with a number, without asking, as before.
 */

export type UploadConflictKind = 'file' | 'folder';

export interface UploadConflict {
  /** The name in the target folder: a file's name, or a folder upload's top folder. */
  name: string;
  kind: UploadConflictKind;
}

export type UploadConflictChoice = 'replace' | 'keep' | 'skip';

/**
 * Asks about the conflicts, in order. Resolves to a choice per name, or to
 * null when the user called the whole upload off.
 */
export type UploadConflictResolver = (conflicts: UploadConflict[]) => Promise<Map<string, UploadConflictChoice> | null>;

export interface ExistingEntry {
  name: string;
  isDirectory: boolean;
}

/**
 * What of `incoming` clashes with `existing`, in the order of `incoming`.
 * Only same-kind clashes are conflicts; each name is listed once.
 */
export function findUploadConflicts(incoming: UploadConflict[], existing: ExistingEntry[]): UploadConflict[] {
  const files = new Set(existing.filter((e) => !e.isDirectory).map((e) => e.name));
  const folders = new Set(existing.filter((e) => e.isDirectory).map((e) => e.name));
  const seen = new Set<string>();
  const conflicts: UploadConflict[] = [];
  for (const entry of incoming) {
    const key = `${entry.kind}:${entry.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if ((entry.kind === 'file' ? files : folders).has(entry.name)) conflicts.push(entry);
  }
  return conflicts;
}

/** A conflict's answer: the choice, whether it covers the rest, or stop. */
export type ConflictAnswer = { choice: UploadConflictChoice; applyToAll: boolean } | null;

/**
 * Goes through the conflicts one question at a time; "Do this for all"
 * answers the rest with the same choice. Null when a question was called off.
 */
export async function resolveConflictsInTurn(
  conflicts: UploadConflict[],
  ask: (conflict: UploadConflict, index: number, total: number) => Promise<ConflictAnswer>,
): Promise<Map<string, UploadConflictChoice> | null> {
  const choices = new Map<string, UploadConflictChoice>();
  for (let i = 0; i < conflicts.length; i++) {
    const answer = await ask(conflicts[i], i, conflicts.length);
    if (!answer) return null;
    if (answer.applyToAll) {
      for (const rest of conflicts.slice(i)) choices.set(rest.name, answer.choice);
      break;
    }
    choices.set(conflicts[i].name, answer.choice);
  }
  return choices;
}
