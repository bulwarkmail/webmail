/**
 * JMAP PatchObjects for the two properties that can change offline, keywords
 * and mailboxIds, in both forms the client sends: `keywords/$seen` paths and
 * the whole map.
 */

export type Patch = Record<string, unknown>;

export interface RecordState {
  keywords?: Record<string, boolean>;
  mailboxIds?: Record<string, boolean>;
}

const MAPS = ['keywords', 'mailboxIds'] as const;
type MapName = (typeof MAPS)[number];

function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** The map and the key a path changes, or null when it isn't one of ours. */
function parsePath(path: string): { map: MapName; key: string | null } | null {
  const slash = path.indexOf('/');
  const name = slash < 0 ? path : path.slice(0, slash);
  if (!(MAPS as readonly string[]).includes(name)) return null;
  return { map: name as MapName, key: slash < 0 ? null : unescapeToken(path.slice(slash + 1)) };
}

/** Why this patch can't wait offline, or null when it can. */
export function patchProblem(patch: Patch): { type: string; description: string } | null {
  const paths = Object.keys(patch);
  if (paths.length === 0) return { type: 'invalidPatch', description: 'An empty change' };
  for (const path of paths) {
    const parsed = parsePath(path);
    if (!parsed) return { type: 'forbidden', description: `Changing ${path} needs the server` };
    // A folder made in the same request: that part needs the server, so this does too.
    if (parsed.map === 'mailboxIds') {
      const keys = parsed.key !== null ? [parsed.key] : Object.keys((patch[path] ?? {}) as object);
      if (keys.some((key) => key.startsWith('#'))) return { type: 'forbidden', description: 'A new folder needs the server' };
    }
  }
  return null;
}

/** `false` means removal to the client's code; on the wire only null does. */
export function normalizePatch(patch: Patch): Patch {
  const out: Patch = {};
  for (const [path, value] of Object.entries(patch)) out[path] = path.includes('/') && !value ? null : value;
  return out;
}

export function applyPatch<T extends object>(record: T, patch: Patch): T & RecordState {
  const state = record as RecordState;
  const next: T & RecordState = {
    ...record,
    keywords: { ...(state.keywords ?? {}) },
    mailboxIds: { ...(state.mailboxIds ?? {}) },
  };
  for (const [path, value] of Object.entries(patch)) {
    const parsed = parsePath(path);
    if (!parsed) continue;
    if (parsed.key === null) {
      next[parsed.map] = { ...((value ?? {}) as Record<string, boolean>) };
      continue;
    }
    const map = next[parsed.map] as Record<string, boolean>;
    if (value) map[parsed.key] = true;
    else delete map[parsed.key];
  }
  return next;
}

/**
 * A later change to the same record on top of an earlier one. A whole map
 * replaces every earlier change to that map; a path into a map the earlier
 * change replaced goes into that map, since the whole map is what gets sent.
 */
export function mergePatches(earlier: Patch, later: Patch): Patch {
  const out: Patch = { ...earlier };
  for (const [path, value] of Object.entries(later)) {
    const parsed = parsePath(path);
    if (!parsed) {
      out[path] = value;
      continue;
    }
    if (parsed.key === null) {
      for (const existing of Object.keys(out)) {
        if (existing === parsed.map || existing.startsWith(`${parsed.map}/`)) delete out[existing];
      }
      out[path] = value;
      continue;
    }
    if (parsed.map in out) {
      const map = { ...(out[parsed.map] as Record<string, boolean>) };
      if (value) map[parsed.key] = true;
      else delete map[parsed.key];
      out[parsed.map] = map;
      continue;
    }
    out[path] = value;
  }
  return out;
}

function sameMap(a: Record<string, boolean> | undefined, b: Record<string, boolean> | undefined): boolean {
  const left = Object.keys(a ?? {}).filter((key) => a?.[key]).map((key) => key.toLowerCase()).sort();
  const right = Object.keys(b ?? {}).filter((key) => b?.[key]).map((key) => key.toLowerCase()).sort();
  return left.length === right.length && left.every((key, i) => key === right[i]);
}

function has(map: Record<string, boolean> | undefined, key: string): boolean {
  const wanted = key.toLowerCase();
  return Object.keys(map ?? {}).some((name) => name.toLowerCase() === wanted && map?.[name]);
}

/**
 * Whether the server changed what this patch touches since it was queued. A
 * change elsewhere on the record isn't a conflict, and neither is the server
 * already having what the patch wants. Folders count as a whole: a move here
 * after a move on another device would leave the message in both places.
 * Keywords stand alone.
 */
export function patchConflicts(patch: Patch, base: RecordState | null, serverRecord: object): boolean {
  if (!base) return false;
  const server = serverRecord as RecordState;
  const paths = Object.keys(patch).map((path) => parsePath(path));
  if (paths.some((parsed) => parsed?.map === 'mailboxIds')
    && !sameMap(base.mailboxIds, server.mailboxIds)
    && !sameMap(applyPatch(base, patch).mailboxIds, server.mailboxIds)) return true;
  for (const [path, value] of Object.entries(patch)) {
    const parsed = parsePath(path);
    if (!parsed || parsed.map === 'mailboxIds') continue;
    if (parsed.key === null) {
      const wanted = value as Record<string, boolean>;
      if (!sameMap(base[parsed.map], server[parsed.map]) && !sameMap(wanted, server[parsed.map])) return true;
      continue;
    }
    const before = has(base[parsed.map], parsed.key);
    const now = has(server[parsed.map], parsed.key);
    if (before !== now && now !== Boolean(value)) return true;
  }
  return false;
}

/** Deleting a record the server changed since: the user should see that. */
export function destroyConflicts(base: RecordState | null, serverRecord: object): boolean {
  if (!base) return false;
  const server = serverRecord as RecordState;
  return !sameMap(base.keywords, server.keywords) || !sameMap(base.mailboxIds, server.mailboxIds);
}

export function stateOf(record: object): RecordState {
  const state = record as RecordState;
  return { keywords: state.keywords ?? {}, mailboxIds: state.mailboxIds ?? {} };
}
