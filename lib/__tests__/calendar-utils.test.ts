import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { CalendarEvent } from '@/lib/jmap/types';
import {
  buildTimedFullDayWeekSegments,
  buildWeekSegments,
  buildAllDayDuration,
  getEventDayBounds,
  getEventDisplayEndDate,
  getEventEndDate,
  getEventStartDate,
  getTimedEventBoundsForDay,
  isTimedEventFullDayOnDate,
  layoutOverlappingEvents,
  normalizeAllDayDuration,
} from '../calendar-utils';

// Several suites assert wall-clock minutes/dates derived in local time. Pin the
// timezone to UTC so results don't depend on the host's zone (CI here runs at
// UTC+2); the expected values below are all UTC.
let originalTZ: string | undefined;
beforeAll(() => {
  originalTZ = process.env.TZ;
  process.env.TZ = 'UTC';
});
afterAll(() => {
  process.env.TZ = originalTZ;
});

function expectLocalDateParts(date: Date, year: number, month: number, day: number, hour: number, minute = 0, second = 0, millisecond = 0) {
  expect(date.getFullYear()).toBe(year);
  expect(date.getMonth()).toBe(month - 1);
  expect(date.getDate()).toBe(day);
  expect(date.getHours()).toBe(hour);
  expect(date.getMinutes()).toBe(minute);
  expect(date.getSeconds()).toBe(second);
  expect(date.getMilliseconds()).toBe(millisecond);
}

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1',
    calendarIds: { 'cal-1': true },
    isDraft: false,
    isOrigin: true,
    utcStart: '2026-03-14T00:00:00Z',
    utcEnd: '2026-03-17T00:00:00Z',
    '@type': 'Event',
    uid: 'uid-1',
    title: 'Test Event',
    description: '',
    descriptionContentType: 'text/plain',
    created: null,
    updated: '2026-03-01T09:00:00Z',
    sequence: 0,
    start: '2026-03-14T00:00:00',
    duration: 'P3D',
    timeZone: 'UTC',
    showWithoutTime: true,
    status: 'confirmed',
    freeBusyStatus: 'busy',
    privacy: 'public',
    color: null,
    keywords: null,
    categories: null,
    locale: null,
    replyTo: null,
    organizerCalendarAddress: null,
    participants: null,
    mayInviteSelf: false,
    mayInviteOthers: false,
    hideAttendees: false,
    recurrenceId: null,
    recurrenceIdTimeZone: null,
    recurrenceRules: null,
    recurrenceOverrides: null,
    excludedRecurrenceRules: null,
    useDefaultAlerts: false,
    alerts: null,
    locations: null,
    virtualLocations: null,
    links: null,
    relatedTo: null,
    ...overrides,
  };
}

describe('calendar-utils all-day handling', () => {
  it('treats all-day event end as exclusive for display', () => {
    const event = makeEvent({
      start: '2026-03-14T00:00:00',
      duration: 'P3D',
      showWithoutTime: true,
    });

    expectLocalDateParts(getEventEndDate(event), 2026, 3, 17, 0);
    expectLocalDateParts(getEventDisplayEndDate(event), 2026, 3, 16, 23, 59, 59, 999);

    const { startDay, endDay } = getEventDayBounds(event);
    expectLocalDateParts(startDay, 2026, 3, 14, 0);
    expectLocalDateParts(endDay, 2026, 3, 16, 0);
  });

  it('leaves timed event display end unchanged', () => {
    const event = makeEvent({
      start: '2026-03-14T09:00:00',
      duration: 'PT2H',
      showWithoutTime: false,
      utcStart: '2026-03-14T09:00:00Z',
      utcEnd: '2026-03-14T11:00:00Z',
    });

    expect(getEventDisplayEndDate(event).toISOString()).toBe('2026-03-14T11:00:00.000Z');
  });

  it('prefers utc timestamps for timed events with an event timezone', () => {
    const event = makeEvent({
      start: '2026-03-15T09:00:00',
      duration: 'PT1H',
      timeZone: 'America/New_York',
      showWithoutTime: false,
      utcStart: '2026-03-15T13:00:00Z',
      utcEnd: '2026-03-15T14:00:00Z',
    });

    expect(getEventStartDate(event).toISOString()).toBe('2026-03-15T13:00:00.000Z');
    expect(getEventEndDate(event).toISOString()).toBe('2026-03-15T14:00:00.000Z');
  });

  it('clips timed multi-day events to the visible day bounds', () => {
    const event = makeEvent({
      start: '2026-03-14T22:00:00',
      duration: 'PT4H',
      showWithoutTime: false,
      utcStart: '2026-03-14T22:00:00Z',
      utcEnd: '2026-03-15T02:00:00Z',
    });

    expect(getTimedEventBoundsForDay(event, new Date('2026-03-14T00:00:00Z'))).toMatchObject({
      startMinutes: 1320,
      endMinutes: 1440,
      continuesBefore: false,
      continuesAfter: true,
    });

    expect(getTimedEventBoundsForDay(event, new Date('2026-03-15T00:00:00Z'))).toMatchObject({
      startMinutes: 0,
      endMinutes: 120,
      continuesBefore: true,
      continuesAfter: false,
    });
  });

  it('lays out continued timed events using clipped bounds for the active day', () => {
    const event = makeEvent({
      start: '2026-03-14T22:00:00',
      duration: 'PT4H',
      showWithoutTime: false,
      utcStart: '2026-03-14T22:00:00Z',
      utcEnd: '2026-03-15T02:00:00Z',
    });

    const layout = layoutOverlappingEvents([event], new Date('2026-03-15T00:00:00Z'));

    expect(layout).toHaveLength(1);
    expect(layout[0]).toMatchObject({
      startMinutes: 0,
      endMinutes: 120,
      column: 0,
      totalColumns: 1,
      continuesBefore: true,
      continuesAfter: false,
    });
  });

  it('detects when a timed multi-day event fully occupies an intermediate day', () => {
    const event = makeEvent({
      start: '2026-03-14T12:00:00',
      duration: 'PT48H',
      showWithoutTime: false,
      utcStart: '2026-03-14T12:00:00Z',
      utcEnd: '2026-03-16T12:00:00Z',
    });

    expect(isTimedEventFullDayOnDate(event, new Date('2026-03-15T00:00:00Z'))).toBe(true);
    expect(isTimedEventFullDayOnDate(event, new Date('2026-03-14T00:00:00Z'))).toBe(false);
    expect(isTimedEventFullDayOnDate(event, new Date('2026-03-16T00:00:00Z'))).toBe(false);
  });

  it('creates week-bar segments for timed events that fully cover visible days', () => {
    const week = [
      new Date('2026-03-14T00:00:00Z'),
      new Date('2026-03-15T00:00:00Z'),
      new Date('2026-03-16T00:00:00Z'),
      new Date('2026-03-17T00:00:00Z'),
      new Date('2026-03-18T00:00:00Z'),
      new Date('2026-03-19T00:00:00Z'),
      new Date('2026-03-20T00:00:00Z'),
    ];
    const event = makeEvent({
      start: '2026-03-14T12:00:00',
      duration: 'PT72H',
      showWithoutTime: false,
      utcStart: '2026-03-14T12:00:00Z',
      utcEnd: '2026-03-17T12:00:00Z',
    });

    const segments = buildTimedFullDayWeekSegments([event], week);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      startIndex: 1,
      span: 2,
      continuesBefore: false,
      continuesAfter: false,
    });
  });

  it('normalizes imported all-day durations to day units', () => {
    expect(normalizeAllDayDuration('PT24H')).toBe('P1D');
    expect(normalizeAllDayDuration('PT72H')).toBe('P3D');
    expect(normalizeAllDayDuration('P1DT12H')).toBe('P2D');
    expect(normalizeAllDayDuration(undefined)).toBeUndefined();
  });

  it('builds an inclusive all-day duration from editor dates', () => {
    const start = new Date('2026-03-14T00:00:00Z');
    const inclusiveEnd = new Date('2026-03-16T00:00:00Z');

    expect(buildAllDayDuration(start, inclusiveEnd)).toBe('P3D');
  });

  it('builds a single week segment for a five-day event instead of one entry per day', () => {
    const week = [
      new Date('2026-03-16T00:00:00Z'),
      new Date('2026-03-17T00:00:00Z'),
      new Date('2026-03-18T00:00:00Z'),
      new Date('2026-03-19T00:00:00Z'),
      new Date('2026-03-20T00:00:00Z'),
      new Date('2026-03-21T00:00:00Z'),
      new Date('2026-03-22T00:00:00Z'),
    ];
    const event = makeEvent({
      start: '2026-03-16T00:00:00',
      duration: 'P5D',
      title: 'Full day',
      showWithoutTime: true,
    });

    const segments = buildWeekSegments([event], week);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      startIndex: 0,
      span: 5,
      row: 0,
      continuesBefore: false,
      continuesAfter: false,
    });
  });

  it('splits a continuing event across weeks without snaking inside a week row', () => {
    const week = [
      new Date('2026-03-16T00:00:00Z'),
      new Date('2026-03-17T00:00:00Z'),
      new Date('2026-03-18T00:00:00Z'),
      new Date('2026-03-19T00:00:00Z'),
      new Date('2026-03-20T00:00:00Z'),
      new Date('2026-03-21T00:00:00Z'),
      new Date('2026-03-22T00:00:00Z'),
    ];
    const event = makeEvent({
      start: '2026-03-14T00:00:00',
      duration: 'P10D',
      title: 'Long event',
      showWithoutTime: true,
    });

    const segments = buildWeekSegments([event], week);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      startIndex: 0,
      span: 7,
      row: 0,
      continuesBefore: true,
      continuesAfter: true,
    });
  });
});
