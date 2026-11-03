/**
 * Calendar writes made while the server can't be reached.
 *
 * Each event has at most one pending row. A later write merges into it, so a
 * flush sends one change per event: edit + edit is one patch, create + edit is
 * one create, create + delete is nothing, edit + delete is a delete.
 *
 * Answers read calendar_event.json, which is the server's copy with the pending
 * write applied. server_json keeps the server's copy underneath, so sync can
 * move it on and reapply the write, or notice that the two collide.
 */

import { applyPatchObject } from '@/lib/jmap/patch-object';
import { mergeOverrideEntry, stableJson } from '@/lib/recurrence-instances';
import type { StoreContext } from '../area';
import type { StorageAdapter } from '../storage';
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

const STAND_IN_PREFIX = 'local-';

export function isStandIn(id: string): boolean {
  return id.startsWith(STAND_IN_PREFIX);
}

export function pendingFor(db: StorageAdapter, jmap: string, id: string): PendingRow | undefined {
  return db.get<PendingRow>('SELECT * FROM calendar_pending WHERE jmap = ? AND record_id = ?', [jmap, id]);
}

/** What a stand-in id became, once its create reached the server. */
export function resolveId(db: StorageAdapter, jmap: string, id: string): string {
  if (!isStandIn(id)) return id;
  return db.get<{ server_id: string }>('SELECT server_id FROM calendar_id_map WHERE jmap = ? AND local_id = ?', [jmap, id])?.server_id ?? id;
}

function mergedScheduling(old: number | null, next: boolean | undefined): number | null {
  if (next === undefined) return old;
  return old === 1 || next ? 1 : 0;
}

function serverCopy(row: EventRow): CalendarObject {
  return JSON.parse(row.server_json ?? row.json) as CalendarObject;
}

function changed(ctx: StoreContext, ...collections: string[]): void {
  ctx.emit({ type: 'changed', account: ctx.account, collections });
}

/** Creates a local event under a stand-in id. The uid is what finds it again after a lost response. */
export function queueCreate(ctx: StoreContext, jmap: string, event: Record<string, unknown>, sendScheduling: boolean | undefined): { id: string; uid: string } {
  const id = `${STAND_IN_PREFIX}${crypto.randomUUID()}`;
  const uid = typeof event.uid === 'string' && event.uid ? event.uid : crypto.randomUUID();
  const payload = { '@type': 'Event', ...event, uid };
  ctx.db.run(
    `INSERT INTO calendar_pending (jmap, record_id, kind, patch, uid, send_scheduling, queued_at) VALUES (?, ?, 'create', ?, ?, ?, ?)`,
    [jmap, id, JSON.stringify(payload), uid, sendScheduling === undefined ? null : Number(sendScheduling), ctx.now()],
  );
  writeEvent(ctx.db, jmap, { shown: { ...payload, id, isOrigin: true }, gen: currentGen(ctx.db, jmap) });
  return { id, uid };
}

/** False when the store has no such event. */
export function queueUpdate(ctx: StoreContext, jmap: string, id: string, patch: Record<string, unknown>, sendScheduling: boolean | undefined): boolean {
  const row = eventRow(ctx.db, jmap, id);
  if (!row || row.hidden) return false;
  const pending = pendingFor(ctx.db, jmap, id);
  const gen = row.gen;
  if (pending?.kind === 'create') {
    const payload = applyPatchObject(JSON.parse(pending.patch) as Record<string, unknown>, patch);
    ctx.db.run(
      'UPDATE calendar_pending SET patch = ?, send_scheduling = ?, rev = rev + 1 WHERE seq = ?',
      [JSON.stringify(payload), mergedScheduling(pending.send_scheduling, sendScheduling), pending.seq],
    );
    writeEvent(ctx.db, jmap, { shown: { ...payload, id, isOrigin: true } as CalendarObject, gen });
    return true;
  }
  const server = serverCopy(row);
  const earlier = pending ? JSON.parse(pending.patch) as Record<string, unknown> : {};
  const earlierBase = pending ? JSON.parse(pending.base) as Record<string, unknown> : {};
  const merged = mergeOverrideEntry(earlier, patch);
  const base: Record<string, unknown> = {};
  for (const key of Object.keys(merged)) {
    base[key] = key in earlierBase ? earlierBase[key] : valueAtPointer(server, key) ?? null;
  }
  if (pending) {
    ctx.db.run(
      'UPDATE calendar_pending SET patch = ?, base = ?, send_scheduling = ?, rev = rev + 1 WHERE seq = ?',
      [JSON.stringify(merged), JSON.stringify(base), mergedScheduling(pending.send_scheduling, sendScheduling), pending.seq],
    );
  } else {
    ctx.db.run(
      `INSERT INTO calendar_pending (jmap, record_id, kind, patch, base, send_scheduling, queued_at) VALUES (?, ?, 'update', ?, ?, ?, ?)`,
      [jmap, id, JSON.stringify(merged), JSON.stringify(base), sendScheduling === undefined ? null : Number(sendScheduling), ctx.now()],
    );
  }
  writeEvent(ctx.db, jmap, { shown: applyPatchObject(server, merged), server, gen });
  return true;
}

/** False when the store has no such event. */
export function queueDestroy(ctx: StoreContext, jmap: string, id: string, sendScheduling: boolean | undefined): boolean {
  const row = eventRow(ctx.db, jmap, id);
  if (!row || row.hidden) return false;
  const pending = pendingFor(ctx.db, jmap, id);
  if (pending?.kind === 'create' && !pending.attempted) {
    // It never left the device.
    ctx.db.run('DELETE FROM calendar_pending WHERE seq = ?', [pending.seq]);
    deleteEventRow(ctx.db, jmap, id);
    return true;
  }
  if (pending) {
    // A create that went out stays findable by its uid, so the delete can follow it.
    ctx.db.run(
      `UPDATE calendar_pending SET kind = 'destroy', patch = '{}', base = '{}', send_scheduling = ?, rev = rev + 1 WHERE seq = ?`,
      [mergedScheduling(pending.send_scheduling, sendScheduling), pending.seq],
    );
  } else {
    ctx.db.run(
      `INSERT INTO calendar_pending (jmap, record_id, kind, patch, send_scheduling, queued_at) VALUES (?, ?, 'destroy', '{}', ?, ?)`,
      [jmap, id, sendScheduling === undefined ? null : Number(sendScheduling), ctx.now()],
    );
  }
  const shown = JSON.parse(row.json) as CalendarObject;
  writeEvent(ctx.db, jmap, {
    shown,
    server: pending?.kind === 'create' ? null : serverCopy(row),
    hidden: true,
    gen: row.gen,
  });
  return true;
}

/** Whether the server moved a value this patch writes, to something other than what the patch writes. */
function collides(pending: PendingRow, server: Record<string, unknown>): boolean {
  const base = JSON.parse(pending.base) as Record<string, unknown>;
  const patch = JSON.parse(pending.patch) as Record<string, unknown>;
  return Object.keys(patch).some((key) => {
    const now = stableJson(valueAtPointer(server, key));
    return now !== stableJson(base[key]) && now !== stableJson(patch[key]);
  });
}

/**
 * Puts a write on the conflict list and takes it off the event, which goes back
 * to the server's copy. A refused create leaves nothing behind.
 */
export function recordConflict(
  ctx: StoreContext,
  pending: PendingRow,
  reason: ConflictReason,
  error?: { type?: string; description?: string },
): void {
  const { db } = ctx;
  const row = eventRow(db, pending.jmap, pending.record_id);
  const shown = row ? JSON.parse(row.json) as Record<string, unknown> : null;
  const known = row && pending.kind !== 'create' && !(pending.kind === 'destroy' && pending.uid);
  const server = known && reason !== 'destroyedOnServer' ? serverCopy(row) : null;
  db.run(
    `INSERT INTO calendar_conflict (jmap, record_id, kind, reason, error_type, description, title, local, server, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      pending.jmap, pending.record_id, pending.kind, reason, error?.type ?? null, error?.description ?? null,
      typeof shown?.title === 'string' ? shown.title : null, pending.patch, server ? JSON.stringify(server) : null, ctx.now(),
    ],
  );
  db.run('DELETE FROM calendar_pending WHERE seq = ?', [pending.seq]);
  if (row) {
    if (server) writeEvent(db, pending.jmap, { shown: server, gen: row.gen });
    else deleteEventRow(db, pending.jmap, pending.record_id);
  }
  changed(ctx, 'CalendarEvent', 'CalendarConflict');
}

/** The server's copy of an event arriving during sync. Any pending write goes back on top, or to the conflict list. */
export function applyServerEvent(ctx: StoreContext, jmap: string, event: CalendarObject, gen: number): void {
  const { db } = ctx;
  const pending = pendingFor(db, jmap, event.id);
  if (!pending) {
    writeEvent(db, jmap, { shown: event, gen });
    return;
  }
  const row = eventRow(db, jmap, event.id);
  if (pending.kind === 'destroy') {
    const previous = row ? stableJson(serverCopy(row)) : null;
    if (previous !== null && previous !== stableJson(event)) {
      // Deleting what someone just changed is the one write that can't be taken
      // back, so the change wins and the user decides.
      writeEvent(db, jmap, { shown: JSON.parse(row!.json) as CalendarObject, server: event, hidden: true, gen });
      recordConflict(ctx, pending, 'changedOnServer');
      return;
    }
    writeEvent(db, jmap, { shown: event, server: event, hidden: true, gen });
    return;
  }
  writeEvent(db, jmap, { shown: applyPatchObject(event, JSON.parse(pending.patch) as Record<string, unknown>), server: event, gen });
  if (collides(pending, event)) recordConflict(ctx, pending, 'changedOnServer');
}

/** The server no longer has this event. A pending delete is done; a pending edit has nothing left to change. */
export function applyServerDestroy(ctx: StoreContext, jmap: string, id: string): void {
  const pending = pendingFor(ctx.db, jmap, id);
  if (pending?.kind === 'update') {
    recordConflict(ctx, pending, 'destroyedOnServer');
    return;
  }
  if (pending) ctx.db.run('DELETE FROM calendar_pending WHERE seq = ?', [pending.seq]);
  deleteEventRow(ctx.db, jmap, id);
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
