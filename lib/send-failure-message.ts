import { NoLongerScheduledError, RecipientsRejectedError, RequestTimeoutError, ScheduleTooLateError, SubmissionQuotaError, formatRejectedRecipients } from '@/lib/jmap/client';
import { RescheduleRestoredError } from '@/lib/jmap/reschedule-error';
import type { RejectedRecipient } from '@/lib/jmap/types';

type Translate = (key: string, values?: Record<string, string>) => string;

/**
 * Thrown by "Undo send" and "Cancel and edit" when the cancel went through
 * but a step after it failed: putting the message back in Drafts
 * (`restore`), or removing the copy of an S/MIME message, which is composed
 * again from scratch (`remove`). Nothing goes out; the message is still in
 * Sent. Reported apart from a failed cancel, which may still let it go.
 */
export class SendCancelledCleanupError extends Error {
  constructor(readonly step: 'restore' | 'remove', readonly reason: unknown) {
    super(step === 'restore'
      ? 'Sending was cancelled, but the message could not be put back in Drafts'
      : 'Sending was cancelled, but the unsent message could not be removed from Sent');
    this.name = 'SendCancelledCleanupError';
  }
}

/**
 * What to tell the user about a send (or reschedule) that failed, from the
 * `email_composer` messages. Most errors carry the server's own description;
 * these are the ones it would misrepresent or leave unexplained:
 * - a full submission quota on Stalwart: it asks the user to "delete some",
 *   but the client has already removed every record it may, so only an
 *   administrator can help. Another server's overQuota may stand for any
 *   sending limit, so its own description goes with a generic sentence;
 * - a timeout, which is not a clean failure: the submission may have reached
 *   the server and gone out, with only the answer lost. Saying "send failed"
 *   would invite a re-send and a duplicate, so point at Sent instead (#702);
 * - a hold beyond the server's limit;
 * - every recipient refused: the server took the submission, so nothing
 *   else would say that the message went nowhere. Its reply per address
 *   goes with it.
 */
export function sendFailureMessage(error: unknown, t: Translate): string {
  if (error instanceof SubmissionQuotaError) {
    return error.countsRecords
      ? t('submission_quota')
      : t('submission_limit', { reason: error.description || error.jmapType });
  }
  if (error instanceof RequestTimeoutError) return t('send_timeout');
  if (error instanceof ScheduleTooLateError) return t('schedule_send_too_late');
  if (error instanceof RecipientsRejectedError) {
    return t('recipients_refused', { recipients: formatRejectedRecipients(error.recipients) });
  }
  return error instanceof Error && error.message ? error.message : t('send_failed');
}

/**
 * The toast for a failed "Send now" or "Reschedule", from the `email_viewer`
 * (`tViewer`) and `email_composer` (`tComposer`) messages. At a full
 * submission quota no replacement was made, so the message still goes out at
 * its old time, `scheduledAt` (formatted) when known. Making room takes a
 * while, and the original may have gone out meanwhile. When the server
 * refused recipients of the replacement that the original had taken, the
 * original was kept too, for all of its recipients - a headline saying the
 * mail wasn't sent would invite sending it a second time.
 */
export function rescheduleFailureToast(
  error: unknown,
  tViewer: Translate,
  tComposer: Translate,
  scheduledAt?: string,
): { title: string; message?: string } {
  if (error instanceof NoLongerScheduledError) {
    return { title: tViewer(error.sent ? 'already_sent' : 'no_longer_scheduled') };
  }
  const stillScheduled = scheduledAt ? tViewer('still_scheduled_at', { date: scheduledAt }) : tViewer('still_scheduled');
  if (error instanceof SubmissionQuotaError) {
    return { title: stillScheduled, message: sendFailureMessage(error, tComposer) };
  }
  if (error instanceof RecipientsRejectedError) {
    return {
      title: stillScheduled,
      message: tViewer('reschedule_recipients_refused', { recipients: formatRejectedRecipients(error.recipients) }),
    };
  }
  // The server refused the new time as too far ahead and the original was
  // put back: it still goes at its old time.
  if (error instanceof RescheduleRestoredError && error.reason instanceof ScheduleTooLateError) {
    return { title: stillScheduled, message: sendFailureMessage(error.reason, tComposer) };
  }
  return { title: sendFailureMessage(error, tComposer) };
}

/**
 * The warning after a send, "Send now" or reschedule that the server took for
 * some recipients only (`rejectedRecipients`), from the `email_composer`
 * messages; null when it took them all. Nothing else, not even a bounce,
 * tells the user who never gets the message.
 */
export function partlyRefusedWarning(result: { rejectedRecipients?: RejectedRecipient[] }, tComposer: Translate): string | null {
  return result.rejectedRecipients?.length
    ? tComposer('recipients_partly_refused', { recipients: formatRejectedRecipients(result.rejectedRecipients) })
    : null;
}

/**
 * The toast after a reschedule the server took (R9): when the message goes
 * out now (`sendAt`, formatted), and whom the server refused, if anyone.
 */
export function rescheduledToast(
  result: { rejectedRecipients?: RejectedRecipient[] },
  tViewer: Translate,
  tComposer: Translate,
  sendAt: string,
): { kind: 'success' | 'warning'; title: string; message?: string } {
  const title = tViewer('rescheduled_for', { date: sendAt });
  const refused = partlyRefusedWarning(result, tComposer);
  return refused ? { kind: 'warning', title, message: refused } : { kind: 'success', title };
}

/**
 * The toast for a failed "Undo send" or "Cancel and edit". A failed cancel
 * may still let the mail go, so it must never read as done: it gets
 * `cancelFailedTitle` and the reason. One that went through while a step
 * after it failed says where the message is instead.
 */
export function cancelFailureToast(
  error: unknown,
  tViewer: Translate,
  cancelFailedTitle: string,
): { title: string; message?: string } {
  if (error instanceof SendCancelledCleanupError) {
    return { title: tViewer(error.step === 'restore' ? 'send_cancelled_restore_failed' : 'send_cancelled_remove_failed') };
  }
  return { title: cancelFailedTitle, message: error instanceof Error ? error.message : undefined };
}
