/**
 * What the OS asks of the app, carried out with what the app already has: the launch
 * handoff for files and new messages, the protocol handlers for mailto: and webcal:,
 * the notification actions for a toast's buttons. A bridge command comes from the
 * user's own OS, so it skips the question a web share gets (decision 17).
 */

import { isAppLocked } from '@/lib/desktop/app-lock-state';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import type { DesktopOsCommand } from '@/lib/desktop/types';
import { openMailLink } from '@/lib/desktop/mail-links';
import { requestFileChoice } from '@/lib/file-drop/choice';
import { handleReminderCommand } from '@/lib/desktop/reminder-notifications';
import type { MailNotificationContext } from '@/lib/desktop/mail-notifications';
import { handOffDraft, handOffFiles, handOffNewMessage, kindForFile } from '@/lib/launch-handoff';
import { parseMailto } from '@/lib/protocol-handlers/mailto';
import { notifyPendingMailto, notifyPendingWebcal, savePendingMailto, savePendingWebcal } from '@/lib/protocol-handlers/session';
import { parseWebcal } from '@/lib/protocol-handlers/webcal';
import { loginFingerprint } from '@/lib/pwa-notify/login-fingerprint';
import { runNotificationAction, type NotificationActionRequest, type NotificationActionStatus } from '@/lib/pwa-notify/page-actions';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';

export interface OsCommandEnv {
  /** Goes to a page, saving an open composer first. */
  leaveFor: (path: '/' | '/calendar' | '/contacts') => void | Promise<void>;
  /** A route change that isn't leaving anything behind. */
  push: (path: string) => void;
  /** Says something couldn't be opened. */
  notifyFailed: (names: readonly string[]) => void;
  /** A typed reply that has nowhere to go: its message's login is gone from here. */
  notifyReplyLost: () => void;
}

/** How long a toast's button waits for a cold start to sign in. */
const SIGN_IN_WAIT_MS = 30_000;

function parseContext(raw: string | undefined): MailNotificationContext {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as MailNotificationContext : {};
  } catch {
    return {};
  }
}

function whenSignedIn(): Promise<boolean> {
  return new Promise((resolve) => {
    if (useAuthStore.getState().isAuthenticated) {
      resolve(true);
      return;
    }
    const finish = (value: boolean) => {
      clearTimeout(timer);
      stop();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), SIGN_IN_WAIT_MS);
    const stop = useAuthStore.subscribe((state) => {
      if (state.isAuthenticated) finish(true);
    });
  });
}

/** A slot goes to whoever signs in next: a day-old toast has to still mean this login. */
async function stillThatLogin(context: MailNotificationContext): Promise<boolean> {
  if (context.slot === undefined || !context.login) return false;
  const entry = useAccountStore.getState().accounts.find((account) => account.cookieSlot === context.slot);
  return !!entry && (await loginFingerprint(entry.serverUrl, entry.username)) === context.login;
}

function showWindow(): void {
  getDesktopBridge()?.windows?.focus?.();
}

async function openFromNotification(context: MailNotificationContext, env: OsCommandEnv, reply?: { text: string }): Promise<void> {
  showWindow();
  await whenSignedIn();
  const known = await stillThatLogin(context);
  if (known && context.emailId) {
    openMailLink({ kind: 'message', id: context.emailId, slot: context.slot, ownerAccountId: context.accountId, ...(reply ? { reply: true } : {}) }, reply ? { replyText: reply.text } : undefined, env.leaveFor);
    return;
  }
  if (reply?.text) env.notifyReplyLost();
  openMailLink({ kind: 'folder', ref: 'inbox', ...(known ? { slot: context.slot } : {}) }, undefined, env.leaveFor);
}

function runAction(request: NotificationActionRequest): Promise<NotificationActionStatus> {
  return new Promise((resolve) => {
    void runNotificationAction(request, (status) => {
      if (status !== 'accepted') resolve(status);
    });
  });
}

async function handleNotification(action: string, rawContext: string, reply: string | undefined, env: OsCommandEnv): Promise<void> {
  // An old toast's Delete doesn't act behind the lock, and its message doesn't open over it.
  if (isAppLocked()) {
    showWindow();
    return;
  }
  if (await handleReminderCommand(action, rawContext, env)) return;
  const context = parseContext(rawContext);
  // A saved file's toast: the offer is on the main window, wherever it was.
  if (context.editedFile) {
    showWindow();
    return;
  }
  if (action === 'reply') {
    await openFromNotification(context, env, { text: reply ?? '' });
    return;
  }
  if ((action === 'archive' || action === 'mark-read' || action === 'delete') && context.emailId && context.accountId) {
    if (await whenSignedIn()) {
      const status = await runAction({
        action,
        emailId: context.emailId,
        accountId: context.accountId,
        threadId: context.threadId,
        slot: context.slot,
        login: context.login,
        at: Date.now(),
      });
      if (status === 'done') return;
    }
  }
  // Clicked, or the button couldn't be carried out here: the message opens.
  await openFromNotification(context, env);
}

function handleFiles(command: Extract<DesktopOsCommand, { type: 'files' }>, env: OsCommandEnv): void {
  const made = command.files.map(({ name, data }) => new File([new Uint8Array(data)], name));
  const failed = [...command.failed];
  if (command.reason === 'attach' && command.ask) {
    // Opened with the app ("Open with"): the same choice as dropping it on the window.
    requestFileChoice({ files: made, preferred: 'new-message' });
  } else if (command.reason === 'attach') {
    if (made.length > 0) handOffDraft({ files: made });
  } else {
    for (const file of made) {
      const kind = kindForFile(file);
      if (kind) handOffFiles([file], kind);
      else failed.push(file.name);
    }
  }
  if (failed.length > 0) env.notifyFailed(failed);
}

export function handleOsCommand(command: DesktopOsCommand, env: OsCommandEnv): void | Promise<void> {
  switch (command.type) {
    case 'new-message':
      handOffNewMessage();
      return;
    case 'navigate':
      if (command.target === 'inbox') openMailLink({ kind: 'folder', ref: 'inbox' }, undefined, env.leaveFor);
      else void env.leaveFor(`/${command.target}`);
      return;
    case 'open-message': {
      const context = parseContext(command.context);
      if (context.slot !== undefined) return openFromNotification({ ...context, emailId: command.emailId }, env);
      openMailLink({ kind: 'message', id: command.emailId, ownerAccountId: command.accountId }, undefined, env.leaveFor);
      return;
    }
    case 'open-mailbox':
      openMailLink({ kind: 'folder', ref: command.mailboxId }, undefined, env.leaveFor);
      return;
    case 'mailto': {
      const parsed = parseMailto(command.url);
      if (!parsed) return;
      // The shell leaves the main window where it is for a mail link. Signed out, the
      // sign-in has to show.
      if (!useAuthStore.getState().isAuthenticated) getDesktopBridge()?.windows?.focus?.();
      savePendingMailto({ ...parsed, fromOs: true });
      notifyPendingMailto();
      env.push('/');
      return;
    }
    case 'webcal': {
      const parsed = parseWebcal(command.url);
      if (!parsed) return;
      savePendingWebcal(parsed);
      notifyPendingWebcal();
      env.push('/calendar');
      return;
    }
    case 'files':
      handleFiles(command, env);
      return;
    case 'notification':
      return handleNotification(command.action, command.context, command.reply, env);
  }
}

/** Listens for as long as the page lives. Commands wait in main until this runs. */
export function startOsCommands(env: OsCommandEnv): () => void {
  const os = getDesktopBridge()?.os;
  if (!os) return () => {};
  return os.onCommand((command) => {
    void Promise.resolve(handleOsCommand(command, env)).catch((error) => {
      console.error('An OS command failed:', error);
    });
  });
}
