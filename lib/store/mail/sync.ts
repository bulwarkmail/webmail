/**
 * Mail sync for one JMAP account.
 *
 * A full sync captures the state first, then pages through the window, so a
 * change that lands during it is picked up by the delta afterwards. Its cursor
 * lives in sync_state, written in the same transaction as the page, so a
 * reload continues where it stopped. Bodies come after the list, newest first.
 */

import type { SyncContext, Syncer } from '../area';
import { deleteObject, putObject } from '../engine/core-schema';
import { runChangesLoop } from '../engine/changes';
import { responseFor, type MethodCall } from '../engine/transport';
import {
  deleteEmail,
  deleteEmailRow,
  EMAIL_BODY_PROPERTIES,
  EMAIL_LIST_PROPERTIES,
  MAIL_USING,
  storeBody,
  upsertEmail,
  type EmailObject,
} from './records';

const PAGE = 500;
const PAIRS_PER_REQUEST = 4;
const BODY_BATCH_IDS = 100;
const BODY_BATCH_BYTES = 8 * 1024 * 1024;
/** Bodies fetched before one commit. Every commit writes search index segments, so fewer is much cheaper. */
const BODY_REQUESTS_PER_COMMIT = 5;
const MAX_BODY_VALUE_BYTES = 1_000_000;
const DELTA_BATCH = 500;

function windowFilter(ctx: SyncContext): Record<string, unknown> | undefined {
  if (ctx.scope.days === null) return undefined;
  return { after: new Date(ctx.now() - ctx.scope.days * 86_400_000).toISOString() };
}

function inWindow(ctx: SyncContext, email: EmailObject): boolean {
  if (ctx.scope.days === null) return true;
  return (Date.parse(String(email.receivedAt)) || 0) >= ctx.now() - ctx.scope.days * 86_400_000;
}

// ---- Mailboxes ----

async function fullMailboxes(ctx: SyncContext, jmap: string): Promise<void> {
  const response = await ctx.transport.request([['Mailbox/get', { accountId: jmap, ids: null }, 'm']], MAIL_USING);
  const [, result] = responseFor(response, 'm');
  ctx.db.transaction(() => {
    ctx.db.run("DELETE FROM object WHERE jmap = ? AND type = 'Mailbox'", [jmap]);
    for (const box of result.list as Array<{ id: string }>) putObject(ctx.db, jmap, 'Mailbox', box.id, box);
    ctx.setSyncState(jmap, 'Mailbox', { state: String(result.state), phase: null, cursor: null });
  });
}

async function syncMailboxes(ctx: SyncContext, jmap: string): Promise<void> {
  const { state, target } = ctx.syncState(jmap, 'Mailbox');
  if (!state) return fullMailboxes(ctx, jmap);
  const outcome = await runChangesLoop({
    transport: ctx.transport,
    type: 'Mailbox',
    jmap,
    using: MAIL_USING,
    since: state,
    target,
    stopped: ctx.stopped,
    apply: async (page) => {
      const ids = [...page.created, ...page.updated];
      const list: Array<{ id: string }> = [];
      for (let i = 0; i < ids.length; i += PAGE) {
        const response = await ctx.transport.request([['Mailbox/get', { accountId: jmap, ids: ids.slice(i, i + PAGE) }, 'm']], MAIL_USING);
        list.push(...responseFor(response, 'm')[1].list);
      }
      ctx.db.transaction(() => {
        for (const box of list) putObject(ctx.db, jmap, 'Mailbox', box.id, box);
        for (const id of page.destroyed) deleteObject(ctx.db, jmap, 'Mailbox', id);
        ctx.setSyncState(jmap, 'Mailbox', { state: page.newState });
      });
    },
  });
  if (outcome.outcome === 'resync') await fullMailboxes(ctx, jmap);
}

// ---- Email list ----

interface ListCursor { position: number; gen: number; captured: string }

/** The generation of the last full listing. One row is enough: every row of a pass has it or an older one. */
function currentGen(ctx: SyncContext, jmap: string): number {
  return Number(ctx.db.get<{ gen: number }>('SELECT gen FROM email WHERE jmap = ? ORDER BY gen DESC LIMIT 1', [jmap])?.gen ?? 0);
}

async function startFullList(ctx: SyncContext, jmap: string): Promise<ListCursor> {
  const response = await ctx.transport.request([['Email/get', { accountId: jmap, ids: [], properties: ['id'] }, 's']], MAIL_USING);
  const captured = String(responseFor(response, 's')[1].state);
  const cursor: ListCursor = { position: 0, gen: currentGen(ctx, jmap) + 1, captured };
  ctx.db.transaction(() => ctx.setSyncState(jmap, 'Email', { state: null, phase: 'list', cursor: { ...cursor } }));
  return cursor;
}

async function runFullList(ctx: SyncContext, jmap: string, start: ListCursor): Promise<boolean> {
  const cursor = { ...start };
  const filter = windowFilter(ctx);
  let total: number | null = null;
  for (;;) {
    if (ctx.stopped()) return false;
    const calls: MethodCall[] = [];
    for (let i = 0; i < PAIRS_PER_REQUEST; i += 1) {
      calls.push(['Email/query', {
        accountId: jmap,
        ...(filter ? { filter } : {}),
        sort: [{ property: 'receivedAt', isAscending: false }],
        position: cursor.position + i * PAGE,
        limit: PAGE,
        calculateTotal: i === 0,
      }, `q${i}`]);
      calls.push(['Email/get', {
        accountId: jmap,
        '#ids': { resultOf: `q${i}`, name: 'Email/query', path: '/ids' },
        properties: EMAIL_LIST_PROPERTIES,
      }, `g${i}`]);
    }
    const response = await ctx.transport.request(calls, MAIL_USING);
    let done = false;
    let got = 0;
    const lists: EmailObject[][] = [];
    for (let i = 0; i < PAIRS_PER_REQUEST; i += 1) {
      const [, query] = responseFor(response, `q${i}`);
      if (i === 0 && typeof query.total === 'number') total = query.total;
      lists.push(responseFor(response, `g${i}`)[1].list as EmailObject[]);
      got += (query.ids as string[]).length;
      if ((query.ids as string[]).length < PAGE) {
        done = true;
        break;
      }
    }
    cursor.position += got;
    ctx.db.transaction(() => {
      for (const list of lists) for (const email of list) upsertEmail(ctx.db, jmap, email, cursor.gen);
      if (done) {
        // Whatever this pass didn't see is gone from the server or the window.
        const stale = ctx.db.all<{ rowid: number }>('SELECT rowid FROM email WHERE jmap = ? AND gen < ?', [jmap, cursor.gen]);
        for (const row of stale) deleteEmailRow(ctx.db, Number(row.rowid));
        ctx.setSyncState(jmap, 'Email', { state: cursor.captured, phase: null, cursor: null });
      } else {
        ctx.setSyncState(jmap, 'Email', { cursor: { ...cursor } });
      }
    });
    ctx.emit({ type: 'progress', account: ctx.account, area: 'mail', phase: 'list', done: cursor.position, total });
    if (done) {
      ctx.emit({ type: 'changed', account: ctx.account, collections: ['Email'] });
      return true;
    }
  }
}

async function syncEmailDelta(ctx: SyncContext, jmap: string, since: string, target: string | null): Promise<'done' | 'resync' | 'stopped'> {
  const outcome = await runChangesLoop({
    transport: ctx.transport,
    type: 'Email',
    jmap,
    using: MAIL_USING,
    since,
    target,
    stopped: ctx.stopped,
    apply: async (page) => {
      const ids = [...page.created, ...page.updated];
      const fetched: EmailObject[] = [];
      for (let i = 0; i < ids.length; i += DELTA_BATCH) {
        const response = await ctx.transport.request([['Email/get', {
          accountId: jmap,
          ids: ids.slice(i, i + DELTA_BATCH),
          properties: EMAIL_LIST_PROPERTIES,
        }, 'g']], MAIL_USING);
        fetched.push(...responseFor(response, 'g')[1].list as EmailObject[]);
      }
      const created = new Set(page.created);
      const newIds: string[] = [];
      ctx.db.transaction(() => {
        const gen = fetched.length > 0 ? currentGen(ctx, jmap) : 0;
        for (const email of fetched) {
          const known = ctx.db.get('SELECT 1 AS x FROM email WHERE jmap = ? AND id = ?', [jmap, email.id]);
          // An old message changing doesn't pull it into the window.
          if (!known && !inWindow(ctx, email)) continue;
          upsertEmail(ctx.db, jmap, email, gen);
          if (!known && created.has(email.id)) newIds.push(email.id);
        }
        for (const id of page.destroyed) deleteEmail(ctx.db, jmap, id);
        ctx.setSyncState(jmap, 'Email', { state: page.newState });
      });
      if (newIds.length > 0) ctx.emit({ type: 'created', account: ctx.account, jmap, collection: 'Email', ids: newIds });
      if (ids.length + page.destroyed.length > 0) ctx.emit({ type: 'changed', account: ctx.account, collections: ['Email'] });
    },
  });
  if (outcome.outcome === 'resync') return 'resync';
  return outcome.outcome === 'stopped' ? 'stopped' : 'done';
}

// ---- Threads ----

async function fetchThreads(ctx: SyncContext, jmap: string, ids: string[]): Promise<Array<{ id: string; emailIds: string[] }>> {
  const out: Array<{ id: string; emailIds: string[] }> = [];
  for (let i = 0; i < ids.length; i += PAGE) {
    const response = await ctx.transport.request([['Thread/get', { accountId: jmap, ids: ids.slice(i, i + PAGE) }, 't']], MAIL_USING);
    out.push(...responseFor(response, 't')[1].list);
  }
  return out;
}

async function syncThreads(ctx: SyncContext, jmap: string): Promise<void> {
  const { state, target } = ctx.syncState(jmap, 'Thread');
  const fullThreads = async () => {
    const response = await ctx.transport.request([['Thread/get', { accountId: jmap, ids: [] }, 's']], MAIL_USING);
    const captured = String(responseFor(response, 's')[1].state);
    const known = ctx.db.all<{ id: string }>(
      `SELECT DISTINCT e.thread_id AS id FROM email e WHERE e.jmap = ? AND e.thread_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM thread t WHERE t.jmap = e.jmap AND t.id = e.thread_id)`,
      [jmap],
    ).map((row) => String(row.id));
    for (let i = 0; i < known.length; i += PAGE) {
      if (ctx.stopped()) return;
      const list = await fetchThreads(ctx, jmap, known.slice(i, i + PAGE));
      ctx.db.transaction(() => {
        for (const thread of list) ctx.db.run('INSERT OR REPLACE INTO thread (jmap, id, email_ids) VALUES (?, ?, ?)', [jmap, thread.id, JSON.stringify(thread.emailIds)]);
      });
      ctx.emit({ type: 'progress', account: ctx.account, area: 'mail', phase: 'threads', done: i + list.length, total: known.length });
    }
    ctx.db.transaction(() => ctx.setSyncState(jmap, 'Thread', { state: captured }));
  };
  if (!state) return fullThreads();
  const outcome = await runChangesLoop({
    transport: ctx.transport,
    type: 'Thread',
    jmap,
    using: MAIL_USING,
    since: state,
    target,
    stopped: ctx.stopped,
    apply: async (page) => {
      const list = await fetchThreads(ctx, jmap, [...page.created, ...page.updated]);
      ctx.db.transaction(() => {
        for (const thread of list) ctx.db.run('INSERT OR REPLACE INTO thread (jmap, id, email_ids) VALUES (?, ?, ?)', [jmap, thread.id, JSON.stringify(thread.emailIds)]);
        for (const id of page.destroyed) ctx.db.run('DELETE FROM thread WHERE jmap = ? AND id = ?', [jmap, id]);
        ctx.setSyncState(jmap, 'Thread', { state: page.newState });
      });
    },
  });
  if (outcome.outcome === 'resync') {
    ctx.db.transaction(() => {
      ctx.db.run('DELETE FROM thread WHERE jmap = ?', [jmap]);
      ctx.setSyncState(jmap, 'Thread', { state: null });
    });
    await fullThreads();
  }
}

// ---- Bodies ----

async function backfillBodies(ctx: SyncContext, jmap: string): Promise<void> {
  let done = 0;
  const totalRow = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM email WHERE jmap = ? AND body_state = 0', [jmap]);
  const total = Number(totalRow?.n ?? 0);
  if (total === 0) return;
  for (;;) {
    if (ctx.stopped()) return;
    const candidates = ctx.db.all<{ rowid: number; id: string; size: number; json: string }>(
      'SELECT rowid, id, size, json FROM email WHERE jmap = ? AND body_state = 0 ORDER BY received_at DESC LIMIT ?',
      [jmap, BODY_BATCH_IDS * BODY_REQUESTS_PER_COMMIT],
    );
    if (candidates.length === 0) return;
    const fetched = new Map<string, EmailObject>();
    const asked: typeof candidates = [];
    let next = 0;
    for (let request = 0; request < BODY_REQUESTS_PER_COMMIT && next < candidates.length; request += 1) {
      let bytes = 0;
      const batch: typeof candidates = [];
      while (next < candidates.length && batch.length < BODY_BATCH_IDS) {
        const row = candidates[next];
        if (batch.length > 0 && bytes + Number(row.size) > BODY_BATCH_BYTES) break;
        bytes += Number(row.size);
        batch.push(row);
        next += 1;
      }
      const response = await ctx.transport.request([['Email/get', {
        accountId: jmap,
        ids: batch.map((row) => String(row.id)),
        properties: ['id', ...EMAIL_BODY_PROPERTIES],
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
        fetchAllBodyValues: true,
        maxBodyValueBytes: MAX_BODY_VALUE_BYTES,
      }, 'b']], MAIL_USING);
      for (const email of responseFor(response, 'b')[1].list as EmailObject[]) fetched.set(email.id, email);
      asked.push(...batch);
      if (ctx.stopped()) break;
    }
    ctx.db.transaction(() => {
      for (const row of asked) {
        const full = fetched.get(String(row.id));
        if (full) storeBody(ctx.db, Number(row.rowid), String(row.json), full);
        else ctx.db.run('UPDATE email SET body_state = 2 WHERE rowid = ?', [row.rowid]);
      }
    });
    done += asked.length;
    ctx.emit({ type: 'progress', account: ctx.account, area: 'mail', phase: 'bodies', done, total });
  }
}

// ---- The whole pass ----

export const mailSyncer: Syncer = {
  name: 'mail',
  capability: 'urn:ietf:params:jmap:mail',
  async run(ctx, jmap) {
    await syncMailboxes(ctx, jmap);
    if (ctx.stopped()) return;

    const email = ctx.syncState(jmap, 'Email');
    let cursor = email.phase === 'list' ? email.cursor as unknown as ListCursor : null;
    if (!cursor && !email.state) cursor = await startFullList(ctx, jmap);
    if (!cursor && email.state) {
      const outcome = await syncEmailDelta(ctx, jmap, email.state, email.target);
      if (outcome === 'stopped') return;
      if (outcome === 'resync') cursor = await startFullList(ctx, jmap);
    }
    if (cursor) {
      const finished = await runFullList(ctx, jmap, cursor);
      if (!finished) return;
      // Catch what changed while paging.
      const after = ctx.syncState(jmap, 'Email');
      if (after.state && (await syncEmailDelta(ctx, jmap, after.state, after.target)) === 'stopped') return;
    }
    if (ctx.stopped()) return;
    await syncThreads(ctx, jmap);
    if (ctx.stopped()) return;
    await backfillBodies(ctx, jmap);
  },
};
