/**
 * Mail reads answered from the store. What an answer must look like is in
 * local-data/desktop-offline-facts-parts/offline-jmap.md sections 1 and 4: it
 * follows what the calling method in lib/jmap/client.ts reads.
 */

import { MethodError, type MethodContext, type MethodHandler, type MethodResult } from '../area';
import { listObjects } from '../engine/core-schema';
import type { SqlValue } from '../storage';
import { headerValue, parseHeaderProperty, type RawHeader } from './headers';
import { keywordKey } from './records';
import { limitTextConditions, searchSnippetGet, tempTermSets, textCondition, TEXT_FIELDS, type TermSets, type TextField } from './search';

type Filter = Record<string, unknown>;

interface Sql { sql: string; params: SqlValue[] }

function jmapOf(ctx: MethodContext, args: Record<string, unknown>): string {
  return (args.accountId as string | undefined) ?? ctx.defaultJmap;
}

function lastState(ctx: MethodContext, jmap: string, type: string): string | null {
  return ctx.db.get<{ state: string | null }>('SELECT state FROM sync_state WHERE jmap = ? AND type = ?', [jmap, type])?.state ?? null;
}

function likeTerm(value: unknown): string {
  return `%${String(value).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * `drivenBy` is the folder the query already starts from: repeating that
 * condition would look the membership up again for every row. With a folder row
 * (`d`) at hand, conditions read it instead of the message's own row, which
 * saves reading the message at all when nothing else needs it.
 */
function filterSql(filter: Filter, jmap: string, drivenBy: string | null = null, folderRow = drivenBy !== null, sets?: TermSets): Sql {
  const rowid = folderRow ? 'd.email_rowid' : 'e.rowid';
  const receivedAt = folderRow ? 'd.received_at' : 'e.received_at';
  if (typeof filter.operator === 'string') {
    const conditions = Array.isArray(filter.conditions) ? filter.conditions as Filter[] : [];
    const parts = conditions.map((c) => filterSql(c, jmap, filter.operator === 'AND' ? drivenBy : null, folderRow, sets));
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
    switch (key) {
      case 'inMailbox':
        if (value === drivenBy) break;
        conditions.push(`EXISTS (SELECT 1 FROM email_mailbox m WHERE m.email_rowid = ${rowid} AND m.mailbox_id = ?)`);
        params.push(String(value));
        break;
      case 'inMailboxOtherThan': {
        const ids = (value as string[]).map(String);
        conditions.push(`EXISTS (SELECT 1 FROM email_mailbox m WHERE m.email_rowid = ${rowid} AND m.mailbox_id NOT IN (${ids.map(() => '?').join(',') || "''"}))`);
        params.push(...ids);
        break;
      }
      case 'hasKeyword':
        conditions.push(`EXISTS (SELECT 1 FROM email_keyword k WHERE k.email_rowid = ${rowid} AND k.keyword = ?)`);
        params.push(keywordKey(String(value)));
        break;
      case 'notKeyword':
        conditions.push(`NOT EXISTS (SELECT 1 FROM email_keyword k WHERE k.email_rowid = ${rowid} AND k.keyword = ?)`);
        params.push(keywordKey(String(value)));
        break;
      case 'after':
        conditions.push(`${receivedAt} >= ?`);
        params.push(Date.parse(String(value)) || 0);
        break;
      case 'before':
        conditions.push(`${receivedAt} < ?`);
        params.push(Date.parse(String(value)) || 0);
        break;
      case 'minSize':
        conditions.push('e.size >= ?');
        params.push(Number(value));
        break;
      case 'maxSize':
        conditions.push('e.size < ?');
        params.push(Number(value));
        break;
      case 'hasAttachment':
        conditions.push(value ? 'e.has_attachment = 1' : 'e.has_attachment = 0');
        break;
      case 'id':
        conditions.push(`e.id IN (${(value as string[]).map(() => '?').join(',') || "''"})`);
        params.push(...(value as string[]).map(String));
        break;
      case 'header': {
        // Stalwart finds nothing for this on either version, plugins may still
        // ask. Answered from the raw headers of the messages kept with a body.
        const [name, wanted] = value as [string, string | undefined];
        conditions.push(`EXISTS (SELECT 1 FROM email_body b, json_each(b.json, '$.headers') h
          WHERE b.email_rowid = e.rowid AND lower(json_extract(h.value, '$.name')) = ?${wanted === undefined ? '' : " AND json_extract(h.value, '$.value') LIKE ? ESCAPE '\\'"})`);
        params.push(String(name).toLowerCase());
        if (wanted !== undefined) params.push(likeTerm(wanted));
        break;
      }
      default:
        if ((TEXT_FIELDS as readonly string[]).includes(key)) {
          const text = textCondition(key as TextField, String(value), rowid, sets);
          conditions.push(text.sql);
          params.push(...text.params);
          break;
        }
        // The thread keyword filters: nothing in the app sends them.
        throw new MethodError('unsupportedFilter', `${key} isn't available offline`);
    }
  }
  return { sql: conditions.length ? conditions.join(' AND ') : '1', params };
}

interface Comparator { property?: string; isAscending?: boolean; keyword?: string }

/**
 * Newest first reads straight off an index. Any other order has to look at
 * every row of the folder, which in a large mailbox takes seconds.
 */
function isNewestFirst(sort: Comparator[]): boolean {
  if (sort.length === 0) return true;
  return sort.length === 1 && sort[0].property === 'receivedAt' && sort[0].isAscending === false;
}

function orderSql(ctx: MethodContext, sort: Comparator[]): Sql {
  const levels = sort.length > 0 ? sort : [{ property: 'receivedAt', isAscending: false }];
  const parts: string[] = [];
  const params: SqlValue[] = [];
  for (const level of levels) {
    // RFC 8621 says isAscending defaults to true.
    let ascending = level.isAscending !== false;
    switch (level.property) {
      case 'receivedAt': parts.push(`e.received_at ${ascending ? 'ASC' : 'DESC'}`); break;
      case 'sentAt': parts.push(`COALESCE(e.sent_at, e.received_at) ${ascending ? 'ASC' : 'DESC'}`); break;
      case 'size': parts.push(`e.size ${ascending ? 'ASC' : 'DESC'}`); break;
      case 'subject': parts.push(`e.subject_sort COLLATE NOCASE ${ascending ? 'ASC' : 'DESC'}`); break;
      case 'from': parts.push(`e.from_sort COLLATE NOCASE ${ascending ? 'ASC' : 'DESC'}`); break;
      case 'to': parts.push(`e.to_sort COLLATE NOCASE ${ascending ? 'ASC' : 'DESC'}`); break;
      case 'hasKeyword': {
        // The client flips this on servers that read it the other way, so a
        // stored answer has to read it the way that server would.
        if (ctx.invertedKeywordSort) ascending = !ascending;
        parts.push(`EXISTS (SELECT 1 FROM email_keyword s WHERE s.email_rowid = e.rowid AND s.keyword = ?) ${ascending ? 'ASC' : 'DESC'}`);
        params.push(keywordKey(String(level.keyword ?? '')));
        break;
      }
      default:
        throw new MethodError('unsupportedSort', `${String(level.property)} isn't available offline`);
    }
  }
  parts.push('e.rowid DESC');
  return { sql: parts.join(', '), params };
}

/** The one folder a filter limits itself to, so the query can start from that folder's index. */
function drivingMailbox(filter: Filter | undefined): string | null {
  if (!filter) return null;
  if (typeof filter.inMailbox === 'string') return filter.inMailbox;
  if (filter.operator === 'AND' && Array.isArray(filter.conditions)) {
    for (const condition of filter.conditions as Filter[]) {
      const found = drivingMailbox(condition);
      if (found) return found;
    }
  }
  return null;
}

/** One step of a "pinned first" or "unread first" order. */
interface KeywordLevel { keyword: string; first: boolean }

/** A keyword this rare is read off its own index, then sorted. Commoner ones are checked along the folder. */
const RARE_KEYWORD_ROWS = 5000;
const MAX_KEYWORD_LEVELS = 4;

/**
 * The keyword comparators of an order that goes on newest first, which is what
 * the pinned and unread-first lists send. Null for any other order.
 */
function keywordLevels(ctx: MethodContext, sort: Comparator[]): KeywordLevel[] | null {
  const levels: KeywordLevel[] = [];
  let next = 0;
  for (; sort[next]?.property === 'hasKeyword'; next += 1) {
    const ascending = sort[next].isAscending !== false;
    levels.push({ keyword: keywordKey(String(sort[next].keyword ?? '')), first: ctx.invertedKeywordSort ? ascending : !ascending });
  }
  if (levels.length === 0 || levels.length > MAX_KEYWORD_LEVELS) return null;
  return isNewestFirst(sort.slice(next)) ? levels : null;
}

/**
 * A page of an order by keywords and then date, without sorting the folder: the
 * order splits into groups (pinned, then the rest), and each group is read in
 * date order off the folder's index until the page is full.
 */
function keywordOrderedPage(
  ctx: MethodContext,
  jmap: string,
  box: string | null,
  where: Sql,
  levels: readonly KeywordLevel[],
  position: number,
  limit: number,
): string[] {
  const rowid = box ? 'd.email_rowid' : 'e.rowid';
  const rows = new Map<string, number>();
  const rowsOf = (keyword: string): number => {
    let n = rows.get(keyword);
    if (n === undefined) {
      n = Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM email_keyword INDEXED BY email_keyword_lookup WHERE keyword = ?', [keyword])?.n ?? 0);
      rows.set(keyword, n);
    }
    return n;
  };

  const groupQuery = (group: ReadonlyArray<{ keyword: string; has: boolean }>) => {
    const rare = group
      .filter((level) => level.has && rowsOf(level.keyword) <= RARE_KEYWORD_ROWS)
      .sort((a, b) => rowsOf(a.keyword) - rowsOf(b.keyword))[0];
    const checked = group.filter((level) => level !== rare);
    const sql = [
      `${box ? 'd.jmap = ?' : 'e.jmap = ?'}${box && !rare ? ' AND d.mailbox_id = ?' : ''}`,
      ...checked.map((level) => `${level.has ? '' : 'NOT '}EXISTS (SELECT 1 FROM email_keyword c WHERE c.email_rowid = ${rowid} AND c.keyword = ?)`),
      `(${where.sql})`,
    ].join(' AND ');
    let head: string;
    const params: SqlValue[] = [];
    if (rare) {
      head = box
        ? 'email_keyword r INDEXED BY email_keyword_lookup CROSS JOIN email_mailbox d ON d.email_rowid = r.email_rowid AND d.mailbox_id = ?'
        : 'email_keyword r INDEXED BY email_keyword_lookup';
      if (box) params.push(box);
    } else {
      head = box ? 'email_mailbox d INDEXED BY email_mailbox_list' : '';
    }
    const emailJoin = !box
      ? (rare ? ' CROSS JOIN email e ON e.rowid = r.email_rowid' : 'email e')
      : ' CROSS JOIN email e ON e.rowid = d.email_rowid';
    const after: SqlValue[] = [jmap, ...(box && !rare ? [box] : []), ...checked.map((level) => level.keyword), ...where.params];
    const rareCondition = rare ? 'r.keyword = ? AND ' : '';
    const allParams = [...params, ...(rare ? [rare.keyword] : []), ...after];
    return {
      // The message's own row is read only for what goes out, or if a condition needs it.
      countFrom: box && !/\be\./.test(where.sql) ? head : `${head}${emailJoin}`,
      from: `${head}${emailJoin}`,
      where: `${rareCondition}${sql}`,
      params: allParams,
      order: box ? 'd.received_at DESC, d.email_rowid DESC' : 'e.received_at DESC, e.rowid DESC',
    };
  };

  const groups = levels.reduce<Array<Array<{ keyword: string; has: boolean }>>>(
    (all, level) => all.flatMap((group) => [
      [...group, { keyword: level.keyword, has: level.first }],
      [...group, { keyword: level.keyword, has: !level.first }],
    ]),
    [[]],
  );

  const ids: string[] = [];
  let skip = position;
  let need = limit;
  for (const group of groups) {
    if (need === 0) break;
    const query = groupQuery(group);
    if (skip > 0) {
      const inGroup = Number(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${query.countFrom} WHERE ${query.where}`, query.params)?.n ?? 0);
      if (inGroup <= skip) {
        skip -= inGroup;
        continue;
      }
    }
    const found = ctx.db.all<{ id: string }>(
      `SELECT e.id FROM ${query.from} WHERE ${query.where} ORDER BY ${query.order} LIMIT ? OFFSET ?`,
      [...query.params, need, skip],
    );
    for (const row of found) ids.push(String(row.id));
    skip = 0;
    if (need > 0) need -= found.length;
  }
  return ids;
}

const emailQuery: MethodHandler = (ctx, args) => {
  const terms = tempTermSets(ctx.db);
  try {
    return queryEmails(ctx, args, terms.sets);
  } finally {
    terms.clear();
  }
};

function queryEmails(ctx: MethodContext, args: Record<string, unknown>, sets: TermSets): MethodResult {
  const jmap = jmapOf(ctx, args);
  const filter = limitTextConditions((args.filter ?? undefined) as Filter | undefined);
  if (args.anchor !== undefined) throw new MethodError('unsupportedFilter', 'anchor needs the server');
  const box = drivingMailbox(filter);
  // Each text term is read off the index once, for the page and its total.
  const where = filter ? filterSql(filter, jmap, box, box !== null, sets) : { sql: '1', params: [] };
  const sort = (args.sort as Comparator[]) ?? [];
  const collapse = Boolean(args.collapseThreads);
  const levels = collapse ? null : keywordLevels(ctx, sort);
  const order: Sql = levels
    ? { sql: '', params: [] }
    : !isNewestFirst(sort)
    ? orderSql(ctx, sort)
    : { sql: box ? 'd.received_at DESC, d.email_rowid DESC' : 'e.received_at DESC, e.rowid DESC', params: [] };
  // Starting from the folder's own index keeps small folders fast in a large account.
  const from = box
    ? 'email_mailbox d INDEXED BY email_mailbox_list CROSS JOIN email e ON e.rowid = d.email_rowid'
    : 'email e';
  const base = box
    ? { sql: 'd.jmap = ? AND d.mailbox_id = ?', params: [jmap, box] as SqlValue[] }
    : { sql: 'e.jmap = ?', params: [jmap] as SqlValue[] };
  const position = Math.max(0, Number(args.position ?? 0));
  const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : -1;
  const group = collapse ? 'GROUP BY COALESCE(e.thread_id, e.id)' : '';
  const ids = levels
    ? keywordOrderedPage(ctx, jmap, box, where, levels, position, limit)
    : ctx.db.all<{ id: string }>(
      `SELECT e.id FROM ${from} WHERE ${base.sql} AND (${where.sql}) ${group} ORDER BY ${order.sql} LIMIT ? OFFSET ?`,
      [...base.params, ...where.params, ...order.params, limit, position],
    ).map((row) => String(row.id));
  // Stalwart's queryState is the Email state. Absent until the first sync, as allowed.
  const queryState = lastState(ctx, jmap, 'Email');
  // Nothing here doesn't mean nothing there: an empty folder of a first sync
  // that hasn't finished mustn't paint over what's on screen.
  if (ids.length === 0 && position === 0 && !queryState) throw new MethodError('serverUnavailable', 'Mail not kept yet');
  const result: MethodResult = {
    accountId: jmap,
    canCalculateChanges: false,
    ...(queryState ? { queryState } : {}),
    position,
    ids,
  };
  if (args.calculateTotal) {
    const count = collapse ? 'COUNT(DISTINCT COALESCE(e.thread_id, e.id))' : 'COUNT(*)';
    // In a folder, what needs nothing of the message itself counts off the
    // folder's index and the keyword rows, without reading a message.
    const countFrom = box && !collapse && !/\be\./.test(where.sql) ? 'email_mailbox d INDEXED BY email_mailbox_list' : from;
    result.total = Number(ctx.db.get<{ n: number }>(
      `SELECT ${count} AS n FROM ${countFrom} WHERE ${base.sql} AND (${where.sql})`,
      [...base.params, ...where.params],
    )?.n ?? 0);
  }
  return result;
}

/** What only the stored body has, past what the list keeps. */
const BODY_PROPERTIES = new Set(['bodyValues', 'textBody', 'htmlBody', 'bodyStructure', 'headers', 'attachments', 'bcc', 'replyTo', 'messageId', 'inReplyTo', 'references', 'sender']);

interface BodyPart { partId?: string | null; subParts?: BodyPart[]; [key: string]: unknown }

function partWithProperties(part: BodyPart, wanted: readonly string[]): BodyPart {
  const out: BodyPart = {};
  for (const name of wanted) if (name in part) out[name] = part[name];
  if (part.subParts) out.subParts = part.subParts.map((sub) => partWithProperties(sub, wanted));
  return out;
}

/** The body values the call asked for. The whole kept text: never cut to maxBodyValueBytes. */
function chosenBodyValues(body: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> {
  const values = (body.bodyValues ?? {}) as Record<string, unknown>;
  if (args.fetchAllBodyValues) return values;
  const parts = [
    ...(args.fetchTextBodyValues ? (body.textBody ?? []) as BodyPart[] : []),
    ...(args.fetchHTMLBodyValues ? (body.htmlBody ?? []) as BodyPart[] : []),
  ];
  const out: Record<string, unknown> = {};
  for (const part of parts) {
    const id = part.partId ?? '';
    if (id in values) out[id] = values[id];
  }
  return out;
}

function shapeEmail(
  list: Record<string, unknown>,
  body: Record<string, unknown> | null,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(body ?? {}), ...list };
  if (body) merged.bodyValues = chosenBodyValues(body, args);
  const bodyProperties = args.bodyProperties as string[] | undefined;
  if (bodyProperties) {
    for (const key of ['textBody', 'htmlBody', 'attachments']) {
      if (Array.isArray(merged[key])) merged[key] = (merged[key] as BodyPart[]).map((part) => partWithProperties(part, bodyProperties));
    }
    if (merged.bodyStructure) merged.bodyStructure = partWithProperties(merged.bodyStructure as BodyPart, bodyProperties);
  }
  const properties = args.properties as string[] | undefined;
  if (!properties) return merged;
  const out: Record<string, unknown> = { id: list.id };
  for (const property of properties) {
    if (property in merged) {
      out[property] = merged[property];
      continue;
    }
    // Only a message kept with its text has the raw headers these come from.
    const form = parseHeaderProperty(property);
    if (form && body && Array.isArray(body.headers)) out[property] = headerValue(form, body.headers as RawHeader[]);
  }
  return out;
}

const emailGet: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  if (!Array.isArray(args.ids)) throw new MethodError('requestTooLarge', 'ids: null needs the server');
  const properties = args.properties as string[] | undefined;
  const wantsValues = Boolean(args.fetchTextBodyValues || args.fetchHTMLBodyValues || args.fetchAllBodyValues) || Boolean(properties?.includes('bodyValues'));
  const wantsBody = wantsValues || !properties || properties.some((p) => BODY_PROPERTIES.has(p) || p.startsWith('header:'));
  const list: Record<string, unknown>[] = [];
  const notFound: string[] = [];
  for (const id of args.ids as string[]) {
    const row = ctx.db.get<{ rowid: number; json: string; body_state: number }>(
      'SELECT rowid, json, body_state FROM email WHERE jmap = ? AND id = ?',
      [jmap, id],
    );
    if (!row) {
      notFound.push(id);
      continue;
    }
    const email = JSON.parse(row.json) as Record<string, unknown>;
    if (!wantsBody) {
      list.push(shapeEmail(email, null, args));
      continue;
    }
    const body = ctx.db.get<{ json: string }>('SELECT json FROM email_body WHERE email_rowid = ?', [row.rowid]);
    // Asked for the text and it isn't here: as if the message weren't there, not an empty message.
    if (!body && wantsValues) {
      notFound.push(id);
      continue;
    }
    list.push(shapeEmail(email, body ? JSON.parse(body.json) as Record<string, unknown> : null, args));
  }
  const state = lastState(ctx, jmap, 'Email');
  return { accountId: jmap, ...(state ? { state } : {}), list, notFound };
};

const threadGet: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  const ids = Array.isArray(args.ids) ? [...new Set(args.ids as string[])] : [];
  const found: Array<{ id: string; emailIds: string[] }> = [];
  for (const id of ids) {
    const stored = ctx.db.get<{ email_ids: string }>('SELECT email_ids FROM thread WHERE jmap = ? AND id = ?', [jmap, id]);
    if (stored) {
      found.push({ id, emailIds: JSON.parse(stored.email_ids) as string[] });
      continue;
    }
    const rows = ctx.db.all<{ id: string }>('SELECT id FROM email WHERE jmap = ? AND thread_id = ? ORDER BY received_at ASC', [jmap, id]);
    if (rows.length > 0) found.push({ id, emailIds: rows.map((row) => String(row.id)) });
  }
  const list = ctx.overlay(jmap, 'Thread', found).filter((thread) => thread.emailIds.length > 0);
  const state = lastState(ctx, jmap, 'Thread');
  return {
    accountId: jmap,
    ...(state ? { state } : {}),
    list,
    notFound: ids.filter((id) => !list.some((thread) => thread.id === id)),
  };
};

function pick(item: Record<string, unknown>, properties: string[] | undefined): Record<string, unknown> {
  if (!properties) return item;
  const out: Record<string, unknown> = { id: item.id };
  for (const property of properties) if (property in item) out[property] = item[property];
  return out;
}

/** The answer of a /get over objects the syncers keep. An error until they've run once. */
function objectGet(ctx: MethodContext, args: Record<string, unknown>, type: string, label: string): MethodResult {
  const jmap = jmapOf(ctx, args);
  const state = lastState(ctx, jmap, type);
  const all = ctx.overlay(jmap, type, listObjects<Record<string, unknown> & { id: string }>(ctx.db, jmap, type));
  if (all.length === 0 && !state) throw new MethodError('serverUnavailable', `${label} not kept yet`);
  const ids = Array.isArray(args.ids) ? args.ids as string[] : null;
  const chosen = ids ? all.filter((item) => ids.includes(item.id)) : all;
  return {
    accountId: jmap,
    ...(state ? { state } : {}),
    list: chosen.map((item) => pick(item, args.properties as string[] | undefined)),
    notFound: ids ? ids.filter((id) => !all.some((item) => item.id === id)) : [],
  };
}

const mailboxQuery: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  const boxes = listObjects<Record<string, unknown>>(ctx.db, jmap, 'Mailbox');
  const state = lastState(ctx, jmap, 'Mailbox');
  if (boxes.length === 0 || !state) throw new MethodError('serverUnavailable', 'Folders not kept yet');
  const filter = (args.filter ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(filter)) {
    if (key !== 'role') throw new MethodError('unsupportedFilter', `${key} isn't available offline`);
  }
  const chosen = filter.role ? boxes.filter((box) => box.role === filter.role) : boxes;
  const position = typeof args.position === 'number' ? args.position : 0;
  const limit = typeof args.limit === 'number' ? args.limit : chosen.length;
  return {
    accountId: jmap,
    queryState: state,
    canCalculateChanges: false,
    position,
    ids: chosen.slice(position, position + limit).map((box) => box.id),
    ...(args.calculateTotal ? { total: chosen.length } : {}),
  };
};

/** The client treats this as "do a full fetch": what it reads next comes from the store anyway. */
const noChanges: MethodHandler = () => {
  throw new MethodError('cannotCalculateChanges', 'Changes need the server');
};

const keywordGet: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  const rows = ctx.db.all<{ keyword: string; total: number; unread: number }>(
    `SELECT k.keyword AS keyword, COUNT(*) AS total,
       SUM(NOT EXISTS (SELECT 1 FROM email_keyword s WHERE s.email_rowid = k.email_rowid AND s.keyword = '$seen')) AS unread
     FROM email_keyword k JOIN email e ON e.rowid = k.email_rowid
     WHERE e.jmap = ? GROUP BY k.keyword`,
    [jmap],
  );
  const counts = new Map(rows.map((row) => [String(row.keyword), { id: String(row.keyword), total: Number(row.total), unread: Number(row.unread) }]));
  const wanted = Array.isArray(args.ids) ? args.ids as string[] : null;
  const list = wanted
    ? wanted.map((id) => ({ ...(counts.get(keywordKey(id)) ?? { total: 0, unread: 0 }), id }))
    : [...counts.values()];
  return {
    accountId: jmap,
    list,
    notFound: [],
    totalEmails: Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM email WHERE jmap = ?', [jmap])?.n ?? 0),
  };
};

export const MAIL_METHODS: Readonly<Record<string, MethodHandler>> = {
  'Core/echo': (_ctx, args) => args,
  'Email/query': emailQuery,
  'Email/get': emailGet,
  'Email/changes': noChanges,
  'Thread/get': threadGet,
  'Mailbox/get': (ctx, args) => objectGet(ctx, args, 'Mailbox', 'Folders'),
  'Mailbox/query': mailboxQuery,
  'Mailbox/changes': noChanges,
  'Identity/get': (ctx, args) => objectGet(ctx, args, 'Identity', 'Identities'),
  'Quota/get': (ctx, args) => objectGet(ctx, args, 'Quota', 'Quotas'),
  'Keyword/get': keywordGet,
  'SearchSnippet/get': searchSnippetGet,
};
