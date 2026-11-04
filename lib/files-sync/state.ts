/**
 * The engine's record of one root: what both sides were at the last sync, per item. Main keeps
 * it (`loadState`/`saveState`), next to the root, as an opaque string.
 *
 * An item is a FileNode the root holds, with its place on both sides. `path` is the local path,
 * `name` the name in Files: the two differ where the disk needed another name (names.ts), and
 * keeping both is what keeps that from reading as a rename either way.
 */

export interface BaseItem {
  /** The FileNode id. */
  id: string;
  kind: 'file' | 'directory';
  /** Local, relative to the root. */
  path: string;
  /** In Files. */
  name: string;
  /** The node's parent in Files. The root's folder (or null, the top of Files) for an item at the top. */
  parentId: string | null;
  // Files, at the last sync.
  blobId: string | null;
  size: number;
  modifiedMs: number;
  // This computer, at the last sync. An empty fileId: not known yet (a placeholder just placed).
  fileId: string;
  localSize: number;
  mtimeMs: number;
}

export interface TooLarge {
  size: number;
  mtimeMs: number;
}

export interface RootRecord {
  v: 1;
  /** The Files folder it was made for: a record of another one says nothing about this root. */
  remoteId: string | null;
  items: BaseItem[];
  /** Local files over the server's upload limit, as they were when that was found. */
  tooLarge: Record<string, TooLarge>;
}

export function emptyRecord(remoteId: string | null): RootRecord {
  return { v: 1, remoteId, items: [], tooLarge: {} };
}

function validItem(value: unknown): value is BaseItem {
  const item = value as BaseItem;
  return !!item
    && typeof item.id === 'string' && item.id.length > 0
    && (item.kind === 'file' || item.kind === 'directory')
    && typeof item.path === 'string' && item.path.length > 0
    && typeof item.name === 'string'
    && (item.parentId === null || typeof item.parentId === 'string')
    && (item.blobId === null || typeof item.blobId === 'string')
    && Number.isFinite(item.size) && Number.isFinite(item.modifiedMs)
    && typeof item.fileId === 'string' && Number.isFinite(item.localSize) && Number.isFinite(item.mtimeMs);
}

/**
 * The record, or an empty one when there's none, it can't be read, or it was made for another
 * Files folder. Empty means "never synced": both sides are then put together without deleting
 * anything.
 */
export function parseRecord(raw: string | null, remoteId: string | null): RootRecord {
  if (!raw) return emptyRecord(remoteId);
  try {
    const parsed = JSON.parse(raw) as Partial<RootRecord>;
    if (parsed?.v !== 1 || parsed.remoteId !== remoteId || !Array.isArray(parsed.items)) return emptyRecord(remoteId);
    const tooLarge: Record<string, TooLarge> = {};
    for (const [path, entry] of Object.entries(parsed.tooLarge ?? {})) {
      if (entry && Number.isFinite(entry.size) && Number.isFinite(entry.mtimeMs)) tooLarge[path] = { size: entry.size, mtimeMs: entry.mtimeMs };
    }
    return { v: 1, remoteId, items: parsed.items.filter(validItem), tooLarge };
  } catch {
    return emptyRecord(remoteId);
  }
}

export function serializeRecord(record: RootRecord): string {
  return JSON.stringify(record);
}
