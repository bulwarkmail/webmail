import { buildMailPath } from "@/lib/deep-links";
import { listRowSource } from "@/lib/draft-source";
import { isFilterEmpty } from "@/lib/jmap/search-utils";
import type { Email, Mailbox } from "@/lib/jmap/types";
import { useAuthStore } from "@/stores/auth-store";
import { emailLinkSource, resolveUnstampedEmailAccountId, useEmailStore } from "@/stores/email-store";
import type { ProEmailTabData } from "@/stores/pro-tab-store";

// The Pro shell's address names a message by its id, its login and the JMAP
// account it is in when that is not the login's own: ids repeat across
// accounts and logins, so a reload opens exactly that message, or nothing
// when the address names no login (MailApp's applyMailDeepLink).

/** The address of a Pro message tab. */
export function emailTabPath(data: ProEmailTabData): string {
  return buildMailPath({
    mailboxId: null,
    threadId: null,
    emailId: data.emailId,
    loginId: data.clientAccountId ?? useAuthStore.getState().activeAccountId ?? null,
    // A tab without an account reads the login's own (ProEmailTabBody).
    ownerAccountId: data.accountId || null,
  });
}

/** The address of the Mail tab: its folder, or the message open in it. */
export function mailTabPath(mailboxId: string | null, open: Email | null, mailboxes: Mailbox[]): string {
  if (!open) return buildMailPath({ mailboxId, emailId: null, threadId: null }, mailboxes);
  return buildMailPath({ mailboxId, emailId: open.id, threadId: null, ...emailLinkSource(open) }, mailboxes);
}

/**
 * The message tabs for messages dragged onto the Pro shell, by the ids the
 * drag carries: each the one row of the Mail list with that id, with the
 * login and account it was listed from, as a double-click on it opens it.
 * An id that names no listed row, or several (a list that mixes accounts),
 * opens nothing.
 */
export function droppedEmailTabs(emailIds: string[], fallbackTitle: string): ProEmailTabData[] {
  const state = useEmailStore.getState();
  const viewMailboxes = state.viewingAccountId
    ? state.accountMailboxes[state.viewingAccountId] ?? state.mailboxes
    : state.mailboxes;
  const list = {
    isScheduledView: state.isScheduledView,
    viewingAccountId: state.viewingAccountId,
    activeAccountId: useAuthStore.getState().activeAccountId,
    accountId: resolveUnstampedEmailAccountId({
      mailboxes: viewMailboxes,
      selectedMailbox: state.selectedMailbox,
      searchActive: !!state.searchQuery || !isFilterEmpty(state.searchFilters),
      searchMailboxId: state.searchMailboxId,
    }),
  };
  const tabs: ProEmailTabData[] = [];
  for (const id of emailIds) {
    const rows = state.emails.filter((email) => email.id === id);
    if (rows.length !== 1) continue;
    const source = listRowSource(rows[0], list);
    if (!source.localAccountId) continue;
    tabs.push({
      accountId: source.accountId ?? '',
      clientAccountId: source.localAccountId,
      emailId: id,
      mailboxId: null,
      title: rows[0].subject?.trim() || fallbackTitle,
    });
  }
  return tabs;
}
