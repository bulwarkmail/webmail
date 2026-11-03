/**
 * File contents kept on the device: pinned files, and recently opened ones
 * within a cap. Metadata for every file is in file_node regardless.
 *
 * What gets kept:
 * - A pinned file stays until it's unpinned or removed on the server. The cap
 *   doesn't push it out and the size limit for one file doesn't apply. The
 *   account's total limit (scope.maxTotalBytes, which a policy can lower) does.
 * - A recently opened file is kept if it's within scope.maxAttachmentBytes, and
 *   pushed out oldest first when the cap is reached. Its opened_at goes with
 *   it, so it isn't fetched straight back.
 * - With scope.attachments off, nothing is kept.
 */

import { TransportError } from '../engine/transport';
import { MethodError, type ScopeChange, type StoreContext, type StoreUsagePart, type SyncContext } from '../area';
import type { StorageAdapter } from '../storage';
import { nodeMediaType, type WireNode } from './records';

export const FILE_CACHE_CAP_BYTES = 500 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

export interface KeptFile { data: Uint8Array; type: string; size: number }

export interface NodeRef { jmap: string; id: string }

interface NodeRow {
  jmap: string;
  id: string;
  name: string;
  kind: string;
  blob_id: string | null;
  size: number | null;
  json: string;
  pinned: number;
  opened_at: number | null;
  keep_error: string | null;
}

interface BlobRow {
  jmap: string;
  blob_id: string;
  size: number;
  kept_at: number;
  pinned: number;
  opened_at: number | null;
}

function capBytes(ctx: Pick<StoreContext, 'scope'>): number {
  return Math.min(FILE_CACHE_CAP_BYTES, ctx.scope.maxTotalBytes);
}

/** A kept file's content, for the client's blob lookup. */
export function fileBlob(ctx: Pick<StoreContext, 'db'>, jmap: string, blobId: string): KeptFile | null {
  const row = ctx.db.get<{ type: string; size: number }>('SELECT type, size FROM file_blob WHERE jmap = ? AND blob_id = ?', [jmap, blobId]);
  if (!row) return null;
  const data = new Uint8Array(Number(row.size));
  let at = 0;
  for (const chunk of ctx.db.all<{ data: Uint8Array }>('SELECT data FROM file_blob_chunk WHERE jmap = ? AND blob_id = ? ORDER BY seq', [jmap, blobId])) {
    data.set(chunk.data, at);
    at += chunk.data.length;
  }
  return { data, type: row.type, size: Number(row.size) };
}

function hasBlob(db: StorageAdapter, jmap: string, blobId: string): boolean {
  return Boolean(db.get('SELECT 1 AS x FROM file_blob WHERE jmap = ? AND blob_id = ?', [jmap, blobId]));
}

function dropBlob(db: StorageAdapter, jmap: string, blobId: string): void {
  db.run('DELETE FROM file_blob_chunk WHERE jmap = ? AND blob_id = ?', [jmap, blobId]);
  db.run('DELETE FROM file_blob WHERE jmap = ? AND blob_id = ?', [jmap, blobId]);
}

function storeBlob(ctx: StoreContext, jmap: string, blobId: string, type: string, data: Uint8Array): void {
  dropBlob(ctx.db, jmap, blobId);
  ctx.db.run('INSERT INTO file_blob (jmap, blob_id, type, size, kept_at) VALUES (?, ?, ?, ?, ?)', [jmap, blobId, type, data.length, ctx.now()]);
  for (let seq = 0, at = 0; at < data.length; seq += 1, at += CHUNK_BYTES) {
    ctx.db.run('INSERT INTO file_blob_chunk (jmap, blob_id, seq, data) VALUES (?, ?, ?, ?)', [jmap, blobId, seq, data.subarray(at, at + CHUNK_BYTES)]);
  }
}

/** All kept contents in the store, with what the nodes pointing at each say about it. */
function keptBlobs(db: StorageAdapter): BlobRow[] {
  return db.all<BlobRow>(
    `SELECT b.jmap, b.blob_id, b.size, b.kept_at, COALESCE(MAX(n.pinned), 0) AS pinned, MAX(n.opened_at) AS opened_at
     FROM file_blob b LEFT JOIN file_node n ON n.jmap = b.jmap AND n.blob_id = b.blob_id
     GROUP BY b.jmap, b.blob_id`,
  );
}

function ageOf(blob: BlobRow): number {
  return Number(blob.opened_at ?? blob.kept_at);
}

function pushOut(db: StorageAdapter, blob: BlobRow): void {
  dropBlob(db, blob.jmap, blob.blob_id);
  db.run('UPDATE file_node SET opened_at = NULL WHERE jmap = ? AND blob_id = ?', [blob.jmap, blob.blob_id]);
}

/**
 * Pushes out unpinned contents, oldest first, so `size` more fits under the
 * cap. A recently opened file only pushes out older ones and says false when
 * that isn't enough. A pinned one always gets in.
 */
function makeRoom(ctx: StoreContext, size: number, incoming: { pinned: boolean; openedAt: number }): boolean {
  const cap = capBytes(ctx);
  const blobs = keptBlobs(ctx.db);
  let used = blobs.reduce((sum, blob) => sum + Number(blob.size), 0);
  const candidates = blobs
    .filter((blob) => !blob.pinned && (incoming.pinned || ageOf(blob) < incoming.openedAt))
    .sort((a, b) => ageOf(a) - ageOf(b));
  const chosen: BlobRow[] = [];
  for (const blob of candidates) {
    if (used + size <= cap) break;
    used -= Number(blob.size);
    chosen.push(blob);
  }
  if (used + size > cap && !incoming.pinned) return false;
  for (const blob of chosen) pushOut(ctx.db, blob);
  return true;
}

function pinnedBytes(db: StorageAdapter): number {
  return keptBlobs(db).filter((blob) => blob.pinned).reduce((sum, blob) => sum + Number(blob.size), 0);
}

function setError(db: StorageAdapter, jmap: string, blobId: string, error: string | null): void {
  db.run('UPDATE file_node SET keep_error = ? WHERE jmap = ? AND blob_id = ?', [error, jmap, blobId]);
}

/** Contents no node points at any more: the file was removed or has a new version. */
export function dropOrphanBlobs(db: StorageAdapter): void {
  for (const blob of keptBlobs(db)) {
    const used = db.get('SELECT 1 AS x FROM file_node WHERE jmap = ? AND blob_id = ?', [blob.jmap, blob.blob_id]);
    if (!used) dropBlob(db, blob.jmap, blob.blob_id);
  }
}

interface Wanted { blob_id: string; id: string; name: string; size: number | null; json: string; pinned: number; opened_at: number | null }

function wantedRow(db: StorageAdapter, jmap: string, blobId: string): Wanted | undefined {
  return db.get<Wanted>(
    `SELECT blob_id, id, name, size, json, pinned, opened_at FROM file_node
     WHERE jmap = ? AND blob_id = ? AND (pinned = 1 OR opened_at IS NOT NULL)
     ORDER BY pinned DESC, opened_at DESC LIMIT 1`,
    [jmap, blobId],
  );
}

/** Fetches what should be kept and isn't yet, one file at a time, pinned files first. */
export async function fetchKeptFiles(ctx: SyncContext, jmap: string): Promise<void> {
  const { db } = ctx;
  if (!ctx.scope.attachments) {
    db.transaction(() => {
      for (const blob of keptBlobs(db)) dropBlob(db, blob.jmap, blob.blob_id);
      db.run("UPDATE file_node SET keep_error = 'notAllowed' WHERE jmap = ? AND (pinned = 1 OR opened_at IS NOT NULL)", [jmap]);
    });
    return;
  }
  db.transaction(() => {
    db.run("UPDATE file_node SET keep_error = NULL WHERE jmap = ? AND keep_error = 'notAllowed'", [jmap]);
    // The limit may have gone down since last time.
    makeRoom(ctx, 0, { pinned: true, openedAt: 0 });
  });
  const todo = db.all<{ blob_id: string }>(
    `SELECT n.blob_id FROM file_node n
     WHERE n.jmap = ? AND n.blob_id IS NOT NULL AND (n.pinned = 1 OR n.opened_at IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM file_blob b WHERE b.jmap = n.jmap AND b.blob_id = n.blob_id)
     GROUP BY n.blob_id ORDER BY MAX(n.pinned) DESC, MAX(n.opened_at) DESC`,
    [jmap],
  ).map((row) => String(row.blob_id));
  let done = 0;
  for (const blobId of todo) {
    if (ctx.stopped()) return;
    // The page may have changed its mind during the last download.
    const want = wantedRow(db, jmap, blobId);
    if (!want) continue;
    const known = Number(want.size ?? 0);
    if (!want.pinned && known > Math.min(ctx.scope.maxAttachmentBytes, capBytes(ctx))) {
      setError(db, jmap, blobId, 'tooLarge');
      continue;
    }
    if (want.pinned && pinnedBytes(db) + known > ctx.scope.maxTotalBytes) {
      setError(db, jmap, blobId, 'overLimit');
      continue;
    }
    let data: Uint8Array;
    const type = nodeMediaType(JSON.parse(want.json) as WireNode);
    try {
      data = await ctx.transport.download(jmap, blobId, type, want.name);
    } catch (error) {
      // No network or no credentials reach the engine. One bad file doesn't stop the others.
      if (error instanceof TransportError && error.kind === 'http') {
        setError(db, jmap, blobId, 'download');
        continue;
      }
      throw error;
    }
    db.transaction(() => {
      const now = wantedRow(db, jmap, blobId);
      if (!now) return;
      if (now.pinned ? pinnedBytes(db) + data.length > ctx.scope.maxTotalBytes : data.length > Math.min(ctx.scope.maxAttachmentBytes, capBytes(ctx))) {
        // The size in the metadata was wrong or missing. With the real one
        // noted, the next pass sees this without downloading it again.
        db.run('UPDATE file_node SET size = ? WHERE jmap = ? AND blob_id = ?', [data.length, jmap, blobId]);
        setError(db, jmap, blobId, now.pinned ? 'overLimit' : 'tooLarge');
        return;
      }
      if (!makeRoom(ctx, data.length, { pinned: Boolean(now.pinned), openedAt: Number(now.opened_at ?? 0) })) {
        db.run('UPDATE file_node SET opened_at = NULL WHERE jmap = ? AND blob_id = ? AND pinned = 0', [jmap, blobId]);
        return;
      }
      storeBlob(ctx, jmap, blobId, type, data);
      setError(db, jmap, blobId, null);
    });
    done += 1;
    ctx.emit({ type: 'progress', account: ctx.account, area: 'files', phase: 'contents', done, total: todo.length });
  }
  if (done > 0) ctx.emit({ type: 'changed', account: ctx.account, collections: ['FileContent'] });
}

/**
 * What the scope no longer allows leaves now, without the network. The pins
 * stay, so a loosened scope fetches them back at the next pass. A pin ignores
 * the size limit but not the total: the organisation's cap wins over it.
 */
export function applyFilesScope(ctx: SyncContext, _change: ScopeChange): void {
  const { db, scope } = ctx;
  let changed = false;
  db.transaction(() => {
    if (!scope.attachments) {
      for (const blob of keptBlobs(db)) {
        dropBlob(db, blob.jmap, blob.blob_id);
        changed = true;
      }
      db.run("UPDATE file_node SET keep_error = 'notAllowed' WHERE pinned = 1 OR opened_at IS NOT NULL");
      return;
    }
    const largest = Math.min(scope.maxAttachmentBytes, capBytes(ctx));
    for (const blob of keptBlobs(db)) {
      if (blob.pinned || Number(blob.size) <= largest) continue;
      pushOut(db, blob);
      changed = true;
    }
    const before = keptBlobs(db).length;
    makeRoom(ctx, 0, { pinned: true, openedAt: 0 });
    if (keptBlobs(db).length !== before) changed = true;
    // Past the total with pins alone: the newest kept go first, as they would have been refused.
    let pinned = pinnedBytes(db);
    for (const blob of keptBlobs(db).filter((row) => row.pinned).sort((a, b) => Number(b.kept_at) - Number(a.kept_at))) {
      if (pinned <= scope.maxTotalBytes) break;
      pinned -= Number(blob.size);
      dropBlob(db, blob.jmap, blob.blob_id);
      setError(db, blob.jmap, blob.blob_id, 'overLimit');
      changed = true;
    }
  });
  if (changed) ctx.emit({ type: 'changed', account: ctx.account, collections: ['FileContent'] });
}

export function filesUsage(ctx: Pick<StoreContext, 'db'>): StoreUsagePart[] {
  const row = ctx.db.get<{ bytes: number | null; items: number }>('SELECT SUM(size) AS bytes, COUNT(*) AS items FROM file_blob');
  return [{ part: 'files', bytes: Number(row?.bytes ?? 0), items: Number(row?.items ?? 0) }];
}

// ---- Calls from the page ----

function fileRow(db: StorageAdapter, { jmap, id }: NodeRef): NodeRow {
  const row = db.get<NodeRow>('SELECT jmap, id, name, kind, blob_id, size, json, pinned, opened_at, keep_error FROM file_node WHERE jmap = ? AND id = ?', [jmap, id]);
  if (!row) throw new MethodError('notFound', `No file ${id}`);
  if (!row.blob_id || row.kind !== 'file') throw new MethodError('invalidArguments', 'Only files can be kept');
  return row;
}

export function pinFile(ctx: StoreContext, ref: NodeRef): { kept: boolean } {
  const row = fileRow(ctx.db, ref);
  ctx.db.run('UPDATE file_node SET pinned = 1, keep_error = NULL WHERE jmap = ? AND id = ?', [ref.jmap, ref.id]);
  const kept = hasBlob(ctx.db, ref.jmap, row.blob_id as string);
  if (!kept) void ctx.requestSync();
  return { kept };
}

/** Back to being a recently opened file, or let go of it if it never was one. */
export function unpinFile(ctx: StoreContext, ref: NodeRef): void {
  const row = fileRow(ctx.db, ref);
  ctx.db.transaction(() => {
    ctx.db.run('UPDATE file_node SET pinned = 0 WHERE jmap = ? AND id = ?', [ref.jmap, ref.id]);
    if (!wantedRow(ctx.db, ref.jmap, row.blob_id as string)) dropBlob(ctx.db, ref.jmap, row.blob_id as string);
  });
}

export function noteOpened(ctx: StoreContext, ref: NodeRef): { kept: boolean } {
  const row = fileRow(ctx.db, ref);
  ctx.db.run('UPDATE file_node SET opened_at = ?, keep_error = NULL WHERE jmap = ? AND id = ?', [ctx.now(), ref.jmap, ref.id]);
  const kept = hasBlob(ctx.db, ref.jmap, row.blob_id as string);
  if (!kept) void ctx.requestSync();
  return { kept };
}

export function readFile(ctx: StoreContext, ref: NodeRef): (KeptFile & { name: string }) | null {
  const row = fileRow(ctx.db, ref);
  const kept = fileBlob(ctx, ref.jmap, row.blob_id as string);
  return kept ? { ...kept, name: row.name } : null;
}

export interface KeptFileStatus {
  jmap: string;
  id: string;
  name: string;
  size: number | null;
  pinned: boolean;
  openedAt: number | null;
  kept: boolean;
  /** Why it isn't kept: tooLarge, overLimit, notAllowed or download. */
  error: string | null;
}

/** Pinned and recently opened files, and how much room their contents take. */
export function keptStatus(ctx: StoreContext): { files: KeptFileStatus[]; bytes: number; capBytes: number } {
  const rows = ctx.db.all<NodeRow>(
    `SELECT jmap, id, name, kind, blob_id, size, json, pinned, opened_at, keep_error FROM file_node
     WHERE pinned = 1 OR opened_at IS NOT NULL ORDER BY pinned DESC, opened_at DESC, name`,
  );
  return {
    files: rows.map((row) => ({
      jmap: row.jmap,
      id: row.id,
      name: row.name,
      size: row.size === null ? null : Number(row.size),
      pinned: Boolean(row.pinned),
      openedAt: row.opened_at === null ? null : Number(row.opened_at),
      kept: row.blob_id !== null && hasBlob(ctx.db, row.jmap, row.blob_id),
      error: row.keep_error,
    })),
    bytes: keptBlobs(ctx.db).reduce((sum, blob) => sum + Number(blob.size), 0),
    capBytes: capBytes(ctx),
  };
}
