// onAfterEmailSend: told once the server accepted a message.
//
// - A plain send is reported straight away, scheduledFor null.
// - A send the user scheduled for later is reported straight away too, with
//   scheduledFor: the server accepted it, even though it goes out later.
// - A send held back for undo ("Sending in 10 s") is reported only when the
//   hold runs out or the user picks "Send now". Undo drops it: that message
//   never leaves.
// A failed send never gets here; the callers only report a resolved send.
//
// `accountId` names the account the sent message lies in (ids repeat across
// accounts; a group identity's send lies in the group's), `composerId` the
// composer it came from, as its slots and actions know it, so a plugin can
// act on what the user chose there.

import type { SendEmailResult } from './jmap/types';
import { emailHooks } from './plugin-hooks';

export interface SentMessage {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** Set when the user scheduled the message; absent for an undo-send hold. */
  delayedUntil?: string;
  /** The id plugins know the sending composer by (composer-registry.ts). */
  composerId?: string;
}

interface AfterSendPayload {
  emailId: string | null;
  /** The JMAP account `emailId` lies in. */
  accountId: string | null;
  submissionId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  scheduledFor: string | null;
  composerId: string | null;
}

const held = new Map<string, { timer: ReturnType<typeof setTimeout>; payload: AfterSendPayload }>();

function emit(payload: AfterSendPayload): void {
  if (emailHooks.onAfterEmailSend.size === 0) return;
  void emailHooks.onAfterEmailSend.emit(payload);
}

/** Report a send the server accepted (see the rules above). */
export function announceSent(result: SendEmailResult, message: SentMessage): void {
  // Waiting in the offline outbox (#523): nothing left yet.
  if (result.queued) return;
  const payload: AfterSendPayload = {
    emailId: result.emailId ?? null,
    accountId: result.emailAccountId ?? null,
    submissionId: result.emailSubmissionId ?? null,
    to: [...message.to],
    cc: [...message.cc],
    bcc: [...message.bcc],
    subject: message.subject,
    scheduledFor: null,
    composerId: message.composerId ?? null,
  };
  if (message.delayedUntil) {
    emit({ ...payload, scheduledFor: result.sendAt ?? message.delayedUntil });
    return;
  }
  const submissionId = result.emailSubmissionId;
  if (result.scheduled && submissionId && result.sendAt) {
    const wait = Math.max(0, Date.parse(result.sendAt) - Date.now());
    const timer = setTimeout(() => {
      held.delete(submissionId);
      emit(payload);
    }, Number.isFinite(wait) ? wait : 0);
    held.set(submissionId, { timer, payload });
    return;
  }
  emit(payload);
}

/** The user undid a held send: it is not reported. */
export function cancelAnnouncedSend(submissionId: string): void {
  const entry = held.get(submissionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  held.delete(submissionId);
}

/** The user chose "Send now" for a held send: report it now. */
export function releaseAnnouncedSend(submissionId: string): void {
  const entry = held.get(submissionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  held.delete(submissionId);
  emit(entry.payload);
}

/** Drop every held send (tests). */
export function resetAnnouncedSends(): void {
  for (const { timer } of held.values()) clearTimeout(timer);
  held.clear();
}
