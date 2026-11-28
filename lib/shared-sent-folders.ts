import type { Mailbox } from '@/lib/jmap/types';

/** A shared account's Sent folder: the JMAP account and the folder's raw id. */
export interface SharedSentFolder {
  accountId: string;
  mailboxId: string;
}

/**
 * The Sent folders of the shared accounts in a folder list, as a stable key
 * (`accountId:mailboxId` per folder, sorted): the list changes with every
 * count, the key only when a shared Sent folder comes or goes.
 */
export function sharedSentFoldersKey(mailboxes: Mailbox[]): string {
  const keys = new Set<string>();
  for (const m of mailboxes) {
    if (m.role !== 'sent' || !m.isShared || !m.accountId) continue;
    keys.add(`${m.accountId}:${m.originalId || m.id}`);
  }
  return [...keys].sort().join('\n');
}

/** The folders of a sharedSentFoldersKey. JMAP ids never contain ":". */
export function parseSharedSentFoldersKey(key: string): SharedSentFolder[] {
  if (!key) return [];
  return key.split('\n').map((entry) => {
    const at = entry.indexOf(':');
    return { accountId: entry.slice(0, at), mailboxId: entry.slice(at + 1) };
  });
}
