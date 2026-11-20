/**
 * A mention of the user in a team note (lib/team-mailboxes/note-format.ts) as a
 * native notification in the desktop app, with the rules new mail follows: mail
 * notifications off, Do not disturb or a muted account say nothing; author and
 * subject stay off it when the app is locked or the organisation says so for the
 * login (contentHiddenFor). A click opens the conversation at the note.
 *
 * Only notes of kind `note` mention anyone: a timeline entry names its assignee
 * in the same header, and that is no mention. Each note is told once, whichever
 * source reports it (the team notes store, or a watcher that runs from sign-in).
 */

import { getDesktopBridge } from '@/lib/desktop/bridge';
import { contentHiddenFor, type MailNotificationContext } from '@/lib/desktop/mail-notifications';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { isAccountMuted } from '@/lib/notification-mutes';
import { playNotificationSound } from '@/lib/notification-sound';
import { isPopoutWindow } from '@/lib/popout/window-role';
import { loginFingerprint } from '@/lib/pwa-notify/login-fingerprint';
import { isOwnNote, type NoteEntry } from '@/lib/team-mailboxes/note-format';
import type { TeamRef } from '@/lib/team-mailboxes/team';
import { useAccountStore } from '@/stores/account-store';
import { useSettingsStore } from '@/stores/settings-store';
import { onNotesArrived } from '@/stores/team-mailbox-store';

export interface MentionLabels {
  /** "Mabel mentioned you in “Offer”". */
  mentionedYou: (name: string, subject: string) => string;
  /** Says nothing about the note. */
  mentionedHidden: string;
}

/** A note older than this is no news (an index loaded late, a restore). */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TOLD_LIMIT = 500;
const told: string[] = [];

/** The message a note is about, in the team's account, for the click. */
async function messageOf(client: IJMAPClient, ref: TeamRef, note: NoteEntry): Promise<string | undefined> {
  const own = `jmap:${ref.accountId}/`;
  if (note.key.startsWith(own)) return note.key.slice(own.length) || undefined;
  if (!note.threadId) return undefined;
  try {
    // Header queries find nothing on Stalwart: the note's thread says where it is.
    const thread = await client.getThread(note.threadId, ref.accountId);
    const ids = thread?.emailIds ?? [];
    if (ids.length === 0) return undefined;
    const { list } = client.getTeamNotes ? await client.getTeamNotes(ref.accountId, ids, ['id', 'messageId']) : { list: [] };
    const match = list.find((raw) => Array.isArray(raw.messageId)
      && raw.messageId.some((value) => typeof value === 'string' && value.replace(/^\s*<|>\s*$/g, '') === note.key));
    // Thread/get lists the messages oldest first.
    return typeof match?.id === 'string' ? match.id : ids[ids.length - 1];
  } catch {
    return undefined;
  }
}

/**
 * Tells the user of one note that mentions them, in the desktop app's main
 * window. Resolves true when a notification went out.
 */
export async function notifyDesktopMention(ref: TeamRef, client: IJMAPClient, note: NoteEntry, labels: MentionLabels): Promise<boolean> {
  const os = getDesktopBridge()?.os;
  if (!os || isPopoutWindow()) return false;
  if (note.kind !== 'note') return false;
  if (!note.mentions.includes(client.getAccountId().toLowerCase())) return false;
  if (isOwnNote(note, client.getUsername())) return false;
  if (note.at > 0 && Date.now() - note.at > MAX_AGE_MS) return false;
  const settings = useSettingsStore.getState();
  if (!settings.emailNotificationsEnabled || settings.doNotDisturb) return false;
  if (isAccountMuted(settings.notificationMutes, ref.accountId)) return false;
  const toldKey = `${ref.key}|${note.id}`;
  if (told.includes(toldKey)) return false;
  told.push(toldKey);
  if (told.length > TOLD_LIMIT) told.splice(0, told.length - TOLD_LIMIT);

  const entry = useAccountStore.getState().accounts.find((account) => account.id === ref.loginId);
  const hidden = contentHiddenFor(entry?.id ?? null);
  const name = note.author.name || note.author.email;
  const subject = note.subject?.trim() ?? '';
  const context: MailNotificationContext = {
    accountId: ref.accountId,
    threadId: note.threadId ?? undefined,
    note: note.id,
    ...(entry ? { slot: entry.cookieSlot, login: await loginFingerprint(entry.serverUrl, entry.username) } : {}),
  };
  const emailId = await messageOf(client, ref, note);
  if (emailId) context.emailId = emailId;
  try {
    const result = await os.notify({
      id: `mention:${ref.accountId}/${note.id}`,
      group: `mention:${ref.accountId}`,
      title: hidden || !subject ? labels.mentionedHidden : labels.mentionedYou(name, subject),
      body: '',
      context: JSON.stringify(context),
      sound: settings.emailNotificationSound,
      attention: true,
    });
    if (result?.playSound) playNotificationSound(settings.notificationSoundChoice);
    return true;
  } catch (error) {
    console.error('Failed to show a mention:', error);
    return false;
  }
}

/** Mentions in notes the team notes store reports, for as long as the handle lives. */
export function startMentionNotifications(labels: () => MentionLabels | null): () => void {
  return onNotesArrived((ref, client, notes) => {
    const current = labels();
    if (!current) return;
    for (const note of notes) {
      void notifyDesktopMention(ref, client, note, current);
    }
  });
}

/** For tests. */
export function resetToldMentions(): void {
  told.length = 0;
}
