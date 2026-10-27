import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { CalendarEvent } from '@/lib/jmap/types';

vi.mock('@/lib/browser-navigation', async (orig) => ({
  ...(await orig<typeof import('@/lib/browser-navigation')>()),
  apiFetch: vi.fn(async () => new Response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { status: 200 })),
}));

import { useCalendarStore } from '../calendar-store';

// A subscribed feed that moved an event, renamed it or changed its series
// used to change nothing: the refresh skipped every UID it already had.
// The stored copies below are what Stalwart 0.16 and 1.0 gave back for the
// same feed import (CalendarEvent/parse, then the import's create, then
// CalendarEvent/get), so an unchanged feed must cause no write on either.

const PARSED_016: Partial<CalendarEvent>[] = [
  { uid: 'e1', title: 'Timed Berlin', description: 'Line one\nLine two', start: '2026-11-10T09:00:00', duration: 'PT1H30M', timeZone: 'Europe/Berlin', status: 'confirmed', locations: { '5960afaa': { '@type': 'Location', name: 'Room 1' } } as never },
  { uid: 'e3', title: 'All day', start: '2026-11-12T00:00:00', duration: 'P1D', showWithoutTime: true },
  {
    uid: 'e5', title: 'Weekly', start: '2026-11-02T08:00:00', duration: 'PT45M', timeZone: 'Europe/Berlin',
    recurrenceRules: [{ frequency: 'weekly', count: 6, byDay: [{ day: 'mo' }] }] as never,
    recurrenceOverrides: {
      '2026-11-09T08:00:00': { excluded: true },
      '2026-11-16T08:00:00': { start: '2026-11-16T10:00:00', updated: '2026-10-20T10:00:00Z', duration: 'PT45M', title: 'Weekly moved' },
    } as never,
  },
  { uid: 'e7', title: 'Zero length', description: 'Zero', start: '2026-11-19T12:00:00', timeZone: 'Etc/UTC' },
  {
    uid: 'e8', title: 'With alarm', start: '2026-11-20T09:00:00', duration: 'PT1H', timeZone: 'Etc/UTC', status: 'tentative',
    alerts: { k1: { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } } } as never,
  },
];

const stored = (version: '0.16' | '1.0'): CalendarEvent[] => PARSED_016.map((p) => {
  const event = { ...p, id: `id-${p.uid}`, calendarIds: { 'cal-sub': true }, useDefaultAlerts: false } as CalendarEvent;
  if (p.uid === 'e7') event.duration = 'PT0S';
  if (p.uid === 'e5') {
    event.recurrenceOverrides = (version === '0.16'
      // 0.16: its own `updated`, keys in another order.
      ? { '2026-11-09T08:00:00': { excluded: true }, '2026-11-16T08:00:00': { title: 'Weekly moved', updated: '2026-10-26T13:31:01Z', duration: 'PT45M', start: '2026-11-16T10:00:00' } }
      // 1.0: only what differs from the series.
      : { '2026-11-09T08:00:00': { excluded: true }, '2026-11-16T08:00:00': { start: '2026-11-16T10:00:00', title: 'Weekly moved' } }) as never;
  }
  return event;
});

let client: Record<string, ReturnType<typeof vi.fn>>;

function setUp(version: '0.16' | '1.0', parsed: Partial<CalendarEvent>[], extra: CalendarEvent[] = []) {
  const events = [...stored(version), ...extra];
  client = {
    getServerUrl: vi.fn(() => 'https://mail.example.com'),
    getUsername: vi.fn(() => 'alice@example.com'),
    getAccountId: vi.fn(() => 'acc'),
    getCalendarsAccountId: vi.fn(() => 'acc'),
    uploadBlob: vi.fn(async () => ({ blobId: 'blob' })),
    parseCalendarEvents: vi.fn(async () => parsed),
    getCalendarEvents: vi.fn(async () => events.map(({ id, uid, calendarIds }) => ({ id, uid, calendarIds }))),
    queryCalendarEvents: vi.fn(async () => events),
    updateCalendarEvent: vi.fn(async () => {}),
    batchDeleteCalendarEvents: vi.fn(async () => {}),
    createCalendarEvents: vi.fn(async () => ({ created: [], failed: [] })),
  };
  useCalendarStore.setState({
    calendars: [], events: [], dateRange: null,
    icalSubscriptions: [{
      id: 'sub', url: 'https://feed.example/x.ics', calendarId: 'cal-sub', name: 'Feed', color: '#3b82f6',
      refreshInterval: 60, lastRefreshed: null, updatedAt: '2026-10-01T00:00:00Z', owner: 'https://mail.example.com|alice@example.com',
    }],
  });
}

const refresh = () => useCalendarStore.getState().refreshICalSubscription(client as unknown as IJMAPClient, 'sub');

beforeEach(() => vi.clearAllMocks());

describe('refreshing an iCal subscription', () => {
  it.each(['0.16', '1.0'] as const)('writes nothing when the feed did not change (%s)', async (version) => {
    setUp(version, PARSED_016);
    await refresh();
    expect(client.updateCalendarEvent).not.toHaveBeenCalled();
    expect(client.batchDeleteCalendarEvents).not.toHaveBeenCalled();
  });

  it.each(['0.16', '1.0'] as const)('applies what the feed changed to the events it still carries (%s)', async (version) => {
    const changed = PARSED_016.map((p) => {
      if (p.uid === 'e1') return { ...p, start: '2026-11-10T11:00:00', locations: { x: { '@type': 'Location', name: 'Room 2' } } as never };
      if (p.uid === 'e5') {
        return {
          ...p,
          recurrenceRules: [{ frequency: 'weekly', count: 8, byDay: [{ day: 'mo' }] }] as never,
          recurrenceOverrides: { ...p.recurrenceOverrides, '2026-11-16T08:00:00': { start: '2026-11-16T10:00:00', title: 'Weekly moved again' } } as never,
        };
      }
      return p;
    });
    setUp(version, changed);
    await refresh();

    expect(client.updateCalendarEvent).toHaveBeenCalledTimes(2);
    expect(client.updateCalendarEvent).toHaveBeenCalledWith('id-e1', expect.objectContaining({
      start: '2026-11-10T11:00:00', timeZone: 'Europe/Berlin', duration: 'PT1H30M', locations: { x: { '@type': 'Location', name: 'Room 2' } },
    }), false);
    expect(client.updateCalendarEvent).toHaveBeenCalledWith('id-e5', expect.objectContaining({
      recurrenceRules: [{ frequency: 'weekly', count: 8, byDay: [{ day: 'mo' }] }],
      recurrenceOverrides: expect.objectContaining({ '2026-11-16T08:00:00': { start: '2026-11-16T10:00:00', title: 'Weekly moved again' } }),
    }), false);
    // The user's alerts are not the feed's to reset.
    for (const [, patch] of client.updateCalendarEvent.mock.calls) expect(patch).not.toHaveProperty('alerts');
  });

  it("leaves the user's own event with the feed's UID as it is", async () => {
    const own = { id: 'id-mine', uid: 'mine', calendarIds: { 'cal-sub': true, personal: true }, title: 'My copy', start: '2026-11-01T09:00:00', duration: 'PT1H' } as unknown as CalendarEvent;
    setUp('1.0', [...PARSED_016, { uid: 'mine', title: 'Feed copy', start: '2026-11-01T10:00:00', duration: 'PT1H' }], [own]);
    await refresh();
    expect(client.updateCalendarEvent).not.toHaveBeenCalled();
  });
});
