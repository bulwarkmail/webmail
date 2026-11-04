import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { followingSeriesData, seriesUpdatesFromOccurrence, type EventEditorState } from '@/lib/recurrence-scope-edit';
import { getEventEndDate, getEventStartDate } from '@/lib/calendar-utils';
import { AUTO_TIME_ZONE, fromWallClock, toDisplayDate } from '@/lib/timezone';
import { useSettingsStore } from '@/stores/settings-store';
import type { CalendarEvent } from '@/lib/jmap/types';

// pim-2: a series moved to another zone with the editor's time zone picker
// goes on at the same time on the new zone's clock, its overrides on their
// keys. Without the picker, a series keeps its own zone.

// Mondays at 08:00 in New York from 5 October; 19 October has a title of its own.
const master = {
  id: 'b', uid: 'weekly@example.org', '@type': 'Event', title: 'Planning', description: '',
  start: '2026-10-05T08:00:00', duration: 'PT1H', timeZone: 'America/New_York', showWithoutTime: false,
  utcStart: '2026-10-05T12:00:00Z', utcEnd: '2026-10-05T13:00:00Z', calendarIds: { cal: true },
  participants: null, alerts: null,
  recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }],
  recurrenceOverrides: { '2026-10-19T08:00:00': { title: 'Planning, budget' } },
} as unknown as CalendarEvent;
const occurrence = {
  ...master, id: 'maaaaac', baseEventId: 'b', start: '2026-10-12T08:00:00', recurrenceId: '2026-10-12T08:00:00',
  recurrenceIdTimeZone: 'America/New_York', utcStart: '2026-10-12T12:00:00Z', utcEnd: '2026-10-12T13:00:00Z',
} as CalendarEvent;

const updates = (change: Partial<CalendarEvent>): Partial<CalendarEvent> => ({
  title: 'Planning', description: '', start: '2026-10-12T08:00:00', duration: 'PT1H', timeZone: 'America/New_York',
  showWithoutTime: false, calendarIds: { cal: true }, recurrenceRules: master.recurrenceRules, recurrenceId: occurrence.recurrenceId,
  ...change,
});
const editor = (when: EventEditorState['when'], change: Partial<EventEditorState> = {}): EventEditorState => ({
  initialAttendees: [], attendees: [], when, ...change,
});
const unmoved = () => ({ allDay: false, start: getEventStartDate(occurrence), end: getEventEndDate(occurrence) });
// 08:00-09:00 on 12 October in Tokyo, as a display date.
const inTokyo = () => ({
  allDay: false,
  start: toDisplayDate(fromWallClock({ year: 2026, month: 10, day: 12, hour: 8, minute: 0, second: 0 }, 'Asia/Tokyo')),
  end: toDisplayDate(fromWallClock({ year: 2026, month: 10, day: 12, hour: 9, minute: 0, second: 0 }, 'Asia/Tokyo')),
});
const context = { userEmail: 'me@example.org', userEmails: ['me@example.org'] };

beforeEach(() => useSettingsStore.setState({ timeZone: 'Europe/Berlin' }));
afterEach(() => useSettingsStore.setState({ timeZone: AUTO_TIME_ZONE }));

describe('a series and its time zone (pim-2)', () => {
  it('keeps its zone and start when every occurrence gets a new title', () => {
    const series = seriesUpdatesFromOccurrence(occurrence, master, updates({ title: 'Planning, room 2' }), editor(unmoved()), context);
    expect(series).toEqual({ title: 'Planning, room 2' });
  });

  it('goes on at the same time in the zone the user picked, overrides on their keys', () => {
    const series = seriesUpdatesFromOccurrence(
      occurrence, master, updates({ timeZone: 'Asia/Tokyo' }), editor(inTokyo(), { timeZoneChanged: true }), context,
    );
    expect(series.timeZone).toBe('Asia/Tokyo');
    expect(series.start ?? master.start).toBe('2026-10-05T08:00:00');
    expect(series.recurrenceOverrides ?? master.recurrenceOverrides).toHaveProperty(['2026-10-19T08:00:00']);
  });

  it('moves with the clock when the user also changed the time', () => {
    const when = inTokyo();
    when.start = new Date(when.start.getTime() + 3_600_000);
    when.end = new Date(when.end.getTime() + 3_600_000);
    const series = seriesUpdatesFromOccurrence(
      occurrence, master, updates({ timeZone: 'Asia/Tokyo', start: '2026-10-12T09:00:00' }), editor(when, { timeZoneChanged: true }), context,
    );
    expect(series).toMatchObject({ start: '2026-10-05T09:00:00', timeZone: 'Asia/Tokyo' });
  });

  it('starts "this and following" in the picked zone at the occurrence time', () => {
    const data = followingSeriesData(occurrence, master, updates({ timeZone: 'Asia/Tokyo' }), master.recurrenceRules, {
      editor: editor(inTokyo(), { timeZoneChanged: true }),
      overrides: { '2026-10-19T08:00:00': { title: 'Planning, budget' } } as CalendarEvent['recurrenceOverrides'] & object,
    });
    expect(data).toMatchObject({ start: '2026-10-12T08:00:00', timeZone: 'Asia/Tokyo' });
    expect(data.recurrenceOverrides).toHaveProperty(['2026-10-19T08:00:00']);
  });
});
