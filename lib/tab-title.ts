// Browser-tab titles read "<context> - <account> - <app>", the order Gmail and
// Outlook Web use. Browsers cut a long title from the end, so the part that
// changes (folder, unread count, subject) goes first and the app name last.
// The account sits in between, so two mailboxes open side by side stay apart
// in the tab strip and in session restore. Empty parts are left out. (#1159)
export function formatTabTitle(
  context: string | null | undefined,
  account: string | null | undefined,
  appName: string,
): string {
  return [context, account, appName].filter(Boolean).join(' - ');
}

/** What the mail view is showing, already localized. */
export interface MailTitleView {
  /** Composer label while the composer is open ("New message", "Reply", ...). */
  composer?: string | null;
  /** Subject of the open message. */
  subject?: string | null;
  /** Selected mailbox, with its unread count when there is one. */
  mailbox?: string | null;
}

/**
 * The context part of the mail view's tab title: composer, then message, then
 * mailbox. The subject does not stay in the tab strip - browsers keep it in
 * history and in the session-restore list, and screen shares show it - so an
 * operator can keep it out (`tabTitleSubjectEnabled`). The mailbox line is
 * shown instead, so the tab still says where you are. (#1159)
 */
export function mailTitleContext(
  view: MailTitleView,
  { showSubject = true }: { showSubject?: boolean } = {},
): string | null {
  return view.composer || (showSubject ? view.subject : null) || view.mailbox || null;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The mailbox line of the tab title: "Inbox (10)", or for the open account's
 * own Inbox while other accounts have unread mail too, "Inbox (10, 30 in all
 * accounts)", the number the favicon and the rail show (usability test
 * 2026-11-04, mail-6). `otherUnread` is 0 when Notifications counts the open
 * account only.
 */
export function mailboxTitleLine(
  { name, unread, otherUnread = 0, ownInbox = false }: { name: string; unread: number; otherUnread?: number; ownInbox?: boolean },
  t: Translate,
): string {
  if (ownInbox && otherUnread > 0) {
    const total = unread + otherUnread;
    return unread > 0
      ? t('mail_p2_folders.title_all_accounts', { name, count: unread, total })
      : t('mail_p2_folders.title_all_accounts_only', { name, total });
  }
  return unread > 0 ? `${name} (${unread})` : name;
}
