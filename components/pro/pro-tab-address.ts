import { buildMailPath } from "@/lib/deep-links";
import type { EmailDragSource } from "@/lib/email-drag-payload";
import type { Email, Mailbox } from "@/lib/jmap/types";
import { useAuthStore } from "@/stores/auth-store";
import { emailLinkSource, listRowSource, useEmailStore } from "@/stores/email-store";
import type { ProEmailTabData, ProFolderTabData } from "@/stores/pro-tab-store";
import { tabLogin, tabLoginClient } from "./pro-tab-login";

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
    // The tab's login. A tab that names none and has several logins to
    // choose from gets an address without one, which opens nothing.
    loginId: tabLogin(data.clientAccountId) ?? null,
    // A tab without an account reads the login's own (ProEmailTabBody).
    ownerAccountId: data.accountId || null,
  });
}

/**
 * The folder tab for a folder dragged from the sidebar onto the Pro shell.
 * The sidebar names the login for another login's folder and none for the
 * active one's: that is the login active at the drop, and the tab names it,
 * so it stays that login's folder when another login becomes the active one.
 * Null while no login is active.
 */
export function droppedFolderTab(payload: { mailboxId: string; name: string; accountId: string | null }): ProFolderTabData | null {
  const login = payload.accountId ?? useAuthStore.getState().activeAccountId;
  if (!login) return null;
  return { accountId: login, mailboxId: payload.mailboxId, title: payload.name };
}

/** The address of the Mail tab: its folder, or the message open in it. */
export function mailTabPath(mailboxId: string | null, open: Email | null, mailboxes: Mailbox[]): string {
  if (!open) return buildMailPath({ mailboxId, emailId: null, threadId: null }, mailboxes);
  return buildMailPath({ mailboxId, emailId: open.id, threadId: null, ...emailLinkSource(open) }, mailboxes);
}

/**
 * The message tabs for a drop onto the Pro shell. Require a still-listed row
 * from the exact source captured at drag start, even after the list refreshes.
 */
export function droppedEmailTabs(sources: EmailDragSource[], fallbackTitle: string): ProEmailTabData[] {
  const state = useEmailStore.getState();
  const sourceOf = listRowSource(state);
  const tabs: ProEmailTabData[] = [];
  for (const source of sources) {
    const rows = state.emails.filter((email) => {
      if (email.id !== source.emailId) return false;
      if (state.isScheduledView && !(email.sourceClientAccountId && email.sourceAccountId)) return false;
      const { login, account } = sourceOf(email);
      return login === source.clientAccountId && account === source.accountId;
    });
    if (rows.length !== 1) continue;
    const row = rows[0];
    const stamped = row.sourceClientAccountId && row.sourceAccountId;
    // Keep the same tab data as double-clicking an unstamped personal row.
    const own = !stamped && tabLoginClient(source.clientAccountId)?.getAccountId() === source.accountId;
    tabs.push({
      accountId: own ? '' : source.accountId,
      clientAccountId: source.clientAccountId,
      emailId: source.emailId,
      mailboxId: null,
      title: row.subject?.trim() || fallbackTitle,
    });
  }
  return tabs;
}
