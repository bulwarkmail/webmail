/**
 * FileNode reads answered from the store, so listings work offline. Nothing
 * here answers FileNode/set: the responder gives it a per-call
 * serverUnavailable, since the design has no offline file writes.
 */

import { MethodError, type MethodContext, type MethodHandler, type MethodResult } from '../area';
import type { SqlValue } from '../storage';
import { FILES_CAPABILITY } from './records';

function jmapOf(ctx: MethodContext, args: Record<string, unknown>): string {
  return (args.accountId as string | undefined) ?? ctx.session.primaryAccounts[FILES_CAPABILITY] ?? ctx.defaultJmap;
}

/** The last state from the server. Throws when the list was never read, so an empty answer always means empty. */
function syncedState(ctx: MethodContext, jmap: string): string | null {
  const row = ctx.db.get<{ state: string | null; phase: string | null }>("SELECT state, phase FROM sync_state WHERE jmap = ? AND type = 'FileNode'", [jmap]);
  if (!row || (!row.state && !row.phase)) throw new MethodError('serverUnavailable', 'Files not kept yet');
  return row.state;
}

function pick(node: Record<string, unknown>, properties: unknown): Record<string, unknown> {
  if (!Array.isArray(properties)) return node;
  const out: Record<string, unknown> = { id: node.id };
  for (const property of properties as string[]) if (property in node) out[property] = node[property];
  return out;
}

const SORTS: Record<string, string> = {
  name: 'name COLLATE NOCASE',
  size: 'size',
  created: "json_extract(json, '$.created')",
  modified: "json_extract(json, '$.modified')",
};

function orderSql(sort: unknown): string {
  const parts: string[] = [];
  for (const level of (Array.isArray(sort) ? sort : []) as Array<{ property?: string; isAscending?: boolean }>) {
    const column = SORTS[String(level.property)];
    if (!column) throw new MethodError('unsupportedSort', `${String(level.property)} isn't available offline`);
    parts.push(`${column} ${level.isAscending === false ? 'DESC' : 'ASC'}`);
  }
  parts.push('name COLLATE NOCASE ASC', 'id ASC');
  return parts.join(', ');
}

const fileNodeGet: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  const state = syncedState(ctx, jmap);
  const list: Array<Record<string, unknown>> = [];
  const notFound: string[] = [];
  if (Array.isArray(args.ids)) {
    for (const id of args.ids as string[]) {
      const row = ctx.db.get<{ json: string }>('SELECT json FROM file_node WHERE jmap = ? AND id = ?', [jmap, id]);
      if (row) list.push(pick(JSON.parse(row.json) as Record<string, unknown>, args.properties));
      else notFound.push(id);
    }
  } else {
    // The whole tree at once. The client reads a long list as possibly cut,
    // pages FileNode/query to check, and finds nothing missing.
    for (const row of ctx.db.all<{ json: string }>('SELECT json FROM file_node WHERE jmap = ?', [jmap])) {
      list.push(pick(JSON.parse(row.json) as Record<string, unknown>, args.properties));
    }
  }
  return { accountId: jmap, ...(state ? { state } : {}), list, notFound };
};

const fileNodeQuery: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  syncedState(ctx, jmap);
  if (args.anchor !== undefined) throw new MethodError('unsupportedFilter', 'anchor needs the server');
  const filter = (args.filter ?? {}) as Record<string, unknown>;
  const conditions = ['jmap = ?'];
  const params: SqlValue[] = [jmap];
  for (const [key, value] of Object.entries(filter)) {
    if (key !== 'parentId') throw new MethodError('unsupportedFilter', `${key} isn't available offline`);
    if (value === null) {
      conditions.push('parent_id IS NULL');
    } else {
      conditions.push('parent_id = ?');
      params.push(String(value));
    }
  }
  const where = conditions.join(' AND ');
  const position = Math.max(0, Number(args.position ?? 0));
  const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : -1;
  const ids = ctx.db.all<{ id: string }>(
    `SELECT id FROM file_node WHERE ${where} ORDER BY ${orderSql(args.sort)} LIMIT ? OFFSET ?`,
    [...params, limit, position],
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
    result.total = Number(ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM file_node WHERE ${where}`, params)?.n ?? 0);
  }
  return result;
};

export const FILE_METHODS: Readonly<Record<string, MethodHandler>> = {
  'FileNode/get': fileNodeGet,
  'FileNode/query': fileNodeQuery,
};
