import type { IJMAPClient } from '@/lib/jmap/client-interface';

export interface TransferMessage {
  id: string;
  client: IJMAPClient;
  accountId: string;
  localAccountId: string;
}
export interface TransferProgress {
  total: number;
  completed: number;
  copied: number;
  moved: number;
  failure?: { emailId: string; copied: boolean; message: string };
}

/** Enumerate before deleting anything: deleting while paging would skip messages. */
export async function collectTransferMessages(
  client: IJMAPClient, localAccountId: string, mailboxId?: string, signal?: AbortSignal,
): Promise<TransferMessage[]> {
  const messages = new Map<string, TransferMessage>();
  const pageSize = Math.max(1, Math.min(200, client.getMaxObjectsInGet()));
  let position = 0;
  let total: number | undefined;
  let state: string | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const page = await client.getEmails(mailboxId, client.getAccountId(), pageSize, position);
    if ((total !== undefined && total !== page.total) || (state && page.state && state !== page.state)) {
      throw new Error('The source mailbox changed during preparation. Please prepare the transfer again.');
    }
    total = page.total;
    state = page.state;
    for (const email of page.emails) {
      messages.set(email.id, { id: email.id, client, accountId: client.getAccountId(), localAccountId });
    }
    position += page.emails.length;
    if (!page.hasMore) break;
    if (!page.emails.length || messages.size !== position) throw new Error('Unable to enumerate all source messages.');
  }
  signal?.throwIfAborted();
  if (messages.size !== total) throw new Error('The source mailbox changed during preparation. Please prepare the transfer again.');
  return [...messages.values()];
}

/** Copy exact MIME bytes and metadata; destroy only after an acknowledged import.
 * Stop on the first failure. An ambiguous network failure must never be retried
 * automatically because Email/import is not idempotent.
 */
export async function transferMessages({ messages, destination, mailboxId, mode, signal, onProgress }: {
  messages: TransferMessage[];
  destination: IJMAPClient;
  mailboxId: string;
  mode: 'copy' | 'move';
  signal?: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
}): Promise<TransferProgress> {
  const progress: TransferProgress = { total: messages.length, completed: 0, copied: 0, moved: 0 };
  const targetId = destination.getAccountId();
  const targets = await destination.getMailboxes();
  const target = targets.find(m => !m.isShared && m.id === mailboxId);
  if (!target || target.myRights?.mayAddItems === false) throw new Error('The destination folder is not writable.');
  // Validate the whole selection before starting, including aliases of the same login.
  if (messages.some(m => m.client === destination ||
    (m.client.getServerUrl() === destination.getServerUrl() && m.accountId === targetId))) {
    throw new Error('Choose a different destination account.');
  }
  onProgress?.({ ...progress });
  for (const message of messages) {
    if (signal?.aborted) break;
    let copied = false;
    try {
      const email = await message.client.getEmail(message.id, message.accountId);
      if (!email?.blobId) throw new Error('The original message is unavailable.');
      const maxUpload = destination.getMaxSizeUpload();
      if (maxUpload > 0 && email.size > maxUpload) throw new Error('Message exceeds the destination upload limit.');
      const blob = await message.client.fetchBlob(email.blobId, 'message.eml', 'message/rfc822', message.accountId);
      // Cancelling during a download leaves the source untouched.
      if (signal?.aborted) break;
      const file = new File([blob], 'message.eml', { type: 'message/rfc822' });
      const uploaded = await destination.uploadBlob(file, targetId);
      const importedId = await destination.importEmail(uploaded.blobId, { [mailboxId]: true }, email.keywords, targetId, email.receivedAt);
      if (!importedId) throw new Error('The destination did not confirm the import.');
      copied = true;
      progress.copied++;
      if (mode === 'move') {
        await message.client.deleteEmail(message.id, message.accountId);
        progress.moved++;
      }
      progress.completed++;
    } catch (error) {
      progress.failure = { emailId: message.id, copied, message: error instanceof Error ? error.message : String(error) };
      onProgress?.({ ...progress });
      return progress;
    }
    onProgress?.({ ...progress });
  }
  return progress;
}
