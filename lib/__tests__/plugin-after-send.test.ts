// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { emailHooks, clearAllHooks } from '../plugin-hooks';
import { announceSent, cancelAnnouncedSend, releaseAnnouncedSend, resetAnnouncedSends, whenSent } from '../plugin-after-send';

const message = { to: ['bob@example.com'], cc: [], bcc: [], subject: 'Hi' };

beforeEach(() => {
  vi.useFakeTimers();
  clearAllHooks();
  resetAnnouncedSends();
});
afterEach(() => vi.useRealTimers());

describe('announceSent for a send held back for undo', () => {
  const held = () => ({ scheduled: true, emailId: 'e1', emailSubmissionId: 's1', sendAt: new Date(Date.now() + 10_000).toISOString() });

  it('reports when the hold runs out', () => {
    const sent = vi.fn();
    emailHooks.onAfterEmailSend.register('t', sent);
    announceSent(held(), message);
    vi.advanceTimersByTime(9_000);
    expect(sent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(sent).toHaveBeenCalledWith({ emailId: 'e1', accountId: null, submissionId: 's1', ...message, scheduledFor: null, composerId: null });
  });

  it('reports at once on "Send now"', () => {
    const sent = vi.fn();
    emailHooks.onAfterEmailSend.register('t', sent);
    announceSent(held(), message);
    releaseAnnouncedSend('s1');
    expect(sent).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('never reports an undone send', () => {
    const sent = vi.fn();
    emailHooks.onAfterEmailSend.register('t', sent);
    announceSent(held(), message);
    cancelAnnouncedSend('s1');
    vi.advanceTimersByTime(20_000);
    expect(sent).not.toHaveBeenCalled();
  });
});

describe('announceSent names the message and the composer', () => {
  it("gives the account the message lies in and the sending composer's id", () => {
    const sent = vi.fn();
    emailHooks.onAfterEmailSend.register('t', sent);
    announceSent(
      { scheduled: false, emailId: 'e9', emailAccountId: 'group', emailSubmissionId: 's9' },
      { ...message, composerId: 'composer-1' },
    );
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ emailId: 'e9', accountId: 'group', composerId: 'composer-1' }));
  });
});

describe('whenSent', () => {
  const held = () => ({ scheduled: true, emailId: 'e1', emailSubmissionId: 's1', sendAt: new Date(Date.now() + 10_000).toISOString() });

  it('runs at once for a plain send, with no plugin listening', () => {
    const followUp = vi.fn();
    const result = { scheduled: false, emailId: 'e1', emailSubmissionId: 's1' };
    announceSent(result, message);
    whenSent(result, followUp);
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it('runs at once for a send the user scheduled', () => {
    const followUp = vi.fn();
    const result = { scheduled: true, emailId: 'e1', emailSubmissionId: 's1', sendAt: '2030-01-01T08:00:00Z' };
    announceSent(result, { ...message, delayedUntil: '2030-01-01T08:00:00Z' });
    whenSent(result, followUp);
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it('waits out the undo hold', () => {
    const followUp = vi.fn();
    const result = held();
    announceSent(result, message);
    whenSent(result, followUp);
    vi.advanceTimersByTime(9_000);
    expect(followUp).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it('runs on "Send now", once', () => {
    const followUp = vi.fn();
    const result = held();
    announceSent(result, message);
    whenSent(result, followUp);
    releaseAnnouncedSend('s1');
    expect(followUp).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000);
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it('never runs for an undone send', () => {
    const followUp = vi.fn();
    const result = held();
    announceSent(result, message);
    whenSent(result, followUp);
    cancelAnnouncedSend('s1');
    vi.advanceTimersByTime(20_000);
    expect(followUp).not.toHaveBeenCalled();
  });

  it('never runs for a send waiting in the offline outbox', () => {
    const followUp = vi.fn();
    const result = { scheduled: false, queued: true };
    announceSent(result, message);
    whenSent(result, followUp);
    expect(followUp).not.toHaveBeenCalled();
  });

  it('a failing follow-up does not stop the plugin report', () => {
    const sent = vi.fn();
    emailHooks.onAfterEmailSend.register('t', sent);
    const result = held();
    announceSent(result, message);
    whenSent(result, () => { throw new Error('boom'); });
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveBeenCalledTimes(1);
  });
});
