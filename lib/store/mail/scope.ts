/**
 * What a changed scope means for kept mail. Tightened: what falls outside goes
 * right away, without the network and without fetching what stays. Loosened:
 * the next pass lists the wider window, keeping every body already here.
 */

import type { ScopeChange, StoreUsagePart, SyncContext } from '../area';
import { deleteEmailRow } from './records';

const DELETE_BATCH = 200;

/** Other calls and syncs get a turn between batches. */
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

function cutoff(ctx: SyncContext, days: number): number {
  return ctx.now() - days * 86_400_000;
}

function widened(previous: number | null, next: number | null): boolean {
  if (previous === null) return false;
  return next === null || next > previous;
}

async function pruneWindow(ctx: SyncContext, days: number): Promise<void> {
  const before = cutoff(ctx, days);
  let removed = false;
  for (const { jmap } of ctx.db.all<{ jmap: string }>('SELECT DISTINCT jmap FROM email')) {
    // A draft only on this device has no other copy. A change waiting for any
    // other message goes out by its id, whether it's kept or not.
    const spared = ctx.sparedRecords(jmap, 'Email');
    const notSpared = spared.length > 0 ? `AND id NOT IN (${spared.map(() => '?').join(', ')})` : '';
    for (;;) {
      if (ctx.stopped()) return;
      const rows = ctx.db.all<{ rowid: number }>(`SELECT rowid FROM email WHERE jmap = ? AND received_at < ? ${notSpared} LIMIT ?`, [jmap, before, ...spared, DELETE_BATCH]);
      if (rows.length === 0) break;
      ctx.db.transaction(() => {
        for (const row of rows) deleteEmailRow(ctx.db, Number(row.rowid));
      });
      removed = true;
      await breathe();
    }
  }
  if (removed) ctx.emit({ type: 'changed', account: ctx.account, collections: ['Email'] });
}

export async function applyMailScope(ctx: SyncContext, { previous, next }: ScopeChange): Promise<void> {
  // First, in case this gets interrupted: a pass under way pages by the old
  // window, so it starts over, tighter or wider.
  if (previous && previous.days !== next.days) {
    ctx.db.transaction(() => {
      for (const { jmap, state, phase } of ctx.db.all<{ jmap: string; state: string | null; phase: string | null }>("SELECT jmap, state, phase FROM sync_state WHERE type = 'Email'")) {
        if (phase === 'list' || (state && widened(previous.days, next.days))) ctx.setSyncState(jmap, 'Email', { state: null, phase: null, cursor: null });
      }
    });
  }
  if (next.days !== null) await pruneWindow(ctx, next.days);
}

/** Message text and the search index aren't counted here: they are what's left of the file. */
export function mailUsage(ctx: Pick<SyncContext, 'db'>): StoreUsagePart[] {
  const blobs = ctx.db.get<{ bytes: number | null; items: number }>('SELECT SUM(size) AS bytes, COUNT(*) AS items FROM blob');
  const messages = ctx.db.get<{ items: number }>('SELECT COUNT(*) AS items FROM email');
  return [
    { part: 'mail', bytes: 0, items: Number(messages?.items ?? 0) },
    { part: 'attachments', bytes: Number(blobs?.bytes ?? 0), items: Number(blobs?.items ?? 0) },
  ];
}
