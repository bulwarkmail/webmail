import { describe, expect, it } from 'vitest';
import { NoLongerScheduledError, RecipientsRejectedError, RequestTimeoutError, RescheduleRestoredError, ScheduleTooLateError, SubmissionQuotaError, formatRejectedRecipients } from '../jmap/client';
import { SendCancelledCleanupError, cancelFailureToast, partlyRefusedWarning, rescheduleFailureToast, rescheduledToast, sendFailureMessage } from '../send-failure-message';

// Keys of a namespace, returned with their values so the test sees which
// message was chosen and what went into it.
const translator = (namespace: string) => (key: string, values?: Record<string, string>) =>
  values ? `${namespace}.${key} ${JSON.stringify(values)}` : `${namespace}.${key}`;
const t = translator('email_composer');
const tViewer = translator('email_viewer');

const STALWART_QUOTA = 'There are too many email submissions, please delete some before adding a new one.';

describe('sendFailureMessage', () => {
  it('explains a full submission quota instead of showing the server text on Stalwart 1.0', () => {
    const error = new SubmissionQuotaError(STALWART_QUOTA, true);

    expect(sendFailureMessage(error, t)).toBe('email_composer.submission_quota');
  });

  it("gives another server's overQuota its own description, not Stalwart's explanation", () => {
    expect(sendFailureMessage(new SubmissionQuotaError('Daily sending limit exceeded'), t))
      .toBe('email_composer.submission_limit {"reason":"Daily sending limit exceeded"}');
    expect(sendFailureMessage(new SubmissionQuotaError(undefined, false), t))
      .toBe('email_composer.submission_limit {"reason":"overQuota"}');
  });

  it('points at Sent after a timeout and names the hold limit', () => {
    expect(sendFailureMessage(new RequestTimeoutError(30_000), t)).toBe('email_composer.send_timeout');
    expect(sendFailureMessage(new ScheduleTooLateError(604800), t)).toBe('email_composer.schedule_send_too_late');
  });

  it("shows other errors' own text, and a generic message when there is none", () => {
    expect(sendFailureMessage(new Error('Envelope mailFrom does not match identity email address. [forbiddenFrom]'), t))
      .toBe('Envelope mailFrom does not match identity email address. [forbiddenFrom]');
    expect(sendFailureMessage(new Error(''), t)).toBe('email_composer.send_failed');
    expect(sendFailureMessage('nope', t)).toBe('email_composer.send_failed');
  });

  // Stalwart 0.16 and 1.0 take the submission and refuse the recipients at
  // RCPT, each with its own reply.
  it('says the message was not sent and names every refused recipient with its reply', () => {
    const error = new RecipientsRejectedError([
      { email: 'nobody@example.net', smtpReply: '550 5.1.2 Relay not allowed.' },
      { email: 'busy@example.org', smtpReply: '452 4.4.5 Rate limit exceeded, try again later.' },
    ]);

    expect(sendFailureMessage(error, t)).toBe(
      'email_composer.recipients_refused {"recipients":"nobody@example.net (550 5.1.2 Relay not allowed.), busy@example.org (452 4.4.5 Rate limit exceeded, try again later.)"}',
    );
  });
});

describe('formatRejectedRecipients', () => {
  it('lists an address without its reply when the server gave none', () => {
    expect(formatRejectedRecipients([{ email: 'a@example.net', smtpReply: '' }, { email: 'b@example.net', smtpReply: '550 5.1.1 No such user' }]))
      .toBe('a@example.net, b@example.net (550 5.1.1 No such user)');
  });
});

describe('rescheduleFailureToast', () => {
  it('says the message is still scheduled, and when, at a full quota on Stalwart 1.0', () => {
    const error = new SubmissionQuotaError(STALWART_QUOTA, true);

    expect(rescheduleFailureToast(error, tViewer, t, 'Sep 26, 10:00')).toEqual({
      title: 'email_viewer.still_scheduled_at {"date":"Sep 26, 10:00"}',
      message: 'email_composer.submission_quota',
    });
    expect(rescheduleFailureToast(error, tViewer, t).title).toBe('email_viewer.still_scheduled');
  });

  it('says the message went out, or is no longer scheduled, when the original left the queue meanwhile', () => {
    expect(rescheduleFailureToast(new NoLongerScheduledError(true), tViewer, t, 'Sep 26, 10:00'))
      .toEqual({ title: 'email_viewer.already_sent' });
    expect(rescheduleFailureToast(new NoLongerScheduledError(false), tViewer, t))
      .toEqual({ title: 'email_viewer.no_longer_scheduled' });
  });

  // The original is kept for all of its recipients, so the headline must not
  // read as "not sent", which invites sending the message a second time.
  it('leads with the kept schedule when the server refused recipients of the replacement (Stalwart 0.16 and 1.0)', () => {
    const error = new RecipientsRejectedError([{ email: 'bob@example.org', smtpReply: '452 4.4.5 Rate limit exceeded, try again later.' }]);

    expect(rescheduleFailureToast(error, tViewer, t, 'Sep 26, 10:00')).toEqual({
      title: 'email_viewer.still_scheduled_at {"date":"Sep 26, 10:00"}',
      message: 'email_viewer.reschedule_recipients_refused {"recipients":"bob@example.org (452 4.4.5 Rate limit exceeded, try again later.)"}',
    });
    expect(rescheduleFailureToast(error, tViewer, t).title).toBe('email_viewer.still_scheduled');
  });

  it('leads with the kept schedule when the server refused the new time as too far ahead (#1897)', () => {
    const error = new RescheduleRestoredError('too late', 'restored', '2026-09-26T08:00:00Z', new ScheduleTooLateError(604800));

    expect(rescheduleFailureToast(error, tViewer, t, 'Sep 26, 10:00')).toEqual({
      title: 'email_viewer.still_scheduled_at {"date":"Sep 26, 10:00"}',
      message: 'email_composer.schedule_send_too_late',
    });
  });

  it('falls back to the send failure message otherwise', () => {
    expect(rescheduleFailureToast(new RequestTimeoutError(30_000), tViewer, t, 'Sep 26, 10:00'))
      .toEqual({ title: 'email_composer.send_timeout' });
    expect(rescheduleFailureToast(new Error('cannotUnsend'), tViewer, t)).toEqual({ title: 'cannotUnsend' });
  });
});

describe('partlyRefusedWarning', () => {
  it('names the recipients the server refused while it took the others', () => {
    expect(partlyRefusedWarning({ rejectedRecipients: [{ email: 'nobody@example.net', smtpReply: '550 5.1.2 Relay not allowed.' }] }, t))
      .toBe('email_composer.recipients_partly_refused {"recipients":"nobody@example.net (550 5.1.2 Relay not allowed.)"}');
  });

  it('says nothing when the server took every recipient', () => {
    expect(partlyRefusedWarning({}, t)).toBeNull();
    expect(partlyRefusedWarning({ rejectedRecipients: [] }, t)).toBeNull();
  });
});

// A reschedule that went through said nothing at all.
describe('rescheduledToast', () => {
  it('says when the message goes out now', () => {
    expect(rescheduledToast({}, tViewer, t, 'Thu, Oct 29, 08:00'))
      .toEqual({ kind: 'success', title: 'email_viewer.rescheduled_for {"date":"Thu, Oct 29, 08:00"}' });
  });

  it('warns about the recipients the server refused', () => {
    const toast = rescheduledToast({ rejectedRecipients: [{ email: 'nobody@example.net', smtpReply: '550 5.1.1 No such user' }] }, tViewer, t, 'Mon, Nov 2, 08:00');
    expect(toast.kind).toBe('warning');
    expect(toast.title).toBe('email_viewer.rescheduled_for {"date":"Mon, Nov 2, 08:00"}');
    expect(toast.message).toContain('email_composer.recipients_partly_refused');
  });
});

describe('cancelFailureToast', () => {
  it('reports a failed cancel with its reason: the mail may still go out', () => {
    expect(cancelFailureToast(new Error('The requested message is no longer in the queue.'), tViewer, 'Undo send failed'))
      .toEqual({ title: 'Undo send failed', message: 'The requested message is no longer in the queue.' });
  });

  it('says the send was cancelled when only a step after the cancel failed', () => {
    expect(cancelFailureToast(new SendCancelledCleanupError('restore', new Error('503')), tViewer, 'Undo send failed'))
      .toEqual({ title: 'email_viewer.send_cancelled_restore_failed' });
    expect(cancelFailureToast(new SendCancelledCleanupError('remove', new Error('503')), tViewer, 'Undo send failed'))
      .toEqual({ title: 'email_viewer.send_cancelled_remove_failed' });
  });
});
