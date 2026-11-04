import { describe, expect, it } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { addEcho, isUndoWindow, mergeEchoes, sentEcho, settleSent, withoutHeldSend } from '../held-send';

const mb = (role: string, totalEmails: number, extra: Partial<Mailbox> = {}) =>
  ({ id: role, name: role, role, totalEmails, unreadEmails: 0, ...extra }) as Mailbox;
const now = Date.parse('2026-11-04T10:00:00Z');
const soon = new Date(now + 5000).toISOString();

describe('withoutHeldSend', () => {
  it('shows Sent and Scheduled as they were before a send in its Undo window', () => {
    const view = withoutHeldSend([mb('inbox', 146), mb('sent', 52)], 1, { sendAt: soon, countsBefore: { sent: 51, scheduled: 0 } }, now);
    expect(view.scheduledTotal).toBe(0);
    expect(view.mailboxes.find((m) => m.role === 'sent')!.totalEmails).toBe(51);
    expect(view.mailboxes.find((m) => m.role === 'inbox')!.totalEmails).toBe(146);
  });

  it('shows a count that fell meanwhile as it is', () => {
    const view = withoutHeldSend([mb('sent', 49)], 0, { sendAt: soon, countsBefore: { sent: 51, scheduled: 1 } }, now);
    expect(view.mailboxes[0].totalEmails).toBe(49);
    expect(view.scheduledTotal).toBe(0);
  });

  it('counts a mail scheduled for later at once', () => {
    const tomorrow = new Date(now + 86_400_000).toISOString();
    const view = withoutHeldSend([mb('sent', 52)], 1, { sendAt: tomorrow, countsBefore: { sent: 51, scheduled: 0 } }, now);
    expect(view.scheduledTotal).toBe(1);
    expect(view.mailboxes[0].totalEmails).toBe(52);
  });

  it('leaves a shared Sent folder alone', () => {
    const view = withoutHeldSend([mb('sent', 9, { isShared: true })], 0, { sendAt: soon, countsBefore: { sent: 5, scheduled: 0 } }, now);
    expect(view.mailboxes[0].totalEmails).toBe(9);
  });
});

describe('isUndoWindow', () => {
  it('is two minutes at most', () => {
    expect(isUndoWindow(soon, now)).toBe(true);
    expect(isUndoWindow(new Date(now + 121_000).toISOString(), now)).toBe(false);
    expect(isUndoWindow(undefined, now)).toBe(false);
  });
});

describe('echoes of sent replies', () => {
  const server = [{ id: 'a' }, { id: 'b' }] as Email[];
  const echo = sentEcho({ emailId: 'c', threadId: 't', to: ['sam@example.org'], subject: 'Re: x', text: 'Thanks', fromEmail: 'me@example.org' });

  it('is read, carries its text and the server id', () => {
    expect(echo.id).toBe('c');
    expect(echo.keywords.$seen).toBe(true);
    expect(Object.values(echo.bodyValues!)[0].value).toBe('Thanks');
    expect(echo.sentEcho).toBe(true);
  });

  it('is added once', () => {
    expect(addEcho(addEcho(server, echo), echo).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('gives way to the server copy, and stays while the server lacks it', () => {
    expect(mergeEchoes([...server, { id: 'c' } as Email], [...server, echo]).map((e) => (e.sentEcho ? 'echo' : e.id))).toEqual(['a', 'b', 'c']);
    expect(mergeEchoes(server, [...server, echo]).map((e) => (e.sentEcho ? 'echo' : e.id))).toEqual(['a', 'b', 'echo']);
  });

  it('keeps the body of a message already unfolded', () => {
    const loaded = { id: 'a', keywords: {}, mailboxIds: { inbox: true }, bodyValues: { 1: { value: 'Hi' } } } as unknown as Email;
    const listed = { id: 'a', keywords: { $seen: true }, mailboxIds: { archive: true } } as unknown as Email;
    const [merged] = mergeEchoes([listed], [loaded]);
    expect(merged.bodyValues).toEqual(loaded.bodyValues);
    expect(merged.keywords).toEqual({ $seen: true });
    expect(merged.mailboxIds).toEqual({ archive: true });
  });
});

describe('settleSent', () => {
  it('drops the waiting mark once the send time passed, keeps later ones', () => {
    const past = { id: 'a', isScheduled: true, scheduledSendAt: new Date(now - 1000).toISOString() } as Email;
    const later = { id: 'b', isScheduled: true, scheduledSendAt: new Date(now + 60_000).toISOString() } as Email;
    const [a, b] = settleSent([past, later], now);
    expect(a.isScheduled).toBe(false);
    expect(b.isScheduled).toBe(true);
  });
});
