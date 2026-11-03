/** What the page asks the outbox. Each call is one SQLite transaction, so two tabs can't interleave. */

import type { AreaCall, StoreContext } from '../area';
import { heldBlobsOf, type DraftCreate } from '../drafts/local-email';
import { metaGet, metaSet } from '../engine/core-schema';
import { deleteEmail, upsertEmail, type EmailObject } from '../mail/records';
import { nextSeq, queueUpdate, type PatchRow } from './email-set';
import type { PatchOutcome, PendingPatch } from './flush-patches';
import {
  heldBlobIds,
  LOCAL_BLOB_PREFIX,
  type ConflictSummary,
  type OutboxError,
  type OutboxStatus,
  type OutboxSummary,
  type PolicyFingerprint,
  type SendItem,
  type StoredConflict,
  type StoredOutboxEntry,
} from './items';
import type { Patch, RecordState } from './patches';

interface OutboxRow {
  id: number;
  seq: number;
  kind: string;
  created_at: number;
  status: string;
  sending_since: number | null;
  first_attempt_at: number | null;
  payload: string;
  summary: string;
  message_id: string | null;
  copy_id: string | null;
  error: string | null;
}

function toEntry(row: OutboxRow): StoredOutboxEntry {
  const payload = JSON.parse(row.payload) as { item: SendItem; fingerprint?: PolicyFingerprint };
  return {
    id: Number(row.id),
    seq: Number(row.seq),
    createdAt: Number(row.created_at),
    status: row.status as OutboxStatus,
    summary: JSON.parse(row.summary) as OutboxSummary,
    item: payload.item,
    ...(payload.fingerprint ? { fingerprint: payload.fingerprint } : {}),
    ...(row.sending_since ? { sendingSince: Number(row.sending_since) } : {}),
    ...(row.first_attempt_at ? { firstAttemptAt: Number(row.first_attempt_at) } : {}),
    ...(row.error ? { error: JSON.parse(row.error) as OutboxError } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.copy_id ? { copyId: row.copy_id } : {}),
  };
}

interface QueueParams {
  summary: OutboxSummary;
  item: SendItem;
  fingerprint?: PolicyFingerprint;
  messageId?: string;
  status?: OutboxStatus;
  createdAt?: number;
  error?: OutboxError;
}

function insertEntry(ctx: StoreContext, params: QueueParams): number {
  return ctx.db.run(
    `INSERT INTO outbox (seq, kind, created_at, status, payload, summary, message_id, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      nextSeq(ctx.db),
      params.item.kind,
      params.createdAt ?? ctx.now(),
      params.status ?? 'waiting',
      JSON.stringify({ item: params.item, fingerprint: params.fingerprint }),
      JSON.stringify(params.summary),
      params.messageId ?? null,
      params.error ? JSON.stringify(params.error) : null,
    ],
  ).lastInsertRowid;
}

function queueSend(ctx: StoreContext, params: QueueParams): number {
  return ctx.db.transaction(() => insertEntry(ctx, params));
}

function read(ctx: StoreContext): { patches: number; entries: StoredOutboxEntry[]; conflicts: StoredConflict[] } {
  const patches = Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outbox_patch')?.n ?? 0);
  const entries = ctx.db.all<OutboxRow>('SELECT * FROM outbox ORDER BY seq ASC').map(toEntry);
  const conflicts = ctx.db.all<{ id: number; jmap: string; record_id: string; summary: string; created_at: number }>(
    'SELECT id, jmap, record_id, summary, created_at FROM conflict ORDER BY id ASC',
  ).map((row) => ({
    id: Number(row.id),
    jmap: row.jmap,
    recordId: row.record_id,
    createdAt: Number(row.created_at),
    summary: JSON.parse(row.summary) as ConflictSummary,
  }));
  return { patches, entries, conflicts };
}

/** Takes a waiting entry for sending: false when it isn't waiting any more (another tab took it, the user deleted it). */
function claim(ctx: StoreContext, params: { id: number }): boolean {
  const now = ctx.now();
  return ctx.db.run(
    `UPDATE outbox SET status = 'sending', sending_since = ?, first_attempt_at = COALESCE(first_attempt_at, ?) WHERE id = ? AND status = 'waiting'`,
    [now, now, params.id],
  ).changes === 1;
}

/** Deleted meanwhile stays deleted: there's no row to update. */
function update(ctx: StoreContext, params: { id: number; status: OutboxStatus; error?: OutboxError; copyId?: string | null }): void {
  ctx.db.run(
    `UPDATE outbox SET status = ?, error = ?, sending_since = NULL,
       copy_id = CASE WHEN ? THEN ? ELSE copy_id END
     WHERE id = ?`,
    [
      params.status,
      params.error ? JSON.stringify(params.error) : null,
      params.copyId === undefined ? 0 : 1,
      params.copyId ?? null,
      params.id,
    ],
  );
}

/** A send a closed tab left behind may have gone out. */
function settleStale(ctx: StoreContext, params: { before: number }): number {
  return ctx.db.run(
    `UPDATE outbox SET status = 'uncertain', sending_since = NULL WHERE status = 'sending' AND COALESCE(sending_since, 0) < ?`,
    [params.before],
  ).changes;
}

/** Every held file a waiting message or a draft on this device still needs. */
function neededFiles(ctx: StoreContext): Set<string> {
  const forSends = ctx.db.all<OutboxRow>('SELECT * FROM outbox').flatMap((row) => heldBlobIds(toEntry(row).item));
  const forDrafts = ctx.db.all<{ create_json: string }>('SELECT create_json FROM draft_pending').flatMap((row) => heldBlobsOf(JSON.parse(row.create_json) as DraftCreate));
  return new Set([...forSends, ...forDrafts]);
}

function dropHeld(ctx: StoreContext, blobId: string): void {
  ctx.db.run('DELETE FROM upload_chunk WHERE local_id = ?', [blobId]);
  ctx.db.run('DELETE FROM upload WHERE local_id = ?', [blobId]);
}

/** Removes an entry and the files only it held. A draft may share one with the message it became. */
function remove(ctx: StoreContext, params: { id: number }): void {
  ctx.db.transaction(() => {
    const row = ctx.db.get<OutboxRow>('SELECT * FROM outbox WHERE id = ?', [params.id]);
    if (!row) return;
    ctx.db.run('DELETE FROM outbox WHERE id = ?', [params.id]);
    const needed = neededFiles(ctx);
    for (const blobId of heldBlobIds(toEntry(row).item)) if (!needed.has(blobId)) dropHeld(ctx, blobId);
  });
}

// ---- Files attached offline ----

/** The same size the page cuts a file into on its way here. */
const HOLD_CHUNK_BYTES = 1024 * 1024;

/** A file that comes in pieces: nothing can read it until the last one is in. */
function holdStart(ctx: StoreContext, params: { jmap?: string; name: string; type: string; size: number }): { blobId: string } {
  const blobId = `${LOCAL_BLOB_PREFIX}${crypto.randomUUID()}`;
  ctx.db.run(
    "INSERT INTO upload (local_id, jmap, type, name, size, data, created_at, complete) VALUES (?, ?, ?, ?, ?, x'', ?, 0)",
    [blobId, params.jmap ?? null, params.type, params.name, params.size, ctx.now()],
  );
  return { blobId };
}

function holdChunk(ctx: StoreContext, params: { blobId: string; seq: number; data: Uint8Array }): void {
  ctx.db.run('INSERT OR REPLACE INTO upload_chunk (local_id, seq, data) VALUES (?, ?, ?)', [params.blobId, params.seq, params.data]);
}

function holdEnd(ctx: StoreContext, params: { blobId: string }): { blobId: string; size: number; type: string } {
  ctx.db.run('UPDATE upload SET complete = 1 WHERE local_id = ?', [params.blobId]);
  const row = ctx.db.get<{ size: number; type: string | null }>('SELECT size, type FROM upload WHERE local_id = ?', [params.blobId]);
  return { blobId: params.blobId, size: Number(row?.size ?? 0), type: row?.type || 'application/octet-stream' };
}

function holdAbort(ctx: StoreContext, params: { blobId: string }): void {
  ctx.db.transaction(() => dropHeld(ctx, params.blobId));
}

/** A file that's here as a whole already: the old database's, on its move here. */
function holdFile(ctx: StoreContext, params: { jmap?: string; name: string; type: string; data: Uint8Array; localId?: string }): { blobId: string; size: number; type: string } {
  return ctx.db.transaction(() => {
    const blobId = params.localId ?? `${LOCAL_BLOB_PREFIX}${crypto.randomUUID()}`;
    dropHeld(ctx, blobId);
    ctx.db.run(
      "INSERT INTO upload (local_id, jmap, type, name, size, data, created_at) VALUES (?, ?, ?, ?, ?, x'', ?)",
      [blobId, params.jmap ?? null, params.type, params.name, params.data.byteLength, ctx.now()],
    );
    for (let at = 0, seq = 0; at < params.data.byteLength; at += HOLD_CHUNK_BYTES, seq += 1) {
      ctx.db.run('INSERT INTO upload_chunk (local_id, seq, data) VALUES (?, ?, ?)', [blobId, seq, params.data.subarray(at, at + HOLD_CHUNK_BYTES)]);
    }
    return { blobId, size: params.data.byteLength, type: params.type || 'application/octet-stream' };
  });
}

/** Piece by piece into a Blob, which the browser can keep out of this worker's memory. */
function heldFile(ctx: StoreContext, params: { blobId: string }): { name: string; type: string; size: number; blob: Blob } | null {
  const row = ctx.db.get<{ name: string | null; type: string | null; size: number; data: Uint8Array }>('SELECT name, type, size, data FROM upload WHERE local_id = ? AND complete = 1', [params.blobId]);
  if (!row) return null;
  const type = row.type || 'application/octet-stream';
  // A file from before chunks has its bytes in the row; a new one has none there.
  let blob = new Blob(row.data?.byteLength ? [row.data as BlobPart] : [], { type });
  for (let seq = 0; ; seq += 1) {
    const chunk = ctx.db.get<{ data: Uint8Array }>('SELECT data FROM upload_chunk WHERE local_id = ? AND seq = ?', [params.blobId, seq]);
    if (!chunk) break;
    // Each step only refers to the last Blob, so one chunk at a time is in memory here.
    blob = new Blob([blob, chunk.data as BlobPart], { type });
  }
  return { name: row.name ?? 'attachment', type, size: Number(row.size), blob };
}

/**
 * Files nothing needs any more: attached to a message that was then discarded,
 * or sent or saved long enough ago. Not at once, because an open composer may
 * still show one.
 */
function dropOrphans(ctx: StoreContext, params: { olderThan: number }): number {
  return ctx.db.transaction(() => {
    const needed = neededFiles(ctx);
    let dropped = 0;
    for (const row of ctx.db.all<{ local_id: string }>('SELECT local_id FROM upload WHERE created_at < ?', [params.olderThan])) {
      if (needed.has(String(row.local_id))) continue;
      dropHeld(ctx, String(row.local_id));
      dropped += 1;
    }
    return dropped;
  });
}

// ---- Changes ----

function pendingPatches(ctx: StoreContext, params: { upToSeq?: number | null }): PendingPatch[] {
  const rows = ctx.db.all<PatchRow>(
    params.upToSeq === undefined || params.upToSeq === null
      ? 'SELECT * FROM outbox_patch ORDER BY seq ASC'
      : 'SELECT * FROM outbox_patch WHERE seq < ? ORDER BY seq ASC',
    params.upToSeq === undefined || params.upToSeq === null ? [] : [params.upToSeq],
  );
  return rows.map((row) => ({
    jmap: row.jmap,
    type: row.type,
    recordId: row.record_id,
    op: row.op,
    patch: JSON.parse(row.patch) as Patch,
    base: row.base ? JSON.parse(row.base) as RecordState : null,
    subject: row.subject,
    seq: Number(row.seq),
  }));
}

function subjectFor(row: PatchRow, server: EmailObject | null | undefined): string {
  if (typeof server?.subject === 'string') return server.subject;
  return row.subject ?? '';
}

/**
 * What came of a flush. A change made while it ran stays and goes next time,
 * without comparing against a state this flush itself just moved. After a
 * conflict the local copy is the server's again: nothing else will correct it
 * if sync already passed that point.
 */
function patchResults(ctx: StoreContext, params: { outcomes: PatchOutcome[] }): number {
  let conflicts = 0;
  ctx.db.transaction(() => {
    for (const outcome of params.outcomes) {
      const key = [outcome.jmap, outcome.type, outcome.recordId];
      const row = ctx.db.get<PatchRow>('SELECT * FROM outbox_patch WHERE jmap = ? AND type = ? AND record_id = ?', key);
      if (!row) continue;
      if (outcome.outcome === 'done' && Number(row.seq) !== outcome.seq) {
        ctx.db.run('UPDATE outbox_patch SET base = NULL WHERE jmap = ? AND type = ? AND record_id = ?', key);
        continue;
      }
      ctx.db.run('DELETE FROM outbox_patch WHERE jmap = ? AND type = ? AND record_id = ?', key);
      if (outcome.outcome === 'done') continue;
      conflicts += 1;
      const summary: ConflictSummary = {
        subject: subjectFor(row, outcome.server),
        op: row.op,
        reason: outcome.reason,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      };
      ctx.db.run(
        'INSERT INTO conflict (jmap, type, record_id, summary, local, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [outcome.jmap, outcome.type, outcome.recordId, JSON.stringify(summary), JSON.stringify({ op: row.op, patch: JSON.parse(row.patch) }), ctx.now()],
      );
      if (outcome.server === null) {
        deleteEmail(ctx.db, outcome.jmap, outcome.recordId);
      } else if (outcome.server) {
        const gen = Number(ctx.db.get<{ gen: number | null }>('SELECT MAX(gen) AS gen FROM email WHERE jmap = ?', [outcome.jmap])?.gen ?? 0);
        upsertEmail(ctx.db, outcome.jmap, outcome.server, gen);
      }
    }
  });
  if (conflicts > 0) ctx.emit({ type: 'changed', account: ctx.account, collections: ['Email', 'Mailbox', 'Thread'] });
  return conflicts;
}

function dismissConflict(ctx: StoreContext, params: { id: number }): void {
  ctx.db.run('DELETE FROM conflict WHERE id = ?', [params.id]);
}

// ---- What the old offline database held ----

export interface LegacyImport {
  entries: QueueParams[];
  patches: Array<{ jmap: string; update: Record<string, Patch> }>;
  files: Array<{ blobId: string; name: string; type: string; data: Uint8Array }>;
}

const LEGACY_DONE = 'legacy_outbox_moved';

/** One transaction: all of it or none. A second run after a partial failure elsewhere adds nothing. */
function importLegacy(ctx: StoreContext, params: LegacyImport): boolean {
  return ctx.db.transaction(() => {
    if (metaGet(ctx.db, LEGACY_DONE)) return false;
    for (const file of params.files) holdFile(ctx, { name: file.name, type: file.type, data: file.data, localId: file.blobId });
    for (const entry of params.entries) insertEntry(ctx, entry);
    for (const { jmap, update: changes } of params.patches) {
      for (const [id, patch] of Object.entries(changes)) queueUpdate(ctx.db, jmap, id, patch, ctx.now());
    }
    metaSet(ctx.db, LEGACY_DONE, '1');
    return true;
  });
}

export const OUTBOX_CALLS: Readonly<Record<string, AreaCall>> = {
  'outbox.queueSend': queueSend,
  'outbox.read': read,
  'outbox.claim': claim,
  'outbox.update': update,
  'outbox.settleStale': settleStale,
  'outbox.remove': remove,
  'outbox.holdFile': holdFile,
  'outbox.holdStart': holdStart,
  'outbox.holdChunk': holdChunk,
  'outbox.holdEnd': holdEnd,
  'outbox.holdAbort': holdAbort,
  'outbox.heldFile': heldFile,
  'outbox.dropOrphans': dropOrphans,
  'outbox.pendingPatches': pendingPatches,
  'outbox.patchResults': patchResults,
  'outbox.dismissConflict': dismissConflict,
  'outbox.importLegacy': importLegacy,
};
