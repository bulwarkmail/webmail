import { describe, expect, it, vi } from 'vitest';
import type { CalendarEvent } from '@/lib/jmap/types';
import {
  buildInvitationForward, invitationForwardText, isForwardableMeeting, uninvitedReplier,
} from '@/lib/calendar-forward';

// Forwarding a meeting (#1797): the invitation goes on as the organiser's
// REQUEST, and the organiser can take in whoever answers it.

// As Stalwart 1.0 holds a meeting: addresses only in calendarAddress, the
// organiser in organizerCalendarAddress.
const meeting = {
  id: 'ev1', uid: 'meeting-1@example.org', title: 'Site visit', start: '2026-12-01T10:00:00',
  timeZone: 'Europe/Berlin', duration: 'PT1H', showWithoutTime: false, calendarIds: { c: true },
  organizerCalendarAddress: 'mailto:alice@example.org',
  locations: { l: { '@type': 'Location', name: 'Hall 3' } },
  participants: {
    a: { '@type': 'Participant', name: 'Alice', calendarAddress: 'mailto:alice@example.org', roles: { owner: true, chair: true, attendee: true }, participationStatus: 'accepted' },
    b: { '@type': 'Participant', name: 'Bob', calendarAddress: 'mailto:bob@example.org', roles: { attendee: true }, participationStatus: 'needs-action', expectReply: true },
  },
} as unknown as CalendarEvent;

const labels = {
  subjectPrefix: 'Fwd:',
  heading: 'Forwarded invitation',
  when: (v: string) => `When: ${v}`,
  where: (v: string) => `Where: ${v}`,
  organizer: (v: string) => `Organizer: ${v}`,
};
const format = { locale: 'en-US', timeZone: 'Europe/Berlin', hour12: false };

describe('forwarding a meeting', () => {
  it('is offered for meetings only', () => {
    expect(isForwardableMeeting(meeting)).toBe(true);
    expect(isForwardableMeeting({ ...meeting, participants: null })).toBe(false);
    expect(isForwardableMeeting({ ...meeting, participants: {} })).toBe(false);
  });

  it('writes what, when, where and who organises it', () => {
    const { subject, body } = invitationForwardText(meeting, labels, format);
    expect(subject).toBe('Fwd: Site visit');
    expect(body).toContain('Forwarded invitation');
    expect(body).toContain('Site visit');
    expect(body).toMatch(/When: .*Dec.*10:00/);
    expect(body).toContain('Where: Hall 3');
    expect(body).toContain('Organizer: Alice <alice@example.org>');
  });

  it('attaches the invitation as a REQUEST with the same UID, organiser and attendees', async () => {
    let sent: File | null = null;
    const client = { uploadBlob: vi.fn(async (file: File) => { sent = file; return { blobId: 'blob-ics', size: file.size, type: file.type }; }) };
    const draft = await buildInvitationForward(client as never, meeting, { subject: 'Fwd: Site visit', body: 'x' });

    expect(draft).toMatchObject({ to: [], subject: 'Fwd: Site visit', inApp: true });
    expect(draft.attachments).toEqual([{ blobId: 'blob-ics', name: 'invite.ics', type: 'text/calendar', size: expect.any(Number) }]);
    const ics = (await sent!.text()).replace(/\r\n /g, '');
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('UID:meeting-1@example.org');
    expect(ics).toContain('ORGANIZER;CN=Alice:mailto:alice@example.org');
    expect(ics).toContain('ATTENDEE;CN=Bob;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bob@example.org');
  });
});

describe('an answer from someone the invitation was forwarded to', () => {
  const reply = {
    uid: 'meeting-1@example.org', organizerCalendarAddress: 'mailto:alice@example.org',
    participants: {
      o: { '@type': 'Participant', calendarAddress: 'mailto:alice@example.org', roles: { owner: true } },
      c: { '@type': 'Participant', name: 'Carol', calendarAddress: 'mailto:carol@example.org', roles: { attendee: true }, participationStatus: 'accepted' },
    },
  } as unknown as Partial<CalendarEvent>;

  it('names the person to the organiser', () => {
    expect(uninvitedReplier(meeting, reply, 'reply', ['alice@example.org']))
      .toEqual({ email: 'carol@example.org', name: 'Carol', status: 'accepted' });
  });

  it('is nothing for an invited attendee, a "no", another method or someone else\'s meeting', () => {
    const fromBob = { ...reply, participants: { ...reply.participants, c: { ...reply.participants!.c, calendarAddress: 'mailto:bob@example.org' } } } as Partial<CalendarEvent>;
    const declined = { ...reply, participants: { ...reply.participants, c: { ...reply.participants!.c, participationStatus: 'declined' } } } as Partial<CalendarEvent>;
    expect(uninvitedReplier(meeting, fromBob, 'reply', ['alice@example.org'])).toBeNull();
    expect(uninvitedReplier(meeting, declined, 'reply', ['alice@example.org'])).toBeNull();
    expect(uninvitedReplier(meeting, reply, 'request', ['alice@example.org'])).toBeNull();
    expect(uninvitedReplier(meeting, reply, 'reply', ['bob@example.org'])).toBeNull();
    expect(uninvitedReplier({ ...meeting, participants: null }, reply, 'reply', ['alice@example.org'])).toBeNull();
  });
});
