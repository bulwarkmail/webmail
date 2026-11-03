/** What the page asks the mail part of the store outside JMAP. */

import type { AreaCall, StoreContext } from '../area';
import { putBlob, storeBody, upsertEmail, type EmailObject } from './records';

/**
 * A message the user opened online: kept with its text if the store doesn't
 * have that yet, for instance because it's older than the window the user
 * chose. Parts cut short for a list view aren't kept.
 */
function recordOpened(ctx: StoreContext, params: { jmap: string; emails: EmailObject[] }): void {
  ctx.db.transaction(() => {
    for (const email of ctx.overlay(params.jmap, 'Email', params.emails)) {
      const values = (email.bodyValues ?? {}) as Record<string, { isTruncated?: boolean }>;
      if (Object.keys(values).length === 0 || Object.values(values).some((value) => value?.isTruncated)) continue;
      const kept = ctx.db.get<{ rowid: number; json: string; body_state: number }>(
        'SELECT rowid, json, body_state FROM email WHERE jmap = ? AND id = ?',
        [params.jmap, email.id],
      );
      if (kept && Number(kept.body_state) === 1) continue;
      if (kept) {
        storeBody(ctx.db, Number(kept.rowid), String(kept.json), email);
        continue;
      }
      // A row needs at least what lists sort and filter on.
      if (typeof email.receivedAt !== 'string' || !email.mailboxIds) continue;
      const gen = Number(ctx.db.get<{ gen: number | null }>('SELECT MAX(gen) AS gen FROM email WHERE jmap = ?', [params.jmap])?.gen ?? 0);
      const { bodyValues, textBody, htmlBody, attachments, bodyStructure, headers, bcc, replyTo, messageId, inReplyTo, references, sender, ...list } = email;
      const rowid = upsertEmail(ctx.db, params.jmap, list as EmailObject, gen);
      storeBody(ctx.db, rowid, JSON.stringify(list), { bodyValues, textBody, htmlBody, attachments, bodyStructure, headers, bcc, replyTo, messageId, inReplyTo, references, sender });
    }
  });
}

/** A file of a kept message the user opened. Nothing else is kept: not an export, not a stray file. */
function recordBlob(ctx: StoreContext, params: { jmap: string; blobId: string; type: string | null; data: Uint8Array }): boolean {
  if (!ctx.scope.attachments || params.data.byteLength > ctx.scope.maxAttachmentBytes) return false;
  const used = Number(ctx.db.get<{ n: number | null }>('SELECT SUM(size) AS n FROM blob')?.n ?? 0);
  if (used + ctx.keptByOthers('mail') + params.data.byteLength > ctx.scope.maxTotalBytes) return false;
  const owner = ctx.db.get<{ received_at: number }>('SELECT received_at FROM email_part WHERE jmap = ? AND blob_id = ?', [params.jmap, params.blobId]);
  if (!owner) return false;
  putBlob(ctx.db, params.jmap, params.blobId, params.type, params.data, Number(owner.received_at));
  return true;
}

function getBlob(ctx: StoreContext, params: { jmap: string; blobId: string }): { type: string | null; data: Uint8Array } | null {
  const row = ctx.db.get<{ type: string | null; data: Uint8Array }>('SELECT type, data FROM blob WHERE jmap = ? AND blob_id = ?', [params.jmap, params.blobId]);
  return row ? { type: row.type, data: row.data } : null;
}

/** How much of the disk this account's file takes. */
function usage(ctx: StoreContext): { bytes: number } {
  const pages = Number(ctx.db.get<{ page_count: number }>('PRAGMA page_count')?.page_count ?? 0);
  const size = Number(ctx.db.get<{ page_size: number }>('PRAGMA page_size')?.page_size ?? 0);
  return { bytes: pages * size };
}

export const MAIL_CALLS: Readonly<Record<string, AreaCall>> = {
  'mail.recordOpened': recordOpened,
  'mail.recordBlob': recordBlob,
  'mail.getBlob': getBlob,
  'mail.usage': usage,
  /** The session kept with the account, for a start from the local copy. */
  'mail.session': (ctx) => ctx.session,
};
