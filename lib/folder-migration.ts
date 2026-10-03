import type { IJMAPClient } from '@/lib/jmap/client-interface';

/**
 * Copies or moves every message of one folder into a folder of another
 * connected account, one message at a time.
 *
 * JMAP has no cross-account move between separate logins, so each message is
 * fetched as its raw RFC 5322 blob and imported on the other side, the same
 * path crossAccountMoveEmails takes for a drag between accounts. Email/import
 * is not idempotent: a request that failed on the way back may still have
 * created the message, so nothing is retried and the run stops at the first
 * failure. A source message is destroyed only after the destination confirmed
 * its import.
 */

export type FolderMigrationMode = 'copy' | 'move';

export interface FolderMigrationProgress {
  /** Messages in the source folder when the run started. */
  total: number;
  /** Messages imported into the destination. */
  done: number;
  /**
   * Moved messages left in the source because they are also filed in other
   * folders there: destroying them would delete them from those folders too.
   */
  kept: number;
}

export interface FolderMigrationResult extends FolderMigrationProgress {
  /** The run was stopped before every message was handled. */
  stopped: boolean;
  /** The message the run stopped on, when it stopped on a failure. */
  failure?: { emailId: string; imported: boolean; message: string };
}

export class FolderChangedError extends Error {
  constructor() {
    super('The folder changed while it was being read');
    this.name = 'FolderChangedError';
  }
}

export class SameAccountError extends Error {
  constructor() {
    super('The destination is in the same account');
    this.name = 'SameAccountError';
  }
}

/** Whether two clients reach the same account (also two logins of one user). */
export function isSameAccount(a: IJMAPClient, b: IJMAPClient): boolean {
  return a === b || (a.getServerUrl() === b.getServerUrl() && a.getAccountId() === b.getAccountId());
}

/**
 * Every message id in a folder, read before anything is changed: destroying
 * messages while paging through the folder shifts the positions and skips
 * messages. Throws FolderChangedError when the folder changes while it is read.
 */
export async function listFolderEmailIds(
  client: IJMAPClient,
  mailboxId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const pageSize = Math.max(1, Math.min(200, client.getMaxObjectsInGet() || 200));
  const ids: string[] = [];
  const seen = new Set<string>();
  let total: number | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const page = await client.getEmails(mailboxId, undefined, pageSize, ids.length);
    if (total !== undefined && page.total !== total) throw new FolderChangedError();
    total = page.total;
    for (const email of page.emails) {
      if (seen.has(email.id)) throw new FolderChangedError();
      seen.add(email.id);
      ids.push(email.id);
    }
    if (!page.hasMore || page.emails.length === 0) break;
  }
  signal?.throwIfAborted();
  if (total && ids.length !== total) throw new FolderChangedError();
  return ids;
}

export async function migrateFolder({
  source,
  sourceMailboxId,
  destination,
  destMailboxId,
  mode,
  signal,
  onProgress,
}: {
  source: IJMAPClient;
  sourceMailboxId: string;
  destination: IJMAPClient;
  destMailboxId: string;
  mode: FolderMigrationMode;
  signal?: AbortSignal;
  onProgress?: (progress: FolderMigrationProgress) => void;
}): Promise<FolderMigrationResult> {
  if (isSameAccount(source, destination)) throw new SameAccountError();

  const ids = await listFolderEmailIds(source, sourceMailboxId, signal);
  const progress: FolderMigrationProgress = { total: ids.length, done: 0, kept: 0 };
  onProgress?.({ ...progress });

  for (const id of ids) {
    if (signal?.aborted) return { ...progress, stopped: true };
    let imported = false;
    try {
      const email = await source.getEmail(id);
      if (!email?.blobId) throw new Error('The message has no raw content to copy');
      const blob = await source.fetchBlob(email.blobId, undefined, 'message/rfc822');
      // Stopping during a download leaves this message untouched. Past this
      // point the message is finished, so a move never stops between the
      // import and the destroy.
      if (signal?.aborted) return { ...progress, stopped: true };
      await destination.importRawEmail(
        blob,
        { [destMailboxId]: true },
        { ...(email.keywords ?? {}) },
        undefined,
        email.receivedAt,
      );
      imported = true;
      if (mode === 'move') {
        const elsewhere = Object.keys(email.mailboxIds ?? {}).some((mb) => mb !== sourceMailboxId);
        if (elsewhere) progress.kept++;
        else await source.deleteEmail(id);
      }
      progress.done++;
    } catch (error) {
      return {
        ...progress,
        stopped: true,
        failure: { emailId: id, imported, message: error instanceof Error ? error.message : String(error) },
      };
    }
    onProgress?.({ ...progress });
  }
  return { ...progress, stopped: false };
}
