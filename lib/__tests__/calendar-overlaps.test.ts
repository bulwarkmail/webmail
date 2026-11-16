import { describe, it, expect } from 'vitest';
import { findOverlappingEvents } from '../calendar-overlaps';
import type { CalendarEvent } from '@/lib/jmap/types';

// Which loaded events share the time of the event in the editor (#1685).

function ev(id: string, start: string, duration: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id, uid: `uid-${id}`, '@type': 'Event', title: id, start, duration, timeZone: null,
    showWithoutTime: false, status: 'confirmed', freeBusyStatus: 'busy', calendarIds: { cal: true },
    ...extra,
  } as unknown as CalendarEvent;
}

const timed = (from: string, to: string) => ({ start: new Date(from), end: new Date(to), allDay: false });
const ids = (events: CalendarEvent[]) => events.map((e) => e.id);

describe('findOverlappingEvents', () => {
  it('finds events that share time, earliest first, and not ones that only touch', () => {
    const events = [
      ev('late', '2026-11-20T10:30:00', 'PT1H'),
      ev('early', '2026-11-20T09:30:00', 'PT1H'),
      ev('before', '2026-11-20T09:00:00', 'PT1H'),
      ev('after', '2026-11-20T11:00:00', 'PT1H'),
    ];
    expect(ids(findOverlappingEvents(timed('2026-11-20T10:00:00', '2026-11-20T11:00:00'), events))).toEqual(['early', 'late']);
  });

  it('leaves out free, cancelled and declined events', () => {
    const declined = ev('declined', '2026-11-20T10:00:00', 'PT1H', {
      participants: {
        me: { '@type': 'Participant', calendarAddress: 'mailto:me@example.com', participationStatus: 'declined', roles: { attendee: true } },
      },
    } as unknown as Partial<CalendarEvent>);
    const events = [
      ev('free', '2026-11-20T10:00:00', 'PT1H', { freeBusyStatus: 'free' }),
      ev('cancelled', '2026-11-20T10:00:00', 'PT1H', { status: 'cancelled' }),
      declined,
      ev('busy', '2026-11-20T10:00:00', 'PT1H'),
    ];
    const found = findOverlappingEvents(timed('2026-11-20T10:00:00', '2026-11-20T11:00:00'), events, {
      userEmailsFor: () => ['me@example.com'],
    });
    expect(ids(found)).toEqual(['busy']);
  });

  it('compares all-day events with all-day events only', () => {
    const events = [
      ev('holiday', '2026-11-20T00:00:00', 'P1D', { showWithoutTime: true }),
      ev('meeting', '2026-11-20T10:00:00', 'PT1H'),
    ];
    expect(ids(findOverlappingEvents(timed('2026-11-20T09:00:00', '2026-11-20T12:00:00'), events))).toEqual(['meeting']);
    const allDay = { start: new Date('2026-11-20T00:00:00'), end: new Date('2026-11-21T00:00:00'), allDay: true };
    expect(ids(findOverlappingEvents(allDay, events))).toEqual(['holiday']);
    const nextDay = { start: new Date('2026-11-21T00:00:00'), end: new Date('2026-11-22T00:00:00'), allDay: true };
    expect(findOverlappingEvents(nextDay, events)).toEqual([]);
  });

  it('skips every occurrence of the event being edited', () => {
    const events = [
      ev('occ-1', '2026-11-20T10:00:00', 'PT1H', { uid: 'series' }),
      ev('other', '2026-11-20T10:00:00', 'PT1H'),
    ];
    const found = findOverlappingEvents(timed('2026-11-20T10:00:00', '2026-11-20T11:00:00'), events, { excludeUid: 'series' });
    expect(ids(found)).toEqual(['other']);
  });

  it('counts an event that lasts no time inside the window', () => {
    const events = [ev('deadline', '2026-11-20T10:15:00', 'PT0S')];
    expect(ids(findOverlappingEvents(timed('2026-11-20T10:00:00', '2026-11-20T11:00:00'), events))).toEqual(['deadline']);
  });
});
