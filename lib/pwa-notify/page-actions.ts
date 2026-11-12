import { subjectForAccount } from '@/lib/org/account-subjects';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { loginFingerprint } from './login-fingerprint';
import { vetoHooksRegistered } from './plugin-veto';
import { useSettingsStore } from '@/stores/settings-store';

/** What the service worker posts when a notification's button is clicked (public/sw.js). */
export interface NotificationActionRequest {
  /** `delete` only comes from the desktop app's toasts, never from the worker. */
  action: 'archive' | 'mark-read' | 'reply' | 'delete';
  emailId: string;
  accountId: string;
  /** When the worker asked. */
  at: number;
  threadId?: string;
  slot?: number;
  login?: string;
  /** A reply typed on the notification, where the browser has a text field there. */
  text?: string;
}

/**
 * `declined`: not for this tab, the worker tries the next tab or the route.
 * `accepted`: this tab is on it. `done` and `failed`: how it ended; on
 * `failed` the message opens, and the route isn't tried.
 */
export type NotificationActionStatus = 'declined' | 'accepted' | 'done' | 'failed';

export interface NotificationReplyRequest {
  emailId: string;
  accountId: string;
  slot: number;
  text?: string;
}

/**
 * A tab that was frozen and thaws after this has lost the click: the worker has
 * moved on, maybe to the route or to opening the message. Past every wait in
 * sw.js for a tab to take an action.
 */
const REQUEST_MAX_AGE_MS = 5_000;

type ReplyOpener = (request: NotificationReplyRequest) => void;

let replyOpener: ReplyOpener | null = null;

/** The mail page opens replies. On other pages the worker navigates to it instead. */
export function setNotificationReplyOpener(opener: ReplyOpener): () => void {
  replyOpener = opener;
  return () => {
    if (replyOpener === opener) replyOpener = null;
  };
}

export function isNotificationActionRequest(value: unknown): value is NotificationActionRequest {
  const request = value as Partial<NotificationActionRequest> | null;
  return !!request
    && (request.action === 'archive' || request.action === 'mark-read' || request.action === 'reply')
    && typeof request.emailId === 'string' && !!request.emailId
    && typeof request.accountId === 'string' && !!request.accountId
    && typeof request.at === 'number';
}

/** The account of this tab's registry the notification is for, if it still means that login. */
async function loginOf(request: NotificationActionRequest) {
  const entry = useAccountStore.getState().accounts.find((account) => account.cookieSlot === request.slot);
  if (!entry || !request.login) return null;
  return (await loginFingerprint(entry.serverUrl, entry.username)) === request.login ? entry : null;
}

/** The Archive gate as it applies to this login, whichever login is active here. */
function archiveEnabledFor(accountEntryId: string): boolean {
  return usePolicyStore.getState().resolveFor(subjectForAccount(accountEntryId)).features?.archiveActionEnabled !== false;
}

/**
 * Runs a notification's button in this tab, through the same store actions as
 * the app's own buttons: plugin hooks, archive mode and the Archive gate all
 * apply, and the list on screen follows. What this tab can't do while plugins
 * listen ends in `failed`, not `declined`: the route has no plugins.
 */
export async function runNotificationAction(
  request: NotificationActionRequest,
  answer: (status: NotificationActionStatus) => void,
): Promise<void> {
  try {
    if (Date.now() - request.at > REQUEST_MAX_AGE_MS) {
      answer('declined');
      return;
    }
    const entry = await loginOf(request);
    if (!entry) {
      answer('declined');
      return;
    }
    const passOn = () => answer(vetoHooksRegistered() ? 'failed' : 'declined');
    const auth = useAuthStore.getState();
    const client = auth.getClientForAccount(entry.id) ?? (entry.id === auth.activeAccountId ? auth.client : null);
    const activeClient = auth.client;
    if (request.action === 'reply') {
      if (!client || !replyOpener || request.slot === undefined) {
        answer('declined');
        return;
      }
      replyOpener({ emailId: request.emailId, accountId: request.accountId, slot: request.slot, text: request.text });
      answer('done');
      return;
    }
    if (!client || !activeClient) {
      passOn();
      return;
    }

    const own = request.accountId === client.getAccountId();
    if (request.action === 'archive') {
      // The route would refuse it too.
      if (!archiveEnabledFor(entry.id)) {
        answer('failed');
        return;
      }
      // The store's targeted archive reads a login's own folders only. A shared
      // account's Archive is the route's to find.
      if (!own) {
        passOn();
        return;
      }
    }

    answer('accepted');
    const accountId = own ? undefined : request.accountId;
    // Unknown with the mail server out of reach. Mark read then queues like the
    // app's own button; Archive files by date and can't go without the message.
    const [email, mailboxes] = await Promise.all([
      client.getEmail(request.emailId, accountId).catch(() => null),
      client.getMailboxes(accountId).catch(() => []),
    ]);
    if (request.action === 'archive' && !email) {
      answer('failed');
      return;
    }
    // Since the notification it may have gone to Trash or Junk: not for a toast
    // to bring back or to mark. The app opens it.
    const inBin = Object.keys(email?.mailboxIds ?? {}).some((id) => {
      const mailbox = mailboxes.find((m) => m.id === id || m.originalId === id);
      return mailbox?.role === 'trash' || mailbox?.role === 'junk';
    });
    if (inBin) {
      answer('failed');
      return;
    }
    if (request.action === 'delete') {
      const store = useEmailStore.getState();
      // In the list: the store's own delete, with its hooks and the Delete
      // setting, for this login and account's message, not a listed row of
      // another account with its id.
      if (store.emails.some((row) => row.id === request.emailId && (row.sourceClientAccountId ?? entry.id) === entry.id)) {
        const source = { clientAccountId: entry.id, accountId: request.accountId, email: email ?? undefined };
        answer(await store.deleteEmail(client, request.emailId, false, undefined, source) ? 'done' : 'failed');
        return;
      }
      // Not in the list, so no store action can reach it, and plugins are never gone round.
      const trash = mailboxes.find((mailbox) => mailbox.role === 'trash');
      if (!trash || !email || vetoHooksRegistered()) {
        answer('failed');
        return;
      }
      const markRead = useSettingsStore.getState().deleteAction === 'trash-and-read';
      await client.batchMoveEmails([request.emailId], trash.originalId || trash.id, accountId, markRead);
      answer('done');
      return;
    }
    const done = request.action === 'mark-read'
      ? await useEmailStore.getState().batchMarkAsRead(activeClient, true, { emailIds: [request.emailId], client, accountId })
      : await useEmailStore.getState().batchArchive(activeClient, { emailIds: [request.emailId], client, emails: email ? [email] : [], userArchive: true });
    answer(done ? 'done' : 'failed');
  } catch {
    answer('failed');
  }
}
