// Account routing for thread fetches (Thread/get + Email/get).
//
// JMAP thread ids are scoped to an account, so the same id names a *different*
// conversation - or none at all - in any other account. A thread fetch that
// doesn't name the owning account is answered by the active account, which
// happily returns whatever thread carries that id there: an unrelated
// conversation from the user's own mailbox. (#814)

import type { Email, Mailbox } from '@/lib/jmap/types';

export interface ThreadRoute {
  /**
   * AccountEntry.id of the login the thread is reachable through, or undefined
   * when the active client already is that login.
   */
  clientAccountId?: string;
  /**
   * Owning JMAP account to scope the fetch to, or undefined for the client's
   * own primary account.
   */
  accountId?: string;
}

/**
 * Resolves which login and which JMAP account a thread must be fetched from.
 *
 * Two sources of truth, in order:
 *  - Aggregate views (unified / cross-account) stamp every email with its own
 *    `sourceClientAccountId` + `sourceAccountId`; those are unambiguous across
 *    personal and shared/group sources, so they win.
 *  - A shared folder browsed directly carries no such stamp - its emails are
 *    undecorated and reached through the active client - so the owner has to
 *    come from the selected mailbox instead.
 *
 * An empty result means "active client, its own account": the normal
 * own-mailbox case, and the same request this code sent before shared folders
 * existed.
 */
export function resolveThreadRoute({
  isUnifiedView,
  ref,
  mailboxes,
  selectedMailbox,
}: {
  isUnifiedView: boolean;
  /** Any email known to belong to the thread, used for its source stamp. */
  ref?: Pick<Email, 'sourceClientAccountId' | 'sourceAccountId'> | null;
  mailboxes: Mailbox[];
  selectedMailbox?: string | null;
}): ThreadRoute {
  if (isUnifiedView && ref?.sourceClientAccountId && ref?.sourceAccountId) {
    return { clientAccountId: ref.sourceClientAccountId, accountId: ref.sourceAccountId };
  }

  const mailbox = selectedMailbox
    ? mailboxes.find((mb) => mb.id === selectedMailbox)
    : undefined;
  return { accountId: mailbox?.isShared ? mailbox.accountId : undefined };
}
