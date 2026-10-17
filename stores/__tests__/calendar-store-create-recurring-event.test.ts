import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCalendarStore } from '../calendar-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';
import { createRecurrenceRule } from '@/lib/recurrence-rule';

const calendars = [
  { id: 'cal-1', originalId: 'cal-1', name: 'Work', isDefault: true, myRights: { mayWriteAll: true } },
] as unknown as Calendar[];

function fakeClient(overrides: Partial<Record<keyof IJMAPClient, unknown>> = {}): IJMAPClient {
  return {
    createCalendarEvent: vi.fn().mockImplementation(async (event: Partial<CalendarEvent>) => ({
      id: 'ev-created-1',
      ...event,
      created: '2026-09-29T21:00:00Z',
      updated: '2026-09-29T21:00:00Z',
    })),
    updateCalendarEvent: vi.fn().mockResolvedValue(undefined),
    deleteCalendarEvent: vi.fn().mockResolvedValue(undefined),
    queryAllCalendarEvents: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as never;
}

describe('calendar-store createEvent with recurring rules', () => {
  beforeEach(() => {
    useCalendarStore.getState().clearState();
    useCalendarStore.setState({ events: [], calendars, selectedCalendarIds: ['cal-1'], error: null });
  });

  it('creates an event with weekly recurrence rules and stores it', async () => {
    const client = fakeClient();
    const eventPayload: Partial<CalendarEvent> = {
      title: 'Weekly Sync',
      start: '2026-09-30T10:00:00',
      duration: 'PT1H',
      timeZone: 'Europe/Berlin',
      showWithoutTime: false,
      calendarIds: { 'cal-1': true },
      recurrenceRules: [createRecurrenceRule('weekly')],
    };

    const created = await useCalendarStore.getState().createEvent(client, eventPayload);

    expect(created).not.toBeNull();
    expect(created?.title).toBe('Weekly Sync');
    expect(client.createCalendarEvent).toHaveBeenCalledTimes(1);
    const passedEvent = (client.createCalendarEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(passedEvent.recurrenceRules).toHaveLength(1);
    expect(passedEvent.recurrenceRules[0].frequency).toBe('weekly');
  });

  it('refetches the visible range after creating a recurring event so all occurrences appear immediately', async () => {
    const client = fakeClient({
      queryAllCalendarEvents: vi.fn().mockResolvedValue([
        { id: 'ev-created-1', title: 'Daily Standup', start: '2026-09-30T10:00:00', duration: 'PT30M', calendarIds: { 'cal-1': true } },
        { id: 'ev-created-1-occ-1', title: 'Daily Standup', start: '2026-10-01T10:00:00', duration: 'PT30M', calendarIds: { 'cal-1': true } },
      ]),
    });

    // Simulate viewing calendar
    await useCalendarStore.getState().fetchEvents(client, '2026-09-01T00:00:00Z', '2026-10-31T23:59:59Z');
    expect(client.queryAllCalendarEvents).toHaveBeenCalledTimes(1);

    const recurringEvent: Partial<CalendarEvent> = {
      title: 'Daily Standup',
      start: '2026-09-30T10:00:00',
      duration: 'PT30M',
      timeZone: 'Europe/Berlin',
      calendarIds: { 'cal-1': true },
      recurrenceRules: [createRecurrenceRule('daily')],
    };

    await useCalendarStore.getState().createEvent(client, recurringEvent);

    // After creating a recurring event, the visible range must be refetched
    expect(client.queryAllCalendarEvents).toHaveBeenCalledTimes(2);
    expect(useCalendarStore.getState().events).toHaveLength(2);
  });
});

