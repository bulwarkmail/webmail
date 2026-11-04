/**
 * New mail as native notifications, with the same rules as the app's other ways of
 * saying so. Mail notifications off or the app's Do not disturb: nothing. Mail that
 * arrives together is told about once. Sender and subject stay off the notification
 * when the app is locked, or when the organisation says so for that login
 * (pushWithoutContent, the rule the push preview route follows).
 *
 * Main decides what the OS allows: pause, quiet hours, Do Not Disturb. It answers
 * whether the page should play the sound the user picked, because this is the one
 * place that sound is played from in the desktop app.
 */

import { getDesktopBridge } from '@/lib/desktop/bridge';
import type { DesktopOsNotification } from '@/lib/desktop/types';
import { isAppLocked } from '@/lib/desktop/app-lock-state';
import { startNewMailWatch, type NewMail, type NewMailWatch } from '@/lib/desktop/new-mail';
import { setStoreCreatedListener } from '@/lib/desktop/system-events';
import { devicesForAccount } from '@/lib/device-policy';
import { playNotificationSound } from '@/lib/notification-sound';
import { isPopoutWindow } from '@/lib/popout/window-role';
import { loginFingerprint } from '@/lib/pwa-notify/login-fingerprint';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

export const MAIL_BATCH_MS = 3000;

export interface MailNotificationLabels {
  newMail: string;
  newMailCount: (count: number) => string;
  noSubject: string;
  archive: string | null;
  markRead: string;
  delete: string;
  reply: string;
  replyPlaceholder: string;
}

/** What a toast's button hands back, possibly after the app restarted. */
export interface MailNotificationContext {
  emailId?: string;
  threadId?: string;
  accountId?: string;
  slot?: number;
  login?: string;
  /** Not mail: an attachment saved in another program (components/desktop/edited-files-host.tsx). */
  editedFile?: boolean;
  /** Not mail: a draft thrown away in a composer window, for Undo (lib/popout/discarded-undo.ts). */
  discardedDraft?: string;
}

/** True where this module plays the new-mail sound, so useNewMailAlerts doesn't as well. */
export function desktopPlaysMailSound(): boolean {
  return !!getDesktopBridge()?.os && !isPopoutWindow();
}

interface Sender {
  entryId: string | null;
  slot?: number;
  login?: string;
  label: string | null;
}

async function senderInfo(client: IJMAPClient): Promise<Sender> {
  const auth = useAuthStore.getState();
  const accounts = useAccountStore.getState().accounts;
  const entry = accounts.find((account) => auth.getClientForAccount(account.id) === client)
    ?? (auth.client === client ? accounts.find((account) => account.id === auth.activeAccountId) : undefined);
  if (!entry) return { entryId: null, label: null };
  return {
    entryId: entry.id,
    slot: entry.cookieSlot,
    login: await loginFingerprint(entry.serverUrl, entry.username),
    label: accounts.length > 1 ? (entry.label || entry.email || entry.username || null) : null,
  };
}

/** Sender and subject stay off everything outside the app. Not knowing yet counts as yes. */
export function contentHiddenFor(accountEntryId: string | null | undefined): boolean {
  if (isAppLocked()) return true;
  // Unknown counts as on, as on the server's route.
  if (!accountEntryId || !usePolicyStore.getState().loaded) return true;
  try {
    return devicesForAccount(accountEntryId).pushWithoutContent;
  } catch {
    return true;
  }
}

function withoutContent(sender: Sender): boolean {
  return contentHiddenFor(sender.entryId);
}

function senderName(mail: NewMail): string {
  const first = mail.email.from?.[0];
  return first?.name || first?.email || '';
}

export async function buildMailNotification(batch: readonly NewMail[], labels: MailNotificationLabels): Promise<DesktopOsNotification> {
  const newest = batch.reduce((a, b) => (new Date(b.email.receivedAt ?? 0).getTime() > new Date(a.email.receivedAt ?? 0).getTime() ? b : a));
  const sender = await senderInfo(newest.client);
  const hidden = withoutContent(sender);
  const context: MailNotificationContext = { accountId: newest.accountId, slot: sender.slot, login: sender.login };
  const base = {
    id: `mail:${newest.accountId}/${newest.email.id}`,
    group: `mail:${newest.accountId}`,
    sound: true,
    attention: true,
  };
  const suffix = sender.label && !hidden ? ` (${sender.label})` : '';
  if (batch.length > 1) {
    return {
      ...base,
      title: `${labels.newMailCount(batch.length)}${suffix}`,
      body: hidden ? '' : `${senderName(newest)}: ${newest.email.subject || labels.noSubject}`,
      // Nothing for one message to act on: a click opens the Inbox.
      context: JSON.stringify(context),
    };
  }
  const full: MailNotificationContext = { ...context, emailId: newest.email.id, threadId: newest.email.threadId };
  if (hidden) {
    return { ...base, title: labels.newMail, body: '', context: JSON.stringify(full) };
  }
  return {
    ...base,
    title: `${senderName(newest) || labels.newMail}${suffix}`,
    body: newest.email.subject || newest.email.preview || labels.noSubject,
    context: JSON.stringify(full),
    actions: [
      ...(labels.archive ? [{ id: 'archive', label: labels.archive }] : []),
      { id: 'mark-read', label: labels.markRead },
      { id: 'delete', label: labels.delete },
    ],
    reply: { label: labels.reply, placeholder: labels.replyPlaceholder },
  };
}

export interface MailNotifications extends NewMailWatch {
  setLabels(labels: MailNotificationLabels): void;
}

export function startMailNotifications(initial: MailNotificationLabels): MailNotifications {
  let labels = initial;
  let batch: NewMail[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    const current = batch;
    batch = [];
    if (current.length === 0) return;
    const settings = useSettingsStore.getState();
    if (!settings.emailNotificationsEnabled || settings.doNotDisturb) return;
    void (async () => {
      const notification = await buildMailNotification(current, labels);
      const result = await getDesktopBridge()?.os?.notify({ ...notification, sound: settings.emailNotificationSound });
      if (result?.playSound) playNotificationSound(settings.notificationSoundChoice);
    })().catch((error) => {
      console.error('Failed to show a notification:', error);
    });
  };

  const watch = startNewMailWatch((mail) => {
    batch.push(...mail);
    timer ??= setTimeout(flush, MAIL_BATCH_MS);
  });

  const handle: MailNotifications = {
    ...watch,
    setLabels(next) {
      labels = next;
    },
    stop() {
      watch.stop();
      if (timer) clearTimeout(timer);
      timer = null;
      setStoreCreatedListener(null);
    },
  };
  setStoreCreatedListener((client, accountId, ids) => watch.noteCreated(client, accountId, ids));
  return handle;
}
