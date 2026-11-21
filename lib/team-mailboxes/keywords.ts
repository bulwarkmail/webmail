/**
 * Assignment and status of a message in a team mailbox, as JMAP keywords on
 * the message, which every member of the group account sees the same (and
 * IMAP clients see as flags). The same keywords as the team-inbox plugin, so
 * nothing it set is lost:
 *
 *   $assigned:<principal id>   who the message is assigned to, one at a time
 *   $done                      the message is dealt with
 *
 * Stalwart uses a user's account id as their principal id ("cj"). Ids are
 * short letters and digits, lower-cased in the keyword; keywords are
 * case-insensitive in JMAP. "Open" means not done: read state can't say it,
 * since $seen is shared in a group account too.
 *
 * The change functions return keyword patches: keyword → true (set) or null
 * (remove), empty when nothing changes. The caller turns them into
 * `keywords/<name>` pointers for Email/set.
 */

export const ASSIGNED_PREFIX = '$assigned:';
export const DONE_KEYWORD = '$done';

export type KeywordPatch = Record<string, true | null>;
export type Keywords = Readonly<Record<string, boolean>> | readonly string[] | null | undefined;

/** What fits in a keyword after the prefix (the plugin API's keyword rule). */
const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,100}$/i;

export function isAssigneeId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

/** `$assigned:<id>`, lower case. Throws for an id that can't go in a keyword. */
export function assignedKeyword(id: string): string {
  if (!isAssigneeId(id)) throw new Error(`Not an id that fits in a keyword: ${id}`);
  return ASSIGNED_PREFIX + id.toLowerCase();
}

/** The keywords that are set, lower case, from a JMAP keyword map or a list. */
export function keywordList(keywords: Keywords): string[] {
  if (Array.isArray(keywords)) {
    return (keywords as readonly unknown[]).filter((k): k is string => typeof k === 'string').map((k) => k.toLowerCase());
  }
  if (keywords && typeof keywords === 'object') {
    const map = keywords as Readonly<Record<string, boolean>>;
    return Object.keys(map).filter((k) => map[k]).map((k) => k.toLowerCase());
  }
  return [];
}

/** Every id the message is assigned to: normally one, two when clients raced. */
export function assigneesOf(keywords: Keywords): string[] {
  return [...new Set(keywordList(keywords)
    .filter((k) => k.startsWith(ASSIGNED_PREFIX))
    .map((k) => k.slice(ASSIGNED_PREFIX.length))
    .filter(isAssigneeId))];
}

/** Whether the message is assigned to `id` (among others, after a race). */
export function assignedTo(keywords: Keywords, id: string | null | undefined): boolean {
  if (!id) return false;
  return assigneesOf(keywords).includes(id.toLowerCase());
}

export function isDone(keywords: Keywords): boolean {
  return keywordList(keywords).includes(DONE_KEYWORD);
}

/**
 * Assigns the message to `id` and to nobody else: every other `$assigned:*`
 * it carries goes, so an Assign after a race leaves one.
 */
export function assignChanges(keywords: Keywords, id: string): KeywordPatch {
  const wanted = assignedKeyword(id);
  const changes: KeywordPatch = {};
  for (const other of assigneesOf(keywords)) {
    const keyword = ASSIGNED_PREFIX + other;
    if (keyword !== wanted) changes[keyword] = null;
  }
  if (!keywordList(keywords).includes(wanted)) changes[wanted] = true;
  return changes;
}

/** Leaves the message assigned to nobody. */
export function unassignChanges(keywords: Keywords): KeywordPatch {
  const changes: KeywordPatch = {};
  for (const id of assigneesOf(keywords)) changes[ASSIGNED_PREFIX + id] = null;
  return changes;
}

export function doneChanges(keywords: Keywords): KeywordPatch {
  return isDone(keywords) ? {} : { [DONE_KEYWORD]: true };
}

export function reopenChanges(keywords: Keywords): KeywordPatch {
  return isDone(keywords) ? { [DONE_KEYWORD]: null } : {};
}

/** The patch that takes `patch` back: what it set is removed, what it removed is set. */
export function reversePatch(patch: KeywordPatch): KeywordPatch {
  const out: KeywordPatch = {};
  for (const [keyword, value] of Object.entries(patch)) out[keyword] = value === true ? null : true;
  return out;
}

/**
 * People messages were assigned to lately, most often first (ties by id):
 * `seen` maps id → count.
 */
export function recentAssignees(
  seen: ReadonlyMap<string, number>,
  { exclude = [], limit = 8 }: { exclude?: readonly string[]; limit?: number } = {},
): string[] {
  const skip = new Set(exclude.map((id) => String(id).toLowerCase()));
  return [...seen.entries()]
    .filter(([id]) => !skip.has(id.toLowerCase()))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([id]) => id);
}
