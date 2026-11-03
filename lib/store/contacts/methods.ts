/** Contact reads and queued edits, answered from the store. */

import { MethodError, type MethodContext, type MethodHandler, type MethodResult } from '../area';
import { listObjects } from '../engine/core-schema';
import type { SqlValue } from '../storage';
import { queueCreate, queueDestroy, queueUpdate, resolveCardId, type SetError } from './pending';
import { CONTACTS_CAPABILITY, foldText } from './records';
import type { JsonObject, Patch } from './patch';

type Filter = Record<string, unknown>;

interface Sql { sql: string; params: SqlValue[] }

function jmapOf(ctx: MethodContext, args: Record<string, unknown>): string {
  return (args.accountId as string | undefined) ?? ctx.session.primaryAccounts[CONTACTS_CAPABILITY] ?? ctx.defaultJmap;
}

/**
 * The last state from the server. Throws until a first full pass finished, so
 * an answer never passes off part of a list as the whole. A later resync
 * (phase `list`) goes on answering from the copy it's refreshing.
 */
function syncedState(ctx: MethodContext, jmap: string, type: string): string | null {
  const row = ctx.db.get<{ state: string | null; phase: string | null }>('SELECT state, phase FROM sync_state WHERE jmap = ? AND type = ?', [jmap, type]);
  if (!row || (!row.state && row.phase !== 'list')) throw new MethodError('serverUnavailable', 'Contacts not kept yet');
  return row.state;
}

function pick(object: Record<string, unknown>, properties: unknown): Record<string, unknown> {
  if (!Array.isArray(properties)) return object;
  const out: Record<string, unknown> = { id: object.id };
  for (const property of properties as string[]) if (property in object) out[property] = object[property];
  return out;
}

function quote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

function terms(text: string): string[] {
  return foldText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * A `text` condition, one part of the client's textFilter (search-utils.ts):
 * words, `word*` or a "quoted phrase". Every word has to match somewhere. The
 * trigram index finds it anywhere in a name, which takes three characters.
 * Shorter ones match the start of a word.
 */
function textCondition(value: string, rank: string[]): Sql {
  const phrase = /^"(.+)"$/.exec(value.trim());
  const words = terms(phrase ? phrase[1] : value);
  if (words.length === 0) return { sql: '0', params: [] };
  if (phrase) {
    rank.push(quote(words.join(' ')));
    return { sql: 'c.rowid IN (SELECT rowid FROM contact_fts_word WHERE contact_fts_word MATCH ?)', params: [quote(words.join(' '))] };
  }
  const parts: string[] = [];
  const params: SqlValue[] = [];
  for (const word of words) {
    rank.push(`${quote(word)}*`);
    if ([...word].length >= 3) {
      parts.push('c.rowid IN (SELECT rowid FROM contact_fts_tri WHERE contact_fts_tri MATCH ?)');
      params.push(quote(word));
    } else {
      parts.push('c.rowid IN (SELECT rowid FROM contact_fts_word WHERE contact_fts_word MATCH ?)');
      params.push(`${quote(word)}*`);
    }
  }
  return { sql: parts.join(' AND '), params };
}

function filterSql(filter: Filter, rank: string[]): Sql {
  if (typeof filter.operator === 'string') {
    const parts = (Array.isArray(filter.conditions) ? filter.conditions as Filter[] : []).map((c) => filterSql(c, rank));
    const params = parts.flatMap((p) => p.params);
    const joined = (joiner: string) => parts.map((p) => `(${p.sql})`).join(joiner);
    if (filter.operator === 'AND') return { sql: parts.length ? joined(' AND ') : '1', params };
    if (filter.operator === 'OR') return { sql: parts.length ? joined(' OR ') : '0', params };
    if (filter.operator === 'NOT') return { sql: parts.length ? `NOT (${joined(' OR ')})` : '1', params };
    throw new MethodError('unsupportedFilter', `Unknown operator ${String(filter.operator)}`);
  }
  const conditions: string[] = [];
  const params: SqlValue[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === 'text') {
      const text = textCondition(String(value), rank);
      conditions.push(text.sql);
      params.push(...text.params);
    } else if (key === 'inAddressBook') {
      conditions.push('EXISTS (SELECT 1 FROM contact_card_book b WHERE b.card_rowid = c.rowid AND b.book_id = ?)');
      params.push(String(value));
    } else {
      throw new MethodError('unsupportedFilter', `${key} isn't available offline`);
    }
  }
  return { sql: conditions.length ? conditions.join(' AND ') : '1', params };
}

const addressBookGet: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  const state = syncedState(ctx, jmap, 'AddressBook');
  const books = listObjects<Record<string, unknown>>(ctx.db, jmap, 'AddressBook');
  const ids = Array.isArray(args.ids) ? args.ids as string[] : null;
  const chosen = ids ? books.filter((book) => ids.includes(book.id as string)) : books;
  return {
    accountId: jmap,
    ...(state ? { state } : {}),
    list: chosen.map((book) => pick(book, args.properties)),
    notFound: ids ? ids.filter((id) => !books.some((book) => book.id === id)) : [],
  };
};

const contactQuery: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  syncedState(ctx, jmap, 'ContactCard');
  if (args.anchor !== undefined) throw new MethodError('unsupportedFilter', 'anchor needs the server');
  if (Array.isArray(args.sort) && args.sort.length > 0) throw new MethodError('unsupportedSort', 'Sorted lists need the server');
  const rank: string[] = [];
  const where = args.filter ? filterSql(args.filter as Filter, rank) : { sql: '1', params: [] };
  const position = Math.max(0, Number(args.position ?? 0));
  // limit 0 means no limit on Stalwart, and the client can't tell a local answer apart.
  const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : -1;
  // Names starting with what was typed come before ones merely containing it.
  const first = rank.length > 0 ? 'c.rowid IN (SELECT rowid FROM contact_fts_word WHERE contact_fts_word MATCH ?) DESC, ' : '';
  const ids = ctx.db.all<{ id: string }>(
    `SELECT c.id FROM contact_card c WHERE c.jmap = ? AND (${where.sql}) ORDER BY ${first}c.sort_key, c.id LIMIT ? OFFSET ?`,
    [jmap, ...where.params, ...(rank.length > 0 ? [rank.join(' AND ')] : []), limit, position],
  ).map((row) => String(row.id));
  const result: MethodResult = {
    accountId: jmap,
    // Local answers aren't a position in the server's log, so this is a token only.
    queryState: 'local',
    canCalculateChanges: false,
    position,
    ids,
  };
  if (args.calculateTotal) {
    result.total = Number(ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM contact_card c WHERE c.jmap = ? AND (${where.sql})`,
      [jmap, ...where.params],
    )?.n ?? 0);
  }
  return result;
};

const contactGet: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  const state = syncedState(ctx, jmap, 'ContactCard');
  const list: Array<Record<string, unknown>> = [];
  const notFound: string[] = [];
  const rows = Array.isArray(args.ids)
    ? (args.ids as string[]).map((id) => ({ id, row: ctx.db.get<{ json: string }>('SELECT json FROM contact_card WHERE jmap = ? AND id = ?', [jmap, resolveCardId(ctx.db, jmap, id)]) }))
    : ctx.db.all<{ json: string; id: string }>('SELECT json, id FROM contact_card WHERE jmap = ? ORDER BY sort_key, id', [jmap]).map((row) => ({ id: row.id, row }));
  for (const { id, row } of rows) {
    if (row) list.push(pick(JSON.parse(row.json) as Record<string, unknown>, args.properties));
    else notFound.push(id);
  }
  return { accountId: jmap, ...(state ? { state } : {}), list, notFound };
};

/**
 * Queues the edits. The answer leaves out oldState and newState: nothing
 * reached the server, so there's no real state to name, and the client reads
 * neither from ContactCard/set.
 */
const contactSet: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  syncedState(ctx, jmap, 'ContactCard');
  const created: Record<string, { id: string; uid: string }> = {};
  const notCreated: Record<string, SetError> = {};
  const updated: Record<string, null> = {};
  const notUpdated: Record<string, SetError> = {};
  const destroyed: string[] = [];
  const notDestroyed: Record<string, SetError> = {};
  ctx.db.transaction(() => {
    for (const [cid, card] of Object.entries((args.create ?? {}) as Record<string, JsonObject>)) {
      const outcome = queueCreate(ctx, jmap, card);
      if ('id' in outcome) created[cid] = outcome;
      else notCreated[cid] = outcome;
    }
    for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Patch>)) {
      const refused = queueUpdate(ctx, jmap, id, patch);
      if (refused) notUpdated[id] = refused;
      else updated[id] = null;
    }
    for (const id of (args.destroy ?? []) as string[]) {
      const refused = queueDestroy(ctx, jmap, id);
      if (refused) notDestroyed[id] = refused;
      else destroyed.push(id);
    }
  });
  if (Object.keys(created).length + Object.keys(updated).length + destroyed.length > 0) {
    ctx.emit({ type: 'changed', account: ctx.account, collections: ['ContactCard'] });
  }
  const some = (name: string, value: object) => (Object.keys(value).length > 0 ? { [name]: value } : {});
  return {
    accountId: jmap,
    ...some('created', created),
    ...some('notCreated', notCreated),
    ...some('updated', updated),
    ...some('notUpdated', notUpdated),
    ...some('destroyed', destroyed),
    ...some('notDestroyed', notDestroyed),
  };
};

export const CONTACT_METHODS: Readonly<Record<string, MethodHandler>> = {
  'AddressBook/get': addressBookGet,
  'ContactCard/query': contactQuery,
  'ContactCard/get': contactGet,
  'ContactCard/set': contactSet,
};
