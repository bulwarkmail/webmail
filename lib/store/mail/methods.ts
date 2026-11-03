/** Mail reads answered from the store. */

import { MethodError, type MethodContext, type MethodHandler, type MethodResult } from '../area';
import { listObjects } from '../engine/core-schema';
import type { SqlValue } from '../storage';
import { limitTextConditions, searchSnippetGet, textCondition, TEXT_FIELDS, type TextField } from './search';

type Filter = Record<string, unknown>;

interface Sql { sql: string; params: SqlValue[] }

function jmapOf(ctx: MethodContext, args: Record<string, unknown>): string {
  return (args.accountId as string | undefined) ?? ctx.defaultJmap;
}

/**
 * `drivenBy` is the folder the query already starts from: repeating that
 * condition would look the membership up again for every row.
 */
function filterSql(filter: Filter, jmap: string, drivenBy: string | null = null): Sql {
  if (typeof filter.operator === 'string') {
    const conditions = Array.isArray(filter.conditions) ? filter.conditions as Filter[] : [];
    const parts = conditions.map((c) => filterSql(c, jmap, filter.operator === 'AND' ? drivenBy : null));
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
        conditions.push('EXISTS (SELECT 1 FROM email_mailbox m WHERE m.email_rowid = e.rowid AND m.mailbox_id = ?)');
        params.push(String(value));
        break;
      case 'inMailboxOtherThan': {
        const ids = (value as string[]).map(String);
        conditions.push(`EXISTS (SELECT 1 FROM email_mailbox m WHERE m.email_rowid = e.rowid AND m.mailbox_id NOT IN (${ids.map(() => '?').join(',') || "''"}))`);
        params.push(...ids);
        break;
      }
      case 'hasKeyword':
        conditions.push('EXISTS (SELECT 1 FROM email_keyword k WHERE k.email_rowid = e.rowid AND k.keyword = ?)');
        params.push(String(value).toLowerCase());
        break;
      case 'notKeyword':
        conditions.push('NOT EXISTS (SELECT 1 FROM email_keyword k WHERE k.email_rowid = e.rowid AND k.keyword = ?)');
        params.push(String(value).toLowerCase());
        break;
      case 'after':
        conditions.push('e.received_at >= ?');
        params.push(Date.parse(String(value)) || 0);
        break;
      case 'before':
        conditions.push('e.received_at < ?');
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
      default:
        if ((TEXT_FIELDS as readonly string[]).includes(key)) {
          const text = textCondition(key as TextField, String(value));
          conditions.push(text.sql);
          params.push(...text.params);
          break;
        }
        // header and the thread keyword filters: the server's job.
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
        params.push(String(level.keyword ?? '').toLowerCase());
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

const emailQuery: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  const filter = limitTextConditions((args.filter ?? undefined) as Filter | undefined);
  if (args.anchor !== undefined) throw new MethodError('unsupportedFilter', 'anchor needs the server');
  const box = drivingMailbox(filter);
  const where = filter ? filterSql(filter, jmap, box) : { sql: '1', params: [] };
  const sort = (args.sort as Comparator[]) ?? [];
  const order: Sql = !isNewestFirst(sort)
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
  const collapse = Boolean(args.collapseThreads);
  const group = collapse ? 'GROUP BY COALESCE(e.thread_id, e.id)' : '';
  const ids = ctx.db.all<{ id: string }>(
    `SELECT e.id FROM ${from} WHERE ${base.sql} AND (${where.sql}) ${group} ORDER BY ${order.sql} LIMIT ? OFFSET ?`,
    [...base.params, ...where.params, ...order.params, limit, position],
  ).map((row) => String(row.id));
  const result: MethodResult = {
    accountId: jmap,
    canCalculateChanges: false,
    // Local answers aren't a position in the server's log, so this is a token only.
    queryState: 'local',
    position,
    ids,
  };
  if (args.calculateTotal) {
    const count = collapse ? 'COUNT(DISTINCT COALESCE(e.thread_id, e.id))' : 'COUNT(*)';
    // A plain folder counts from its index alone, without reading a message.
    const countFrom = box && !collapse && where.sql === '1' ? 'email_mailbox d INDEXED BY email_mailbox_list' : from;
    result.total = Number(ctx.db.get<{ n: number }>(
      `SELECT ${count} AS n FROM ${countFrom} WHERE ${base.sql} AND (${where.sql})`,
      [...base.params, ...where.params],
    )?.n ?? 0);
  }
  return result;
};

const BODY_PROPERTIES = new Set(['bodyValues', 'textBody', 'htmlBody', 'bodyStructure', 'headers', 'attachments', 'bcc', 'replyTo', 'messageId', 'inReplyTo', 'references']);

function pick(email: Record<string, unknown>, properties: string[] | undefined): Record<string, unknown> {
  if (!properties) return email;
  const out: Record<string, unknown> = { id: email.id };
  for (const property of properties) if (property in email) out[property] = email[property];
  return out;
}

const emailGet: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  if (!Array.isArray(args.ids)) throw new MethodError('requestTooLarge', 'ids: null needs the server');
  const properties = args.properties as string[] | undefined;
  const wantsValues = Boolean(args.fetchTextBodyValues || args.fetchHTMLBodyValues || args.fetchAllBodyValues) || Boolean(properties?.includes('bodyValues'));
  const wantsBody = wantsValues || !properties || properties.some((p) => BODY_PROPERTIES.has(p));
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
      list.push(pick(email, properties));
      continue;
    }
    const body = ctx.db.get<{ json: string }>('SELECT json FROM email_body WHERE email_rowid = ?', [row.rowid]);
    // Asked for the text and it isn't here: as if the message weren't there, not an empty message.
    if (!body && wantsValues) {
      notFound.push(id);
      continue;
    }
    list.push(pick({ ...(body ? JSON.parse(body.json) as object : {}), ...email }, properties));
  }
  const state = ctx.db.get<{ state: string | null }>("SELECT state FROM sync_state WHERE jmap = ? AND type = 'Email'", [jmap])?.state;
  return { accountId: jmap, ...(state ? { state } : {}), list, notFound };
};

const threadGet: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  const ids = Array.isArray(args.ids) ? [...new Set(args.ids as string[])] : [];
  const list: Array<{ id: string; emailIds: string[] }> = [];
  const notFound: string[] = [];
  for (const id of ids) {
    const stored = ctx.db.get<{ email_ids: string }>('SELECT email_ids FROM thread WHERE jmap = ? AND id = ?', [jmap, id]);
    if (stored) {
      list.push({ id, emailIds: JSON.parse(stored.email_ids) as string[] });
      continue;
    }
    const rows = ctx.db.all<{ id: string }>('SELECT id FROM email WHERE jmap = ? AND thread_id = ? ORDER BY received_at ASC', [jmap, id]);
    if (rows.length > 0) list.push({ id, emailIds: rows.map((row) => String(row.id)) });
    else notFound.push(id);
  }
  return { accountId: jmap, list, notFound };
};

const mailboxGet: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  const boxes = listObjects<Record<string, unknown>>(ctx.db, jmap, 'Mailbox');
  if (boxes.length === 0) throw new MethodError('serverUnavailable', 'Folders not kept yet');
  const ids = Array.isArray(args.ids) ? new Set(args.ids as string[]) : null;
  const chosen = ids ? boxes.filter((box) => ids.has(box.id as string)) : boxes;
  const state = ctx.db.get<{ state: string | null }>("SELECT state FROM sync_state WHERE jmap = ? AND type = 'Mailbox'", [jmap])?.state;
  return {
    accountId: jmap,
    ...(state ? { state } : {}),
    list: chosen.map((box) => pick(box, args.properties as string[] | undefined)),
    notFound: ids ? [...ids].filter((id) => !boxes.some((box) => box.id === id)) : [],
  };
};

const mailboxQuery: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  const boxes = listObjects<Record<string, unknown>>(ctx.db, jmap, 'Mailbox');
  if (boxes.length === 0) throw new MethodError('serverUnavailable', 'Folders not kept yet');
  const filter = (args.filter ?? {}) as { role?: string };
  const chosen = filter.role ? boxes.filter((box) => box.role === filter.role) : boxes;
  const position = typeof args.position === 'number' ? args.position : 0;
  const limit = typeof args.limit === 'number' ? args.limit : chosen.length;
  return {
    accountId: jmap,
    queryState: 'local',
    canCalculateChanges: false,
    position,
    ids: chosen.slice(position, position + limit).map((box) => box.id),
    ...(args.calculateTotal ? { total: chosen.length } : {}),
  };
};

export const MAIL_METHODS: Readonly<Record<string, MethodHandler>> = {
  'Email/query': emailQuery,
  'Email/get': emailGet,
  'Thread/get': threadGet,
  'Mailbox/get': mailboxGet,
  'Mailbox/query': mailboxQuery,
  'SearchSnippet/get': searchSnippetGet,
};
