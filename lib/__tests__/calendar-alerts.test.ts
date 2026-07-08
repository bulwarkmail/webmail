import { describe, it, expect } from 'vitest';
import {
  parseAlertOffset,
  computeFireTime,
  getEffectiveAlerts,
  buildAlertKey,
  getPendingAlerts,
} from '../calendar-alerts';
import type {
  CalendarEvent,
  CalendarEventAlert,
  Calendar,
} from '@/lib/jmap/types';

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1',
    calendarIds: { 'cal-1': true },
    isDraft: false,
    isOrigin: true,
    utcStart: '2026-03-01T10:00:00Z',
    utcEnd: '2026-03-01T11:00:00Z',
    '@type': 'Event',
    uid: 'uid-1',
    title: 'Test Event',
    description: '',
    descriptionContentType: 'text/plain',
    created: null,
    updated: '2026-03-01T09:00:00Z',
    sequence: 0,
    start: '2026-03-01T10:00:00',
    duration: 'PT1H',
    timeZone: 'UTC',
    showWithoutTime: false,
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

function makeCalendar(overrides: Partial<Calendar> = {}): Calendar {
  return {
    id: 'cal-1',
    name: 'Work',
    description: null,
    color: '#0000ff',
    sortOrder: 1,
    isSubscribed: true,
    isVisible: true,
    isDefault: true,
    includeInAvailability: 'all',
    defaultAlertsWithTime: null,
    defaultAlertsWithoutTime: null,
    timeZone: null,
    shareWith: null,
    myRights: {
      mayReadFreeBusy: true,
      mayReadItems: true,
      mayWriteAll: true,
      mayWriteOwn: true,
      mayUpdatePrivate: true,
      mayRSVP: true,
      mayShare: false,
      mayDelete: false,
    },
    ...overrides,
  };
}

function makeAlert(overrides: Partial<CalendarEventAlert> = {}): CalendarEventAlert {
  return {
    '@type': 'Alert',
    trigger: {
      '@type': 'OffsetTrigger',
      offset: '-PT5M',
      relativeTo: 'start',
    },
    action: 'display',
    acknowledged: null,
    relatedTo: null,
    ...overrides,
  };
}

describe('parseAlertOffset', () => {
  it('parses negative minutes', () => {
    expect(parseAlertOffset('-PT5M')).toBe(-5 * 60 * 1000);
  });

  it('parses positive minutes', () => {
    expect(parseAlertOffset('PT10M')).toBe(10 * 60 * 1000);
  });

  it('parses zero duration', () => {
    expect(parseAlertOffset('PT0S')).toBe(0);
  });

  it('parses hours', () => {
    expect(parseAlertOffset('-PT1H')).toBe(-60 * 60 * 1000);
  });

  it('parses days', () => {
    expect(parseAlertOffset('-P1D')).toBe(-24 * 60 * 60 * 1000);
  });

  it('parses complex duration', () => {
    expect(parseAlertOffset('-P1DT2H30M')).toBe(-(24 * 60 * 60 + 2 * 60 * 60 + 30 * 60) * 1000);
  });

  it('returns null for invalid format', () => {
    expect(parseAlertOffset('invalid')).toBeNull();
  });

  it('parses positive day duration', () => {
    expect(parseAlertOffset('P2D')).toBe(2 * 24 * 60 * 60 * 1000);
  });

  it('parses seconds only', () => {
    expect(parseAlertOffset('PT30S')).toBe(30 * 1000);
  });
});

describe('computeFireTime', () => {
  it('computes offset from utcStart', () => {
    const event = makeEvent({ utcStart: '2026-03-01T10:00:00Z' });
    const trigger = { '@type': 'OffsetTrigger' as const, offset: '-PT5M', relativeTo: 'start' as const };
    const expected = new Date('2026-03-01T10:00:00Z').getTime() - 5 * 60 * 1000;
    expect(computeFireTime(event, trigger)).toBe(expected);
  });

  it('falls back to start when utcStart is null', () => {
    const event = makeEvent({ utcStart: null, start: '2026-03-01T10:00:00' });
    const trigger = { '@type': 'OffsetTrigger' as const, offset: '-PT10M', relativeTo: 'start' as const };
    const expected = new Date('2026-03-01T10:00:00').getTime() - 10 * 60 * 1000;
    expect(computeFireTime(event, trigger)).toBe(expected);
  });

  it('handles absolute trigger', () => {
    const event = makeEvent();
    const trigger = { '@type': 'AbsoluteTrigger' as const, when: '2026-03-01T09:55:00Z' };
    expect(computeFireTime(event, trigger)).toBe(new Date('2026-03-01T09:55:00Z').getTime());
  });

  it('handles zero offset (at time of event)', () => {
    const event = makeEvent({ utcStart: '2026-03-01T10:00:00Z' });
    const trigger = { '@type': 'OffsetTrigger' as const, offset: 'PT0S', relativeTo: 'start' as const };
    expect(computeFireTime(event, trigger)).toBe(new Date('2026-03-01T10:00:00Z').getTime());
  });

  it('handles positive offset (after start)', () => {
    const event = makeEvent({ utcStart: '2026-03-01T10:00:00Z' });
    const trigger = { '@type': 'OffsetTrigger' as const, offset: 'PT15M', relativeTo: 'start' as const };
    const expected = new Date('2026-03-01T10:00:00Z').getTime() + 15 * 60 * 1000;
    expect(computeFireTime(event, trigger)).toBe(expected);
  });

  it('computes offset from utcEnd when relativeTo is end', () => {
    const event = makeEvent({ utcStart: '2026-03-01T10:00:00Z', utcEnd: '2026-03-01T11:00:00Z' });
    const trigger = { '@type': 'OffsetTrigger' as const, offset: 'PT5M', relativeTo: 'end' as const };
    const expected = new Date('2026-03-01T11:00:00Z').getTime() + 5 * 60 * 1000;
    expect(computeFireTime(event, trigger)).toBe(expected);
  });

  it('returns null for invalid offset', () => {
    const event = makeEvent();
    const trigger = { '@type': 'OffsetTrigger' as const, offset: 'garbage', relativeTo: 'start' as const };
    expect(computeFireTime(event, trigger)).toBeNull();
  });

  it('returns null for invalid absolute trigger date', () => {
    const event = makeEvent();
    const trigger = { '@type': 'AbsoluteTrigger' as const, when: 'not-a-date' };
    expect(computeFireTime(event, trigger)).toBeNull();
  });
});

describe('getEffectiveAlerts', () => {
  it('returns event alerts when useDefaultAlerts is false', () => {
    const alerts = { 'a1': makeAlert() };
    const event = makeEvent({ useDefaultAlerts: false, alerts });
    const calendars = [makeCalendar()];
    expect(getEffectiveAlerts(event, calendars)).toBe(alerts);
  });

  it('returns null when event has no alerts and useDefaultAlerts is false', () => {
    const event = makeEvent({ useDefaultAlerts: false, alerts: null });
    const calendars = [makeCalendar()];
    expect(getEffectiveAlerts(event, calendars)).toBeNull();
  });

  it('returns calendar defaultAlertsWithTime for timed events', () => {
    const defaultAlerts = { 'd1': makeAlert() };
    const event = makeEvent({ useDefaultAlerts: true, showWithoutTime: false });
    const calendars = [makeCalendar({ defaultAlertsWithTime: defaultAlerts })];
    expect(getEffectiveAlerts(event, calendars)).toBe(defaultAlerts);
  });

  it('returns calendar defaultAlertsWithoutTime for all-day events', () => {
    const defaultAlerts = { 'd1': makeAlert() };
    const event = makeEvent({ useDefaultAlerts: true, showWithoutTime: true });
    const calendars = [makeCalendar({ defaultAlertsWithoutTime: defaultAlerts })];
    expect(getEffectiveAlerts(event, calendars)).toBe(defaultAlerts);
  });

  it('returns null when calendar not found', () => {
    const event = makeEvent({ useDefaultAlerts: true, calendarIds: { 'missing': true } });
    const calendars = [makeCalendar()];
    expect(getEffectiveAlerts(event, calendars)).toBeNull();
  });

  it('returns null when calendarIds is empty', () => {
    const event = makeEvent({ useDefaultAlerts: true, calendarIds: {} });
    const calendars = [makeCalendar()];
    expect(getEffectiveAlerts(event, calendars)).toBeNull();
  });
});

describe('buildAlertKey', () => {
  it('builds deterministic key', () => {
    const key = buildAlertKey('evt-1', 'alert-1', 12345);
    expect(key).toBe('evt-1:alert-1:12345');
  });
});

describe('getPendingAlerts', () => {
  const eventStart = new Date('2026-03-01T10:00:00Z').getTime();
  const fiveMinBefore = eventStart - 5 * 60 * 1000;

  it('returns pending display alerts', () => {
    const event = makeEvent({
      alerts: { 'a1': makeAlert() },
    });
    const calendars = [makeCalendar()];
    const now = fiveMinBefore + 1000;
    const result = getPendingAlerts([event], calendars, new Set(), now);
    expect(result).toHaveLength(1);
    expect(result[0].eventId).toBe('evt-1');
    expect(result[0].alertId).toBe('a1');
    expect(result[0].calendarName).toBe('Work');
  });

  it('skips alerts not yet due', () => {
    const event = makeEvent({
      alerts: { 'a1': makeAlert() },
    });
    const calendars = [makeCalendar()];
    const now = fiveMinBefore - 10000;
    const result = getPendingAlerts([event], calendars, new Set(), now);
    expect(result).toHaveLength(0);
  });

  it('skips stale alerts older than 10 minutes', () => {
    const event = makeEvent({
      alerts: { 'a1': makeAlert() },
    });
    const calendars = [makeCalendar()];
    const now = fiveMinBefore + 11 * 60 * 1000;
    const result = getPendingAlerts([event], calendars, new Set(), now);
    expect(result).toHaveLength(0);
  });

  it('skips alerts at exactly the stale threshold', () => {
    const event = makeEvent({
      alerts: { 'a1': makeAlert() },
    });
    const calendars = [makeCalendar()];
    const now = fiveMinBefore + 10 * 60 * 1000;
    const result = getPendingAlerts([event], calendars, new Set(), now);
    expect(result).toHaveLength(0);
  });

  it('skips acknowledged alerts', () => {
    const event = makeEvent({
      alerts: { 'a1': makeAlert() },
    });
    const calendars = [makeCalendar()];
    const now = fiveMinBefore + 1000;
    const key = buildAlertKey('evt-1', 'a1', fiveMinBefore);
    const result = getPendingAlerts([event], calendars, new Set([key]), now);
    expect(result).toHaveLength(0);
  });

  it('skips alerts for cancelled events', () => {
    // iTIP CANCEL marks the attendee's copy with status "cancelled" instead
    // of deleting it (#572) - its reminders must not fire.
    const event = makeEvent({
      status: 'cancelled',
      alerts: { 'a1': makeAlert() },
    });
    const calendars = [makeCalendar()];
    const now = fiveMinBefore + 1000;
    const result = getPendingAlerts([event], calendars, new Set(), now);
    expect(result).toHaveLength(0);
  });

  it('skips email action alerts', () => {
    const event = makeEvent({
      alerts: { 'a1': makeAlert({ action: 'email' }) },
    });
    const calendars = [makeCalendar()];
    const now = fiveMinBefore + 1000;
    const result = getPendingAlerts([event], calendars, new Set(), now);
    expect(result).toHaveLength(0);
  });

  it('skips server-acknowledged alerts', () => {
    const event = makeEvent({
      alerts: { 'a1': makeAlert({ acknowledged: '2026-03-01T09:55:00Z' }) },
    });
    const calendars = [makeCalendar()];
    const now = fiveMinBefore + 1000;
    const result = getPendingAlerts([event], calendars, new Set(), now);
    expect(result).toHaveLength(0);
  });

  it('resolves useDefaultAlerts from calendar defaults', () => {
    const defaultAlerts = {
      'd1': makeAlert({
        trigger: { '@type': 'OffsetTrigger', offset: '-PT15M', relativeTo: 'start' },
      }),
    };
    const event = makeEvent({
      useDefaultAlerts: true,
      alerts: null,
    });
    const calendars = [makeCalendar({ defaultAlertsWithTime: defaultAlerts })];
    const fifteenMinBefore = eventStart - 15 * 60 * 1000;
    const now = fifteenMinBefore + 1000;
    const result = getPendingAlerts([event], calendars, new Set(), now);
    expect(result).toHaveLength(1);
    expect(result[0].alertId).toBe('d1');
  });

  it('returns multiple alerts from same event independently', () => {
    const tenMinBefore = eventStart - 10 * 60 * 1000;
    const event = makeEvent({
      alerts: {
        'a1': makeAlert({ trigger: { '@type': 'OffsetTrigger', offset: '-PT5M', relativeTo: 'start' } }),
        'a2': makeAlert({ trigger: { '@type': 'OffsetTrigger', offset: '-PT10M', relativeTo: 'start' } }),
      },
    });
    const calendars = [makeCalendar()];
    const now = tenMinBefore + 1000;
    const result = getPendingAlerts([event], calendars, new Set(), now);
    expect(result).toHaveLength(1);
    expect(result[0].alertId).toBe('a2');

    const nowLater = fiveMinBefore + 1000;
    const result2 = getPendingAlerts([event], calendars, new Set(), nowLater);
    expect(result2).toHaveLength(2);
    const alertIds = result2.map(r => r.alertId).sort();
    expect(alertIds).toEqual(['a1', 'a2']);
  });

  it('handles multiple events with mixed alert states', () => {
    const evt1 = makeEvent({
      id: 'evt-1',
      alerts: { 'a1': makeAlert() },
    });
    const evt2 = makeEvent({
      id: 'evt-2',
      alerts: { 'a1': makeAlert({ acknowledged: '2026-03-01T09:55:00Z' }) },
    });
    const evt3 = makeEvent({
      id: 'evt-3',
      alerts: { 'a1': makeAlert() },
    });
    const calendars = [makeCalendar()];
    const now = fiveMinBefore + 1000;
    const key1 = buildAlertKey('evt-1', 'a1', fiveMinBefore);
    const result = getPendingAlerts([evt1, evt2, evt3], calendars, new Set([key1]), now);
    expect(result).toHaveLength(1);
    expect(result[0].eventId).toBe('evt-3');
  });

  it('skips alerts with unparseable offsets', () => {
    const event = makeEvent({
      alerts: {
        'a1': makeAlert({
          trigger: { '@type': 'OffsetTrigger', offset: 'invalid', relativeTo: 'start' },
        }),
      },
    });
    const calendars = [makeCalendar()];
    const now = fiveMinBefore + 1000;
    const result = getPendingAlerts([event], calendars, new Set(), now);
    expect(result).toHaveLength(0);
  });

  it('returns calendarName as null when calendar not found', () => {
    const event = makeEvent({
      calendarIds: { 'missing': true },
      alerts: { 'a1': makeAlert() },
    });
    const calendars = [makeCalendar()];
    const now = fiveMinBefore + 1000;
    const result = getPendingAlerts([event], calendars, new Set(), now);
    expect(result).toHaveLength(1);
    expect(result[0].calendarName).toBeNull();
  });
});
