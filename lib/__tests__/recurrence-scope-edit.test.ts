import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { addDays, addHours, addMinutes, startOfDay } from 'date-fns';
import {
  deleteOccurrence,
  followingSeriesData,
  saveOccurrenceEdit,
  seriesUpdatesFromOccurrence,
  type EventEditorState,
  type OccurrenceEditActions,
} from '@/lib/recurrence-scope-edit';
import { expandRecurringEvents } from '@/lib/recurrence-expansion';
import { getEventEndDate, getEventStartDate } from '@/lib/calendar-utils';
import { AUTO_TIME_ZONE } from '@/lib/timezone';
import { useSettingsStore } from '@/stores/settings-store';
import { useCalendarStore } from '@/stores/calendar-store';
import type { CalendarEvent, CalendarParticipant } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// "All occurrences" from the editor opened on one occurrence: the editor's
// dates and participants are that occurrence's. Written to the series as
// they were, a rename from the third occurrence moved the series' start to
// it (the first two occurrences gone) and gave every occurrence the third
// one's answers - here userb's "declined" for that day only.

type Version = '0.16' | '1.0';
const ORGANIZER = 'userc@example.org';
const ATTENDEE = 'userb@example.org';
// Someone userc shares the calendar with, read & write; not invited.
const SHAREE = 'usera@example.org';

// Participants as each version stores them: 0.16.23 drops an attendee's
// roles, 1.0 keeps them.
function participant(version: Version, address: string, owner: boolean, status: string): CalendarParticipant {
  return {
    '@type': 'Participant', calendarAddress: `mailto:${address}`, email: address,
    ...(owner ? { roles: { owner: true } } : version === '1.0' ? { roles: { attendee: true } } : {}),
    participationStatus: status, scheduleAgent: 'server', expectReply: !owner, kind: 'individual',
  } as unknown as CalendarParticipant;
}

const statusOf = (participants: CalendarEvent['participants'] | undefined, address: string) =>
  Object.values(participants ?? {}).find((p) => p.calendarAddress === `mailto:${address}`)?.participationStatus;

// Weekly on Mondays from 5 October, 10:00 in Berlin, five times. userb
// accepted the series and declined 19 October alone: 1.0 returns that
// override as a PatchObject, 0.16 as the whole participants map.
function series(version: Version): CalendarEvent {
  const participants = {
    org: participant(version, ORGANIZER, true, 'accepted'),
    b: participant(version, ATTENDEE, false, 'accepted'),
  };
  return {
    id: 'b', uid: 'weekly@example.org', '@type': 'Event', title: 'Planning', description: '',
    start: '2026-10-05T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin', showWithoutTime: false,
    utcStart: '2026-10-05T08:00:00Z', utcEnd: '2026-10-05T09:00:00Z',
    calendarIds: { cal: true }, organizerCalendarAddress: `mailto:${ORGANIZER}`, participants,
    recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: 5 }],
    recurrenceOverrides: version === '1.0'
      ? { '2026-10-19T10:00:00': { 'participants/b/participationStatus': 'declined' } }
      : { '2026-10-19T10:00:00': { participants: { ...participants, b: participant(version, ATTENDEE, false, 'declined') } } },
    excludedRecurrenceRules: null, alerts: null,
  } as unknown as CalendarEvent;
}

// 19 October as the server expands it (0.16.20 on, and 1.0): a synthetic id
// naming its base event, hydrated from it.
function serverOccurrence(version: Version): CalendarEvent {
  const base = series(version);
  return {
    ...base,
    id: 'maaaaac', baseEventId: 'b',
    start: '2026-10-19T10:00:00', utcStart: '2026-10-19T08:00:00Z', utcEnd: '2026-10-19T09:00:00Z',
    recurrenceId: '2026-10-19T10:00:00', recurrenceIdTimeZone: 'Europe/Berlin',
    participants: { ...base.participants, b: participant(version, ATTENDEE, false, 'declined') },
  } as CalendarEvent;
}

// 19 October as the browser expands it (0.16 before 0.16.20).
function browserOccurrence(): CalendarEvent {
  const occurrences = expandRecurringEvents([series('0.16')], '2026-10-01T00:00:00', '2026-11-30T00:00:00');
  return occurrences.find((o) => o.recurrenceId === '2026-10-19T10:00:00')!;
}

const occurrences: Array<[string, Version, () => CalendarEvent]> = [
  ['1.0', '1.0', () => serverOccurrence('1.0')],
  ['0.16.20+', '0.16', () => serverOccurrence('0.16')],
  ['0.16 before 0.16.20', '0.16', browserOccurrence],
];

/** What the editor had, opened on `occurrence` and saved as it came unless changed. */
function editorOn(occurrence: CalendarEvent, change: Partial<EventEditorState> = {}): EventEditorState {
  const attendees = [{ name: '', email: ATTENDEE }];
  return {
    initialAttendees: attendees,
    attendees,
    when: { allDay: !!occurrence.showWithoutTime, start: getEventStartDate(occurrence), end: getEventEndDate(occurrence) },
    ...change,
  };
}

/** What the editor writes for `occurrence` (event-modal handleSave) with `change`. */
function editorUpdates(occurrence: CalendarEvent, change: Partial<CalendarEvent> = {}): Partial<CalendarEvent> {
  return {
    title: occurrence.title, description: '', start: occurrence.start, duration: occurrence.duration,
    timeZone: occurrence.timeZone, showWithoutTime: false, calendarIds: { cal: true },
    recurrenceRules: occurrence.recurrenceRules, recurrenceId: occurrence.recurrenceId,
    // The occurrence's participants, rebuilt with its answers.
    participants: occurrence.participants,
    ...change,
  };
}

const context = { userEmail: ORGANIZER, userEmails: [ORGANIZER] };

beforeEach(() => useSettingsStore.setState({ timeZone: 'Europe/Berlin' }));
afterEach(() => useSettingsStore.setState({ timeZone: AUTO_TIME_ZONE }));

describe.each(occurrences)('changing every occurrence from one of them on Stalwart %s', (_label, version, make) => {
  it('renames the series and keeps when it happens and its answers', () => {
    const occurrence = make();
    const updates = seriesUpdatesFromOccurrence(
      occurrence, series(version), editorUpdates(occurrence, { title: 'Planning, room 2' }), editorOn(occurrence), context,
    );

    expect(updates.title).toBe('Planning, room 2');
    for (const key of ['start', 'duration', 'timeZone', 'showWithoutTime', 'recurrenceId', 'participants', 'organizerCalendarAddress']) {
      expect(updates).not.toHaveProperty(key);
    }
  });

  it('moves the series from its own start by as much as the occurrence moved, and asks again', () => {
    const occurrence = make();
    const start = getEventStartDate(occurrence);
    const updates = seriesUpdatesFromOccurrence(
      occurrence, series(version),
      editorUpdates(occurrence, { start: '2026-10-19T11:30:00' }),
      editorOn(occurrence, { when: { allDay: false, start: addMinutes(start, 90), end: addMinutes(getEventEndDate(occurrence), 90) } }),
      context,
    );

    expect(updates.start).toBe('2026-10-05T11:30:00');
    expect(updates).not.toHaveProperty('duration');
    expect(updates).not.toHaveProperty('timeZone');
    // Asked again as the series' organizer: the series' answer, not the
    // occurrence's "declined", goes back to needs-action.
    expect(statusOf(updates.participants, ORGANIZER)).toBe('accepted');
    expect(statusOf(updates.participants, ATTENDEE)).toBe('needs-action');
  });

  it('moves the series to another weekday by the days the occurrence moved', () => {
    const occurrence = make();
    const updates = seriesUpdatesFromOccurrence(
      occurrence, series(version), editorUpdates(occurrence),
      editorOn(occurrence, { when: { allDay: false, start: addDays(getEventStartDate(occurrence), 1), end: addDays(getEventEndDate(occurrence), 1) } }),
      context,
    );

    expect(updates.start).toBe('2026-10-06T10:00:00');
  });

  it('changes only the length when only the end moved', () => {
    const occurrence = make();
    const updates = seriesUpdatesFromOccurrence(
      occurrence, series(version), editorUpdates(occurrence, { duration: 'PT1H30M' }),
      editorOn(occurrence, { when: { allDay: false, start: getEventStartDate(occurrence), end: addMinutes(getEventEndDate(occurrence), 30) } }),
      context,
    );

    expect(updates.duration).toBe('PT1H30M');
    expect(updates).not.toHaveProperty('start');
    expect(statusOf(updates.participants, ATTENDEE)).toBe('needs-action');
  });

  it('turns the series all-day on its own first day', () => {
    const occurrence = make();
    const day = startOfDay(getEventStartDate(occurrence));
    const updates = seriesUpdatesFromOccurrence(
      occurrence, series(version),
      editorUpdates(occurrence, { start: '2026-10-19T00:00:00', duration: 'P1D', timeZone: null, showWithoutTime: true }),
      editorOn(occurrence, { when: { allDay: true, start: day, end: day } }),
      context,
    );

    expect(updates).toMatchObject({ start: '2026-10-05T00:00:00', duration: 'P1D', timeZone: null, showWithoutTime: true });
  });

  it('adds the attendee the user added to the series\' own participants', () => {
    const occurrence = make();
    const attendees = [{ name: '', email: ATTENDEE }, { name: 'Anna', email: 'usera@example.org' }];
    const updates = seriesUpdatesFromOccurrence(
      occurrence, series(version), editorUpdates(occurrence), editorOn(occurrence, { attendees }), context,
    );

    const participants = updates.participants as Record<string, CalendarParticipant>;
    // The series' ids and answers: userb accepted the series.
    expect(participants.org.calendarAddress).toBe(`mailto:${ORGANIZER}`);
    expect(participants.b.participationStatus).toBe('accepted');
    expect(statusOf(participants, 'usera@example.org')).toBe('needs-action');
    expect(Object.keys(participants)).toHaveLength(3);
    expect(updates).not.toHaveProperty('organizerCalendarAddress');
  });

  it('removes the attendee the user removed, and the participants with the last one', () => {
    const occurrence = make();
    const updates = seriesUpdatesFromOccurrence(
      occurrence, series(version), editorUpdates(occurrence, { participants: null }), editorOn(occurrence, { attendees: [] }), context,
    );

    expect(updates.participants).toBeNull();
    expect(updates.organizerCalendarAddress).toBeNull();
  });

  it('asks the attendees again when the series gets another rule', () => {
    const occurrence = make();
    const updates = seriesUpdatesFromOccurrence(
      occurrence, series(version),
      editorUpdates(occurrence, { recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'daily', count: 5 } as never] }),
      editorOn(occurrence, { ruleChanged: true }), context,
    );

    expect(updates).not.toHaveProperty('start');
    expect(statusOf(updates.participants, ATTENDEE)).toBe('needs-action');
  });

  it('moves an attendee\'s own copy of the series and leaves its participants alone', () => {
    const occurrence = make();
    const updates = seriesUpdatesFromOccurrence(
      occurrence, { ...series(version), isOrigin: false }, editorUpdates(occurrence, { participants: undefined }),
      editorOn(occurrence, { when: { allDay: false, start: addHours(getEventStartDate(occurrence), 1), end: addHours(getEventEndDate(occurrence), 1) } }),
      { userEmail: ATTENDEE, userEmails: [ATTENDEE] },
    );

    expect(updates.start).toBe('2026-10-05T11:00:00');
    expect(updates).not.toHaveProperty('participants');
  });

  // The series in userc's calendar, shared with usera read & write: Stalwart
  // sends usera's change from userc (isOrigin: true).
  it('asks again when the user moves the owner\'s series in a calendar shared with them', () => {
    const occurrence = make();
    const updates = seriesUpdatesFromOccurrence(
      occurrence, { ...series(version), isOrigin: true, isShared: true, accountId: 'f' }, editorUpdates(occurrence),
      editorOn(occurrence, { when: { allDay: false, start: addHours(getEventStartDate(occurrence), 1), end: addHours(getEventEndDate(occurrence), 1) } }),
      { userEmail: SHAREE, userEmails: [SHAREE] },
    );

    expect(updates.start).toBe('2026-10-05T11:00:00');
    expect(statusOf(updates.participants, ORGANIZER)).toBe('accepted');
    expect(statusOf(updates.participants, ATTENDEE)).toBe('needs-action');
    expect(statusOf(updates.participants, SHAREE)).toBeUndefined();
  });

  // userb attends userc's series, and moves it in userc's calendar shared
  // with her. 0.16 sends her nothing of her own change (her address counts
  // as the account's own): reset, her answers stayed needs-action in userc's
  // copy (live on 0.16.23).
  it('keeps the answers of the user who attends the owner\'s series and moves it there', () => {
    const occurrence = make();
    const updates = seriesUpdatesFromOccurrence(
      occurrence, { ...series(version), isOrigin: true, isShared: true, accountId: 'f' }, editorUpdates(occurrence),
      editorOn(occurrence, { when: { allDay: false, start: addHours(getEventStartDate(occurrence), 1), end: addHours(getEventEndDate(occurrence), 1) } }),
      { userEmail: ATTENDEE, userEmails: [ATTENDEE] },
    );

    expect(updates.start).toBe('2026-10-05T11:00:00');
    expect(statusOf(updates.participants, ATTENDEE)).toBe('accepted');
    // 0.16: her answer to 19 October alone, in the override's whole map, stays too.
    if (version === '0.16') {
      const overrides = updates.recurrenceOverrides as Record<string, Record<string, unknown>>;
      expect(statusOf(overrides['2026-10-19T11:00:00'].participants as CalendarEvent['participants'], ATTENDEE)).toBe('declined');
    }
  });
});

describe('changing every occurrence of a series in another time zone', () => {
  it('moves the series on its own wall clock, whatever zone the user sees it in', () => {
    useSettingsStore.setState({ timeZone: 'Asia/Tokyo' });
    // 08:00 in New York is 21:00 in Tokyo; the user moves it to 22:00.
    const base = {
      ...series('1.0'), start: '2026-10-05T08:00:00', timeZone: 'America/New_York',
      utcStart: '2026-10-05T12:00:00Z', utcEnd: '2026-10-05T13:00:00Z',
    } as CalendarEvent;
    const occurrence = {
      ...base, id: 'maaaaac', baseEventId: 'b', start: '2026-10-19T08:00:00',
      utcStart: '2026-10-19T12:00:00Z', utcEnd: '2026-10-19T13:00:00Z', recurrenceId: '2026-10-19T08:00:00',
    } as CalendarEvent;
    const start = getEventStartDate(occurrence);

    const updates = seriesUpdatesFromOccurrence(
      occurrence, base,
      editorUpdates(occurrence, { start: '2026-10-19T22:00:00', timeZone: 'Asia/Tokyo' }),
      editorOn(occurrence, { when: { allDay: false, start: addHours(start, 1), end: addHours(getEventEndDate(occurrence), 1) } }),
      context,
    );

    expect(updates.start).toBe('2026-10-05T09:00:00');
    expect(updates).not.toHaveProperty('timeZone');
  });
});

// Weekly on Wednesdays from 9 December, 10:00 in Berlin, five times; userb
// accepted. 16 December is excluded, 30 December retitled, and 6 January
// moved to 14:00 on its own. 1.0 returns the overrides as PatchObjects; 0.16
// as Bulwark wrote them on the base event: the occurrence's time pinned, its
// participants copied, and the server's `updated`.
function seriesWithOverrides(version: Version): CalendarEvent {
  const participants = { org: participant(version, ORGANIZER, true, 'accepted'), b: participant(version, ATTENDEE, false, 'accepted') };
  const written = (start: string, extra: Record<string, unknown> = {}) => ({
    updated: '2026-11-20T09:00:00Z', start, duration: 'PT1H', participants, ...extra,
  });
  return {
    ...series(version),
    start: '2026-12-09T10:00:00', utcStart: '2026-12-09T09:00:00Z', utcEnd: '2026-12-09T10:00:00Z',
    recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: 5 }],
    recurrenceOverrides: version === '1.0'
      ? {
        '2026-12-16T10:00:00': { excluded: true },
        '2026-12-30T10:00:00': { title: 'Planning, special' },
        '2027-01-06T10:00:00': { start: '2027-01-06T14:00:00' },
      }
      : {
        '2026-12-16T10:00:00': { excluded: true },
        '2026-12-30T10:00:00': written('2026-12-30T10:00:00', { title: 'Planning, special' }),
        '2027-01-06T10:00:00': written('2027-01-06T14:00:00'),
      },
  } as unknown as CalendarEvent;
}

/** A Berlin wall clock in winter (UTC+1), `hours` later, as the UTC instant the server reports. */
const berlinUtc = (wall: string, hours = 0) => `${new Date(Date.parse(`${wall}+01:00`) + hours * 3_600_000).toISOString().slice(0, 19)}Z`;

/** An occurrence of seriesWithOverrides as the server expands it, on its (own) day and time. */
function overriddenOccurrence(version: Version, recurrenceId: string, start = recurrenceId): CalendarEvent {
  return {
    ...seriesWithOverrides(version), id: 'maaaaad', baseEventId: 'b', start, recurrenceId, recurrenceIdTimeZone: 'Europe/Berlin',
    utcStart: berlinUtc(start), utcEnd: berlinUtc(start, 1),
  } as CalendarEvent;
}

const moveBy = (occurrence: CalendarEvent, hours: number) => ({
  when: { allDay: false, start: addHours(getEventStartDate(occurrence), hours), end: addHours(getEventEndDate(occurrence), hours) },
});

// A series moved for every occurrence kept its overrides under the old
// recurrence ids: 16 December came back at 11:00, 30 December showed twice
// (10:00 "special" and 11:00), in the attendee's copy too (live on 1.0 and
// 0.16.23). Each override now goes with its occurrence.
describe.each<[string, Version]>([['1.0', '1.0'], ['0.16', '0.16']])('overrides of a series moved for every occurrence on Stalwart %s', (_label, version) => {
  const pinned = (start: string, extra: Record<string, unknown> = {}) => ({ start, duration: 'PT1H', ...extra });

  it('moves every override with its occurrence; one moved on its own keeps its time', () => {
    const occurrence = overriddenOccurrence(version, '2026-12-23T10:00:00');
    const updates = seriesUpdatesFromOccurrence(
      occurrence, seriesWithOverrides(version), editorUpdates(occurrence), editorOn(occurrence, moveBy(occurrence, 1)), context,
    );

    expect(updates.start).toBe('2026-12-09T11:00:00');
    const overrides = updates.recurrenceOverrides as Record<string, Record<string, unknown>>;
    expect(Object.keys(overrides).sort()).toEqual(['2026-12-16T11:00:00', '2026-12-30T11:00:00', '2027-01-06T11:00:00']);
    expect(overrides['2026-12-16T11:00:00']).toEqual({ excluded: true });
    if (version === '1.0') {
      expect(overrides['2026-12-30T11:00:00']).toEqual({ title: 'Planning, special' });
      expect(overrides['2027-01-06T11:00:00']).toEqual({ start: '2027-01-06T14:00:00' });
    } else {
      // The time the override only held moves; the answers in it are asked
      // again with the series'. 6 January stays at 14:00 and keeps them.
      expect(overrides['2026-12-30T11:00:00']).toMatchObject(pinned('2026-12-30T11:00:00', { title: 'Planning, special' }));
      expect(statusOf(overrides['2026-12-30T11:00:00'].participants as CalendarEvent['participants'], ATTENDEE)).toBe('needs-action');
      expect(overrides['2027-01-06T11:00:00']).toMatchObject(pinned('2027-01-06T14:00:00'));
      expect(statusOf(overrides['2027-01-06T11:00:00'].participants as CalendarEvent['participants'], ATTENDEE)).toBe('accepted');
      expect(overrides['2026-12-30T11:00:00']).not.toHaveProperty('updated');
    }
  });

  it('moves the overrides to the day the series moved to', () => {
    const occurrence = overriddenOccurrence(version, '2026-12-23T10:00:00');
    const updates = seriesUpdatesFromOccurrence(
      occurrence, seriesWithOverrides(version), editorUpdates(occurrence), editorOn(occurrence, moveBy(occurrence, 24)), context,
    );

    expect(updates.start).toBe('2026-12-10T10:00:00');
    expect(Object.keys(updates.recurrenceOverrides!).sort()).toEqual(['2026-12-17T10:00:00', '2026-12-31T10:00:00', '2027-01-07T10:00:00']);
    expect(updates.recurrenceOverrides!['2027-01-07T10:00:00']).toMatchObject({ start: '2027-01-06T14:00:00' });
  });

  it('gives the occurrence the editor was opened on the move made there', () => {
    // 6 January, at 14:00 on its own, moved to 15:00 for every occurrence.
    const occurrence = overriddenOccurrence(version, '2027-01-06T10:00:00', '2027-01-06T14:00:00');
    const updates = seriesUpdatesFromOccurrence(
      occurrence, seriesWithOverrides(version), editorUpdates(occurrence), editorOn(occurrence, moveBy(occurrence, 1)), context,
    );

    expect(updates.start).toBe('2026-12-09T11:00:00');
    expect(updates.recurrenceOverrides!['2027-01-06T11:00:00']).toMatchObject({ start: '2027-01-06T15:00:00' });
    expect(updates.recurrenceOverrides!['2026-12-30T11:00:00']).toMatchObject({ title: 'Planning, special' });
  });

  it('takes every occurrence along when the series turns all-day', () => {
    const occurrence = overriddenOccurrence(version, '2026-12-23T10:00:00');
    const day = startOfDay(getEventStartDate(occurrence));
    const updates = seriesUpdatesFromOccurrence(
      occurrence, seriesWithOverrides(version),
      editorUpdates(occurrence, { start: '2026-12-23T00:00:00', duration: 'P1D', timeZone: null, showWithoutTime: true }),
      editorOn(occurrence, { when: { allDay: true, start: day, end: day } }), context,
    );

    expect(updates).toMatchObject({ start: '2026-12-09T00:00:00', showWithoutTime: true });
    const overrides = updates.recurrenceOverrides as Record<string, Record<string, unknown>>;
    expect(overrides['2026-12-16T00:00:00']).toEqual({ excluded: true });
    expect(overrides['2026-12-30T00:00:00']).toMatchObject({ title: 'Planning, special' });
    for (const key of ['start', 'duration', 'timeZone']) expect(overrides['2026-12-30T00:00:00']).not.toHaveProperty(key);
    // 6 January had nothing but its own time (on 1.0): with it gone, so is the override.
    if (version === '1.0') expect(overrides).not.toHaveProperty('2027-01-06T00:00:00');
  });

  it('drops the overrides of occurrences a new rule no longer has', () => {
    const occurrence = overriddenOccurrence(version, '2026-12-23T10:00:00');
    const everyOtherWeek = [{ '@type': 'RecurrenceRule', frequency: 'weekly', interval: 2, count: 5 }] as never;
    const updates = seriesUpdatesFromOccurrence(
      occurrence, seriesWithOverrides(version), editorUpdates(occurrence, { recurrenceRules: everyOtherWeek }),
      editorOn(occurrence, { ruleChanged: true }), context,
    );

    // 9, 23 December and 6 January stay; 16 and 30 December are gone.
    expect(updates).not.toHaveProperty('start');
    expect(Object.keys(updates.recurrenceOverrides!)).toEqual(['2027-01-06T10:00:00']);
  });

  it('leaves the overrides alone when the series only gets a new title', () => {
    const occurrence = overriddenOccurrence(version, '2026-12-23T10:00:00');
    const updates = seriesUpdatesFromOccurrence(
      occurrence, seriesWithOverrides(version), editorUpdates(occurrence, { title: 'Planning, room 2' }), editorOn(occurrence), context,
    );

    expect(updates).not.toHaveProperty('recurrenceOverrides');
  });
});

// A rule that names the days - Mondays and Tuesdays - keeps its occurrences
// on them when the series starts a day later. Each override went a day
// later with the series: Monday 14 December's onto Tuesday 15 December, over
// that day's cancellation. The cancelled Tuesday came back with Monday's
// title, and Monday lost its change (live on 1.0 and 0.16.23).
describe.each<[string, Version]>([['1.0', '1.0'], ['0.16', '0.16']])('overrides of a series on named weekdays on Stalwart %s', (_label, version) => {
  const special = (start: string, title = 'Standup, special') => (version === '1.0'
    ? { title }
    : { updated: '2026-11-20T09:00:00Z', start, duration: 'PT1H', title, participants: series(version).participants });
  // Mondays and Tuesdays (or the days given) from Monday 7 December, 10:00 in Berlin, ten times.
  function onDays(overrides: Record<string, unknown>, days = ['mo', 'tu'], frequency = 'weekly'): CalendarEvent {
    return {
      ...series(version), title: 'Standup', start: '2026-12-07T10:00:00', utcStart: '2026-12-07T09:00:00Z', utcEnd: '2026-12-07T10:00:00Z',
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency, byDay: days.map((day) => ({ '@type': 'NDay', day })), count: 10 }],
      recurrenceOverrides: overrides,
    } as unknown as CalendarEvent;
  }
  const on = (master: CalendarEvent, recurrenceId: string) => ({
    ...master, id: 'maaaaae', baseEventId: 'b', start: recurrenceId, recurrenceId, recurrenceIdTimeZone: 'Europe/Berlin',
    utcStart: berlinUtc(recurrenceId), utcEnd: berlinUtc(recurrenceId, 1),
  }) as CalendarEvent;
  // Both orders: the server hands the map out in an order of its own.
  const bothOrders = (entries: Array<[string, unknown]>) => [Object.fromEntries(entries), Object.fromEntries([...entries].reverse())];
  // The overrides after the save: those written, or the series' own when none are.
  const after = (master: CalendarEvent, updates: Partial<CalendarEvent>) =>
    (updates.recurrenceOverrides === undefined ? master.recurrenceOverrides : updates.recurrenceOverrides) as Record<string, Record<string, unknown>>;

  it('keeps Monday\'s change and Tuesday\'s cancellation on their days when the series starts a day later', () => {
    for (const overrides of bothOrders([
      ['2026-12-14T10:00:00', special('2026-12-14T10:00:00', 'Standup, Monday special')],
      ['2026-12-15T10:00:00', { excluded: true }],
    ])) {
      const master = onDays(overrides);
      const monday = on(master, '2026-12-21T10:00:00');
      const updates = seriesUpdatesFromOccurrence(monday, master, editorUpdates(monday), editorOn(monday, moveBy(monday, 24)), context);

      expect(updates.start).toBe('2026-12-08T10:00:00');
      const kept = after(master, updates);
      expect(Object.keys(kept).sort()).toEqual(['2026-12-14T10:00:00', '2026-12-15T10:00:00']);
      expect(kept['2026-12-15T10:00:00']).toEqual({ excluded: true });
      expect(kept['2026-12-14T10:00:00']).toMatchObject({ title: 'Standup, Monday special' });
      // 0.16: the time the override holds stays Monday's.
      if (version === '0.16') expect(kept['2026-12-14T10:00:00'].start).toBe('2026-12-14T10:00:00');
      // 1.0: nothing about them changes, so they are not written.
      else expect(updates).not.toHaveProperty('recurrenceOverrides');
    }
  });

  it('keeps the change of the Monday the editor was opened on on that Monday', () => {
    const master = onDays({ '2026-12-21T10:00:00': special('2026-12-21T10:00:00') });
    const monday = { ...on(master, '2026-12-21T10:00:00'), title: 'Standup, special' } as CalendarEvent;
    const updates = seriesUpdatesFromOccurrence(monday, master, editorUpdates(monday), editorOn(monday, moveBy(monday, 24)), context);

    const kept = after(master, updates);
    expect(Object.keys(kept)).toEqual(['2026-12-21T10:00:00']);
    expect(kept['2026-12-21T10:00:00']).toMatchObject(version === '1.0' ? { title: 'Standup, special' } : { title: 'Standup, special', start: '2026-12-21T10:00:00' });
  });

  it('keeps them on their days at the new time when the series also moves an hour', () => {
    const master = onDays({ '2026-12-14T10:00:00': special('2026-12-14T10:00:00'), '2026-12-15T10:00:00': { excluded: true } });
    const monday = on(master, '2026-12-21T10:00:00');
    const updates = seriesUpdatesFromOccurrence(monday, master, editorUpdates(monday), editorOn(monday, moveBy(monday, 25)), context);

    expect(updates.start).toBe('2026-12-08T11:00:00');
    const overrides = updates.recurrenceOverrides as Record<string, Record<string, unknown>>;
    expect(Object.keys(overrides).sort()).toEqual(['2026-12-14T11:00:00', '2026-12-15T11:00:00']);
    expect(overrides['2026-12-15T11:00:00']).toEqual({ excluded: true });
    expect(overrides['2026-12-14T11:00:00']).toMatchObject(version === '1.0' ? { title: 'Standup, special' } : { title: 'Standup, special', start: '2026-12-14T11:00:00' });
  });

  it('keeps Thursday\'s change and Friday\'s cancellation of a series on weekdays', () => {
    const master = onDays({
      '2026-12-10T10:00:00': special('2026-12-10T10:00:00', 'Standup, Thursday special'),
      '2026-12-11T10:00:00': { excluded: true },
    }, ['mo', 'tu', 'we', 'th', 'fr'], 'daily');
    const tuesday = on(master, '2026-12-08T10:00:00');
    const updates = seriesUpdatesFromOccurrence(tuesday, master, editorUpdates(tuesday), editorOn(tuesday, moveBy(tuesday, 24)), context);

    expect(updates.start).toBe('2026-12-08T10:00:00');
    const kept = after(master, updates);
    expect(Object.keys(kept).sort()).toEqual(['2026-12-10T10:00:00', '2026-12-11T10:00:00']);
    expect(kept['2026-12-10T10:00:00']).toMatchObject({ title: 'Standup, Thursday special' });
    expect(kept['2026-12-11T10:00:00']).toEqual({ excluded: true });
  });

  // The series starts on Tuesday 8 December: its first Monday is gone, and
  // moved a day, that Monday's override met Tuesday's cancellation.
  it('drops the override of an occurrence that is gone rather than write it over the next one', () => {
    for (const [hours, tuesday] of [[24, '2026-12-08T10:00:00'], [25, '2026-12-08T11:00:00']] as const) {
      for (const overrides of bothOrders([
        ['2026-12-07T10:00:00', special('2026-12-07T10:00:00', 'Kick-off')],
        ['2026-12-08T10:00:00', { excluded: true }],
      ])) {
        const master = onDays(overrides);
        const monday = on(master, '2026-12-21T10:00:00');
        const updates = seriesUpdatesFromOccurrence(monday, master, editorUpdates(monday), editorOn(monday, moveBy(monday, hours)), context);

        expect(updates.recurrenceOverrides).toEqual({ [tuesday]: { excluded: true } });
      }
    }
  });

  it('keeps them on their days in the rest of a series split from a Monday moved to Tuesday', async () => {
    const master = onDays({ '2026-12-28T10:00:00': special('2026-12-28T10:00:00'), '2026-12-29T10:00:00': { excluded: true } });
    const monday = on(master, '2026-12-21T10:00:00');
    const deps = actions(master);

    await saveOccurrenceEdit('this_and_future', {
      event: monday, updates: editorUpdates(monday), editor: editorOn(monday, moveBy(monday, 24)), sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    const [, created] = deps.createEvent.mock.calls[0];
    expect(created.start).toBe('2026-12-22T10:00:00');
    const overrides = created.recurrenceOverrides as Record<string, Record<string, unknown>>;
    expect(Object.keys(overrides).sort()).toEqual(['2026-12-28T10:00:00', '2026-12-29T10:00:00']);
    expect(overrides['2026-12-29T10:00:00']).toEqual({ excluded: true });
    expect(overrides['2026-12-28T10:00:00']).toMatchObject(version === '1.0' ? { title: 'Standup, special' } : { title: 'Standup, special', start: '2026-12-28T10:00:00' });
  });
});

// "Repeat: none" for every occurrence leaves one event. The override of its
// first occurrence stayed with it: 1.0 applied it to the event - cancelled,
// the event was gone from every range - and 0.16.23 listed a retitled one
// next to the event (live).
describe.each<[string, Version]>([['1.0', '1.0'], ['0.16', '0.16']])('a series that stops repeating on Stalwart %s', (_label, version) => {
  const firstChanged = (first: Record<string, unknown>) => ({
    ...series(version),
    recurrenceOverrides: {
      '2026-10-05T10:00:00': version === '1.0' || first.excluded
        ? first
        : { start: '2026-10-05T10:00:00', duration: 'PT1H', participants: series(version).participants, ...first },
      '2026-10-26T10:00:00': { excluded: true },
    },
  }) as unknown as CalendarEvent;
  const none = { recurrenceRules: null, recurrenceOverrides: null } as Partial<CalendarEvent>;

  it('keeps no override, whether its first occurrence was changed or cancelled', () => {
    for (const first of [{ title: 'Kick-off' }, { excluded: true }]) {
      const occurrence = serverOccurrence(version);
      const updates = seriesUpdatesFromOccurrence(
        occurrence, firstChanged(first), editorUpdates(occurrence, none), editorOn(occurrence, { ruleChanged: true }), context,
      );

      expect(updates.recurrenceRules).toBeNull();
      expect(updates.recurrenceOverrides).toBeNull();
      expect(updates).not.toHaveProperty('start');
    }
  });

  it('drops them when the editor wrote only the rule', () => {
    const occurrence = serverOccurrence(version);
    const updates = seriesUpdatesFromOccurrence(
      occurrence, firstChanged({ title: 'Kick-off' }), editorUpdates(occurrence, { recurrenceRules: null }),
      editorOn(occurrence, { ruleChanged: true }), context,
    );

    expect(updates.recurrenceOverrides).toBeNull();
  });

  it('writes the event without them when it tells the attendees', async () => {
    const occurrence = serverOccurrence(version);
    const deps = actions(firstChanged({ title: 'Kick-off' }));

    await saveOccurrenceEdit('all', {
      event: occurrence, updates: editorUpdates(occurrence, none), editor: editorOn(occurrence, { ruleChanged: true }),
      sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    const [, id, patch] = deps.updateEvent.mock.calls[0];
    expect(id).toBe('b');
    expect(patch).toMatchObject({ recurrenceRules: null, recurrenceOverrides: null });
    expect(Object.keys(patch).some((key) => key.startsWith('recurrenceOverrides/'))).toBe(false);
  });
});

// "This and the following occurrences" left the overrides after the split in
// the old series, whose rule no longer reached them: they showed on as
// occurrences of it, next to the new series. And the new series got the
// whole COUNT again. Six weekly occurrences from 7 December, 4 January
// retitled alone, split from 21 December: the old series showed 7 and 14
// December and 4 January, the new one ran six times to 25 January (live on
// 1.0 and 0.16.23).
describe.each<[string, Version]>([['1.0', '1.0'], ['0.16', '0.16']])('overrides of a series split from one occurrence on Stalwart %s', (_label, version) => {
  function sixWeeks(overrides: CalendarEvent['recurrenceOverrides']): CalendarEvent {
    return {
      ...series(version), start: '2026-12-07T10:00:00', utcStart: '2026-12-07T09:00:00Z', utcEnd: '2026-12-07T10:00:00Z',
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: 6 }], recurrenceOverrides: overrides,
    } as unknown as CalendarEvent;
  }
  const special = version === '1.0'
    ? { title: 'Planning, special' }
    : {
      updated: '2026-11-20T09:00:00Z', start: '2027-01-04T10:00:00', duration: 'PT1H', title: 'Planning, special',
      participants: { org: participant(version, ORGANIZER, true, 'accepted'), b: participant(version, ATTENDEE, false, 'accepted') },
    };
  const occurrenceOf = (master: CalendarEvent, recurrenceId: string) => ({
    ...master, id: 'maaaaae', baseEventId: 'b', start: recurrenceId, recurrenceId, recurrenceIdTimeZone: 'Europe/Berlin',
    utcStart: berlinUtc(recurrenceId), utcEnd: berlinUtc(recurrenceId, 1),
  }) as CalendarEvent;

  it('ends the old series with its overrides, and gives the new one those and what is left of the count', async () => {
    const master = sixWeeks({ '2027-01-04T10:00:00': special } as never);
    const occurrence = occurrenceOf(master, '2026-12-21T10:00:00');
    const deps = actions(master);

    await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence, { title: 'Planning, room 2' }), editor: editorOn(occurrence),
      sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    expect(deps.updateEvent).toHaveBeenCalledWith(deps.client, 'b', {
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: null, until: '2026-12-21T09:59:59' }],
      'recurrenceOverrides/2027-01-04T10:00:00': null,
    }, true);
    const [, created] = deps.createEvent.mock.calls[0];
    expect(created.start).toBe('2026-12-21T10:00:00');
    expect(created.recurrenceRules).toEqual([{ '@type': 'RecurrenceRule', frequency: 'weekly', count: 4 }]);
    // What the organizer changed goes along, not the answers the old series
    // had. 0.16 keeps an override as an event of its own: it gets the new
    // series' participants, asked again, or the occurrence has none.
    expect(created.recurrenceOverrides).toEqual({
      '2027-01-04T10:00:00': version === '1.0'
        ? { title: 'Planning, special' }
        : { start: '2027-01-04T10:00:00', duration: 'PT1H', title: 'Planning, special', participants: created.participants },
    });
    expect(statusOf(created.participants, ATTENDEE)).toBe('needs-action');
  });

  it('takes an exclusion along, and keeps the overrides before the split', async () => {
    const master = sixWeeks({ '2026-12-14T10:00:00': special, '2026-12-28T10:00:00': { excluded: true } } as never);
    const occurrence = occurrenceOf(master, '2026-12-21T10:00:00');
    const deps = actions(master);

    await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence), editor: editorOn(occurrence), sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    const [, , patch] = deps.updateEvent.mock.calls[0];
    expect(Object.keys(patch).sort()).toEqual(['recurrenceOverrides/2026-12-28T10:00:00', 'recurrenceRules']);
    expect(deps.createEvent.mock.calls[0][1].recurrenceOverrides).toEqual({ '2026-12-28T10:00:00': { excluded: true } });
  });

  it('keeps the rule the user gave the new series, count and all', async () => {
    const master = sixWeeks(null);
    const occurrence = occurrenceOf(master, '2026-12-21T10:00:00');
    const deps = actions(master);
    const daily = [{ '@type': 'RecurrenceRule', frequency: 'daily', count: 10 }] as never;

    await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence, { recurrenceRules: daily }), editor: editorOn(occurrence, { ruleChanged: true }),
      sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    expect(deps.createEvent.mock.calls[0][1].recurrenceRules).toEqual(daily);
  });

  // 18 December on, of a weekly series on Fridays: the retitled 1 January
  // stayed as an occurrence of the old series.
  it('deletes the overrides from the occurrence on with the rest of the series', async () => {
    const master = {
      ...sixWeeks({ '2027-01-01T10:00:00': { ...special, ...(version === '1.0' ? {} : { start: '2027-01-01T10:00:00' }) } } as never),
      start: '2026-12-04T10:00:00',
    } as CalendarEvent;
    const deps = { ...actions(master), deleteEvent: vi.fn().mockResolvedValue(undefined) };

    await deleteOccurrence('this_and_future', { event: occurrenceOf(master, '2026-12-18T10:00:00'), sendScheduling: true, userEmails: [ORGANIZER] }, deps);

    expect(deps.updateEvent).toHaveBeenCalledWith(deps.client, 'b', {
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: null, until: '2026-12-18T09:59:59' }],
      'recurrenceOverrides/2027-01-01T10:00:00': null,
    }, true);
  });
});

// The move of an "all" edit was measured on the user's clock. In the week
// Berlin leaves summer time and New York does not yet, 16:00 on Saturday and
// 16:00 on Monday in Berlin are 10:00 and 11:00 in New York: the series went
// to Mondays at 10:00 instead of the 11:00 the user picked.
describe('changing every occurrence across a week only one zone changes clocks in', () => {
  it('moves the series by what the move is on its own clock', () => {
    // Saturdays 10:00 in New York from 3 October; the user is in Berlin.
    const master = {
      ...series('1.0'), start: '2026-10-03T10:00:00', timeZone: 'America/New_York',
      utcStart: '2026-10-03T14:00:00Z', utcEnd: '2026-10-03T15:00:00Z',
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }], recurrenceOverrides: null,
    } as unknown as CalendarEvent;
    const occurrence = {
      ...master, id: 'maaaaac', baseEventId: 'b', start: '2026-10-24T10:00:00', recurrenceId: '2026-10-24T10:00:00',
      utcStart: '2026-10-24T14:00:00Z', utcEnd: '2026-10-24T15:00:00Z',
    } as CalendarEvent;
    const from = getEventStartDate(occurrence);
    // 16:00 in Berlin on Saturday 24 October, moved to 16:00 on Monday 26 October.
    expect(from.getHours()).toBe(16);
    const updates = seriesUpdatesFromOccurrence(
      occurrence, master, editorUpdates(occurrence, { start: '2026-10-26T16:00:00', timeZone: 'Europe/Berlin' }),
      editorOn(occurrence, { when: { allDay: false, start: addDays(from, 2), end: addHours(addDays(from, 2), 1) } }),
      context,
    );

    expect(updates.start).toBe('2026-10-05T11:00:00');
  });
});

// "All" from an occurrence with an override of its own wrote everything the
// editor showed - the occurrence's own title, copied into its override when
// it got one - to the series: a new room there renamed the series back.
describe.each<[string, Version]>([['1.0', '1.0'], ['0.16', '0.16']])('what "all" writes from an overridden occurrence on Stalwart %s', (_label, version) => {
  const room = (name: string) => ({ loc1: { '@type': 'Location', name } }) as unknown as CalendarEvent['locations'];
  // "Daily sync" weekly from 7 December. 21 December is called "Standup" in
  // room 1; 28 December was moved to 14:00 on its own (0.16 copied the
  // title then, as it was).
  function withOwnTitle(): CalendarEvent {
    const copies = version === '1.0' ? {} : { duration: 'PT1H', title: 'Daily sync' };
    return {
      ...series(version), title: 'Daily sync', start: '2026-12-07T10:00:00', utcStart: '2026-12-07T09:00:00Z', utcEnd: '2026-12-07T10:00:00Z',
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }], locations: room('Room 0'),
      recurrenceOverrides: {
        '2026-12-21T10:00:00': version === '1.0'
          ? { title: 'Standup', locations: room('Room 1') }
          : { start: '2026-12-21T10:00:00', duration: 'PT1H', title: 'Standup', locations: room('Room 1') },
        '2026-12-28T10:00:00': { start: '2026-12-28T14:00:00', ...copies },
      },
    } as unknown as CalendarEvent;
  }
  const on = (master: CalendarEvent, recurrenceId: string, own: Partial<CalendarEvent> = {}) => ({
    ...master, id: 'maaaaac', baseEventId: 'b', start: recurrenceId, recurrenceId,
    utcStart: berlinUtc(recurrenceId), utcEnd: berlinUtc(recurrenceId, 1), ...own,
  }) as CalendarEvent;

  it('writes only the new room to the series, and to that occurrence', () => {
    const master = withOwnTitle();
    const occurrence = on(master, '2026-12-21T10:00:00', { title: 'Standup', locations: room('Room 1') });
    const updates = seriesUpdatesFromOccurrence(
      occurrence, master, editorUpdates(occurrence, { locations: room('Room 2') }), editorOn(occurrence), context,
    );

    expect(updates).not.toHaveProperty('title');
    expect(updates.locations).toEqual(room('Room 2'));
    const own = updates.recurrenceOverrides!['2026-12-21T10:00:00'] as Record<string, unknown>;
    expect(own).toMatchObject({ title: 'Standup', locations: room('Room 2') });
  });

  // 1.0 returns the field as pointers when the occurrence's value came from
  // the editor under another id (live): the room stayed Room 1 there.
  it('replaces pointers into the changed field on that occurrence', () => {
    const master = withOwnTitle();
    master.recurrenceOverrides!['2026-12-21T10:00:00'] = {
      title: 'Standup', 'locations/loc1/name': 'Room 1', 'locations/l': null,
    } as never;
    const occurrence = on(master, '2026-12-21T10:00:00', { title: 'Standup', locations: room('Room 1') });
    const updates = seriesUpdatesFromOccurrence(
      occurrence, master, editorUpdates(occurrence, { locations: room('Room 2') }), editorOn(occurrence), context,
    );

    expect(updates.recurrenceOverrides!['2026-12-21T10:00:00']).toEqual({ title: 'Standup', locations: room('Room 2') });
  });

  it('renames the series and the occurrences that only had its old name, not one with its own', () => {
    const master = withOwnTitle();
    const occurrence = on(master, '2026-12-14T10:00:00');
    const updates = seriesUpdatesFromOccurrence(
      occurrence, master, editorUpdates(occurrence, { title: 'Weekly sync' }), editorOn(occurrence), context,
    );

    expect(updates.title).toBe('Weekly sync');
    if (version === '1.0') {
      // 1.0 keeps an override as a patch: 28 December has no title to change.
      expect(updates).not.toHaveProperty('recurrenceOverrides');
    } else {
      const overrides = updates.recurrenceOverrides as Record<string, Record<string, unknown>>;
      expect(overrides['2026-12-28T10:00:00'].title).toBe('Weekly sync');
      expect(overrides['2026-12-21T10:00:00'].title).toBe('Standup');
    }
  });
});

// "This and following" started the new series at the opened occurrence's own
// time and in the user's zone. Mondays 10:00 in New York, 21 December moved
// alone to Tuesday: renamed from there by a user in Berlin, the rest became
// a Tuesday series at 16:00 in Berlin.
describe.each<[string, Version]>([['1.0', '1.0'], ['0.16', '0.16']])('where "this and following" goes on on Stalwart %s', (_label, version) => {
  function mondays(): CalendarEvent {
    return {
      ...series(version), start: '2026-12-07T10:00:00', timeZone: 'America/New_York',
      utcStart: '2026-12-07T15:00:00Z', utcEnd: '2026-12-07T16:00:00Z',
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }],
      recurrenceOverrides: {
        '2026-12-21T10:00:00': version === '1.0'
          ? { start: '2026-12-22T10:00:00', title: 'Planning, Tuesday' }
          : { start: '2026-12-22T10:00:00', duration: 'PT1H', title: 'Planning, Tuesday' },
      },
    } as unknown as CalendarEvent;
  }
  // 21 December as the server hands it out: on Tuesday, 16:00 in Berlin.
  const tuesday = (master: CalendarEvent) => ({
    ...master, id: 'maaaaac', baseEventId: 'b', start: '2026-12-22T10:00:00', recurrenceId: '2026-12-21T10:00:00',
    recurrenceIdTimeZone: 'America/New_York', title: 'Planning, Tuesday',
    utcStart: '2026-12-22T15:00:00Z', utcEnd: '2026-12-22T16:00:00Z',
  }) as CalendarEvent;

  async function split(change: Partial<CalendarEvent>, hours = 0) {
    const master = mondays();
    const occurrence = tuesday(master);
    const deps = actions(master);
    await saveOccurrenceEdit('this_and_future', {
      event: occurrence,
      updates: editorUpdates(occurrence, { start: '2026-12-22T16:00:00', timeZone: 'Europe/Berlin', ...change }),
      editor: editorOn(occurrence, hours ? moveBy(occurrence, hours) : {}),
      sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);
    return deps.createEvent.mock.calls[0][1];
  }

  // 0.16.23 turns UNTIL, read on the series' clock, into UTC and compares
  // that with the occurrences' own clock: in New York "until 09:59:59" kept
  // the 10:00 occurrence (live). Five hours earlier ends the series there on
  // 0.16 and on 1.0.
  it('ends the old series early enough for 0.16 in a zone behind UTC', async () => {
    const master = mondays();
    const deps = actions(master);

    await deleteOccurrence('this_and_future', { event: tuesday(master), sendScheduling: true, userEmails: [ORGANIZER] }, {
      ...deps, deleteEvent: vi.fn(),
    });

    const [, , patch] = deps.updateEvent.mock.calls[0];
    expect(patch.recurrenceRules).toEqual([{ '@type': 'RecurrenceRule', frequency: 'weekly', until: '2026-12-21T04:59:59', count: null }]);
  });

  it('goes on from the occurrence\'s place in the series, in the series\' zone, the moved occurrence staying where it was', async () => {
    const created = await split({ description: 'New agenda' });

    expect(created).toMatchObject({ start: '2026-12-21T10:00:00', timeZone: 'America/New_York', description: 'New agenda' });
    // The series' title, not the occurrence's own; that one stays with it.
    expect(created.title).toBe('Planning');
    expect(created.recurrenceOverrides!['2026-12-21T10:00:00']).toMatchObject({ start: '2026-12-22T10:00:00', title: 'Planning, Tuesday' });
  });

  it('moves the new series and the occurrence by what the editor moved it', async () => {
    const created = await split({}, 1);

    expect(created).toMatchObject({ start: '2026-12-21T11:00:00', timeZone: 'America/New_York' });
    expect(created.recurrenceOverrides!['2026-12-21T11:00:00']).toMatchObject({ start: '2026-12-22T11:00:00' });
  });
});

// With the real calendar store: it answers a create that failed on the way
// ("Failed to fetch") with null. The series stayed ended - told so to the
// attendees - and the save reported success.
describe('this and following when the store cannot create the new series', () => {
  beforeEach(() => {
    useCalendarStore.getState().clearState();
  });

  it('puts the series back and fails the save on Stalwart 1.0', async () => {
    const occurrence = serverOccurrence('1.0');
    useCalendarStore.setState({ events: [occurrence], calendars: [], error: null });
    const client = {
      updateCalendarEvent: vi.fn().mockResolvedValue(undefined),
      createCalendarEvent: vi.fn().mockRejectedValue(new Error('Failed to fetch')),
      queryAllCalendarEvents: vi.fn().mockResolvedValue([]),
    } as unknown as IJMAPClient & { updateCalendarEvent: ReturnType<typeof vi.fn> };
    const store = useCalendarStore.getState();

    await expect(saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence, { title: 'Planning, room 2' }), editor: editorOn(occurrence),
      sendScheduling: true, userEmails: [ORGANIZER],
    }, { client, updateEvent: store.updateEvent, createEvent: store.createEvent, findMasterEvent: async () => series('1.0') })).rejects.toThrow();

    expect(client.updateCalendarEvent).toHaveBeenCalledTimes(2);
    const [id, restore, send] = client.updateCalendarEvent.mock.calls[1];
    expect([id, send]).toEqual(['b', true]);
    expect(restore).toMatchObject({ recurrenceRules: series('1.0').recurrenceRules });
  });
});

function actions(master: CalendarEvent | null) {
  return {
    client: {} as IJMAPClient,
    updateEvent: vi.fn().mockResolvedValue(undefined),
    // The calendar store's createEvent: the created event, or null when the
    // server refused it for a reason it does not pass on.
    createEvent: vi.fn(async (_client: IJMAPClient, event: Partial<CalendarEvent>, _send?: boolean) => ({ ...event, id: 'n1' }) as CalendarEvent | null),
    findMasterEvent: vi.fn().mockResolvedValue(master),
  } satisfies OccurrenceEditActions;
}

describe('saveOccurrenceEdit for every occurrence', () => {

  it('writes the series\' own change to its base event on Stalwart 1.0', async () => {
    const occurrence = serverOccurrence('1.0');
    const deps = actions(series('1.0'));

    const saved = await saveOccurrenceEdit('all', {
      event: occurrence,
      updates: editorUpdates(occurrence, { title: 'Planning, room 2' }),
      editor: editorOn(occurrence),
      sendScheduling: true,
      userEmails: [ORGANIZER],
    }, deps);

    expect(saved).toBe(true);
    expect(deps.findMasterEvent).toHaveBeenCalledWith(occurrence);
    // What the user changed, and only that: the calendar, the description
    // and the rule the editor wrote as they were stay the series' own. The
    // attendees are told, and 19 October has an override: the SEQUENCE goes
    // up (see below).
    expect(deps.updateEvent).toHaveBeenCalledWith(deps.client, 'b', {
      title: 'Planning, room 2', sequence: 1, 'recurrenceOverrides/2026-10-19T10:00:00/sequence': 1,
    }, true, expect.objectContaining({ keepSequence: true }));
  });

  it('reports a series it cannot find', async () => {
    const occurrence = serverOccurrence('1.0');
    const deps = actions(null);

    const saved = await saveOccurrenceEdit('all', {
      event: occurrence, updates: editorUpdates(occurrence), editor: editorOn(occurrence), userEmails: [ORGANIZER],
    }, deps);

    expect(saved).toBe(false);
    expect(deps.updateEvent).not.toHaveBeenCalled();
  });
});

// Privacy is the series' own: Stalwart 1.0 refuses one occurrence whose
// privacy differs from its series', so "This occurrence" with a new
// visibility failed to save.
describe('saveOccurrenceEdit with a new privacy for one occurrence', () => {
  it('gives the series the privacy before writing the occurrence', async () => {
    const occurrence = serverOccurrence('1.0');
    const deps = actions(series('1.0'));

    const saved = await saveOccurrenceEdit('this', {
      event: occurrence, updates: { title: 'Planning', privacy: 'private' }, editor: editorOn(occurrence),
      sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    expect(saved).toBe(true);
    expect(deps.updateEvent).toHaveBeenCalledTimes(2);
    expect(deps.updateEvent.mock.calls[0]).toEqual([deps.client, 'b', { privacy: 'private' }, false]);
    expect(deps.updateEvent.mock.calls[1][1]).toBe('maaaaac');
  });

  it('leaves the series alone when the privacy stays', async () => {
    const occurrence = serverOccurrence('1.0');
    const deps = actions(series('1.0'));

    await saveOccurrenceEdit('this', {
      event: occurrence, updates: { title: 'Planning, room 2' }, editor: editorOn(occurrence),
      sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    expect(deps.findMasterEvent).not.toHaveBeenCalled();
    expect(deps.updateEvent).toHaveBeenCalledTimes(1);
    expect(deps.updateEvent.mock.calls[0][1]).toBe('maaaaac');
  });
});

// The calendar store resolves false when a plugin stopped a write and has
// told the user why; the app must not report the change as saved.
describe('occurrence changes a plugin stops', () => {
  it('reports a stopped change of every occurrence', async () => {
    const occurrence = serverOccurrence('1.0');
    const deps = actions(series('1.0'));
    deps.updateEvent.mockResolvedValue(false);

    const saved = await saveOccurrenceEdit('all', {
      event: occurrence, updates: editorUpdates(occurrence, { title: 'Planning, room 2' }), editor: editorOn(occurrence),
      sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    expect(saved).toBe('stopped');
  });

  it('creates no new series when ending the old one was stopped', async () => {
    const occurrence = serverOccurrence('1.0');
    const deps = actions(series('1.0'));
    deps.updateEvent.mockResolvedValue(false);

    const saved = await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence, { title: 'Planning, room 2' }), editor: editorOn(occurrence),
      sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    expect(saved).toBe('stopped');
    expect(deps.createEvent).not.toHaveBeenCalled();
  });

  it('reports a stopped deletion of one occurrence', async () => {
    const occurrence = serverOccurrence('1.0');
    const deps = { ...actions(series('1.0')), deleteEvent: vi.fn().mockResolvedValue(false) };

    expect(await deleteOccurrence('this', { event: occurrence, userEmails: [ORGANIZER] }, deps)).toBe('stopped');
  });
});


// 0.16 sends the change of one occurrence with its SEQUENCE raised, without
// keeping the raise itself. A later rename of every occurrence carried the
// lower number for it, and the attendee's server refused the whole change:
// the mail arrived, the copy stayed as it was (live on 0.16.23). 1.0 raises
// every occurrence's SEQUENCE the same way itself for a change it sends.
describe.each<[string, Version]>([['1.0', '1.0'], ['0.16', '0.16']])('the SEQUENCE of a changed series on Stalwart %s', (_label, version) => {
  // Five Mondays from 5 October, 19 October with an override: on 0.16 it
  // holds a sequence of its own (copied when it got the override), on 1.0
  // the PatchObject leaves it out while it is the series'.
  const withSequences = (overrides: CalendarEvent['recurrenceOverrides'] = series(version).recurrenceOverrides) => ({
    ...series(version), sequence: 2,
    recurrenceOverrides: version === '1.0'
      ? overrides
      : Object.fromEntries(Object.entries(overrides ?? {}).map(([key, entry]) => [key, { ...entry, sequence: 2 }])),
  }) as CalendarEvent;
  const save = (master: CalendarEvent, change: Partial<CalendarEvent>, extra: Partial<Parameters<typeof saveOccurrenceEdit>[1]> = {}, editor = {}) => {
    const occurrence = { ...serverOccurrence(version), id: 'maaaaad', start: '2026-10-26T10:00:00', recurrenceId: '2026-10-26T10:00:00', utcStart: '2026-10-26T09:00:00Z', utcEnd: '2026-10-26T10:00:00Z' } as CalendarEvent;
    const deps = actions(master);
    return saveOccurrenceEdit('all', {
      event: occurrence, updates: editorUpdates(occurrence, change), editor: editorOn(occurrence, editor),
      sendScheduling: true, userEmails: [ORGANIZER], ...extra,
    }, deps).then(() => deps.updateEvent.mock.calls[0]);
  };

  it('raises the series\' and each changed occurrence\'s by one on a new title', async () => {
    const [, id, patch, send, options] = await save(withSequences(), { title: 'Planning, room 2' });

    expect([id, send, options.keepSequence]).toEqual(['b', true, true]);
    expect(patch).toEqual({ title: 'Planning, room 2', sequence: 3, 'recurrenceOverrides/2026-10-19T10:00:00/sequence': 3 });
    // The same from the series as the server holds it, when that is the copy.
    expect(options.fromCurrent(withSequences())).toEqual(patch);
  });

  it('raises them inside the overrides when the series moves', async () => {
    const occurrenceStart = getEventStartDate({ ...serverOccurrence(version), start: '2026-10-26T10:00:00', utcStart: '2026-10-26T09:00:00Z' } as CalendarEvent);
    const retitled = withSequences({ '2026-10-19T10:00:00': { title: 'Planning, special' } } as never);
    const [, , patch, , options] = await save(retitled, {}, {}, {
      when: { allDay: false, start: addHours(occurrenceStart, 1), end: addHours(occurrenceStart, 2) },
    });

    expect(options.keepSequence).toBe(true);
    expect(patch.sequence).toBe(3);
    expect(patch.recurrenceOverrides['2026-10-19T11:00:00'].sequence).toBe(3);
    expect(Object.keys(patch).some((key: string) => key.startsWith('recurrenceOverrides/'))).toBe(false);
  });

  // A series opened from a link a while ago, changed by another client since:
  // raised from the copy's number, the change went out lower than what the
  // attendees had, which 0.16 took and they refused; a pointer into an
  // override removed meanwhile failed the whole save. The store reads the
  // series right before the write (fromCurrent).
  it('raises the numbers the server holds right before the write, not the copy\'s', async () => {
    const stale = withSequences();
    const [, , , , options] = await save(stale, { title: 'Planning, room 2' });
    // Since then: moved twice (SEQUENCE 4), 19 October's override gone, 2
    // November cancelled and 9 November retitled alone.
    const current = {
      ...stale, sequence: 4,
      recurrenceOverrides: {
        '2026-11-02T10:00:00': { excluded: true },
        '2026-11-09T10:00:00': version === '1.0' ? { title: 'Planning, special' } : { title: 'Planning, special', sequence: 4 },
      },
    } as unknown as CalendarEvent;

    expect(options.fromCurrent(current)).toEqual({
      title: 'Planning, room 2', sequence: 5, 'recurrenceOverrides/2026-11-09T10:00:00/sequence': 5,
    });
  });

  it('raises an override the change rewrites from the copy at least one above the series the server holds', async () => {
    const occurrenceStart = getEventStartDate({ ...serverOccurrence(version), start: '2026-10-26T10:00:00', utcStart: '2026-10-26T09:00:00Z' } as CalendarEvent);
    const retitled = withSequences({ '2026-10-19T10:00:00': { title: 'Planning, special' } } as never);
    const [, , , , options] = await save(retitled, {}, {}, {
      when: { allDay: false, start: addHours(occurrenceStart, 1), end: addHours(occurrenceStart, 2) },
    });

    const raised = options.fromCurrent({ ...retitled, sequence: 6 } as CalendarEvent);
    expect(raised.sequence).toBe(7);
    expect(raised.recurrenceOverrides['2026-10-19T11:00:00'].sequence).toBe(7);
  });

  it('leaves them alone when nothing goes out, nothing the attendees see changes, or no occurrence has an override', async () => {
    const quiet = await save(withSequences(), { title: 'Planning, room 2' }, { sendScheduling: false });
    const alerts = await save(withSequences(), {
      alerts: { a1: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT5M', relativeTo: 'start' }, action: 'display' } } as never,
    });
    const plain = await save({ ...withSequences(), recurrenceOverrides: null } as CalendarEvent, { title: 'Planning, room 2' });

    for (const [, , patch, , options] of [quiet, alerts, plain]) {
      expect(patch).not.toHaveProperty('sequence');
      expect(options).toBeUndefined();
    }
  });
});

// "This and the following occurrences" ends the series before the
// occurrence and makes a new series of the rest. The new series kept the
// answers, and Stalwart invites to a new event only attendees without one:
// everyone who had answered lost the following occurrences without a word.
// The series was also ended without telling anyone, so the attendees kept
// every occurrence of it.
describe.each(occurrences)('saving this and the following occurrences on Stalwart %s', (_label, version, make) => {
  const truncated = [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: null, until: '2026-10-19T09:59:59' }];
  // The series ends before 19 October, and userb's answer to 19 October
  // (an override) goes with it.
  const truncation = { recurrenceRules: truncated, 'recurrenceOverrides/2026-10-19T10:00:00': null };

  it('tells the attendees the series ends there, and asks all of them to the new one', async () => {
    const occurrence = make();
    const deps = actions(series(version));

    const saved = await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence, { title: 'Planning, room 2' }), editor: editorOn(occurrence),
      sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    expect(saved).toBe(true);
    expect(deps.updateEvent).toHaveBeenCalledTimes(1);
    expect(deps.updateEvent).toHaveBeenCalledWith(deps.client, 'b', truncation, true);
    const [, created, send] = deps.createEvent.mock.calls[0];
    expect(send).toBe(true);
    // Five occurrences in all, two of them before 19 October.
    expect(created).toMatchObject({
      title: 'Planning, room 2', start: '2026-10-19T10:00:00',
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: 3 }],
    });
    // The new series asks userb again for every occurrence: the old answer
    // to 19 October does not come along.
    for (const key of ['id', 'uid', 'recurrenceId', 'recurrenceOverrides']) expect(created).not.toHaveProperty(key);
    expect(statusOf(created.participants, ORGANIZER)).toBe('accepted');
    expect(statusOf(created.participants, ATTENDEE)).toBe('needs-action');
  });

  // The calendar store answers most failures - "Failed to fetch" among them -
  // with null and reports them itself. The series stayed ended, told so to
  // the attendees, and the save said it had worked.
  it('puts the series back, telling the attendees again, when the store could not create the new one', async () => {
    const occurrence = make();
    const deps = actions(series(version));
    deps.createEvent.mockResolvedValue(null);

    await expect(saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence), editor: editorOn(occurrence), sendScheduling: true, userEmails: [ORGANIZER],
    }, deps)).rejects.toThrow('rest of the series');

    expect(deps.updateEvent).toHaveBeenCalledTimes(2);
    // The whole map: the truncation took the series' only override, and a
    // pointer into a series without overrides fails.
    expect(deps.updateEvent).toHaveBeenLastCalledWith(deps.client, 'b', {
      recurrenceRules: series(version).recurrenceRules,
      recurrenceOverrides: series(version).recurrenceOverrides,
    }, true);
  });

  it('puts the series back and passes on a refusal the store passes on', async () => {
    const occurrence = make();
    const deps = actions(series(version));
    deps.createEvent.mockRejectedValue(new Error('An event cannot have more than 20 participants.'));

    await expect(saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence), editor: editorOn(occurrence), sendScheduling: true, userEmails: [ORGANIZER],
    }, deps)).rejects.toThrow('more than 20');

    expect(deps.updateEvent).toHaveBeenLastCalledWith(deps.client, 'b', expect.objectContaining({
      recurrenceRules: series(version).recurrenceRules,
    }), true);
  });

  it('ends an attendee\'s own copy quietly', async () => {
    const occurrence = make();
    const deps = actions({ ...series(version), isOrigin: false });

    await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence), editor: editorOn(occurrence), sendScheduling: true, userEmails: [ATTENDEE],
    }, deps);

    expect(deps.updateEvent).toHaveBeenCalledWith(deps.client, 'b', truncation, undefined);
  });

  // The series in userc's calendar, shared with usera read & write: the
  // split ended it without a word, and the rest had no attendees - the
  // editor wrote none for someone it took for an attendee.
  it('tells the attendees and asks them to the new series when the user splits the owner\'s series in a shared calendar', async () => {
    const occurrence = make();
    const deps = actions({ ...series(version), isOrigin: true, isShared: true, accountId: 'f' });

    await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence, { title: 'Planning, room 2' }), editor: editorOn(occurrence),
      sendScheduling: true, userEmails: [SHAREE],
    }, deps);

    expect(deps.updateEvent).toHaveBeenCalledWith(deps.client, 'b', truncation, true);
    const [, created, send] = deps.createEvent.mock.calls[0];
    expect(send).toBe(true);
    expect(statusOf(created.participants, ORGANIZER)).toBe('accepted');
    expect(statusOf(created.participants, ATTENDEE)).toBe('needs-action');
  });
});

describe('the new series from this and the following occurrences', () => {
  it('starts at the occurrence and leaves the old series\' identity behind', () => {
    const occurrence = serverOccurrence('1.0');
    const data = followingSeriesData(occurrence, series('1.0'), { title: 'Moved on', recurrenceId: occurrence.recurrenceId }, null);

    expect(data).toMatchObject({ title: 'Moved on', start: '2026-10-19T10:00:00', recurrenceRules: null, timeZone: 'Europe/Berlin' });
    expect(data).not.toHaveProperty('recurrenceId');
    // Without participants in the change there are none to ask.
    expect(data).not.toHaveProperty('participants');
  });
});

// The rest of a split series is a new event, and 0.16.23 makes whoever
// creates it the organizer unless it names one: a sharee who split the
// owner's meeting became its organizer (live: the sharee's address, isOrigin
// false), and so would the user's main address for a series organized under
// an alias. 1.0 takes the owner participant.
describe.each<[string, Version]>([['1.0', '1.0'], ['0.16', '0.16']])('the organizer of the rest of a split series on Stalwart %s', (_label, version) => {
  it('is the series\' own when a sharee splits the owner\'s meeting', async () => {
    const occurrence = serverOccurrence(version);
    const deps = actions({ ...series(version), isOrigin: true, isShared: true, accountId: 'f' });

    await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence, { title: 'Planning, room 2' }), editor: editorOn(occurrence),
      sendScheduling: true, userEmails: [SHAREE],
    }, deps);

    expect(deps.createEvent.mock.calls[0][1].organizerCalendarAddress).toBe(`mailto:${ORGANIZER}`);
  });

  it('is the exact address a series organized under an alias has', async () => {
    const alias = 'planning@example.org';
    const participants = { org: participant(version, alias, true, 'accepted'), b: participant(version, ATTENDEE, false, 'accepted') };
    const master = { ...series(version), organizerCalendarAddress: `mailto:${alias}`, participants, recurrenceOverrides: null } as CalendarEvent;
    const occurrence = { ...serverOccurrence(version), organizerCalendarAddress: `mailto:${alias}`, participants } as CalendarEvent;
    const deps = actions(master);

    await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence, { title: 'Planning, room 2' }), editor: editorOn(occurrence),
      sendScheduling: true, userEmails: [ORGANIZER, alias],
    }, deps);

    expect(deps.createEvent.mock.calls[0][1].organizerCalendarAddress).toBe(`mailto:${alias}`);
  });

  it('is left out with the participants when the user removed every attendee', async () => {
    const occurrence = serverOccurrence(version);
    const deps = actions(series(version));

    await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence, { participants: null, organizerCalendarAddress: null }),
      editor: editorOn(occurrence, { attendees: [] }), sendScheduling: false, userEmails: [ORGANIZER],
    }, deps);

    const created = deps.createEvent.mock.calls[0][1];
    expect(created.participants).toBeNull();
    expect(created.organizerCalendarAddress).toBeNull();
  });
});

// The new series of a split starts at a SEQUENCE of its own. An override
// that brought the old series' number along made 0.16.23 list its
// occurrence twice in the new series - changed, and as the series has it
// (live).
describe('the overrides a split gives the new series on Stalwart 0.16', () => {
  it('leave the old series\' SEQUENCE behind', async () => {
    const participants = series('0.16').participants;
    const master = {
      ...series('0.16'), sequence: 3, start: '2026-12-07T10:00:00', utcStart: '2026-12-07T09:00:00Z', utcEnd: '2026-12-07T10:00:00Z',
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: 6 }],
      recurrenceOverrides: {
        '2027-01-04T10:00:00': { updated: '2026-11-20T09:00:00Z', start: '2027-01-04T10:00:00', duration: 'PT1H', sequence: 3, title: 'Planning, special', participants },
      },
    } as unknown as CalendarEvent;
    const occurrence = {
      ...master, id: 'maaaaae', baseEventId: 'b', start: '2026-12-21T10:00:00', recurrenceId: '2026-12-21T10:00:00',
      recurrenceIdTimeZone: 'Europe/Berlin', utcStart: berlinUtc('2026-12-21T10:00:00'), utcEnd: berlinUtc('2026-12-21T10:00:00', 1),
    } as CalendarEvent;
    const deps = actions(master);

    await saveOccurrenceEdit('this_and_future', {
      event: occurrence, updates: editorUpdates(occurrence), editor: editorOn(occurrence), sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    const created = deps.createEvent.mock.calls[0][1];
    expect(created).not.toHaveProperty('sequence');
    expect(created.recurrenceOverrides!['2027-01-04T10:00:00']).toMatchObject({ title: 'Planning, special' });
    expect(created.recurrenceOverrides!['2027-01-04T10:00:00']).not.toHaveProperty('sequence');
  });
});

// A first change to one occurrence goes out in two steps when the user
// organizes the event (see the calendar store's updateEvent).
describe.each(occurrences)('saving one occurrence on Stalwart %s', (_label, version, make) => {
  it('tells the store the user organizes the event', async () => {
    const occurrence = make();
    const deps = actions(series(version));
    const updates = editorUpdates(occurrence, { title: 'Planning, room 2' });

    await saveOccurrenceEdit('this', { event: occurrence, updates, sendScheduling: true, userEmails: [ORGANIZER] }, deps);

    expect(deps.updateEvent).toHaveBeenCalledWith(deps.client, occurrence.id, updates, true, { asOrganizer: true });
  });

  it('and that an attendee does not', async () => {
    const occurrence = make();
    const deps = actions(series(version));
    const updates = editorUpdates(occurrence, { title: 'My note' });

    await saveOccurrenceEdit('this', { event: occurrence, updates, sendScheduling: false, userEmails: [ATTENDEE] }, deps);

    expect(deps.updateEvent).toHaveBeenCalledWith(deps.client, occurrence.id, updates, false, { asOrganizer: false });
  });
});


// A series the calendar has not expanded - one just created, one opened from
// a link - shows as the series itself, once, at its first occurrence. "This
// occurrence" of it went to the series: the editor's data rewrote every
// occurrence (live on 1.0 and 0.16.23, the request an update of the series'
// id with its title, start and rule), and deleting it deleted the series.
describe.each<[string, Version]>([['1.0', '1.0'], ['0.16', '0.16']])('the series itself standing for its first occurrence on Stalwart %s', (_label, version) => {
  // As CalendarEvent/get returns the base event: on 1.0 (and 0.16.20 on) it
  // names itself as its base event.
  const base = (overrides: Partial<CalendarEvent> = {}) => ({
    ...series(version), ...(version === '1.0' ? { baseEventId: 'b' } : {}), recurrenceOverrides: null, ...overrides,
  }) as CalendarEvent;
  function seriesActions(master: CalendarEvent | null) {
    return { ...actions(master), deleteEvent: vi.fn().mockResolvedValue(undefined) };
  }

  // userb accepted the series. Stalwart sends a new override only to
  // attendees who have not answered: the change went out in one write that
  // reached nobody who had. It now takes the store's two steps.
  it('changes only the first occurrence for "this occurrence", in two steps for those who answered', async () => {
    const master = base();
    const deps = seriesActions(master);

    const saved = await saveOccurrenceEdit('this', {
      event: master, updates: editorUpdates(master, { title: 'Kick-off', recurrenceId: undefined }), sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    expect(saved).toBe(true);
    expect(deps.updateEvent).toHaveBeenCalledTimes(2);
    // First the occurrence as it is, without messages: the whole map, as the
    // series has no overrides yet; nothing of the series changes.
    const [, id, copy, quiet] = deps.updateEvent.mock.calls[0];
    expect([id, quiet]).toEqual(['b', false]);
    expect(Object.keys(copy)).toEqual(['recurrenceOverrides']);
    expect(copy.recurrenceOverrides['2026-10-05T10:00:00']).toMatchObject({ start: '2026-10-05T10:00:00', title: 'Planning' });
    // Then the change of that override, with messages.
    const [, again, change, send] = deps.updateEvent.mock.calls[1];
    expect([again, send]).toEqual(['b', true]);
    expect(Object.keys(change)).toEqual(['recurrenceOverrides/2026-10-05T10:00:00']);
    expect(change['recurrenceOverrides/2026-10-05T10:00:00']).toMatchObject({ start: '2026-10-05T10:00:00', title: 'Kick-off' });
    expect(statusOf(change['recurrenceOverrides/2026-10-05T10:00:00'].participants, ATTENDEE)).toBe('accepted');
  });

  it('changes it in one write when nobody has answered, or nothing is sent', async () => {
    const unanswered = base({
      participants: { org: participant(version, ORGANIZER, true, 'accepted'), b: participant(version, ATTENDEE, false, 'needs-action') },
    });
    for (const [master, send] of [[unanswered, true], [base(), false]] as const) {
      const deps = seriesActions(master);

      await saveOccurrenceEdit('this', {
        event: master, updates: editorUpdates(master, { title: 'Kick-off', recurrenceId: undefined }), sendScheduling: send, userEmails: [ORGANIZER],
      }, deps);

      expect(deps.updateEvent).toHaveBeenCalledTimes(1);
      expect(deps.updateEvent.mock.calls[0][3]).toBe(send);
    }
  });

  it('adds the override to those the series has', async () => {
    const master = base({ recurrenceOverrides: series(version).recurrenceOverrides });
    const deps = seriesActions(master);

    await saveOccurrenceEdit('this', {
      event: master, updates: editorUpdates(master, { title: 'Kick-off', recurrenceId: undefined }), sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    expect(Object.keys(deps.updateEvent.mock.calls[0][2])).toEqual(['recurrenceOverrides/2026-10-05T10:00:00']);
  });

  it('changes the whole series for "this and following" from its first occurrence', async () => {
    const master = base();
    const deps = seriesActions(master);

    await saveOccurrenceEdit('this_and_future', {
      event: master, updates: editorUpdates(master, { title: 'Kick-off', recurrenceId: undefined }), editor: editorOn(master),
      sendScheduling: true, userEmails: [ORGANIZER],
    }, deps);

    // Not ended before its first occurrence, no new series: the series itself changes.
    expect(deps.createEvent).not.toHaveBeenCalled();
    expect(deps.updateEvent).toHaveBeenCalledTimes(1);
    const [, id, patch] = deps.updateEvent.mock.calls[0];
    expect(id).toBe('b');
    expect(patch).toEqual({ title: 'Kick-off' });
  });

  it('excludes the first occurrence for "delete this occurrence"', async () => {
    const master = base();
    const deps = seriesActions(master);

    const deleted = await deleteOccurrence('this', { event: master, sendScheduling: true, userEmails: [ORGANIZER] }, deps);

    expect(deleted).toBe(true);
    expect(deps.deleteEvent).not.toHaveBeenCalled();
    expect(deps.updateEvent).toHaveBeenCalledWith(deps.client, 'b', {
      recurrenceOverrides: { '2026-10-05T10:00:00': { excluded: true } },
    }, true);
  });

  it('deletes the whole series for "delete this and following" from its first occurrence', async () => {
    const master = base();
    const deps = seriesActions(master);

    await deleteOccurrence('this_and_future', { event: master, sendScheduling: true, userEmails: [ORGANIZER] }, deps);

    expect(deps.deleteEvent).toHaveBeenCalledWith(deps.client, 'b', true);
    expect(deps.updateEvent).not.toHaveBeenCalled();
  });

  it('refuses rather than touch a series it cannot find', async () => {
    const deps = seriesActions(null);

    expect(await saveOccurrenceEdit('this', { event: base(), updates: { title: 'x' }, userEmails: [ORGANIZER] }, deps)).toBe(false);
    expect(await deleteOccurrence('this', { event: base(), userEmails: [ORGANIZER] }, deps)).toBe(false);
    expect(deps.updateEvent).not.toHaveBeenCalled();
    expect(deps.deleteEvent).not.toHaveBeenCalled();
  });
});

describe.each(occurrences)('deleting part of a series from one occurrence on Stalwart %s', (_label, version, make) => {
  function deleteActions() {
    return { ...actions(series(version)), deleteEvent: vi.fn().mockResolvedValue(undefined) };
  }

  it('deletes that occurrence alone through the store', async () => {
    const occurrence = make();
    const deps = deleteActions();

    await deleteOccurrence('this', { event: occurrence, sendScheduling: true, userEmails: [ORGANIZER] }, deps);

    expect(deps.deleteEvent).toHaveBeenCalledWith(deps.client, occurrence.id, true);
  });

  it('ends the series before it, telling the attendees', async () => {
    const occurrence = make();
    const deps = deleteActions();

    await deleteOccurrence('this_and_future', { event: occurrence, sendScheduling: true, userEmails: [ORGANIZER] }, deps);

    expect(deps.updateEvent).toHaveBeenCalledWith(deps.client, 'b', {
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: null, until: '2026-10-19T09:59:59' }],
      'recurrenceOverrides/2026-10-19T10:00:00': null,
    }, true);
    expect(deps.deleteEvent).not.toHaveBeenCalled();
  });

  it('deletes the series for every occurrence', async () => {
    const deps = deleteActions();

    await deleteOccurrence('all', { event: make(), sendScheduling: true, userEmails: [ORGANIZER] }, deps);

    expect(deps.deleteEvent).toHaveBeenCalledWith(deps.client, 'b', true);
  });
});

// An invitation to one occurrence alone: the server keeps it as an event of
// its own, with a recurrence id and no series to find.
describe('one occurrence the server keeps as its own event', () => {
  const lone = () => ({
    ...serverOccurrence('1.0'), id: 'lone', baseEventId: undefined, recurrenceRules: null, recurrenceOverrides: null,
  }) as unknown as CalendarEvent;

  it('is itself what changes, and what is deleted', async () => {
    const deps = { ...actions(null), deleteEvent: vi.fn().mockResolvedValue(undefined) };

    await saveOccurrenceEdit('this', { event: lone(), updates: { title: 'Mine' }, userEmails: [ATTENDEE] }, deps);
    await deleteOccurrence('this', { event: lone(), userEmails: [ATTENDEE] }, deps);

    expect(deps.updateEvent).toHaveBeenCalledWith(deps.client, 'lone', { title: 'Mine' }, undefined);
    expect(deps.deleteEvent).toHaveBeenCalledWith(deps.client, 'lone', undefined);
  });
});
