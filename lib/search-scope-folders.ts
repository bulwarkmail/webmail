import type { Mailbox } from '@/lib/jmap/types';

export interface SearchScopeFolderGroup {
  /** Owner JMAP account id; the React key. */
  ownerId: string;
  /** Owner account label (`accountName`, else the owner id). */
  label: string;
  mailboxes: Mailbox[];
}

/**
 * Splits the sidebar's folder list into the login's own folders and the
 * group/shared folders grouped by their owner account, for the search
 * panel's Folder dropdown.
 *
 * Shared folders carry their owner's name in the sidebar, but the flat
 * dropdown listed them by bare name, so a group's "Inbox" was
 * indistinguishable from the user's own (#1082).
 */
export function groupSearchScopeFolders(
  mailboxes: Mailbox[],
): { own: Mailbox[]; shared: SearchScopeFolderGroup[] } {
  const own: Mailbox[] = [];
  const byOwner = new Map<string, SearchScopeFolderGroup>();
  for (const mailbox of mailboxes) {
    if (!mailbox.isShared) {
      own.push(mailbox);
      continue;
    }
    const ownerId = mailbox.accountId ?? '';
    let group = byOwner.get(ownerId);
    if (!group) {
      group = { ownerId, label: mailbox.accountName || ownerId, mailboxes: [] };
      byOwner.set(ownerId, group);
    }
    group.mailboxes.push(mailbox);
  }
  return { own, shared: Array.from(byOwner.values()) };
}
