/**
 * The files of kept mail: attachments, inline images (so a message offline shows
 * them) and the raw message an export reads (decision in
 * local-data/desktop-offline-decisions.md). Fetched last in a pass, newest mail
 * first, one at a time and paced, and a new pass that's asked for goes first.
 *
 * What's kept is bounded by the scope: nothing with `attachments` off, nothing
 * over `maxAttachmentBytes`, and `maxTotalBytes` in all. At the total a newer
 * message's file pushes out raw messages first, then files of older messages,
 * oldest first. Never the files of a pinned message. Raw messages come after
 * every file and only take room that's free. Files held for a draft or a send
 * are in `upload`, pinned files in the files area, and neither is touched here.
 *
 * A file comes in as a stream where the transport can, written in 1 MB chunks
 * that each commit on their own, and is held nowhere whole. Its row in `blob`
 * comes last, so a broken download leaves nothing readable.
 */

import type { StoreContext, SyncContext, Syncer } from '../area';
import { TransportError } from '../engine/transport';
import type { StorageAdapter } from '../storage';
import { BLOB_CHUNK_BYTES, dropBlob, putBlob } from './records';

/** Keeps well under the server's 1000 requests a minute, which the user's own clicks count against too. */
const PACE_MS = 200;
/** There's one raw message per message, and nothing waits for them. */
const RAW_PACE_MS = 1000;
const PAGE = 20;
/**
 * Parts in a row that don't fit before a pass stops looking. Each check reads the
 * kept list, and older mail only has less to push out.
 */
const MOST_PASSED_IN_A_ROW = 50;
const PINNED = '$pinned';
/** What says a file won't come. Anything else, like a 500, is tried at the next sync. */
const PERMANENT_DOWNLOAD_STATUSES = new Set([403, 404, 410]);
const RAW_TYPE = 'message/rfc822';

class DownloadStopped extends Error {}

class DownloadTooLarge extends Error {}

/** Someone else kept the same file while this one was coming in. */
class AlreadyKept extends Error {}

interface Part {
  blob_id: string;
  size: number;
  type: string | null;
  name: string | null;
  received_at: number;
  raw: number;
}

type KeptContext = Pick<StoreContext, 'db' | 'scope'> & Partial<Pick<StoreContext, 'keptByOthers'>>;

/** The total is for everything an account keeps, so what the Files area holds takes its part. */
function mailCap(ctx: KeptContext): number {
  return Math.max(0, ctx.scope.maxTotalBytes - (ctx.keptByOthers?.('mail') ?? 0));
}

function usedBytes(db: StorageAdapter): number {
  return Number(db.get<{ n: number | null }>('SELECT SUM(size) AS n FROM blob')?.n ?? 0);
}

const NOT_PINNED = `NOT EXISTS (
  SELECT 1 FROM email_part p JOIN email_keyword k ON k.email_rowid = p.email_rowid
  WHERE p.jmap = b.jmap AND p.blob_id = b.blob_id AND k.keyword = '${PINNED}'
)`;

const IS_RAW = `EXISTS (SELECT 1 FROM email_part r WHERE r.jmap = b.jmap AND r.blob_id = b.blob_id AND r.raw = 1)`;

/**
 * Whether `size` more can fit, counting what could be pushed out for mail
 * received at `at`. A raw message pushes out nothing: it only takes what's free.
 */
function couldFit(db: StorageAdapter, cap: number, size: number, at: number, raw: boolean): boolean {
  const used = usedBytes(db);
  if (used + size <= cap) return true;
  if (raw) return false;
  const yielding = Number(db.get<{ n: number | null }>(`SELECT SUM(b.size) AS n FROM blob b WHERE (${IS_RAW} OR b.at < ?) AND ${NOT_PINNED}`, [at])?.n ?? 0);
  return used - yielding + size <= cap;
}

/** Pushes out raw messages, then files of mail older than `at`, oldest first, until `size` more fits or nothing is left to push out. */
function pushOut(db: StorageAdapter, cap: number, size: number, at: number): void {
  let used = usedBytes(db);
  while (used + size > cap) {
    const oldest = db.all<{ jmap: string; blob_id: string; size: number }>(`SELECT b.jmap, b.blob_id, b.size FROM blob b WHERE (${IS_RAW} OR b.at < ?) AND ${NOT_PINNED} ORDER BY ${IS_RAW} DESC, b.at ASC LIMIT 50`, [at]);
    if (oldest.length === 0) return;
    for (const row of oldest) {
      if (used + size <= cap) break;
      dropBlob(db, row.jmap, row.blob_id);
      used -= Number(row.size);
    }
  }
}

/** Makes room for `size` more. False, with nothing pushed out, when it can't. */
function makeRoom(db: StorageAdapter, cap: number, size: number, at: number, raw: boolean): boolean {
  if (!couldFit(db, cap, size, at, raw)) return false;
  pushOut(db, cap, size, at);
  return true;
}

/** A tighter scope applies at once, not at the next sync. */
export function applyAttachmentScope(ctx: KeptContext): void {
  const { db, scope } = ctx;
  db.transaction(() => {
    if (!scope.attachments) {
      db.run('DELETE FROM blob_chunk');
      db.run('DELETE FROM blob');
      return;
    }
    for (const row of db.all<{ jmap: string; blob_id: string }>('SELECT jmap, blob_id FROM blob WHERE size > ?', [scope.maxAttachmentBytes])) {
      dropBlob(db, row.jmap, row.blob_id);
    }
    pushOut(db, mailCap(ctx), 0, Number.MAX_SAFE_INTEGER);
  });
}

/** A kept file, piece by piece into a Blob, which the browser can keep out of this worker's memory. */
export function keptBlob(ctx: Pick<StoreContext, 'db' | 'scope'>, jmap: string, blobId: string): { type: string | null; size: number; blob: Blob } | null {
  if (!ctx.scope.attachments) return null;
  const row = ctx.db.get<{ type: string | null; size: number; data: Uint8Array }>('SELECT type, size, data FROM blob WHERE jmap = ? AND blob_id = ?', [jmap, blobId]);
  if (!row) return null;
  const type = row.type ?? '';
  // A file from before chunks has its bytes in the row; a new one has none there.
  let blob = new Blob(row.data?.byteLength ? [row.data as BlobPart] : [], { type });
  for (let seq = 0; ; seq += 1) {
    const chunk = ctx.db.get<{ data: Uint8Array }>('SELECT data FROM blob_chunk WHERE jmap = ? AND blob_id = ? AND seq = ?', [jmap, blobId, seq]);
    if (!chunk) break;
    // Each step only refers to the last Blob, so one chunk at a time is in memory here.
    blob = new Blob([blob, chunk.data as BlobPart], { type });
  }
  // Better not there, and fetched again, than a file that reads as empty or cut short.
  if (blob.size !== Number(row.size)) {
    ctx.db.transaction(() => dropBlob(ctx.db, jmap, blobId));
    return null;
  }
  return { type: row.type, size: Number(row.size), blob };
}

/** A file the user opened online: kept if it belongs to a kept message and the scope allows it. */
export function recordKeptBlob(ctx: KeptContext, jmap: string, blobId: string, type: string | null, data: Uint8Array): boolean {
  const { db, scope } = ctx;
  const owner = db.get<{ received_at: number; raw: number }>('SELECT received_at, raw FROM email_part WHERE jmap = ? AND blob_id = ?', [jmap, blobId]);
  if (!owner || !scope.attachments || data.byteLength > scope.maxAttachmentBytes) return false;
  const at = Number(owner.received_at);
  return db.transaction(() => {
    if (!makeRoom(db, mailCap(ctx), data.byteLength, at, Boolean(owner.raw))) return false;
    putBlob(db, jmap, blobId, type, data, at);
    return true;
  });
}

export type RawRefusal = 'attachments_off' | 'not_kept';

/**
 * A whole message as the server has it, by `Email.blobId`, for an offline
 * export. It stays a refusal rather than something rebuilt: a rebuilt message
 * would lose its signatures and exact bytes.
 */
export function rawBlob(ctx: Pick<StoreContext, 'db' | 'scope'>, jmap: string, blobId: string): { ok: true; type: string; size: number; blob: Blob } | { ok: false; reason: RawRefusal } {
  if (!ctx.scope.attachments) return { ok: false, reason: 'attachments_off' };
  const isRaw = ctx.db.get('SELECT 1 AS x FROM email_part WHERE jmap = ? AND blob_id = ? AND raw = 1', [jmap, blobId]);
  const kept = isRaw ? keptBlob(ctx, jmap, blobId) : null;
  if (!kept) return { ok: false, reason: 'not_kept' };
  return { ok: true, type: RAW_TYPE, size: kept.size, blob: new Blob([kept.blob], { type: RAW_TYPE }) };
}

/** How many messages (of one folder, or all) an export could write right now. */
export function rawStatus(ctx: Pick<StoreContext, 'db' | 'scope'>, jmap: string, mailboxId?: string): { total: number; kept: number } {
  const inFolder = mailboxId ? 'JOIN email_mailbox m ON m.email_rowid = e.rowid AND m.mailbox_id = ?' : '';
  const params = mailboxId ? [mailboxId, jmap] : [jmap];
  const total = Number(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM email e ${inFolder} WHERE e.jmap = ?`, params)?.n ?? 0);
  if (!ctx.scope.attachments) return { total, kept: 0 };
  const kept = Number(ctx.db.get<{ n: number }>(
    `SELECT COUNT(DISTINCT e.rowid) AS n FROM email e ${inFolder}
     JOIN email_part p ON p.email_rowid = e.rowid AND p.raw = 1
     JOIN blob b ON b.jmap = p.jmap AND b.blob_id = p.blob_id
     WHERE e.jmap = ?`,
    params,
  )?.n ?? 0);
  return { total, kept };
}

function isKept(db: StorageAdapter, jmap: string, blobId: string): boolean {
  return Boolean(db.get('SELECT 1 AS x FROM blob WHERE jmap = ? AND blob_id = ?', [jmap, blobId]));
}

/** What a download left. Never the pieces of a file that's kept: its row says they're whole. */
function clearUnfinished(db: StorageAdapter, jmap: string, blobId: string): void {
  if (!isKept(db, jmap, blobId)) db.run('DELETE FROM blob_chunk WHERE jmap = ? AND blob_id = ?', [jmap, blobId]);
}

/** Takes a body piece by piece and writes it in chunks, each committed on its own. */
function chunkWriter(ctx: SyncContext, jmap: string, blobId: string) {
  const buffer = new Uint8Array(BLOB_CHUNK_BYTES);
  let filled = 0;
  let seq = 0;
  let total = 0;
  const write = () => {
    if (filled === 0) return;
    if (isKept(ctx.db, jmap, blobId)) throw new AlreadyKept();
    ctx.db.run('INSERT INTO blob_chunk (jmap, blob_id, seq, data) VALUES (?, ?, ?, ?)', [jmap, blobId, seq, buffer.subarray(0, filled)]);
    seq += 1;
    filled = 0;
  };
  return {
    push(part: Uint8Array): void {
      total += part.length;
      if (total > ctx.scope.maxAttachmentBytes) throw new DownloadTooLarge();
      for (let at = 0; at < part.length;) {
        const take = Math.min(part.length - at, BLOB_CHUNK_BYTES - filled);
        buffer.set(part.subarray(at, at + take), filled);
        filled += take;
        at += take;
        if (filled === BLOB_CHUNK_BYTES) {
          if (ctx.stopped() || !ctx.scope.attachments) throw new DownloadStopped();
          write();
        }
      }
    },
    /** The last piece goes in the transaction that files it, so a small file costs one commit. */
    writeLast: write,
    get total(): number {
      return total;
    },
  };
}

function refuse(db: StorageAdapter, jmap: string, blobId: string): void {
  db.run('UPDATE email_part SET refused = 1 WHERE jmap = ? AND blob_id = ?', [jmap, blobId]);
}

type Fetched = 'kept' | 'skipped' | 'stopped';

async function fetchOne(ctx: SyncContext, jmap: string, part: Part): Promise<Fetched> {
  const { db, transport } = ctx;
  const blobId = String(part.blob_id);
  const type = part.type ?? 'application/octet-stream';
  const name = part.name ?? 'attachment';
  if (isKept(db, jmap, blobId)) return 'kept';
  clearUnfinished(db, jmap, blobId);
  const writer = chunkWriter(ctx, jmap, blobId);
  try {
    if (transport.downloadStream) await transport.downloadStream(jmap, blobId, type, name, (piece) => writer.push(piece));
    else writer.push(await transport.download(jmap, blobId, type, name));
  } catch (error) {
    clearUnfinished(db, jmap, blobId);
    if (error instanceof AlreadyKept) return 'kept';
    if (error instanceof DownloadStopped) return 'stopped';
    if (error instanceof DownloadTooLarge) {
      refuse(db, jmap, blobId);
      return 'skipped';
    }
    if (error instanceof TransportError && error.kind === 'http') {
      if (!PERMANENT_DOWNLOAD_STATUSES.has(error.status ?? 0)) return 'stopped';
      refuse(db, jmap, blobId);
      return 'skipped';
    }
    // The connection works and this transfer broke: the next one may be fine.
    if (error instanceof TransportError && error.interrupted) return 'skipped';
    throw error;
  }
  const at = Number(part.received_at);
  const size = writer.total;
  return db.transaction((): Fetched => {
    // The user opened it meanwhile, and that copy is whole.
    if (isKept(db, jmap, blobId)) return 'kept';
    // Its message may have gone while this was on its way, or the rules changed.
    const wanted = ctx.scope.attachments && db.get('SELECT 1 AS x FROM email_part WHERE jmap = ? AND blob_id = ?', [jmap, blobId]);
    if (!wanted || !makeRoom(db, mailCap(ctx), size, at, Boolean(part.raw))) {
      clearUnfinished(db, jmap, blobId);
      return 'skipped';
    }
    writer.writeLast();
    db.run(
      `INSERT INTO blob (jmap, blob_id, type, size, at, data) VALUES (?, ?, ?, ?, ?, x'')
       ON CONFLICT (jmap, blob_id) DO UPDATE SET type = excluded.type, size = excluded.size, at = excluded.at, data = excluded.data`,
      [jmap, blobId, part.type, size, at],
    );
    return 'kept';
  });
}

async function fetchKept(ctx: SyncContext, jmap: string): Promise<void> {
  const { db } = ctx;
  // What a closed app or a stopped pass left unfinished.
  db.run('DELETE FROM blob_chunk WHERE jmap = ? AND NOT EXISTS (SELECT 1 FROM blob b WHERE b.jmap = blob_chunk.jmap AND b.blob_id = blob_chunk.blob_id)', [jmap]);
  applyAttachmentScope(ctx);
  if (!ctx.scope.attachments) return;
  // Rows passed over in this pass stay in the list, so the next page starts past them.
  let passed = 0;
  let passedInARow = 0;
  let done = 0;
  for (;;) {
    const parts = db.all<Part>(
      `SELECT p.blob_id, p.size, p.type, p.name, p.received_at, p.raw FROM email_part p
       WHERE p.jmap = ? AND p.refused = 0 AND p.size <= ?
         AND NOT EXISTS (SELECT 1 FROM blob b WHERE b.jmap = p.jmap AND b.blob_id = p.blob_id)
       ORDER BY p.raw ASC, p.received_at DESC, p.blob_id ASC LIMIT ? OFFSET ?`,
      [jmap, ctx.scope.maxAttachmentBytes, PAGE, passed],
    );
    if (parts.length === 0) return;
    for (const part of parts) {
      if (ctx.stopped() || ctx.syncWanted()) return;
      // The same file a second time in this page: kept by now.
      if (db.get('SELECT 1 AS x FROM blob WHERE jmap = ? AND blob_id = ?', [jmap, String(part.blob_id)])) continue;
      if (!couldFit(db, mailCap(ctx), Number(part.size), Number(part.received_at), Boolean(part.raw))) {
        passed += 1;
        passedInARow += 1;
        if (passedInARow >= MOST_PASSED_IN_A_ROW) return;
        continue;
      }
      passedInARow = 0;
      const outcome = await fetchOne(ctx, jmap, part);
      if (outcome === 'stopped') return;
      if (outcome === 'skipped') passed += 1;
      done += 1;
      ctx.emit({ type: 'progress', account: ctx.account, area: 'mail', phase: 'attachments', done, total: null });
      await ctx.pause(part.raw ? RAW_PACE_MS : PACE_MS);
    }
  }
}

export const attachmentSyncer: Syncer = {
  name: 'attachments',
  capability: 'urn:ietf:params:jmap:mail',
  low: true,
  run: fetchKept,
};
