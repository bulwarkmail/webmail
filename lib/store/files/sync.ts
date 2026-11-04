/**
 * FileNode metadata for one JMAP account, then the contents worth keeping.
 *
 * A full pass reads the tree the way the client does (fetchAllFileNodes,
 * lib/jmap/client.ts). `FileNode/get` with ids null returns everything, but
 * 0.16 silently stops at maxObjectsInGet and 1.0 refuses a larger account with
 * requestTooLarge. Past that, ids come from paging FileNode/query. Before
 * 0.16.6 that query leaves out folders, so parents still unknown afterwards are
 * read by id. The cursor is in sync_state, so a reload continues. Query pages
 * go from the last node read (`anchor`): a position moves when an earlier node
 * is deleted, and a skipped node would be swept at the end.
 */

import type { SyncContext, Syncer } from '../area';
import { runChangesLoop } from '../engine/changes';
import { requestLimits } from '../engine/limits';
import { JmapMethodError, responseFor, type MethodCall } from '../engine/transport';
import { dropOrphanBlobs, fetchKeptFiles } from './keep';
import { FILE_NODE_PROPERTIES, FILES_CAPABILITY, FILES_USING, removeNode, writeNode, type WireNode } from './records';

const MOST_GETS_PER_REQUEST = 8;
const QUERY_PAGE = 5000;

function getBatch(ctx: SyncContext): number {
  return requestLimits(ctx.session).maxObjectsInGet;
}

async function fetchNodes(ctx: SyncContext, jmap: string, ids: string[]): Promise<WireNode[]> {
  const size = getBatch(ctx);
  const perRequest = Math.min(MOST_GETS_PER_REQUEST, requestLimits(ctx.session).maxCallsInRequest);
  const nodes: WireNode[] = [];
  for (let at = 0; at < ids.length;) {
    const calls: MethodCall[] = [];
    for (let i = 0; i < perRequest && at < ids.length; i += 1, at += size) {
      calls.push(['FileNode/get', { accountId: jmap, ids: ids.slice(at, at + size), properties: FILE_NODE_PROPERTIES }, `g${i}`]);
    }
    const response = await ctx.transport.request(calls, FILES_USING);
    calls.forEach(([, , callId]) => nodes.push(...responseFor(response, callId)[1].list as WireNode[]));
  }
  return nodes;
}

interface ListCursor { step: 'all' | 'query' | 'parents'; position: number; anchor: string | null; gen: number; captured: string }

async function startFullList(ctx: SyncContext, jmap: string): Promise<ListCursor> {
  const response = await ctx.transport.request([['FileNode/get', { accountId: jmap, ids: [], properties: ['id'] }, 's']], FILES_USING);
  const captured = String(responseFor(response, 's')[1].state);
  const gen = Number(ctx.db.get<{ gen: number | null }>('SELECT MAX(gen) AS gen FROM file_node WHERE jmap = ?', [jmap])?.gen ?? 0) + 1;
  const cursor: ListCursor = { step: 'all', position: 0, anchor: null, gen, captured };
  // Answers wait for the end of a first pass (phase `first`). A resync has an older copy to give.
  const phase = ctx.syncState(jmap, 'FileNode').state ? 'list' : 'first';
  ctx.db.transaction(() => ctx.setSyncState(jmap, 'FileNode', { state: null, phase, cursor: { ...cursor } }));
  return cursor;
}

function saveStep(ctx: SyncContext, jmap: string, nodes: WireNode[], cursor: ListCursor): void {
  ctx.db.transaction(() => {
    for (const node of nodes) writeNode(ctx.db, jmap, node, cursor.gen);
    ctx.setSyncState(jmap, 'FileNode', { cursor: { ...cursor } });
  });
}

async function runFullList(ctx: SyncContext, jmap: string, start: ListCursor): Promise<boolean> {
  const cursor = { ...start };

  if (cursor.step === 'all') {
    let nodes: WireNode[] = [];
    let complete = false;
    try {
      const response = await ctx.transport.request([['FileNode/get', { accountId: jmap, ids: null, properties: FILE_NODE_PROPERTIES }, 'a']], FILES_USING);
      nodes = responseFor(response, 'a')[1].list as WireNode[];
      complete = nodes.length < getBatch(ctx);
    } catch (error) {
      if (!(error instanceof JmapMethodError && error.type === 'requestTooLarge')) throw error;
    }
    if (!complete) cursor.step = 'query';
    else cursor.step = 'parents';
    saveStep(ctx, jmap, nodes, cursor);
  }

  while (cursor.step === 'query') {
    if (ctx.stopped()) return false;
    const from = cursor.anchor === null ? { position: 0 } : { anchor: cursor.anchor, anchorOffset: 1 };
    const response = await ctx.transport.request([['FileNode/query', { accountId: jmap, filter: {}, ...from, limit: QUERY_PAGE, calculateTotal: true }, 'q']], FILES_USING);
    let query: { ids: string[]; position?: number; total?: number };
    try {
      [, query] = responseFor(response, 'q');
    } catch (error) {
      if (!(error instanceof JmapMethodError && error.type === 'anchorNotFound')) throw error;
      // The node it went from is gone. Going through again costs requests, not nodes.
      cursor.anchor = null;
      cursor.position = 0;
      saveStep(ctx, jmap, [], cursor);
      continue;
    }
    const ids = query.ids;
    const missing = ids.filter((id) => Number(ctx.db.get<{ gen: number }>('SELECT gen FROM file_node WHERE jmap = ? AND id = ?', [jmap, id])?.gen ?? -1) < cursor.gen);
    const nodes = await fetchNodes(ctx, jmap, missing);
    cursor.position = Number(query.position ?? 0) + ids.length;
    if (ids.length > 0) cursor.anchor = ids[ids.length - 1];
    // The server may clamp the limit, so only an empty page or the total ends this.
    if (ids.length === 0 || (typeof query.total === 'number' && cursor.position >= query.total)) cursor.step = 'parents';
    saveStep(ctx, jmap, nodes, cursor);
    ctx.emit({ type: 'progress', account: ctx.account, area: 'files', phase: 'list', done: cursor.position, total: typeof query.total === 'number' ? query.total : null });
  }

  const asked = new Set<string>();
  for (;;) {
    if (ctx.stopped()) return false;
    const parents = ctx.db.all<{ id: string }>(
      `SELECT DISTINCT n.parent_id AS id FROM file_node n
       WHERE n.jmap = ? AND n.gen = ? AND n.parent_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM file_node p WHERE p.jmap = n.jmap AND p.id = n.parent_id AND p.gen = ?)`,
      [jmap, cursor.gen, cursor.gen],
    ).map((row) => String(row.id)).filter((id) => !asked.has(id));
    if (parents.length === 0) break;
    for (const id of parents) asked.add(id);
    saveStep(ctx, jmap, await fetchNodes(ctx, jmap, parents), cursor);
  }

  ctx.db.transaction(() => {
    // Whatever this pass didn't see is gone from the server.
    ctx.db.run('DELETE FROM file_node WHERE jmap = ? AND gen < ?', [jmap, cursor.gen]);
    ctx.setSyncState(jmap, 'FileNode', { state: cursor.captured, phase: null, cursor: null });
  });
  ctx.emit({ type: 'changed', account: ctx.account, collections: ['FileNode'] });
  return true;
}

async function syncDelta(ctx: SyncContext, jmap: string, since: string, target: string | null): Promise<'done' | 'resync' | 'stopped'> {
  const outcome = await runChangesLoop({
    transport: ctx.transport,
    type: 'FileNode',
    jmap,
    using: FILES_USING,
    since,
    target,
    stopped: ctx.stopped,
    apply: async (page) => {
      const nodes = await fetchNodes(ctx, jmap, [...page.created, ...page.updated]);
      ctx.db.transaction(() => {
        const gen = Number(ctx.db.get<{ gen: number | null }>('SELECT MAX(gen) AS gen FROM file_node WHERE jmap = ?', [jmap])?.gen ?? 0);
        for (const node of nodes) writeNode(ctx.db, jmap, node, gen);
        for (const id of page.destroyed) removeNode(ctx.db, jmap, id);
        ctx.setSyncState(jmap, 'FileNode', { state: page.newState });
      });
      if (nodes.length + page.destroyed.length > 0) ctx.emit({ type: 'changed', account: ctx.account, collections: ['FileNode'] });
    },
  });
  if (outcome.outcome === 'resync') return 'resync';
  return outcome.outcome === 'stopped' ? 'stopped' : 'done';
}

export const filesSyncer: Syncer = {
  name: 'files',
  capability: FILES_CAPABILITY,
  async run(ctx, jmap) {
    const row = ctx.syncState(jmap, 'FileNode');
    let cursor = row.phase === 'list' || row.phase === 'first' ? row.cursor as unknown as ListCursor : null;
    if (!cursor && !row.state) cursor = await startFullList(ctx, jmap);
    if (!cursor && row.state) {
      const outcome = await syncDelta(ctx, jmap, row.state, row.target);
      if (outcome === 'stopped') return;
      if (outcome === 'resync') cursor = await startFullList(ctx, jmap);
    }
    if (cursor) {
      if (!(await runFullList(ctx, jmap, cursor))) return;
      // Catch what changed while paging.
      const after = ctx.syncState(jmap, 'FileNode');
      if (after.state && (await syncDelta(ctx, jmap, after.state, after.target)) === 'stopped') return;
    }
    if (ctx.stopped()) return;
    await fetchKeptFiles(ctx, jmap);
    // After the fetching: a file's old content stays until the new one is in.
    ctx.db.transaction(() => dropOrphanBlobs(ctx.db));
  },
};
