/**
 * The "Team notes" folder of a team mailbox (a Stalwart group account) holds
 * one small message per note (lib/team-mailboxes/note-format.ts). It is part
 * of the mailbox, so export includes it and IMAP clients see it, but Bulwark
 * itself never lists, counts, searches or offers it anywhere.
 *
 * The rule lives here, once:
 * - a folder is hidden when it sits at the root of an account other than the
 *   login's own, has no role, and is named "Team notes";
 * - folder lists leave it out where they are mapped (lib/jmap/client.ts),
 *   which covers every list, picker and count built from them;
 * - queries without a folder (search, tag views, unified views) add
 *   `hiddenFolderClause`, so its messages never show up in results.
 *
 * The name is the marker on purpose: the folder must be found by any member,
 * on any server version, without metadata. A folder somebody made by hand
 * with that exact name in a shared account is hidden too.
 */

export const TEAM_NOTES_FOLDER_NAME = 'Team notes';

/** Every note message carries it (and `$seen`). */
export const NOTE_KEYWORD = '$bulwark-note';

interface RawFolder {
  name?: string | null;
  parentId?: string | null;
  role?: string | null;
}

/** Whether this raw JMAP mailbox is a team notes folder Bulwark keeps out of sight. */
export function isTeamNotesFolder(folder: RawFolder, isOwnAccount: boolean): boolean {
  if (isOwnAccount) return false;
  if (folder.parentId) return false;
  if (folder.role) return false;
  return folder.name === TEAM_NOTES_FOLDER_NAME;
}

/** Splits a raw Mailbox/get list into what Bulwark shows and the ids it hides. */
export function splitHiddenFolders<T extends RawFolder & { id: string }>(
  folders: readonly T[],
  isOwnAccount: boolean,
): { visible: T[]; hiddenIds: string[] } {
  const visible: T[] = [];
  const hiddenIds: string[] = [];
  for (const folder of folders) {
    if (isTeamNotesFolder(folder, isOwnAccount)) hiddenIds.push(folder.id);
    else visible.push(folder);
  }
  return { visible, hiddenIds };
}

/**
 * The same rule for folders already mapped into the store's shape, for lists
 * that don't come through the client (the boot snapshot in localStorage, which
 * an older build may have written with the folder in it).
 */
export function withoutHiddenFolders<T extends RawFolder & { isShared?: boolean }>(folders: readonly T[]): T[] {
  return folders.filter((folder) => !isTeamNotesFolder(folder, !folder.isShared));
}

/**
 * The condition that keeps notes out of a query without a folder. The
 * keyword part works before the folder ids are known; the folder part also
 * catches notes another client wrote without the keyword. `hiddenIds` are the
 * account's raw JMAP ids, never the store's `accountId:id` form.
 */
export function hiddenFolderClause(hiddenIds: readonly string[] = []): Record<string, unknown> {
  const keyword = { notKeyword: NOTE_KEYWORD };
  if (hiddenIds.length === 0) return keyword;
  return { operator: 'AND', conditions: [keyword, { inMailboxOtherThan: [...hiddenIds] }] };
}

/**
 * Remembers, per JMAP account, the raw ids of the folders that were left out
 * of the lists, so queries can exclude them after they are gone from every
 * list. One per client: ids repeat across accounts and logins.
 */
export class HiddenFolderRegistry {
  private byAccount = new Map<string, Set<string>>();

  /** Replaces what is known for an account from a complete folder list. */
  setAll(accountId: string, hiddenIds: readonly string[]): void {
    if (hiddenIds.length === 0) this.byAccount.delete(accountId);
    else this.byAccount.set(accountId, new Set(hiddenIds));
  }

  /** Adds ids found in a partial list (Mailbox/get by ids). */
  add(accountId: string, hiddenIds: readonly string[]): void {
    if (hiddenIds.length === 0) return;
    const set = this.byAccount.get(accountId) ?? new Set<string>();
    for (const id of hiddenIds) set.add(id);
    this.byAccount.set(accountId, set);
  }

  ids(accountId: string): string[] {
    return [...(this.byAccount.get(accountId) ?? [])];
  }

  has(accountId: string, rawId: string): boolean {
    return this.byAccount.get(accountId)?.has(rawId) ?? false;
  }

  clear(): void {
    this.byAccount.clear();
  }
}
