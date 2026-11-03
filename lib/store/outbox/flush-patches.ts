/**
 * Sends the changes that waited. Written against a small `request`, so the page
 * can run it through the JMAP client (its auth, its retries) while the logic
 * stays testable next to the store.
 *
 * Per batch: read what the server has now, keep back what it changed since the
 * change was queued, send the rest, and report per record. A change the server
 * took is dropped and the next /changes run brings the truth. A change it
 * refused, or that met a record changed since, goes to the user as a conflict.
 * Anything that looks like an outage stops the run: the changes wait.
 */

import { JmapMethodError, responseFor, type JmapResponse, type MethodCall } from '../engine/transport';
import { EMAIL_LIST_PROPERTIES, MAIL_USING, type EmailObject } from '../mail/records';
import type { ConflictReason } from './items';
import { destroyConflicts, patchConflicts, type Patch, type RecordState } from './patches';

export interface PendingPatch {
  jmap: string;
  type: string;
  recordId: string;
  op: 'update' | 'destroy';
  patch: Patch;
  base: RecordState | null;
  subject: string | null;
  seq: number;
}

export type PatchOutcome =
  | { jmap: string; type: string; recordId: string; seq: number; outcome: 'done' }
  | {
    jmap: string;
    type: string;
    recordId: string;
    seq: number;
    outcome: 'conflict';
    reason: ConflictReason;
    detail?: string;
    /** The record as the server has it, or null when it's gone there. Undefined when unknown. */
    server?: EmailObject | null;
  };

export interface PatchIo {
  request(calls: MethodCall[], using: string[]): Promise<JmapResponse>;
}

const BATCH = 200;
/** Method errors that mean "not now" rather than "no". */
const RETRY_LATER = new Set(['serverUnavailable', 'serverFail', 'serverPartialFail', 'rateLimit', 'requestTooLarge']);

/**
 * The server refused the request itself, for good: a JMAP problem document with
 * a status that says so. `limit` is the parallel-request ceiling, which passes,
 * and an error page says something about a proxy, not about this request.
 */
export function isRequestRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const problem = /^Request failed: (?:400|403|404|413|422)\b[\s\S]*?"type"\s*:\s*"urn:ietf:params:jmap:error:([A-Za-z]+)"/.exec(error.message);
  return !!problem && problem[1] !== 'limit';
}

function isLater(error: unknown): boolean {
  if (error instanceof JmapMethodError) return RETRY_LATER.has(error.type);
  return !isRequestRefusal(error);
}

function conflict(row: PendingPatch, reason: ConflictReason, server?: EmailObject | null, detail?: string): PatchOutcome {
  return { jmap: row.jmap, type: row.type, recordId: row.recordId, seq: row.seq, outcome: 'conflict', reason, detail, server };
}

function done(row: PendingPatch): PatchOutcome {
  return { jmap: row.jmap, type: row.type, recordId: row.recordId, seq: row.seq, outcome: 'done' };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readRecords(io: PatchIo, jmap: string, rows: PendingPatch[]): Promise<Map<string, EmailObject>> {
  const read = await io.request([['Email/get', {
    accountId: jmap,
    ids: rows.map((row) => row.recordId),
    properties: EMAIL_LIST_PROPERTIES,
  }, 'g']], MAIL_USING);
  const [, got] = responseFor(read, 'g');
  return new Map((got.list as EmailObject[]).map((email) => [email.id, email]));
}

/**
 * The whole batch was refused. The server's copy of each record goes with the
 * conflict so that this device shows what's true again. When even that read is
 * refused the record stays as it is here until the next sync.
 */
async function refusedOutcomes(io: PatchIo, jmap: string, rows: PendingPatch[], refusal: unknown): Promise<PatchOutcome[] | null> {
  let current: Map<string, EmailObject> | null = null;
  try {
    current = await readRecords(io, jmap, rows);
  } catch (error) {
    if (isLater(error)) return null;
  }
  return rows.map((row) => {
    if (current && !current.has(row.recordId)) return row.op === 'destroy' ? done(row) : conflict(row, 'gone', null);
    return conflict(row, 'refused', current?.get(row.recordId), errorText(refusal));
  });
}

async function flushBatch(io: PatchIo, jmap: string, rows: PendingPatch[]): Promise<PatchOutcome[]> {
  const current = await readRecords(io, jmap, rows);

  const outcomes: PatchOutcome[] = [];
  const update: Record<string, Patch> = {};
  const destroy: string[] = [];
  const sent = new Map<string, PendingPatch>();
  for (const row of rows) {
    const server = current.get(row.recordId);
    if (!server) {
      // Asked to delete what's already gone: that's the same result.
      outcomes.push(row.op === 'destroy' ? done(row) : conflict(row, 'gone', null));
      continue;
    }
    const changed = row.op === 'destroy' ? destroyConflicts(row.base, server) : patchConflicts(row.patch, row.base, server);
    if (changed) {
      outcomes.push(conflict(row, 'changed', server));
      continue;
    }
    sent.set(row.recordId, row);
    if (row.op === 'destroy') destroy.push(row.recordId);
    else update[row.recordId] = row.patch;
  }
  if (sent.size === 0) return outcomes;

  const response = await io.request([['Email/set', {
    accountId: jmap,
    ...(Object.keys(update).length > 0 ? { update } : {}),
    ...(destroy.length > 0 ? { destroy } : {}),
  }, 's']], MAIL_USING);
  const [, result] = responseFor(response, 's');
  const refused: Record<string, { type?: string; description?: string }> = { ...(result.notUpdated ?? {}), ...(result.notDestroyed ?? {}) };
  for (const [id, row] of sent) {
    const refusal = refused[id];
    if (!refusal) {
      outcomes.push(done(row));
    } else if (refusal.type === 'notFound') {
      outcomes.push(row.op === 'destroy' ? done(row) : conflict(row, 'gone', null));
    } else {
      outcomes.push(conflict(row, 'refused', current.get(id), refusal.description ?? refusal.type));
    }
  }
  return outcomes;
}

/** True when all went through to an answer, false when the run stopped on an outage. */
export async function flushPatches(
  io: PatchIo,
  pending: readonly PendingPatch[],
  report: (outcomes: PatchOutcome[]) => Promise<void>,
): Promise<boolean> {
  const byAccount = new Map<string, PendingPatch[]>();
  for (const row of pending) byAccount.set(row.jmap, [...(byAccount.get(row.jmap) ?? []), row]);
  for (const [jmap, rows] of byAccount) {
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      let outcomes: PatchOutcome[] | null;
      try {
        outcomes = await flushBatch(io, jmap, batch);
      } catch (error) {
        if (isLater(error)) return false;
        outcomes = await refusedOutcomes(io, jmap, batch, error);
        if (!outcomes) return false;
      }
      await report(outcomes);
    }
  }
  return true;
}
