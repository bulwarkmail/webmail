import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '@/lib/jmap/types';
import { buildDuplicateEventData } from '../calendar-duplicate';

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'ev1',
    uid: 'original-uid',
    title: 'Standup',
    description: 'Daily sync',
    start: '2026-10-05T09:30:00',
    duration: 'PT30M',
    timeZone: 'Europe/Berlin',
    showWithoutTime: false,
    calendarIds: { cal1: true },
    status: 'tentative',
    ...overrides,
  } as CalendarEvent;
}

describe('buildDuplicateEventData', () => {
  it('keeps the meeting link (#1170)', () => {
    const virtualLocations = {
      v1: { '@type': 'VirtualLocation', name: 'Video call', uri: 'https://meet.example.org/abc' },
    } as unknown as CalendarEvent['virtualLocations'];
    const data = buildDuplicateEventData(makeEvent({ virtualLocations }));
    expect(data.virtualLocations).toEqual(virtualLocations);
    expect(data.virtualLocations).not.toBe(virtualLocations);
  });

  it('moves a timed event one day later in its own time zone with a fresh uid', () => {
    const data = buildDuplicateEventData(makeEvent());
    expect(data).toMatchObject({
      title: 'Standup',
      start: '2026-10-06T09:30:00',
      duration: 'PT30M',
      timeZone: 'Europe/Berlin',
      calendarIds: { cal1: true },
      status: 'confirmed',
    });
    expect(data.uid).toBeTruthy();
    expect(data.uid).not.toBe('original-uid');
    expect(data.id).toBeUndefined();
  });

  it('sends all-day copies as floating midnight starts', () => {
    const data = buildDuplicateEventData(makeEvent({
      start: '2026-10-05T00:00:00',
      duration: 'P1D',
      showWithoutTime: true,
    }));
    expect(data).toMatchObject({ start: '2026-10-06T00:00:00', showWithoutTime: true, timeZone: null });
  });
});
