import type { Mailbox } from "@/lib/jmap/types";

/**
 * Unread messages waiting in an account's own inbox.
 *
 * Mountain View's account popover puts this number next to every address, so
 * that switching account is a decision one can take from the popover instead
 * of having to visit each account in turn.
 *
 * Shared folders are skipped: they are someone else's inbox, they are listed
 * under their owner in the sidebar, and counting them here would attribute
 * another person's unread mail to this account. `undefined` means "not known
 * yet" - the account's folders have not been fetched - and is deliberately
 * distinct from a known zero, which the caller should render as no badge
 * rather than as a "0".
 */
export function inboxUnread(mailboxes: Mailbox[] | undefined): number | undefined {
  if (!mailboxes || mailboxes.length === 0) return undefined;
  const inbox = mailboxes.find((mailbox) => mailbox.role === "inbox" && !mailbox.isShared);
  return inbox ? inbox.unreadEmails : undefined;
}

/**
 * What "All inboxes" carries: the unread of every listed account's inbox.
 *
 * Accounts whose folders are still loading contribute nothing rather than
 * blocking the total, so the badge grows as the fetches land instead of
 * appearing all at once several seconds in.
 */
export function totalInboxUnread(
  accountIds: readonly string[],
  mailboxesByAccount: Record<string, Mailbox[] | undefined>
): number {
  return accountIds.reduce((total, id) => total + (inboxUnread(mailboxesByAccount[id]) ?? 0), 0);
}
