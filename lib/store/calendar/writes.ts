/**
 * Calendar writes made while the server can't be reached.
 *
 * An event has a chain of pending rows, sent in order. A later write merges into
 * the last row when both have the same scheduling flag: edit + edit is one patch,
 * create + edit is one create. Different flags stay apart, because they mean
 * different things to attendees. The change to one occurrence that must reach
 * those who answered is a quiet write and then one with messages, and a change
 * made with "don't notify" must not go out with a later answer that does.
 *
 * Answers read calendar_event.json, which is the server's copy with the chain
 * applied. server_json keeps the server's copy underneath, so sync can move it on
 * and reapply the chain, or notice that the two collide.
 */

import { applyPatchObject } from '@/lib/jmap/patch-object';
import { isStandInId, newStandInId } from '@/lib/jmap/stand-in-ids';
import { mergeOverrideEntry, stableJson } from '@/lib/recurrence-instances';
import type { StoreContext } from '../area';
import type { StorageAdapter } from '../storage';
import { asOverridePointers, collides, holdsValue } from './patches';
import { currentGen, deleteEventRow, eventRow, valueAtPointer, writeEvent, type CalendarObject, type EventRow } from './records';

export interface PendingRow {
  seq: number;
  jmap: string;
  record_id: string;
  kind: 'create' | 'update' | 'destroy';
  patch: string;
  base: string;
  uid: string | null;
  send_scheduling: number | null;
  attempted: number;
  sent: string | null;
  rev: number;
  queued_at: number;
}

export type ConflictReason = 'refused' | 'changedOnServer' | 'destroyedOnServer';

export interface CalendarConflict {
  id: number;
  jmap: string;
  recordId: string;
  kind: PendingRow['kind'];
  reason: ConflictReason;
  errorType: string | null;
  description: string | null;
  title: string | null;
  /** The write that wasn't made: the whole event for a create, otherwise the patch. */
  local: Record<string, unknown>;
  /** The event as the server has it, when it still does. */
  server: Record<string, unknown> | null;
  createdAt: number;
}

export const isStandIn = isStandInId;

/** An event's pending writes, in the order they go out. */
export function pendingChain(db: StorageAdapter, jmap: string, id: string): PendingRow[] {
  return db.all<PendingRow>('SELECT * FROM calendar_pending WHERE jmap = ? AND record_id = ? ORDER BY seq', [jmap, id]);
}

export function pendingBySeq(db: StorageAdapter, seq: number): PendingRow | undefined {
  return db.get<PendingRow>('SELECT * FROM calendar_pending WHERE seq = ?', [seq]);
}

/** What a stand-in id became, once its create reached the server. */
export function resolveId(db: StorageAdapter, jmap: string, id: string): string {
  if (!isStandIn(id)) return id;
  return db.get<{ server_id: string }>('SELECT server_id FROM calendar_id_map WHERE jmap = ? AND local_id = ?', [jmap, id])?.server_id ?? id;
}

/** For the page's client: the real id, or null while it's still only on this device. */
export function resolveStandIns(db: StorageAdapter, ids: readonly string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const id of ids) {
    out[id] = db.get<{ server_id: string }>('SELECT server_id FROM calendar_id_map WHERE local_id = ?', [id])?.server_id ?? null;
  }
  return out;
}

function flagOf(sendScheduling: boolean | undefined): number | null {
  return sendScheduling === undefined ? null : Number(sendScheduling);
}

function parse(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

function serverCopy(row: EventRow): CalendarObject {
  return JSON.parse(row.server_json ?? row.json) as CalendarObject;
}

function changed(ctx: StoreContext, ...collections: string[]): void {
  ctx.emit({ type: 'changed', account: ctx.account, collections });
}

/** Writes what answers show: `server` with the event's chain on top. */
function rewriteShown(db: StorageAdapter, jmap: string, id: string, server: CalendarObject | null, gen: number): void {
  const chain = pendingChain(db, jmap, id);
  if (chain.length === 0) {
    if (server) writeEvent(db, jmap, { shown: server, gen });
    else deleteEventRow(db, jmap, id);
    return;
  }
  const row = eventRow(db, jmap, id);
  let shown: CalendarObject | null = server ?? (row ? JSON.parse(row.json) as CalendarObject : null);
  let hidden = false;
  for (const pending of chain) {
    if (pending.kind === 'create') shown = { ...parse(pending.patch), id, isOrigin: true };
    else if (pending.kind === 'update') shown = applyPatchObject(shown as CalendarObject, parse(pending.patch));
    else hidden = true;
  }
  if (shown) writeEvent(db, jmap, { shown, server, hidden, gen });
}

/**
 * Creates a local event under a stand-in id. The uid is what finds it again. One
 * the device chose can't be on the server yet. One from the caller might: the
 * client's request may have got through before its answer was lost, or an import
 * names an event that exists. That counts as attempted, so a flush looks first.
 */
export function queueCreate(ctx: StoreContext, jmap: string, event: Record<string, unknown>, sendScheduling: boolean | undefined): { id: string; uid: string } {
  const id = newStandInId();
  const given = typeof event.uid === 'string' && event.uid ? event.uid : null;
  const uid = given ?? crypto.randomUUID();
  const payload = { '@type': 'Event', ...event, uid };
  ctx.db.run(
    `INSERT INTO calendar_pending (jmap, record_id, kind, patch, uid, send_scheduling, attempted, queued_at) VALUES (?, ?, 'create', ?, ?, ?, ?, ?)`,
    [jmap, id, JSON.stringify(payload), uid, flagOf(sendScheduling), given ? 1 : 0, ctx.now()],
  );
  rewriteShown(ctx.db, jmap, id, null, currentGen(ctx.db, jmap));
  return { id, uid };
}

function baseFor(server: Record<string, unknown>, patch: Record<string, unknown>, earlier: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) base[key] = key in earlier ? earlier[key] : valueAtPointer(server, key) ?? null;
  return base;
}

/** False when the store has no such event. */
export function queueUpdate(ctx: StoreContext, jmap: string, id: string, rawPatch: Record<string, unknown>, sendScheduling: boolean | undefined): boolean {
  const { db } = ctx;
  const row = eventRow(db, jmap, id);
  if (!row || row.hidden) return false;
  const chain = pendingChain(db, jmap, id);
  const last = chain.at(-1);
  const flag = flagOf(sendScheduling);
  const local = chain[0]?.kind === 'create';
  const server = local ? null : serverCopy(row);
  if (last?.kind === 'create' && last.send_scheduling === flag) {
    db.run(
      'UPDATE calendar_pending SET patch = ?, rev = rev + 1 WHERE seq = ?',
      [JSON.stringify(applyPatchObject(parse(last.patch), rawPatch)), last.seq],
    );
    rewriteShown(db, jmap, id, null, row.gen);
    return true;
  }
  const patch = asOverridePointers(rawPatch, JSON.parse(row.json) as Record<string, unknown>);
  if (Object.keys(patch).length === 0) return true;
  if (last?.kind === 'update' && last.send_scheduling === flag) {
    const merged = mergeOverrideEntry(parse(last.patch), patch);
    const base = baseFor(server ?? {}, merged, parse(last.base));
    db.run('UPDATE calendar_pending SET patch = ?, base = ?, rev = rev + 1 WHERE seq = ?', [JSON.stringify(merged), JSON.stringify(base), last.seq]);
  } else {
    db.run(
      `INSERT INTO calendar_pending (jmap, record_id, kind, patch, base, send_scheduling, queued_at) VALUES (?, ?, 'update', ?, ?, ?, ?)`,
      [jmap, id, JSON.stringify(patch), JSON.stringify(baseFor(server ?? {}, patch, {})), flag, ctx.now()],
    );
  }
  rewriteShown(db, jmap, id, server, row.gen);
  return true;
}

/** False when the store has no such event. */
export function queueDestroy(ctx: StoreContext, jmap: string, id: string, sendScheduling: boolean | undefined): boolean {
  const { db } = ctx;
  const row = eventRow(db, jmap, id);
  if (!row || row.hidden) return false;
  const chain = pendingChain(db, jmap, id);
  const flag = flagOf(sendScheduling);
  const head = chain[0];
  if (head?.kind === 'create') {
    db.run('DELETE FROM calendar_pending WHERE jmap = ? AND record_id = ? AND seq <> ?', [jmap, id, head.seq]);
    if (!head.attempted) {
      // It never left the device.
      db.run('DELETE FROM calendar_pending WHERE seq = ?', [head.seq]);
      deleteEventRow(db, jmap, id);
      return true;
    }
    // It may be on the server. Its uid stays, so the delete can follow it.
    db.run(
      `UPDATE calendar_pending SET kind = 'destroy', patch = '{}', base = '{}', send_scheduling = ?, rev = rev + 1 WHERE seq = ?`,
      [flag, head.seq],
    );
    rewriteShown(db, jmap, id, null, row.gen);
    return true;
  }
  const last = chain.at(-1);
  if (last?.kind === 'update' && last.send_scheduling === flag) {
    db.run(`UPDATE calendar_pending SET kind = 'destroy', patch = '{}', base = '{}', sent = NULL, rev = rev + 1 WHERE seq = ?`, [last.seq]);
  } else {
    db.run(
      `INSERT INTO calendar_pending (jmap, record_id, kind, patch, send_scheduling, queued_at) VALUES (?, ?, 'destroy', '{}', ?, ?)`,
      [jmap, id, flag, ctx.now()],
    );
  }
  rewriteShown(db, jmap, id, serverCopy(row), row.gen);
  return true;
}

/**
 * Puts a write on the conflict list with every later write of that event, which
 * were built on it. The event goes back to the server's copy plus what's left. A
 * refused create leaves nothing behind.
 */
export function recordConflict(
  ctx: StoreContext,
  pending: PendingRow,
  reason: ConflictReason,
  error?: { type?: string; description?: string },
): void {
  const { db } = ctx;
  const { jmap, record_id: id } = pending;
  const row = eventRow(db, jmap, id);
  const gone = reason === 'destroyedOnServer';
  const local = pending.kind === 'create' || (pending.kind === 'destroy' && pending.uid !== null);
  const server = row && !local && !gone ? serverCopy(row) : null;
  const title = row ? (parse(row.json).title as string | undefined) ?? null : null;
  const chain = pendingChain(db, jmap, id).filter((other) => gone || other.seq >= pending.seq);
  for (const other of chain) {
    db.run(
      `INSERT INTO calendar_conflict (jmap, record_id, kind, reason, error_type, description, title, local, server, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [jmap, id, other.kind, reason, error?.type ?? null, error?.description ?? null, title, other.patch, server ? JSON.stringify(server) : null, ctx.now()],
    );
    db.run('DELETE FROM calendar_pending WHERE seq = ?', [other.seq]);
  }
  if (row) {
    if (local || gone) deleteEventRow(db, jmap, id);
    else rewriteShown(db, jmap, id, serverCopy(row), row.gen);
  }
  changed(ctx, 'CalendarEvent', 'CalendarConflict');
}

/** Before a row goes out: what it says may be on the server from now on. */
export function markSent(ctx: StoreContext, row: PendingRow, sent: Record<string, unknown>): void {
  ctx.db.transaction(() => ctx.db.run('UPDATE calendar_pending SET attempted = 1, sent = ? WHERE seq = ?', [JSON.stringify(sent), row.seq]));
}

/**
 * The server's event for a create found again, or just made: the stand-in becomes
 * it, and later rows go on under the real id. What the server doesn't hold of the
 * create goes on as an update: what came in after the last send, or, when nothing
 * of ours was sent, whatever differs. True when writes are left.
 */
export function adoptStandIn(ctx: StoreContext, row: PendingRow, event: CalendarObject): boolean {
  const { db } = ctx;
  const { jmap, record_id: standIn } = row;
  const head = pendingBySeq(db, row.seq);
  const gen = currentGen(db, jmap);
  deleteEventRow(db, jmap, standIn);
  db.run('INSERT OR REPLACE INTO calendar_id_map (jmap, local_id, server_id) VALUES (?, ?, ?)', [jmap, standIn, event.id]);
  db.run('UPDATE calendar_pending SET record_id = ? WHERE jmap = ? AND record_id = ?', [event.id, jmap, standIn]);
  if (head?.kind === 'destroy') {
    db.run('UPDATE calendar_pending SET uid = NULL, attempted = 0, sent = NULL WHERE seq = ?', [head.seq]);
  } else if (head) {
    const payload = parse(head.patch);
    const sent = head.sent ? parse(head.sent) : null;
    const patch: Record<string, unknown> = {};
    if (sent) {
      for (const key of new Set([...Object.keys(sent), ...Object.keys(payload)])) {
        if (stableJson(sent[key]) !== stableJson(payload[key])) patch[key] = payload[key] ?? null;
      }
    } else {
      for (const [key, value] of Object.entries(payload)) {
        if (key !== '@type' && key !== 'uid' && !holdsValue(event, key, value)) patch[key] = value;
      }
    }
    const pointers = asOverridePointers(patch, event);
    if (Object.keys(pointers).length === 0) {
      db.run('DELETE FROM calendar_pending WHERE seq = ?', [head.seq]);
    } else {
      db.run(
        `UPDATE calendar_pending SET kind = 'update', patch = ?, base = ?, uid = NULL, attempted = 0, sent = NULL WHERE seq = ?`,
        [JSON.stringify(pointers), JSON.stringify(baseFor(event, pointers, {})), head.seq],
      );
    }
  }
  const rest = pendingChain(db, jmap, event.id);
  for (const later of rest) {
    if (later.kind === 'update' && later.seq !== head?.seq) {
      db.run('UPDATE calendar_pending SET base = ? WHERE seq = ?', [JSON.stringify(baseFor(event, parse(later.patch), {})), later.seq]);
    }
  }
  rewriteShown(db, jmap, event.id, event, gen);
  changed(ctx, 'CalendarEvent');
  return rest.length > 0;
}

/**
 * A write went through: `sent` is the server's now. True when this row has to go
 * again, because a newer write merged into it during the send. Later rows read
 * their overlap with `sent` as ours, not as someone's change.
 */
export function finishWrite(ctx: StoreContext, row: PendingRow, sent: Record<string, unknown>): boolean {
  const { db } = ctx;
  const current = pendingBySeq(db, row.seq);
  const event = eventRow(db, row.jmap, row.record_id);
  if (!current || !event) return false;
  const server = applyPatchObject(serverCopy(event), sent);
  const stays = current.rev !== row.rev;
  if (stays) {
    db.run('UPDATE calendar_pending SET attempted = 0, sent = ? WHERE seq = ?', [JSON.stringify(sent), row.seq]);
  } else {
    db.run('DELETE FROM calendar_pending WHERE seq = ?', [row.seq]);
  }
  for (const later of pendingChain(db, row.jmap, row.record_id)) {
    if (later.kind !== 'update') continue;
    const earlierSent = later.sent ? parse(later.sent) : {};
    db.run(
      'UPDATE calendar_pending SET base = ?, sent = ? WHERE seq = ?',
      [JSON.stringify(baseFor(server, parse(later.patch), {})), JSON.stringify({ ...earlierSent, ...sent }), later.seq],
    );
  }
  rewriteShown(db, row.jmap, row.record_id, server, event.gen);
  changed(ctx, 'CalendarEvent');
  return stays;
}

/** The server's copy of an event arriving during sync. Any pending writes go back on top, or to the conflict list. */
export function applyServerEvent(ctx: StoreContext, jmap: string, event: CalendarObject, gen: number): void {
  const { db } = ctx;
  if (typeof event.uid === 'string') {
    // A create of ours that no answer told us about.
    const waiting = db.get<PendingRow>('SELECT * FROM calendar_pending WHERE jmap = ? AND uid = ? ORDER BY seq LIMIT 1', [jmap, event.uid]);
    if (waiting && waiting.record_id !== event.id) {
      adoptStandIn(ctx, waiting, event);
      return;
    }
  }
  const before = eventRow(db, jmap, event.id);
  const previous = before ? stableJson(serverCopy(before)) : null;
  const chain = pendingChain(db, jmap, event.id);
  if (chain.length === 0) {
    writeEvent(db, jmap, { shown: event, gen });
    return;
  }
  writeEvent(db, jmap, { shown: event, server: event, gen });
  for (const pending of chain) {
    if (pending.kind === 'destroy') {
      // Deleting what someone just changed is the one write that can't be taken
      // back, so the change wins and the user decides.
      if (previous !== null && previous !== stableJson(event)) recordConflict(ctx, pending, 'changedOnServer');
      break;
    }
    if (collides({ patch: parse(pending.patch), base: parse(pending.base), sent: pending.sent ? parse(pending.sent) : null }, event)) {
      recordConflict(ctx, pending, 'changedOnServer');
      break;
    }
  }
  rewriteShown(db, jmap, event.id, event, gen);
}

/** The server no longer has this event. A pending delete is done; a pending edit has nothing left to change. */
export function applyServerDestroy(ctx: StoreContext, jmap: string, id: string): void {
  const { db } = ctx;
  const chain = pendingChain(db, jmap, id);
  const edit = chain.find((row) => row.kind === 'update');
  if (edit) {
    recordConflict(ctx, edit, 'destroyedOnServer');
    return;
  }
  db.run('DELETE FROM calendar_pending WHERE jmap = ? AND record_id = ?', [jmap, id]);
  deleteEventRow(db, jmap, id);
}

export function listConflicts(db: StorageAdapter): CalendarConflict[] {
  const rows = db.all<{
    id: number; jmap: string; record_id: string; kind: PendingRow['kind']; reason: ConflictReason; error_type: string | null;
    description: string | null; title: string | null; local: string; server: string | null; created_at: number;
  }>('SELECT * FROM calendar_conflict ORDER BY id');
  return rows.map((row) => ({
    id: Number(row.id),
    jmap: row.jmap,
    recordId: row.record_id,
    kind: row.kind,
    reason: row.reason,
    errorType: row.error_type,
    description: row.description,
    title: row.title,
    local: JSON.parse(row.local) as Record<string, unknown>,
    server: row.server ? JSON.parse(row.server) as Record<string, unknown> : null,
    createdAt: Number(row.created_at),
  }));
}
