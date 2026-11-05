import type { Mailbox } from "./jmap/types";

/**
 * In Archive, or a folder under it (the year and month folders), the first
 * filing action brings mail back instead of archiving it again (mail-p3-4):
 * "Move to Inbox", as Gmail's All Mail and Outlook's Archive offer. Returns
 * the Inbox of the browsed folder's own account, or undefined outside
 * Archive.
 */
export function archiveInboxTarget(mailboxes: readonly Mailbox[], browsedId: string | null | undefined): Mailbox | undefined {
  if (!browsedId) return undefined;
  const byId = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]));
  const start = byId.get(browsedId);
  if (!start) return undefined;
  let inArchive = false;
  const seen = new Set<string>();
  for (let at: Mailbox | undefined = start; at && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) {
    seen.add(at.id);
    if (at.role === "archive") {
      inArchive = true;
      break;
    }
  }
  if (!inArchive) return undefined;
  const account = start.accountId ?? null;
  return mailboxes.find((mailbox) => mailbox.role === "inbox" && (mailbox.accountId ?? null) === account)
    ?? (start.isShared ? undefined : mailboxes.find((mailbox) => mailbox.role === "inbox" && !mailbox.isShared));
}
