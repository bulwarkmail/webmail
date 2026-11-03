/**
 * File contents kept on the device: pinned files, and recently opened ones
 * within a cap. Metadata for every file is in file_node regardless.
 *
 * What gets kept:
 * - A pinned file stays until it's unpinned or removed on the server. The cap
 *   doesn't push it out and the user's own size limit doesn't apply. The
 *   organisation's limit on one file (scope.orgMaxFileBytes) and the account's
 *   total (scope.maxTotalBytes, which a policy can lower) do: past the total, the
 *   newest pins lose their content and say `overLimit`.
 * - A recently opened file is kept if it's within scope.maxAttachmentBytes, and
 *   pushed out oldest first when the cap is reached. Its opened_at goes with
 *   it, so it isn't fetched straight back.
 * - With scope.attachments off, nothing is kept or given out.
 *
 * A file comes in as a stream, written in 1 MB chunks that each commit on their
 * own, and is held nowhere whole. `complete` says the last chunk is in, so a
 * broken download or a closed app leaves nothing readable. Reading goes chunk by
 * chunk into a Blob, which the browser can keep out of the worker's memory.
 * A new version's content replaces the old one only when it's all there.
 */

import { TransportError } from '../engine/transport';
import { MethodError, type StoreContext, type StoreUsagePart, type SyncContext } from '../area';
import type { StorageAdapter } from '../storage';
import { nodeMediaType, type WireNode } from './records';

export const FILE_CACHE_CAP_BYTES = 500 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
/** After the second failure in a row a file waits this long, doubling, before the next try. */
const RETRY_WAIT_MS = 15 * 60 * 1000;
const MOST_RETRY_WAIT_MS = 24 * 60 * 60 * 1000;

export interface KeptFile {
  blob: Blob;
  type: string;
  size: number;
  /** This is the version before the one asked for, whose content hasn't arrived. */
  stale: boolean;
}

export interface NodeRef { jmap: string; id: string }

interface NodeRow {
  jmap: string;
  id: string;
  name: string;
  kind: string;
  blob_id: string | null;
  stale_blob_id: string | null;
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
  pinned_at: number | null;
  opened_at: number | null;
}

function capBytes(ctx: Pick<StoreContext, 'scope'>): number {
  return Math.min(FILE_CACHE_CAP_BYTES, ctx.scope.maxTotalBytes);
}

function openedLimit(ctx: Pick<StoreContext, 'scope'>): number {
  return Math.min(ctx.scope.maxAttachmentBytes, capBytes(ctx));
}

function assemble(db: StorageAdapter, jmap: string, blobId: string, type: string): Blob {
  let blob = new Blob([], { type });
  for (let seq = 0; ; seq += 1) {
    const chunk = db.get<{ data: Uint8Array }>('SELECT data FROM file_blob_chunk WHERE jmap = ? AND blob_id = ? AND seq = ?', [jmap, blobId, seq]);
    if (!chunk) return blob;
    // Each step only refers to the last Blob, so one chunk at a time is in memory here.
    blob = new Blob([blob, chunk.data as Uint8Array<ArrayBuffer>], { type });
  }
}

/**
 * A kept file's content, for the client's blob lookup. If this version hasn't
 * arrived and the one before is still kept, that one, marked `stale`.
 */
export function fileBlob(ctx: Pick<StoreContext, 'db' | 'scope'>, jmap: string, blobId: string): KeptFile | null {
  if (!ctx.scope.attachments) return null;
  const read = (id: string, stale: boolean): KeptFile | null => {
    const row = ctx.db.get<{ type: string; size: number }>('SELECT type, size FROM file_blob WHERE jmap = ? AND blob_id = ? AND complete = 1', [jmap, id]);
    return row ? { blob: assemble(ctx.db, jmap, id, row.type), type: row.type, size: Number(row.size), stale } : null;
  };
  const current = read(blobId, false);
  if (current) return current;
  const older = ctx.db.get<{ stale_blob_id: string }>('SELECT stale_blob_id FROM file_node WHERE jmap = ? AND blob_id = ? AND stale_blob_id IS NOT NULL LIMIT 1', [jmap, blobId]);
  return older ? read(older.stale_blob_id, true) : null;
}

function hasBlob(db: StorageAdapter, jmap: string, blobId: string): boolean {
  return Boolean(db.get('SELECT 1 AS x FROM file_blob WHERE jmap = ? AND blob_id = ? AND complete = 1', [jmap, blobId]));
}

function dropBlob(db: StorageAdapter, jmap: string, blobId: string): void {
  db.run('DELETE FROM file_blob_chunk WHERE jmap = ? AND blob_id = ?', [jmap, blobId]);
  db.run('DELETE FROM file_blob WHERE jmap = ? AND blob_id = ?', [jmap, blobId]);
  db.run('UPDATE file_node SET stale_blob_id = NULL WHERE jmap = ? AND stale_blob_id = ?', [jmap, blobId]);
}

/** All complete contents in the store, with what the nodes pointing at each say about it. */
function keptBlobs(db: StorageAdapter): BlobRow[] {
  return db.all<BlobRow>(
    `SELECT b.jmap, b.blob_id, b.size, b.kept_at, COALESCE(MAX(n.pinned), 0) AS pinned, MAX(n.pinned_at) AS pinned_at, MAX(n.opened_at) AS opened_at
     FROM file_blob b LEFT JOIN file_node n ON n.jmap = b.jmap AND (n.blob_id = b.blob_id OR n.stale_blob_id = b.blob_id)
     WHERE b.complete = 1
     GROUP BY b.jmap, b.blob_id`,
  );
}

function ageOf(blob: BlobRow): number {
  return Number(blob.opened_at ?? blob.kept_at);
}

function pushOut(db: StorageAdapter, blob: BlobRow): void {
  db.run('UPDATE file_node SET opened_at = NULL WHERE jmap = ? AND (blob_id = ? OR stale_blob_id = ?)', [blob.jmap, blob.blob_id, blob.blob_id]);
  dropBlob(db, blob.jmap, blob.blob_id);
}

/**
 * Pushes out unpinned contents, oldest first, so `size` more fits under the
 * cap. A recently opened file only pushes out older ones and says false when
 * that isn't enough. A pinned one always gets in. With `dryRun` it only says.
 */
function makeRoom(ctx: StoreContext, size: number, incoming: { pinned: boolean; openedAt: number }, dryRun = false): boolean {
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
  if (!dryRun) for (const blob of chosen) pushOut(ctx.db, blob);
  return true;
}

/** The organisation's limit on one file, which a pin obeys. The user's own doesn't bind a pin. */
function overOrgLimit(ctx: Pick<StoreContext, 'scope'>, size: number): boolean {
  const cap = ctx.scope.orgMaxFileBytes;
  return typeof cap === 'number' && size > cap;
}

/** What pinned contents take. Leaves out the old version a new one will replace. */
function pinnedBytes(db: StorageAdapter, except: string | null = null): number {
  return keptBlobs(db).filter((blob) => blob.pinned && blob.blob_id !== except).reduce((sum, blob) => sum + Number(blob.size), 0);
}

function setError(db: StorageAdapter, jmap: string, blobId: string, error: string | null): void {
  db.run('UPDATE file_node SET keep_error = ? WHERE jmap = ? AND (blob_id = ? OR stale_blob_id = ?)', [error, jmap, blobId, blobId]);
}

/**
 * Makes the store fit the scope as it is now, without the network. Runs at
 * start, when the scope changes and before fetching. The pins stay, so a loosened
 * scope fetches them back at the next pass.
 */
export function applyFilesScope(ctx: StoreContext): void {
  const { db } = ctx;
  const before = keptBlobs(db).length;
  db.transaction(() => {
    if (!ctx.scope.attachments) {
      for (const row of db.all<{ jmap: string; blob_id: string }>('SELECT jmap, blob_id FROM file_blob')) dropBlob(db, row.jmap, row.blob_id);
      db.run("UPDATE file_node SET keep_error = 'notAllowed' WHERE pinned = 1 OR opened_at IS NOT NULL");
      return;
    }
    db.run("UPDATE file_node SET keep_error = NULL WHERE keep_error = 'notAllowed'");
    for (const blob of keptBlobs(db)) {
      if (blob.pinned ? !overOrgLimit(ctx, Number(blob.size)) : Number(blob.size) <= openedLimit(ctx)) continue;
      if (blob.pinned) {
        setError(db, blob.jmap, blob.blob_id, 'tooLarge');
        dropBlob(db, blob.jmap, blob.blob_id);
      } else {
        pushOut(db, blob);
      }
    }
    // Oldest pins first, so the newest are the ones to lose out. One that still
    // fits stays: dropping it would only have the next pass fetch it back.
    const pins = keptBlobs(db).filter((blob) => blob.pinned).sort((a, b) => Number(a.pinned_at ?? 0) - Number(b.pinned_at ?? 0));
    let used = 0;
    for (const blob of pins) {
      if (used + Number(blob.size) <= ctx.scope.maxTotalBytes) {
        used += Number(blob.size);
      } else {
        setError(db, blob.jmap, blob.blob_id, 'overLimit');
        dropBlob(db, blob.jmap, blob.blob_id);
      }
    }
    makeRoom(ctx, 0, { pinned: true, openedAt: 0 });
  });
  if (keptBlobs(db).length !== before) ctx.emit({ type: 'changed', account: ctx.account, collections: ['FileContent'] });
}

export function filesUsage(ctx: Pick<StoreContext, 'db'>): StoreUsagePart[] {
  const row = ctx.db.get<{ bytes: number | null; items: number }>('SELECT SUM(size) AS bytes, COUNT(*) AS items FROM file_blob WHERE complete = 1');
  return [{ part: 'files', bytes: Number(row?.bytes ?? 0), items: Number(row?.items ?? 0) }];
}

/** Contents no node points at any more: the file was removed or has a new version in place. */
export function dropOrphanBlobs(db: StorageAdapter): void {
  for (const blob of keptBlobs(db)) {
    const used = db.get('SELECT 1 AS x FROM file_node WHERE jmap = ? AND (blob_id = ? OR stale_blob_id = ?)', [blob.jmap, blob.blob_id, blob.blob_id]);
    if (!used) dropBlob(db, blob.jmap, blob.blob_id);
  }
}

interface Wanted {
  blob_id: string;
  id: string;
  name: string;
  size: number | null;
  json: string;
  pinned: number;
  opened_at: number | null;
  stale_blob_id: string | null;
  keep_failures: number;
  keep_failed_at: number | null;
}

function wantedRow(db: StorageAdapter, jmap: string, blobId: string): Wanted | undefined {
  return db.get<Wanted>(
    `SELECT blob_id, id, name, size, json, pinned, opened_at, stale_blob_id, keep_failures, keep_failed_at FROM file_node
     WHERE jmap = ? AND blob_id = ? AND (pinned = 1 OR opened_at IS NOT NULL)
     ORDER BY pinned DESC, opened_at DESC LIMIT 1`,
    [jmap, blobId],
  );
}

/** A file that failed once goes again next pass. After that it waits, so it can't eat every pass. */
function stillWaiting(ctx: StoreContext, want: Wanted): boolean {
  const failures = Number(want.keep_failures);
  if (failures < 2 || want.keep_failed_at === null) return false;
  const wait = Math.min(RETRY_WAIT_MS * 2 ** (failures - 2), MOST_RETRY_WAIT_MS);
  return ctx.now() < Number(want.keep_failed_at) + wait;
}

/** Thrown from the sink to end a download that's no longer wanted. */
class DownloadStopped extends Error {}

/** Thrown from the sink when a download passes its limit, whatever the metadata said. */
class DownloadTooLarge extends Error {
  constructor(readonly seen: number) {
    super('Over the limit');
  }
}

/** Takes a body piece by piece and writes it in chunks, each committed on its own. */
function chunkWriter(ctx: SyncContext, jmap: string, blobId: string, limit: number) {
  const buffer = new Uint8Array(CHUNK_BYTES);
  let filled = 0;
  let seq = 0;
  let total = 0;
  const flush = () => {
    if (filled === 0) return;
    if (ctx.stopped() || !ctx.scope.attachments || !wantedRow(ctx.db, jmap, blobId)) throw new DownloadStopped();
    ctx.db.run('INSERT INTO file_blob_chunk (jmap, blob_id, seq, data) VALUES (?, ?, ?, ?)', [jmap, blobId, seq, buffer.subarray(0, filled)]);
    seq += 1;
    filled = 0;
  };
  return {
    push(part: Uint8Array): void {
      total += part.length;
      if (total > limit) throw new DownloadTooLarge(total);
      for (let at = 0; at < part.length;) {
        const take = Math.min(part.length - at, CHUNK_BYTES - filled);
        buffer.set(part.subarray(at, at + take), filled);
        filled += take;
        at += take;
        if (filled === CHUNK_BYTES) flush();
      }
    },
    finish(): number {
      flush();
      return total;
    },
  };
}

function markFailed(ctx: StoreContext, jmap: string, blobId: string): void {
  ctx.db.run(
    "UPDATE file_node SET keep_error = 'download', keep_failures = keep_failures + 1, keep_failed_at = ? WHERE jmap = ? AND blob_id = ?",
    [ctx.now(), jmap, blobId],
  );
}

/** The last chunk is in: the file becomes readable if it still fits and is still wanted. */
function completeBlob(ctx: SyncContext, jmap: string, blobId: string, size: number): void {
  const { db } = ctx;
  db.transaction(() => {
    const now = wantedRow(db, jmap, blobId);
    if (!now || !ctx.scope.attachments) {
      dropBlob(db, jmap, blobId);
      return;
    }
    if (now.pinned && (overOrgLimit(ctx, size) || pinnedBytes(db, now.stale_blob_id) + size > ctx.scope.maxTotalBytes)) {
      dropBlob(db, jmap, blobId);
      setError(db, jmap, blobId, overOrgLimit(ctx, size) ? 'tooLarge' : 'overLimit');
      return;
    }
    if (!makeRoom(ctx, size, { pinned: Boolean(now.pinned), openedAt: Number(now.opened_at ?? 0) })) {
      dropBlob(db, jmap, blobId);
      db.run('UPDATE file_node SET opened_at = NULL WHERE jmap = ? AND blob_id = ? AND pinned = 0', [jmap, blobId]);
      return;
    }
    db.run('UPDATE file_blob SET complete = 1, size = ?, kept_at = ? WHERE jmap = ? AND blob_id = ?', [size, ctx.now(), jmap, blobId]);
    // The new version is all here, so the old one can go.
    const olds = db.all<{ stale_blob_id: string }>('SELECT DISTINCT stale_blob_id FROM file_node WHERE jmap = ? AND blob_id = ? AND stale_blob_id IS NOT NULL', [jmap, blobId]);
    db.run('UPDATE file_node SET stale_blob_id = NULL, keep_error = NULL, keep_failures = 0, keep_failed_at = NULL WHERE jmap = ? AND blob_id = ?', [jmap, blobId]);
    for (const { stale_blob_id: old } of olds) {
      if (!db.get('SELECT 1 AS x FROM file_node WHERE jmap = ? AND (blob_id = ? OR stale_blob_id = ?)', [jmap, old, old])) dropBlob(db, jmap, old);
    }
  });
}

async function fetchOne(ctx: SyncContext, jmap: string, want: Wanted): Promise<boolean> {
  const { db } = ctx;
  const blobId = want.blob_id;
  const type = nodeMediaType(JSON.parse(want.json) as WireNode);
  const limit = want.pinned
    ? Math.min(ctx.scope.maxTotalBytes - pinnedBytes(db, want.stale_blob_id), ctx.scope.orgMaxFileBytes ?? Infinity)
    : openedLimit(ctx);
  db.transaction(() => {
    db.run('DELETE FROM file_blob_chunk WHERE jmap = ? AND blob_id = ?', [jmap, blobId]);
    db.run('DELETE FROM file_blob WHERE jmap = ? AND blob_id = ?', [jmap, blobId]);
    db.run('INSERT INTO file_blob (jmap, blob_id, type, size, kept_at, complete) VALUES (?, ?, ?, 0, ?, 0)', [jmap, blobId, type, ctx.now()]);
  });
  const writer = chunkWriter(ctx, jmap, blobId, limit);
  const forget = () => db.transaction(() => {
    db.run('DELETE FROM file_blob_chunk WHERE jmap = ? AND blob_id = ?', [jmap, blobId]);
    db.run('DELETE FROM file_blob WHERE jmap = ? AND blob_id = ?', [jmap, blobId]);
  });
  try {
    if (ctx.transport.downloadStream) await ctx.transport.downloadStream(jmap, blobId, type, want.name, (part) => writer.push(part));
    else writer.push(await ctx.transport.download(jmap, blobId, type, want.name));
    completeBlob(ctx, jmap, blobId, writer.finish());
    return true;
  } catch (error) {
    forget();
    if (error instanceof DownloadStopped) return false;
    if (error instanceof DownloadTooLarge) {
      // With the size it now knows, the next pass sees this without starting the download.
      db.run('UPDATE file_node SET size = ? WHERE jmap = ? AND blob_id = ?', [error.seen, jmap, blobId]);
      setError(db, jmap, blobId, want.pinned && !overOrgLimit(ctx, error.seen) ? 'overLimit' : 'tooLarge');
      return false;
    }
    // This file broke, or the server won't give it: the next one may be fine. No
    // network at all or no credentials reach the engine, and the next pass tries again.
    if (error instanceof TransportError && (error.kind === 'http' || error.interrupted)) {
      markFailed(ctx, jmap, blobId);
      return false;
    }
    throw error;
  }
}

/** Fetches what should be kept and isn't yet, one file at a time, pinned first and failed ones last. */
export async function fetchKeptFiles(ctx: SyncContext, jmap: string): Promise<void> {
  const { db } = ctx;
  // What a closed app or a stopped pass left unfinished.
  db.transaction(() => {
    for (const row of db.all<{ blob_id: string }>('SELECT blob_id FROM file_blob WHERE jmap = ? AND complete = 0', [jmap])) {
      db.run('DELETE FROM file_blob_chunk WHERE jmap = ? AND blob_id = ?', [jmap, row.blob_id]);
      db.run('DELETE FROM file_blob WHERE jmap = ? AND blob_id = ?', [jmap, row.blob_id]);
    }
  });
  applyFilesScope(ctx);
  if (!ctx.scope.attachments) return;
  const todo = db.all<{ blob_id: string }>(
    `SELECT n.blob_id FROM file_node n
     WHERE n.jmap = ? AND n.blob_id IS NOT NULL AND (n.pinned = 1 OR n.opened_at IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM file_blob b WHERE b.jmap = n.jmap AND b.blob_id = n.blob_id AND b.complete = 1)
     GROUP BY n.blob_id ORDER BY MAX(n.keep_failures) > 0 ASC, MAX(n.pinned) DESC, MAX(n.opened_at) DESC`,
    [jmap],
  ).map((row) => String(row.blob_id));
  let done = 0;
  for (const blobId of todo) {
    if (ctx.stopped() || !ctx.scope.attachments) return;
    // The page may have changed its mind during the last download.
    const want = wantedRow(db, jmap, blobId);
    if (!want || stillWaiting(ctx, want)) continue;
    const known = Number(want.size ?? 0);
    if (want.pinned && overOrgLimit(ctx, known)) {
      setError(db, jmap, blobId, 'tooLarge');
      continue;
    }
    if (!want.pinned && known > openedLimit(ctx)) {
      setError(db, jmap, blobId, 'tooLarge');
      continue;
    }
    if (want.pinned && pinnedBytes(db, want.stale_blob_id) + known > ctx.scope.maxTotalBytes) {
      setError(db, jmap, blobId, 'overLimit');
      continue;
    }
    if (!makeRoom(ctx, known, { pinned: Boolean(want.pinned), openedAt: Number(want.opened_at ?? 0) }, true)) {
      // Older than all that's kept, and no room: not worth the download.
      db.run('UPDATE file_node SET opened_at = NULL WHERE jmap = ? AND blob_id = ? AND pinned = 0', [jmap, blobId]);
      continue;
    }
    if (await fetchOne(ctx, jmap, want)) {
      done += 1;
      ctx.emit({ type: 'progress', account: ctx.account, area: 'files', phase: 'contents', done, total: todo.length });
    }
  }
  if (done > 0) ctx.emit({ type: 'changed', account: ctx.account, collections: ['FileContent'] });
}

// ---- Calls from the page ----

const ROW_COLUMNS = 'jmap, id, name, kind, blob_id, stale_blob_id, size, json, pinned, opened_at, keep_error';

function fileRow(db: StorageAdapter, { jmap, id }: NodeRef): NodeRow {
  const row = db.get<NodeRow>(`SELECT ${ROW_COLUMNS} FROM file_node WHERE jmap = ? AND id = ?`, [jmap, id]);
  if (!row) throw new MethodError('notFound', `No file ${id}`);
  if (!row.blob_id || row.kind !== 'file') throw new MethodError('invalidArguments', 'Only files can be kept');
  return row;
}

export function pinFile(ctx: StoreContext, ref: NodeRef): { kept: boolean } {
  const row = fileRow(ctx.db, ref);
  ctx.db.run('UPDATE file_node SET pinned = 1, pinned_at = ?, keep_error = NULL, keep_failures = 0, keep_failed_at = NULL WHERE jmap = ? AND id = ?', [ctx.now(), ref.jmap, ref.id]);
  const kept = hasBlob(ctx.db, ref.jmap, row.blob_id as string);
  if (!kept) void ctx.requestSync();
  return { kept };
}

/** Back to being a recently opened file, or let go of it if it never was one. */
export function unpinFile(ctx: StoreContext, ref: NodeRef): void {
  const row = fileRow(ctx.db, ref);
  ctx.db.transaction(() => {
    ctx.db.run('UPDATE file_node SET pinned = 0, pinned_at = NULL WHERE jmap = ? AND id = ?', [ref.jmap, ref.id]);
    if (!wantedRow(ctx.db, ref.jmap, row.blob_id as string)) {
      dropBlob(ctx.db, ref.jmap, row.blob_id as string);
      if (row.stale_blob_id) dropBlob(ctx.db, ref.jmap, row.stale_blob_id);
    }
  });
}

export function noteOpened(ctx: StoreContext, ref: NodeRef): { kept: boolean } {
  const row = fileRow(ctx.db, ref);
  ctx.db.run('UPDATE file_node SET opened_at = ?, keep_error = NULL, keep_failures = 0, keep_failed_at = NULL WHERE jmap = ? AND id = ?', [ctx.now(), ref.jmap, ref.id]);
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
  /** Its current content is here. */
  kept: boolean;
  /** Only the version before is here, until the current one arrives. */
  stale: boolean;
  /** Why it isn't kept: tooLarge, overLimit, notAllowed or download. */
  error: string | null;
}

/** Pinned and recently opened files, and how much room their contents take. */
export function keptStatus(ctx: StoreContext): { files: KeptFileStatus[]; bytes: number; capBytes: number } {
  const rows = ctx.db.all<NodeRow>(
    `SELECT ${ROW_COLUMNS} FROM file_node
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
      stale: row.stale_blob_id !== null,
      error: row.keep_error,
    })),
    bytes: keptBlobs(ctx.db).reduce((sum, blob) => sum + Number(blob.size), 0),
    capBytes: capBytes(ctx),
  };
}
