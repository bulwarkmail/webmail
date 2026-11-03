// Whether a folder is shared with other people, as the server says. The
// folder lists the app loads don't carry the share map (Mailbox/get without
// shareWith), so a plugin's move or filter into a folder is checked here,
// folder by folder, before it may send mail where someone else reads it.

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Mailbox } from '@/lib/jmap/types';

/**
 * True when the folder, a folder above it, or (with `descendants`) a folder
 * below it is shared with anyone. Fails closed: an answer the server
 * refuses or a client that can't ask counts as shared. False only when the
 * server has no folder sharing at all, or every share map is empty.
 */
export async function isSharedOut(
  client: IJMAPClient,
  mailboxes: Pick<Mailbox, 'id' | 'parentId'>[],
  mailboxId: string,
  accountId?: string,
  { descendants = false }: { descendants?: boolean } = {},
): Promise<boolean> {
  if (!client.supportsMailboxSharing?.(accountId)) return false;
  if (typeof client.getMailboxShareWith !== 'function') return true;
  const byId = new Map(mailboxes.map((m) => [m.id, m]));
  const ids: string[] = [];
  for (let id: string | null | undefined = mailboxId; id && !ids.includes(id); id = byId.get(id)?.parentId) ids.push(id);
  if (descendants) {
    const below = (root: string): string[] => mailboxes.filter((m) => m.parentId === root).flatMap((m) => [m.id, ...below(m.id)]);
    for (const id of below(mailboxId)) if (!ids.includes(id)) ids.push(id);
  }
  for (const id of ids) {
    try {
      const shareWith = await client.getMailboxShareWith(id, accountId);
      if (shareWith && Object.keys(shareWith).length > 0) return true;
    } catch {
      return true;
    }
  }
  return false;
}
