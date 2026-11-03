/**
 * Contact sync for one JMAP account: first what's queued goes out, then the
 * address books, then the cards. A full pass over the cards captures the
 * state first and pages, with its cursor in sync_state, so a reload continues
 * where it stopped. Cards the pass didn't see are gone from the server.
 */

import type { SyncContext, Syncer } from '../area';
import { runChangesLoop } from '../engine/changes';
import { deleteObject, putObject } from '../engine/core-schema';
import { responseFor, type MethodCall } from '../engine/transport';
import { flushPending, serverDestroyed, storeServerCard } from './pending';
import { ADDRESS_BOOK_PROPERTIES, CONTACTS_CAPABILITY, CONTACTS_USING, type Card } from './records';

const PAGE = 500;
const PAIRS_PER_REQUEST = 4;

// ---- Address books ----

async function fullBooks(ctx: SyncContext, jmap: string): Promise<void> {
  const response = await ctx.transport.request([['AddressBook/get', { accountId: jmap, properties: ADDRESS_BOOK_PROPERTIES }, 'b']], CONTACTS_USING);
  const [, result] = responseFor(response, 'b');
  ctx.db.transaction(() => {
    ctx.db.run("DELETE FROM object WHERE jmap = ? AND type = 'AddressBook'", [jmap]);
    for (const book of result.list as Array<{ id: string }>) putObject(ctx.db, jmap, 'AddressBook', book.id, book);
    ctx.setSyncState(jmap, 'AddressBook', { state: String(result.state), phase: null, cursor: null });
  });
  ctx.emit({ type: 'changed', account: ctx.account, collections: ['AddressBook'] });
}

async function syncBooks(ctx: SyncContext, jmap: string): Promise<void> {
  const { state, target } = ctx.syncState(jmap, 'AddressBook');
  if (!state) return fullBooks(ctx, jmap);
  const outcome = await runChangesLoop({
    transport: ctx.transport,
    type: 'AddressBook',
    jmap,
    using: CONTACTS_USING,
    since: state,
    target,
    stopped: ctx.stopped,
    apply: async (page) => {
      const ids = [...page.created, ...page.updated];
      const list: Array<{ id: string }> = [];
      for (let i = 0; i < ids.length; i += PAGE) {
        const response = await ctx.transport.request([['AddressBook/get', { accountId: jmap, ids: ids.slice(i, i + PAGE), properties: ADDRESS_BOOK_PROPERTIES }, 'b']], CONTACTS_USING);
        list.push(...responseFor(response, 'b')[1].list);
      }
      ctx.db.transaction(() => {
        for (const book of list) putObject(ctx.db, jmap, 'AddressBook', book.id, book);
        for (const id of page.destroyed) deleteObject(ctx.db, jmap, 'AddressBook', id);
        ctx.setSyncState(jmap, 'AddressBook', { state: page.newState });
      });
      if (ids.length + page.destroyed.length > 0) ctx.emit({ type: 'changed', account: ctx.account, collections: ['AddressBook'] });
    },
  });
  if (outcome.outcome === 'resync') await fullBooks(ctx, jmap);
}

// ---- Cards ----

interface ListCursor { position: number; gen: number; captured: string }

async function startFullList(ctx: SyncContext, jmap: string): Promise<ListCursor> {
  const response = await ctx.transport.request([['ContactCard/get', { accountId: jmap, ids: [] }, 's']], CONTACTS_USING);
  const captured = String(responseFor(response, 's')[1].state);
  const gen = Number(ctx.db.get<{ gen: number | null }>('SELECT MAX(gen) AS gen FROM contact_card WHERE jmap = ?', [jmap])?.gen ?? 0) + 1;
  const cursor: ListCursor = { position: 0, gen, captured };
  ctx.db.transaction(() => ctx.setSyncState(jmap, 'ContactCard', { state: null, phase: 'list', cursor: { ...cursor } }));
  return cursor;
}

/** Cards from before this pass that it didn't find, leaving alone creates still on this device. */
function sweep(ctx: SyncContext, jmap: string, gen: number): void {
  const stale = ctx.db.all<{ id: string }>(
    `SELECT c.id FROM contact_card c WHERE c.jmap = ? AND c.gen < ?
       AND NOT EXISTS (SELECT 1 FROM contact_pending p WHERE p.jmap = c.jmap AND p.id = c.id AND p.op = 'create')`,
    [jmap, gen],
  );
  for (const row of stale) serverDestroyed(ctx, jmap, String(row.id));
}

async function runFullList(ctx: SyncContext, jmap: string, start: ListCursor): Promise<boolean> {
  const cursor = { ...start };
  for (;;) {
    if (ctx.stopped()) return false;
    const calls: MethodCall[] = [];
    for (let i = 0; i < PAIRS_PER_REQUEST; i += 1) {
      calls.push(['ContactCard/query', { accountId: jmap, position: cursor.position + i * PAGE, limit: PAGE, calculateTotal: i === 0 }, `q${i}`]);
      calls.push(['ContactCard/get', { accountId: jmap, '#ids': { resultOf: `q${i}`, name: 'ContactCard/query', path: '/ids' } }, `g${i}`]);
    }
    const response = await ctx.transport.request(calls, CONTACTS_USING);
    let total: number | null = null;
    let got = 0;
    let short = false;
    const cards: Card[] = [];
    for (let i = 0; i < PAIRS_PER_REQUEST && !short; i += 1) {
      const [, query] = responseFor(response, `q${i}`);
      if (i === 0 && typeof query.total === 'number') total = query.total;
      cards.push(...responseFor(response, `g${i}`)[1].list as Card[]);
      got += (query.ids as string[]).length;
      short = (query.ids as string[]).length < PAGE;
    }
    cursor.position += got;
    const done = got === 0 || (total === null ? short : cursor.position >= total);
    ctx.db.transaction(() => {
      for (const card of cards) storeServerCard(ctx.db, jmap, card, cursor.gen);
      if (done) {
        sweep(ctx, jmap, cursor.gen);
        ctx.setSyncState(jmap, 'ContactCard', { state: cursor.captured, phase: null, cursor: null });
      } else {
        ctx.setSyncState(jmap, 'ContactCard', { cursor: { ...cursor } });
      }
    });
    ctx.emit({ type: 'progress', account: ctx.account, area: 'contacts', phase: 'list', done: cursor.position, total });
    if (done) {
      ctx.emit({ type: 'changed', account: ctx.account, collections: ['ContactCard'] });
      return true;
    }
  }
}

async function syncDelta(ctx: SyncContext, jmap: string, since: string, target: string | null): Promise<'done' | 'resync' | 'stopped'> {
  const outcome = await runChangesLoop({
    transport: ctx.transport,
    type: 'ContactCard',
    jmap,
    using: CONTACTS_USING,
    since,
    target,
    stopped: ctx.stopped,
    apply: async (page) => {
      const ids = [...page.created, ...page.updated];
      const fetched: Card[] = [];
      for (let i = 0; i < ids.length; i += PAGE) {
        const response = await ctx.transport.request([['ContactCard/get', { accountId: jmap, ids: ids.slice(i, i + PAGE) }, 'g']], CONTACTS_USING);
        fetched.push(...responseFor(response, 'g')[1].list as Card[]);
      }
      ctx.db.transaction(() => {
        const gen = Number(ctx.db.get<{ gen: number | null }>('SELECT MAX(gen) AS gen FROM contact_card WHERE jmap = ?', [jmap])?.gen ?? 0);
        for (const card of fetched) storeServerCard(ctx.db, jmap, card, gen);
        for (const id of page.destroyed) serverDestroyed(ctx, jmap, id);
        ctx.setSyncState(jmap, 'ContactCard', { state: page.newState });
      });
      if (ids.length + page.destroyed.length > 0) ctx.emit({ type: 'changed', account: ctx.account, collections: ['ContactCard'] });
    },
  });
  if (outcome.outcome === 'resync') return 'resync';
  return outcome.outcome === 'stopped' ? 'stopped' : 'done';
}

async function syncCards(ctx: SyncContext, jmap: string): Promise<void> {
  const row = ctx.syncState(jmap, 'ContactCard');
  let cursor = row.phase === 'list' ? row.cursor as unknown as ListCursor : null;
  if (!cursor && !row.state) cursor = await startFullList(ctx, jmap);
  if (!cursor && row.state) {
    const outcome = await syncDelta(ctx, jmap, row.state, row.target);
    if (outcome === 'stopped') return;
    if (outcome === 'resync') cursor = await startFullList(ctx, jmap);
  }
  if (cursor) {
    if (!(await runFullList(ctx, jmap, cursor))) return;
    // Catch what changed while paging.
    const after = ctx.syncState(jmap, 'ContactCard');
    if (after.state) await syncDelta(ctx, jmap, after.state, after.target);
  }
}

export const contactsSyncer: Syncer = {
  name: 'contacts',
  capability: CONTACTS_CAPABILITY,
  async run(ctx, jmap) {
    await flushPending(ctx, jmap);
    if (ctx.stopped()) return;
    await syncBooks(ctx, jmap);
    if (ctx.stopped()) return;
    await syncCards(ctx, jmap);
  },
};
