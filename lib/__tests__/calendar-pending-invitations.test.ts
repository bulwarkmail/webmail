import { describe, expect, it, vi } from 'vitest';
import type { CalendarEvent } from '@/lib/jmap/types';
import { answerTargetId, fetchUpcomingEvents, pendingInvitations } from '@/lib/calendar-pending-invitations';

// #1669: the invitations the user hasn't answered, for the calendar's sidebar.

const me = 'me@example.com';

function meeting(id: string, start: string, myStatus: string | null, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  const mine: Record<string, unknown> = { '@type': 'Participant', calendarAddress: `mailto:${me}`, roles: { attendee: true } };
  if (myStatus) mine.participationStatus = myStatus;
  return {
    id, uid: `uid-${id}`, title: id, start, utcStart: `${start}Z`, duration: 'PT1H', showWithoutTime: false,
    calendarIds: { c: true },
    organizerCalendarAddress: 'mailto:boss@example.com',
    participants: {
      boss: { '@type': 'Participant', calendarAddress: 'mailto:boss@example.com', roles: { owner: true } },
      me: mine,
    },
    ...extra,
  } as unknown as CalendarEvent;
}

describe('pendingInvitations', () => {
  const emails = () => [me];

  it('lists the meetings the user hasn\'t answered, soonest first', () => {
    const list = pendingInvitations([
      meeting('later', '2026-12-10T10:00:00', 'needs-action'),
      meeting('accepted', '2026-12-02T10:00:00', 'accepted'),
      meeting('sooner', '2026-12-01T10:00:00', null),
      meeting('maybe', '2026-12-03T10:00:00', 'tentative'),
    ], emails);
    expect(list.map((e) => e.id)).toEqual(['sooner', 'later']);
  });

  it('leaves out what the user organises, cancelled meetings and shared calendars', () => {
    const own = meeting('own', '2026-12-01T10:00:00', 'needs-action', { organizerCalendarAddress: `mailto:${me}` });
    const cancelled = meeting('cancelled', '2026-12-01T11:00:00', 'needs-action', { status: 'cancelled' });
    const shared = meeting('shared', '2026-12-01T12:00:00', 'needs-action', { isShared: true });
    expect(pendingInvitations([own, cancelled, shared], emails)).toEqual([]);
  });

  it('shows a series once, at its next date, and answers the series', () => {
    const first = meeting('occ-1', '2026-12-01T10:00:00', 'needs-action', { uid: 'series', recurrenceId: '2026-12-01T10:00:00', baseEventId: 'base' });
    const second = meeting('occ-2', '2026-12-08T10:00:00', 'needs-action', { uid: 'series', recurrenceId: '2026-12-08T10:00:00', baseEventId: 'base' });
    const list = pendingInvitations([second, first], emails);
    expect(list.map((e) => e.id)).toEqual(['occ-1']);
    expect(answerTargetId(list[0])).toBe('base');
    expect(answerTargetId(meeting('single', '2026-12-01T10:00:00', null))).toBe('single');
  });

  it('reads the user\'s own calendars from now on', async () => {
    const queryCalendarEvents = vi.fn(async () => []);
    await fetchUpcomingEvents({ queryCalendarEvents }, new Date('2026-11-24T12:00:00Z'));
    expect(queryCalendarEvents).toHaveBeenCalledWith(
      { after: '2026-11-24T12:00:00.000Z', before: '2027-05-23T12:00:00.000Z' },
      [{ property: 'start', isAscending: true }],
      500,
      undefined,
      { signal: undefined },
    );
  });
});
