/**
 * Contact edits made while the server can't be reached, and sending them.
 *
 * One row per card, whatever number of edits it had. The visible card in
 * contact_card already has the edits on top, and sync keeps it so. Sending
 * runs at the start of each sync pass, so it never overlaps with itself.
 *
 * What a row becomes on its way out:
 * - Update: the server's card is read first. Nothing to do if it already has
 *   the values (a lost response). A conflict if the server changed one of the
 *   properties the edit touches. Otherwise the patch goes out.
 * - Destroy: done if the card is gone, a conflict if it changed since.
 * - Create: a request that may have reached the server looks for the card's
 *   uid first, so a lost response doesn't make a second card. Stalwart also
 *   refuses a second card with the same uid. Either way the card found is only
 *   ours if it holds what was sent, or an offline card with someone else's uid
 *   would silently turn into theirs.
 *
 * The local copy after sending is always the server's own read-back, never what
 * was sent: Stalwart 1.0 stores a data: URI as a blob. A base built from what
 * was sent would read that as someone else's change. If the network goes before
 * the read-back, that counts as a lost response: the row stays, and the next
 * pass finds its edit already there. `sent` is what the last request held, so
 * the next pass can tell its own edit from someone else's.
 */

import type { StoreContext, SyncContext } from '../area';
import { requestLimits, type RequestLimits } from '../engine/limits';
import { JmapMethodError, responseFor, TransportError, type MethodCall } from '../engine/transport';
import type { StorageAdapter } from '../storage';
import { applyPatch, coversJson, InvalidPatchError, mergePatches, sameJson, touchedProperties, type JsonObject, type Patch } from './patch';
import { cardDisplayName, CONTACTS_USING, readCard, removeCard, writeCard, type Card } from './records';

export const STAND_IN_PREFIX = 'bulwark-local-card-';
/** What a held upload's stand-in blob id starts with (lib/offline/queue.ts). */
const LOCAL_BLOB_MARK = '"blobId":"bulwark-local-';

const SET_BATCH = 100;

/** Of the session's request limit. A bigger card would never go out. */
function maxRecordBytes(ctx: StoreContext): number {
  return Math.floor(requestLimits(ctx.session).maxSizeRequest * 0.8);
}

/** Set errors that say nothing about the edit itself: it goes out again next time. */
const TRANSIENT_ERRORS = new Set(['serverFail', 'serverUnavailable', 'rateLimit']);
/** Server-kept timestamps: their changing doesn't mean someone edited the card. */
const SERVER_STAMPS = ['updated', 'created'];

export interface PendingRow {
  seq: number;
  jmap: string;
  id: string;
  op: 'create' | 'update' | 'destroy';
  uid: string | null;
  payload: string | null;
  base: string | null;
  attempted: number;
  sent: string | null;
  queued_at: number;
}

export interface SetError { type: string; description?: string; properties?: string[] }

export interface ContactConflict {
  id: number;
  jmap: string;
  recordId: string;
  kind: 'refused' | 'changed' | 'gone';
  summary: string;
  local: { op: string; payload: unknown };
  server: unknown;
  error: string | null;
  createdAt: number;
}

export function pendingFor(db: StorageAdapter, jmap: string, id: string): PendingRow | undefined {
  return db.get<PendingRow>('SELECT * FROM contact_pending WHERE jmap = ? AND id = ?', [jmap, id]);
}

function dropPending(db: StorageAdapter, jmap: string, id: string): void {
  db.run('DELETE FROM contact_pending WHERE jmap = ? AND id = ?', [jmap, id]);
}

function savePending(db: StorageAdapter, ctx: { now(): number }, row: { jmap: string; id: string; op: PendingRow['op']; uid?: string | null; payload: string | null; base: string | null }): void {
  db.run(
    `INSERT INTO contact_pending (jmap, id, op, uid, payload, base, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (jmap, id) DO UPDATE SET op = excluded.op, uid = excluded.uid, payload = excluded.payload, base = excluded.base`,
    [row.jmap, row.id, row.op, row.uid ?? null, row.payload, row.base, ctx.now()],
  );
}

/** A stand-in id that already went through becomes the real one. */
export function resolveCardId(db: StorageAdapter, jmap: string, id: string): string {
  return db.get<{ real_id: string }>('SELECT real_id FROM contact_id_map WHERE jmap = ? AND local_id = ?', [jmap, id])?.real_id ?? id;
}

/** A held upload can't be named in a card that goes out later. The client falls back to a data: URI. */
function holdsLocalBlob(value: unknown): boolean {
  return JSON.stringify(value).includes(LOCAL_BLOB_MARK);
}

const TOO_LARGE_ERROR: SetError = { type: 'tooLarge', description: 'This contact is too large to save' };

const LOCAL_BLOB_ERROR: SetError = {
  type: 'invalidProperties',
  description: 'A photo that is not on the server yet cannot be used here',
  properties: ['media'],
};

export function queueCreate(ctx: StoreContext, jmap: string, card: JsonObject): { id: string; uid: string } | SetError {
  if (holdsLocalBlob(card)) return LOCAL_BLOB_ERROR;
  if (Object.keys((card.addressBookIds ?? {}) as object).length === 0) {
    // The client picks the default book. None known means there's nowhere to put it.
    return { type: 'invalidProperties', description: 'A contact needs an address book', properties: ['addressBookIds'] };
  }
  const id = `${STAND_IN_PREFIX}${crypto.randomUUID()}`;
  const uid = typeof card.uid === 'string' && card.uid ? card.uid : `urn:uuid:${crypto.randomUUID()}`;
  const payload = JSON.stringify({ ...card, uid });
  if (payload.length > maxRecordBytes(ctx)) return TOO_LARGE_ERROR;
  savePending(ctx.db, ctx, { jmap, id, op: 'create', uid, payload, base: null });
  writeCard(ctx.db, jmap, { '@type': 'Card', version: '1.0', ...card, uid, id });
  return { id, uid };
}

export function queueUpdate(ctx: StoreContext, jmap: string, rawId: string, patch: Patch): SetError | null {
  const id = resolveCardId(ctx.db, jmap, rawId);
  const card = readCard(ctx.db, jmap, id);
  if (!card) return { type: 'notFound' };
  if ('id' in patch) return { type: 'invalidProperties', description: 'The id property is immutable.', properties: ['id'] };
  if (holdsLocalBlob(patch)) return LOCAL_BLOB_ERROR;
  const pending = pendingFor(ctx.db, jmap, id);
  let visible: Card;
  try {
    visible = applyPatch(card, patch);
  } catch (error) {
    if (error instanceof InvalidPatchError) return { type: 'invalidPatch', description: error.message };
    throw error;
  }
  if (pending?.op === 'create') {
    const payload = JSON.stringify(applyPatch(JSON.parse(pending.payload as string) as JsonObject, patch));
    if (payload.length > maxRecordBytes(ctx)) return TOO_LARGE_ERROR;
    savePending(ctx.db, ctx, { jmap, id, op: 'create', uid: pending.uid, payload, base: null });
  } else {
    const merged = JSON.stringify(pending ? mergePatches(JSON.parse(pending.payload as string) as Patch, patch) : patch);
    if (merged.length > maxRecordBytes(ctx)) return TOO_LARGE_ERROR;
    savePending(ctx.db, ctx, { jmap, id, op: 'update', payload: merged, base: pending ? pending.base : JSON.stringify(card) });
  }
  writeCard(ctx.db, jmap, visible);
  return null;
}

export function queueDestroy(ctx: StoreContext, jmap: string, rawId: string): SetError | null {
  const id = resolveCardId(ctx.db, jmap, rawId);
  const card = readCard(ctx.db, jmap, id);
  if (!card) return { type: 'notFound' };
  const pending = pendingFor(ctx.db, jmap, id);
  if (pending?.op === 'create' && !pending.attempted) {
    // Never reached the server, so it never has to.
    dropPending(ctx.db, jmap, id);
  } else if (pending?.op === 'create') {
    // It may have reached the server. Sending decides, then destroys it.
    savePending(ctx.db, ctx, { jmap, id, op: 'destroy', uid: pending.uid, payload: pending.payload, base: null });
  } else {
    savePending(ctx.db, ctx, { jmap, id, op: 'destroy', payload: null, base: pending ? pending.base : JSON.stringify(card) });
  }
  removeCard(ctx.db, jmap, id);
  return null;
}

// ---- What sync does around queued edits ----

/** Stores a card the server sent, with whatever is queued for it on top. */
export function storeServerCard(db: StorageAdapter, jmap: string, card: Card, gen?: number): void {
  const pending = pendingFor(db, jmap, card.id);
  if (pending?.op === 'destroy') return;
  let visible = card;
  if (pending?.op === 'update') {
    try {
      visible = applyPatch(card, JSON.parse(pending.payload as string) as Patch);
    } catch (error) {
      // The patch no longer fits the card. Sending turns this into a conflict.
      if (!(error instanceof InvalidPatchError)) throw error;
    }
  }
  writeCard(db, jmap, visible, gen);
}

/** The server no longer has this card. */
export function serverDestroyed(ctx: StoreContext, jmap: string, id: string): void {
  const pending = pendingFor(ctx.db, jmap, id);
  if (pending?.op === 'update') recordConflict(ctx, pending, 'gone', null, null);
  if (pending && pending.op !== 'create') dropPending(ctx.db, jmap, id);
  removeCard(ctx.db, jmap, id);
}

function recordConflict(ctx: StoreContext, row: PendingRow, kind: ContactConflict['kind'], server: Card | null, error: SetError | null): void {
  const local = row.payload ? JSON.parse(row.payload) as JsonObject : null;
  const known = server ?? readCard(ctx.db, row.jmap, row.id) ?? (row.base ? JSON.parse(row.base) as JsonObject : local);
  ctx.db.run(
    'INSERT INTO contact_conflict (jmap, record_id, kind, summary, local, server, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      row.jmap,
      row.id,
      kind,
      cardDisplayName(known ?? {}),
      JSON.stringify({ op: row.op, payload: local }),
      server ? JSON.stringify(server) : null,
      error ? [error.type, error.description].filter(Boolean).join(': ') : null,
      ctx.now(),
    ],
  );
}

export function listConflicts(db: StorageAdapter): ContactConflict[] {
  return db.all<{ id: number; jmap: string; record_id: string; kind: ContactConflict['kind']; summary: string; local: string; server: string | null; error: string | null; created_at: number }>(
    'SELECT * FROM contact_conflict ORDER BY id',
  ).map((row) => ({
    id: Number(row.id),
    jmap: row.jmap,
    recordId: row.record_id,
    kind: row.kind,
    summary: row.summary,
    local: JSON.parse(row.local) as ContactConflict['local'],
    server: row.server ? JSON.parse(row.server) : null,
    error: row.error,
    createdAt: Number(row.created_at),
  }));
}

export function pendingCount(db: StorageAdapter): number {
  return Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contact_pending')?.n ?? 0);
}

// ---- Sending ----

function withoutStamps(card: JsonObject): JsonObject {
  const copy = { ...card };
  for (const key of SERVER_STAMPS) delete copy[key];
  return copy;
}

async function readServerCards(ctx: SyncContext, jmap: string, ids: string[], limits: RequestLimits): Promise<Map<string, Card>> {
  const cards = new Map<string, Card>();
  for (let i = 0; i < ids.length; i += limits.maxObjectsInGet) {
    const response = await ctx.transport.request([['ContactCard/get', { accountId: jmap, ids: ids.slice(i, i + limits.maxObjectsInGet) }, 'g']], CONTACTS_USING);
    for (const card of responseFor(response, 'g')[1].list as Card[]) cards.set(card.id, card);
  }
  return cards;
}

/** The server's cards with these uids. */
async function cardsByUid(ctx: SyncContext, jmap: string, uids: string[], limits: RequestLimits): Promise<Map<string, Card>> {
  const ids = new Map<string, string>();
  for (let i = 0; i < uids.length; i += limits.maxCallsInRequest) {
    const group = uids.slice(i, i + limits.maxCallsInRequest);
    const calls: MethodCall[] = group.map((uid, n) => ['ContactCard/query', { accountId: jmap, filter: { uid }, limit: 1 }, `q${n}`]);
    const response = await ctx.transport.request(calls, CONTACTS_USING);
    group.forEach((uid, n) => {
      const found = responseFor(response, `q${n}`)[1].ids as string[];
      if (found.length > 0) ids.set(uid, found[0]);
    });
  }
  const cards = await readServerCards(ctx, jmap, [...ids.values()], limits);
  const byUid = new Map<string, Card>();
  for (const [uid, id] of ids) {
    const card = cards.get(id);
    if (card) byUid.set(uid, card);
  }
  return byUid;
}

/** Whether a card the server has under our uid is the one we sent. */
function holdsSent(sentPayload: string, card: Card): boolean {
  const sent = JSON.parse(sentPayload) as JsonObject;
  return Object.keys(sent).every((key) => coversJson(sent[key], card[key]));
}

const UID_TAKEN: SetError = { type: 'invalidProperties', description: 'Another contact already has this uid', properties: ['uid'] };

/** The create went through, or had already. The stand-in row becomes the server's card. */
function settleCreated(ctx: SyncContext, sent: PendingRow, server: Card): void {
  const { db } = ctx;
  const { jmap, id: standIn } = sent;
  const now = pendingFor(db, jmap, standIn);
  db.run('INSERT OR REPLACE INTO contact_id_map (jmap, local_id, real_id) VALUES (?, ?, ?)', [jmap, standIn, server.id]);
  dropPending(db, jmap, standIn);
  removeCard(db, jmap, standIn);
  if (now?.op === 'destroy' || !now) {
    // Deleted while the create was on its way: delete the real one next.
    savePending(db, ctx, { jmap, id: server.id, op: 'destroy', payload: null, base: JSON.stringify(server) });
    return;
  }
  if (now.payload !== sent.payload) {
    // Edited while the create was on its way: what differs goes out as an edit.
    const before = JSON.parse(sent.payload as string) as JsonObject;
    const after = JSON.parse(now.payload as string) as JsonObject;
    const patch: Patch = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!sameJson(before[key], after[key])) patch[key.replace(/~/g, '~0').replace(/\//g, '~1')] = after[key] ?? null;
    }
    savePending(db, ctx, { jmap, id: server.id, op: 'update', payload: JSON.stringify(patch), base: JSON.stringify(server) });
    writeCard(db, jmap, applyPatch(server, patch));
    return;
  }
  writeCard(db, jmap, server);
}

interface Decision { create: Map<string, PendingRow>; update: Map<string, PendingRow>; destroy: Map<string, PendingRow> }

/**
 * Whether someone else moved one of these properties since the edit was queued.
 * The server holding what our last request sent is our own doing, not a change:
 * its response may have been lost.
 */
function movedOnServer(row: PendingRow, server: Card, keys: readonly string[]): boolean {
  if (!row.base) return false;
  const base = JSON.parse(row.base) as JsonObject;
  let own: JsonObject | null = null;
  if (row.sent) {
    try {
      own = applyPatch(base, JSON.parse(row.sent) as Patch);
    } catch (error) {
      if (!(error instanceof InvalidPatchError)) throw error;
    }
  }
  return keys.some((key) => !sameJson(base[key], server[key]) && !(own && coversJson(own[key], server[key], base[key])));
}

/** What to do with one row now that the server's copy is known. Conflicts are settled here. */
function decide(ctx: SyncContext, row: PendingRow, server: Card | undefined, serverByUid: Map<string, Card>, out: Decision): void {
  const { db } = ctx;
  const { jmap, id } = row;
  const uidHit = row.uid ? serverByUid.get(row.uid) : undefined;
  if (row.op === 'create') {
    if (!uidHit) {
      out.create.set(id, row);
    } else if (holdsSent(row.sent ?? (row.payload as string), uidHit)) {
      settleCreated(ctx, { ...row, payload: row.sent ?? row.payload }, uidHit);
    } else {
      recordConflict(ctx, row, 'refused', null, UID_TAKEN);
      dropPending(db, jmap, id);
      removeCard(db, jmap, id);
    }
    return;
  }
  if (row.op === 'destroy' && id.startsWith(STAND_IN_PREFIX)) {
    // A create that may have gone out, deleted since. Only a card holding what was sent is ours to delete.
    dropPending(db, jmap, id);
    const sent = row.sent ?? row.payload;
    if (uidHit && sent && holdsSent(sent, uidHit)) {
      savePending(db, ctx, { jmap, id: uidHit.id, op: 'destroy', payload: null, base: JSON.stringify(uidHit) });
    }
    return;
  }
  if (row.op === 'destroy') {
    if (!server) {
      dropPending(db, jmap, id);
      return;
    }
    const stable = withoutStamps(server);
    const base = row.base ? withoutStamps(JSON.parse(row.base) as JsonObject) : {};
    if (movedOnServer(row, server, [...new Set([...Object.keys(stable), ...Object.keys(base)])])) {
      recordConflict(ctx, row, 'changed', server, null);
      dropPending(db, jmap, id);
      writeCard(db, jmap, server);
    } else {
      out.destroy.set(id, row);
    }
    return;
  }
  if (!server) {
    recordConflict(ctx, row, 'gone', null, null);
    dropPending(db, jmap, id);
    removeCard(db, jmap, id);
    return;
  }
  const patch = JSON.parse(row.payload as string) as Patch;
  const base = row.base ? JSON.parse(row.base) as JsonObject : {};
  let applied: Card | null = null;
  try {
    applied = applyPatch(server, patch);
  } catch (error) {
    if (!(error instanceof InvalidPatchError)) throw error;
  }
  const touched = touchedProperties(patch);
  if (applied && touched.every((key) => coversJson((applied as Card)[key], server[key], base[key]))) {
    dropPending(db, jmap, id);
    writeCard(db, jmap, server);
    return;
  }
  if (!applied || movedOnServer(row, server, touched)) {
    recordConflict(ctx, row, 'changed', server, null);
    dropPending(db, jmap, id);
    writeCard(db, jmap, server);
    return;
  }
  out.update.set(id, row);
}

function settleUpdated(ctx: SyncContext, sent: PendingRow, server: Card | undefined): void {
  const { db } = ctx;
  const now = pendingFor(db, sent.jmap, sent.id);
  if (!now) return;
  if (now.op === 'update' && now.payload === sent.payload) {
    dropPending(db, sent.jmap, sent.id);
    if (server) writeCard(db, sent.jmap, server);
    return;
  }
  // Edited again while this was on its way: that edit now builds on what the server holds.
  if (!server) return;
  db.run('UPDATE contact_pending SET base = ?, sent = NULL, attempted = 0 WHERE seq = ?', [JSON.stringify(server), now.seq]);
  if (now.op === 'update') storeServerCard(db, sent.jmap, server);
}

function settleRefused(ctx: SyncContext, sent: PendingRow, error: SetError, server: Card | undefined): void {
  const { db } = ctx;
  if (TRANSIENT_ERRORS.has(error.type)) return;
  const now = pendingFor(db, sent.jmap, sent.id);
  if (now && (now.op !== sent.op || now.payload !== sent.payload)) {
    // Edited again while this was on its way, so the refused edit is still in
    // the row. It goes out once more, and a second refusal is the conflict.
    db.run('UPDATE contact_pending SET sent = NULL, attempted = 0 WHERE seq = ?', [now.seq]);
    return;
  }
  if (sent.op === 'destroy' && error.type === 'notFound') {
    dropPending(db, sent.jmap, sent.id);
    return;
  }
  const kind = error.type === 'notFound' ? 'gone' : 'refused';
  recordConflict(ctx, sent, kind, server ?? null, error);
  dropPending(db, sent.jmap, sent.id);
  const restore = server ?? (sent.base ? JSON.parse(sent.base) as Card : null);
  if (restore && kind === 'refused') writeCard(db, sent.jmap, restore);
  else removeCard(db, sent.jmap, sent.id);
}

/** Takes rows up to about the size of one request. */
function nextBatch(db: StorageAdapter, jmap: string, afterSeq: number, limits: RequestLimits): PendingRow[] {
  const rows = db.all<PendingRow>('SELECT * FROM contact_pending WHERE jmap = ? AND seq > ? ORDER BY seq LIMIT ?', [jmap, afterSeq, Math.min(SET_BATCH, limits.maxObjectsInSet)]);
  const room = limits.maxSizeRequest / 2;
  let bytes = 0;
  const batch: PendingRow[] = [];
  for (const row of rows) {
    bytes += row.payload?.length ?? 0;
    if (batch.length > 0 && bytes > room) break;
    batch.push(row);
  }
  return batch;
}

/** One exchange with the server for these rows: read, decide, send, read back, settle. */
async function exchange(ctx: SyncContext, jmap: string, rows: readonly PendingRow[], limits: RequestLimits): Promise<void> {
  const { db } = ctx;
  const current = await readServerCards(ctx, jmap, rows.filter((row) => row.op !== 'create' && !row.id.startsWith(STAND_IN_PREFIX)).map((row) => row.id), limits);
  const serverByUid = await cardsByUid(ctx, jmap, rows.filter((row) => row.uid && row.attempted).map((row) => row.uid as string), limits);

  const out: Decision = { create: new Map(), update: new Map(), destroy: new Map() };
  db.transaction(() => {
    for (const { seq, id } of rows) {
      // The page may have edited it while the reads were on their way.
      const row = pendingFor(db, jmap, id);
      if (row && row.seq === seq) decide(ctx, row, current.get(id), serverByUid, out);
    }
    for (const row of [...out.create.values(), ...out.update.values()]) {
      db.run('UPDATE contact_pending SET attempted = 1, sent = payload WHERE seq = ?', [row.seq]);
    }
  });
  if (out.create.size + out.update.size + out.destroy.size === 0) return;

  const creationIds = new Map([...out.create.values()].map((row) => [`c${row.seq}`, row]));
  const response = await ctx.transport.request([['ContactCard/set', {
    accountId: jmap,
    ...(creationIds.size > 0 ? { create: Object.fromEntries([...creationIds].map(([cid, row]) => [cid, JSON.parse(row.payload as string)])) } : {}),
    ...(out.update.size > 0 ? { update: Object.fromEntries([...out.update.values()].map((row) => [row.id, JSON.parse(row.payload as string)])) } : {}),
    ...(out.destroy.size > 0 ? { destroy: [...out.destroy.keys()] } : {}),
  }, 's']], CONTACTS_USING);
  const [, result] = responseFor(response, 's');

  // What the server now holds. A network failure here is a lost response: the rows stay.
  const createdIds = new Map<string, string>();
  for (const cid of creationIds.keys()) {
    const created = result.created?.[cid] as { id?: unknown } | undefined;
    if (created?.id) createdIds.set(cid, String(created.id));
  }
  const updatedIds = [...out.update.keys()].filter((id) => result.updated && id in result.updated);
  const readBack = await readServerCards(ctx, jmap, [...createdIds.values(), ...updatedIds], limits);
  // A card already has this uid: maybe this one, sent before.
  const uidRefused = [...creationIds].filter(([cid]) => (result.notCreated?.[cid] as SetError | undefined)?.properties?.includes('uid'));
  const taken = await cardsByUid(ctx, jmap, uidRefused.map(([, row]) => row.uid as string), limits);

  db.transaction(() => {
    for (const [cid, row] of creationIds) {
      const realId = createdIds.get(cid);
      const refused = result.notCreated?.[cid] as SetError | undefined;
      if (realId) {
        const card = readBack.get(realId);
        if (card) {
          settleCreated(ctx, row, card);
        } else {
          // Created and deleted again already. The delta will say the same.
          dropPending(db, jmap, row.id);
          removeCard(db, jmap, row.id);
        }
      } else if (refused?.properties?.includes('uid')) {
        const card = taken.get(row.uid as string);
        if (card && holdsSent(row.payload as string, card)) settleCreated(ctx, row, card);
        else settleRefused(ctx, row, refused, undefined);
      } else if (refused) {
        settleRefused(ctx, row, refused, undefined);
      }
    }
    for (const [id, row] of out.update) {
      const refused = result.notUpdated?.[id] as SetError | undefined;
      if (refused) settleRefused(ctx, row, refused, current.get(id));
      else if (updatedIds.includes(id)) settleUpdated(ctx, row, readBack.get(id));
    }
    for (const [id, row] of out.destroy) {
      const refused = result.notDestroyed?.[id] as SetError | undefined;
      if (refused) settleRefused(ctx, row, refused, current.get(id));
      else if ((result.destroyed as string[] | undefined)?.includes(id)) dropPending(db, jmap, id);
    }
  });
}

/** The server said no to the request itself, for a reason that won't go away by itself. */
function requestRefusal(error: unknown): SetError | null {
  if (error instanceof JmapMethodError) return TRANSIENT_ERRORS.has(error.type) ? null : { type: error.type, description: error.message };
  if (error instanceof TransportError && error.kind === 'http' && error.status !== undefined && error.status >= 400 && error.status < 500) {
    return { type: 'requestRefused', description: error.message };
  }
  return null;
}

/** One card may be what makes a request fail: the others go one by one, and that one becomes a conflict. */
async function sendRows(ctx: SyncContext, jmap: string, rows: readonly PendingRow[], limits: RequestLimits): Promise<void> {
  try {
    await exchange(ctx, jmap, rows, limits);
  } catch (error) {
    const refusal = requestRefusal(error);
    if (!refusal) throw error;
    if (rows.length > 1) {
      for (const row of rows) {
        if (ctx.stopped()) return;
        await sendRows(ctx, jmap, [row], limits);
      }
      return;
    }
    ctx.db.transaction(() => {
      const row = pendingFor(ctx.db, jmap, rows[0].id);
      if (row) settleRefused(ctx, row, refusal, undefined);
    });
  }
}

/** Sends what's queued for one JMAP account. Network failures reach the engine and the rows stay. */
export async function flushPending(ctx: SyncContext, jmap: string): Promise<void> {
  const limits = requestLimits(ctx.session);
  let afterSeq = 0;
  let settled = false;
  try {
    for (;;) {
      if (ctx.stopped()) break;
      const batch = nextBatch(ctx.db, jmap, afterSeq, limits);
      if (batch.length === 0) break;
      afterSeq = batch[batch.length - 1].seq;
      settled = true;
      await sendRows(ctx, jmap, batch, limits);
    }
  } finally {
    if (settled) ctx.emit({ type: 'changed', account: ctx.account, collections: ['ContactCard'] });
  }
}
