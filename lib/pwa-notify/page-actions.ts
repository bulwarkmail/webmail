import { isArchiveActionEnabled } from '@/lib/archive-gate';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { loginFingerprint } from './login-fingerprint';

/** What the service worker posts when a notification's button is clicked (public/sw.js). */
export interface NotificationActionRequest {
  action: 'archive' | 'mark-read' | 'reply';
  emailId: string;
  accountId: string;
  threadId?: string;
  slot?: number;
  login?: string;
  /** A reply typed on the notification, where the browser has a text field there. */
  text?: string;
}

/**
 * `declined`: not for this tab, the worker tries the next tab or the route.
 * `accepted`: this tab is on it. `done` and `failed`: how it ended.
 */
export type NotificationActionStatus = 'declined' | 'accepted' | 'done' | 'failed';

export interface NotificationReplyRequest {
  emailId: string;
  accountId: string;
  slot: number;
  text?: string;
}

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
    && typeof request.accountId === 'string' && !!request.accountId;
}

/** The login the notification is for, if this tab has it signed in right now. */
async function loginOf(request: NotificationActionRequest) {
  const entry = useAccountStore.getState().accounts.find((account) => account.cookieSlot === request.slot);
  if (!entry || !request.login) return null;
  if ((await loginFingerprint(entry.serverUrl, entry.username)) !== request.login) return null;
  const auth = useAuthStore.getState();
  const client = auth.getClientForAccount(entry.id) ?? (entry.id === auth.activeAccountId ? auth.client : null);
  return client ? { client } : null;
}

/**
 * Runs a notification's button in this tab, through the same store actions as
 * the app's own buttons: plugin hooks, archive mode and the Archive gate all
 * apply, and the list on screen follows.
 */
export async function runNotificationAction(
  request: NotificationActionRequest,
  answer: (status: NotificationActionStatus) => void,
): Promise<void> {
  try {
    const login = await loginOf(request);
    const activeClient = useAuthStore.getState().client;
    if (!login || !activeClient) {
      answer('declined');
      return;
    }
    if (request.action === 'reply') {
      if (!replyOpener || request.slot === undefined) {
        answer('declined');
        return;
      }
      replyOpener({ emailId: request.emailId, accountId: request.accountId, slot: request.slot, text: request.text });
      answer('done');
      return;
    }

    const own = request.accountId === login.client.getAccountId();
    if (request.action === 'mark-read') {
      answer('accepted');
      await useEmailStore.getState().batchMarkAsRead(activeClient, true, {
        emailIds: [request.emailId],
        client: login.client,
        accountId: own ? undefined : request.accountId,
      });
      answer('done');
      return;
    }

    // The store's targeted archive reads a login's own folders only. A shared
    // account's Archive is the route's to find.
    if (!own || !isArchiveActionEnabled()) {
      answer('declined');
      return;
    }
    answer('accepted');
    const email = await login.client.getEmail(request.emailId);
    if (!email) {
      answer('failed');
      return;
    }
    const archived = await useEmailStore.getState().batchArchive(activeClient, {
      emailIds: [request.emailId],
      client: login.client,
      emails: [email],
    });
    answer(archived ? 'done' : 'failed');
  } catch {
    answer('failed');
  }
}
