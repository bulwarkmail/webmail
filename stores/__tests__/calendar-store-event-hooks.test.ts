import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCalendarStore } from '../calendar-store';
import { calendarHooks, clearAllHooks } from '@/lib/plugin-hooks';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { CalendarEvent } from '@/lib/jmap/types';

// Plugins see event creates, edits, deletes, RSVPs and imports through the
// calendar hooks: the before-hooks run ahead of the server call and can stop
// the action, the observers fire once it succeeded.

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1',
    uid: 'uid-1',
    title: 'Planning',
    start: '2026-09-08T10:00:00',
    duration: 'PT1H',
    timeZone: 'Europe/Berlin',
    showWithoutTime: false,
    calendarIds: { c1: true },
    participants: {
      p1: { '@type': 'Participant', name: 'Me', email: 'me@example.com', participationStatus: 'needs-action' },
    },
    ...overrides,
  } as CalendarEvent;
}

function fakeClient(overrides: Partial<Record<keyof IJMAPClient, unknown>> = {}) {
  return {
    createCalendarEvent: vi.fn(async (e: Partial<CalendarEvent>) => ({ ...e, id: 'new-1' })),
    updateCalendarEvent: vi.fn().mockResolvedValue(undefined),
    deleteCalendarEvent: vi.fn().mockResolvedValue(undefined),
    queryAllCalendarEvents: vi.fn().mockResolvedValue([]),
    getCalendarEvents: vi.fn().mockResolvedValue([]),
    batchCreateCalendarEvents: vi.fn(async (batch: unknown[]) => ({
      created: batch.map((_, i) => ({ id: `imp-${i}` })), failed: [], notCreated: {},
    })),
    ...overrides,
  } as unknown as IJMAPClient & Record<string, ReturnType<typeof vi.fn>>;
}

beforeEach(() => {
  clearAllHooks();
  useCalendarStore.getState().clearState();
  useCalendarStore.setState({ events: [], calendars: [], error: null, dateRange: null });
});

describe('createEvent hooks', () => {
  it('asks onBeforeEventCreate before the server call and reports the created event', async () => {
    const client = fakeClient();
    const order: string[] = [];
    calendarHooks.onBeforeEventCreate.register('t', vi.fn((view) => {
      order.push('before');
      expect(client.createCalendarEvent).not.toHaveBeenCalled();
      expect(view).toMatchObject({ title: 'Planning', calendarId: 'c1' });
      return true;
    }));
    const after = vi.fn();
    calendarHooks.onAfterEventCreate.register('t', after);

    const created = await useCalendarStore.getState().createEvent(client, { title: 'Planning', start: '2026-09-08T10:00:00', calendarIds: { c1: true } });

    expect(order).toEqual(['before']);
    expect(created?.id).toBe('new-1');
    expect(after).toHaveBeenCalledTimes(1);
    expect(after.mock.calls[0][0]).toMatchObject({ id: 'new-1', title: 'Planning', calendarId: 'c1' });
  });

  it('creates nothing when a plugin says no', async () => {
    const client = fakeClient();
    calendarHooks.onBeforeEventCreate.register('t', () => false);
    const after = vi.fn();
    calendarHooks.onAfterEventCreate.register('t', after);

    const created = await useCalendarStore.getState().createEvent(client, { title: 'Nope' });

    expect(created).toBeNull();
    expect(client.createCalendarEvent).not.toHaveBeenCalled();
    expect(useCalendarStore.getState().events).toEqual([]);
    expect(after).not.toHaveBeenCalled();
  });

  it('does not report a create the server refused', async () => {
    const client = fakeClient({ createCalendarEvent: vi.fn().mockRejectedValue(new Error('boom')) });
    const after = vi.fn();
    calendarHooks.onAfterEventCreate.register('t', after);
    await useCalendarStore.getState().createEvent(client, { title: 'X' });
    expect(after).not.toHaveBeenCalled();
  });
});

describe('updateEvent hooks', () => {
  it('passes id and patch to onBeforeEventUpdate and the changed event to onAfterEventUpdate', async () => {
    const client = fakeClient();
    useCalendarStore.setState({ events: [event()] });
    const before = vi.fn(() => {
      expect(client.updateCalendarEvent).not.toHaveBeenCalled();
      return true;
    });
    calendarHooks.onBeforeEventUpdate.register('t', before);
    const after = vi.fn();
    calendarHooks.onAfterEventUpdate.register('t', after);

    expect(await useCalendarStore.getState().updateEvent(client, 'e1', { title: 'Renamed' })).toBe(true);

    expect(before).toHaveBeenCalledWith({ eventId: 'e1', patch: { title: 'Renamed' } });
    expect(after).toHaveBeenCalledTimes(1);
    expect(after.mock.calls[0][0]).toMatchObject({ id: 'e1', title: 'Renamed', start: '2026-09-08T10:00:00' });
  });

  it('leaves the event alone when a plugin says no', async () => {
    const client = fakeClient();
    useCalendarStore.setState({ events: [event()] });
    calendarHooks.onBeforeEventUpdate.register('t', () => false);
    const after = vi.fn();
    calendarHooks.onAfterEventUpdate.register('t', after);

    expect(await useCalendarStore.getState().updateEvent(client, 'e1', { title: 'Renamed' })).toBe(false);

    expect(client.updateCalendarEvent).not.toHaveBeenCalled();
    expect(useCalendarStore.getState().events[0].title).toBe('Planning');
    expect(after).not.toHaveBeenCalled();
  });

  it('reports a single-occurrence edit once, with the edited occurrence', async () => {
    const client = fakeClient();
    const occ = event({
      id: 'maaaaab', originalId: 'maaaaab', baseEventId: 'b', uid: 'series',
      recurrenceId: '2026-09-08T10:00:00', recurrenceIdTimeZone: 'Europe/Berlin',
      recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'daily', count: 5 }] as unknown as CalendarEvent['recurrenceRules'],
    });
    useCalendarStore.setState({ events: [occ] });
    const after = vi.fn();
    calendarHooks.onAfterEventUpdate.register('t', after);

    await useCalendarStore.getState().updateEvent(client, 'maaaaab', { title: 'Just this one' });

    expect(after).toHaveBeenCalledTimes(1);
    expect(after.mock.calls[0][0]).toMatchObject({ id: 'maaaaab', title: 'Just this one', isRecurring: true });
  });

  it('does not report an update the server refused', async () => {
    const client = fakeClient({ updateCalendarEvent: vi.fn().mockRejectedValue(new Error('boom')) });
    useCalendarStore.setState({ events: [event()] });
    const after = vi.fn();
    calendarHooks.onAfterEventUpdate.register('t', after);
    await expect(useCalendarStore.getState().updateEvent(client, 'e1', { title: 'X' })).rejects.toThrow('boom');
    expect(after).not.toHaveBeenCalled();
  });
});

describe('deleteEvent hooks', () => {
  it('asks first and reports the deleted event with its title', async () => {
    const client = fakeClient();
    useCalendarStore.setState({ events: [event()] });
    const before = vi.fn(() => {
      expect(client.deleteCalendarEvent).not.toHaveBeenCalled();
      return true;
    });
    calendarHooks.onBeforeEventDelete.register('t', before);
    const after = vi.fn();
    calendarHooks.onAfterEventDelete.register('t', after);

    expect(await useCalendarStore.getState().deleteEvent(client, 'e1')).toBe(true);

    expect(before).toHaveBeenCalledWith({ eventId: 'e1', title: 'Planning' });
    expect(after).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith({ eventId: 'e1', title: 'Planning' });
  });

  it('keeps the event when a plugin says no', async () => {
    const client = fakeClient();
    useCalendarStore.setState({ events: [event()] });
    calendarHooks.onBeforeEventDelete.register('t', () => false);
    const after = vi.fn();
    calendarHooks.onAfterEventDelete.register('t', after);

    expect(await useCalendarStore.getState().deleteEvent(client, 'e1')).toBe(false);

    expect(client.deleteCalendarEvent).not.toHaveBeenCalled();
    expect(useCalendarStore.getState().events).toHaveLength(1);
    expect(after).not.toHaveBeenCalled();
  });

  it('does not report a delete the server refused', async () => {
    const client = fakeClient({ deleteCalendarEvent: vi.fn().mockRejectedValue(new Error('boom')) });
    useCalendarStore.setState({ events: [event()] });
    const after = vi.fn();
    calendarHooks.onAfterEventDelete.register('t', after);
    await expect(useCalendarStore.getState().deleteEvent(client, 'e1')).rejects.toThrow('boom');
    expect(after).not.toHaveBeenCalled();
  });
});

describe('rsvpEvent hooks', () => {
  it('asks first and reports the answer', async () => {
    const client = fakeClient();
    useCalendarStore.setState({ events: [event()] });
    const before = vi.fn(() => {
      expect(client.updateCalendarEvent).not.toHaveBeenCalled();
      return true;
    });
    calendarHooks.onBeforeEventRsvp.register('t', before);
    const after = vi.fn();
    calendarHooks.onEventRsvp.register('t', after);

    expect(await useCalendarStore.getState().rsvpEvent(client, 'e1', 'p1', 'accepted')).toBe(true);

    expect(before).toHaveBeenCalledWith({ eventId: 'e1', status: 'accepted' });
    expect(after).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith({ eventId: 'e1', status: 'accepted' });
  });

  it('sends no answer when a plugin says no', async () => {
    const client = fakeClient();
    useCalendarStore.setState({ events: [event()] });
    calendarHooks.onBeforeEventRsvp.register('t', () => false);
    const after = vi.fn();
    calendarHooks.onEventRsvp.register('t', after);

    expect(await useCalendarStore.getState().rsvpEvent(client, 'e1', 'p1', 'accepted')).toBe(false);

    expect(client.updateCalendarEvent).not.toHaveBeenCalled();
    expect(useCalendarStore.getState().events[0].participants?.p1.participationStatus).toBe('needs-action');
    expect(after).not.toHaveBeenCalled();
  });

  it('does not report an answer the server refused', async () => {
    const client = fakeClient({ updateCalendarEvent: vi.fn().mockRejectedValue(new Error('boom')) });
    useCalendarStore.setState({ events: [event()] });
    const after = vi.fn();
    calendarHooks.onEventRsvp.register('t', after);
    await expect(useCalendarStore.getState().rsvpEvent(client, 'e1', 'p1', 'accepted')).rejects.toThrow('boom');
    expect(after).not.toHaveBeenCalled();
  });
});

describe('importEvents hooks', () => {
  const file = [
    { uid: 'a', title: 'A', start: '2026-09-08T10:00:00' },
    { uid: 'b', title: 'B', start: '2026-09-09T10:00:00' },
    { uid: 'a', title: 'A again', start: '2026-09-08T10:00:00' },
  ] as Partial<CalendarEvent>[];

  it('asks with the event count and reports what was imported and skipped', async () => {
    const client = fakeClient();
    const before = vi.fn(() => {
      expect(client.batchCreateCalendarEvents).not.toHaveBeenCalled();
      return true;
    });
    calendarHooks.onBeforeEventsImport.register('t', before);
    const after = vi.fn();
    calendarHooks.onEventsImport.register('t', after);

    const count = await useCalendarStore.getState().importEvents(client, file, 'c1');

    expect(count).toBe(2);
    expect(before).toHaveBeenCalledWith({ calendarId: 'c1', count: 3 });
    expect(after).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith({ calendarId: 'c1', imported: 2, skipped: 1 });
  });

  it('imports nothing when a plugin says no', async () => {
    const client = fakeClient();
    calendarHooks.onBeforeEventsImport.register('t', () => false);
    const after = vi.fn();
    calendarHooks.onEventsImport.register('t', after);

    const count = await useCalendarStore.getState().importEvents(client, file, 'c1');

    // null, not 0: "0 events imported" would be a success message.
    expect(count).toBeNull();
    expect(client.getCalendarEvents).not.toHaveBeenCalled();
    expect(client.batchCreateCalendarEvents).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });
});

describe('importEvents zero-duration events (#837)', () => {
  it('sends an explicit zero duration for a timed event without one', async () => {
    const client = fakeClient();
    // CalendarEvent/parse of DTSTART == DTEND returns no duration.
    const parsed = [
      { uid: 'ci', title: 'C/I', start: '2026-09-30T10:00:00', timeZone: 'Etc/UTC' },
      { uid: 'sb', title: 'Standby', start: '2026-09-30T10:00:00', timeZone: 'Etc/UTC', duration: 'PT8H' },
    ] as Partial<CalendarEvent>[];

    await useCalendarStore.getState().importEvents(client, parsed, 'c1');

    const batch = vi.mocked(client.batchCreateCalendarEvents).mock.calls[0][0];
    expect(batch.map((e) => e.duration)).toEqual(['PT0S', 'PT8H']);
  });
});

describe('fetchEvents hooks (onBeforeFetchEvents & onFetchingEvents)', () => {
  it('does not change behavior when no plugin is registered', async () => {
    const client = fakeClient({
      queryAllCalendarEvents: vi.fn().mockResolvedValue([event({ id: 'f1', start: '2026-09-08T10:00:00' })]),
    });

    const events = await useCalendarStore.getState().fetchEvents(client, '2026-09-01', '2026-09-30');

    expect(events).toHaveLength(1);
    expect(client.queryAllCalendarEvents).toHaveBeenCalledWith('2026-09-01', '2026-09-30');
  });

  it('allows onBeforeFetchEvents to edit the range and onFetchingEvents to edit fetched events', async () => {
    const client = fakeClient({
      queryAllCalendarEvents: vi.fn().mockResolvedValue([event({ id: 'f1', title: 'Original' })]),
    });

    calendarHooks.onBeforeFetchEvents.register('t', () => ({
      start: '2026-10-01',
      end: '2026-10-31',
    }));

    calendarHooks.onFetchingEvents.register('t', (events: CalendarEvent[]) =>
      events.map((e) => ({ ...e, title: 'Edited by fetch plugin' }))
    );

    await useCalendarStore.getState().fetchEvents(client, '2026-09-01', '2026-09-30');

    expect(client.queryAllCalendarEvents).toHaveBeenCalledWith('2026-10-01', '2026-10-31');
    expect(useCalendarStore.getState().events[0].title).toBe('Edited by fetch plugin');
  });
});

describe('onCreatingEvent and onUpdatingEvent hooks', () => {
  it('allows onCreatingEvent to edit the event before sending to the network', async () => {
    const client = fakeClient();

    calendarHooks.onCreatingEvent.register('t', (newEvt) => ({
      ...newEvt,
      title: 'Modified by creation plugin',
    }));

    await useCalendarStore.getState().createEvent(client, { title: 'Initial Title', start: '2026-09-08T10:00:00' });

    expect(client.createCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Modified by creation plugin' })
    );
  });

  it('allows onUpdatingEvent to edit the update payload before sending to the network', async () => {
    const client = fakeClient();
    useCalendarStore.setState({ events: [event()] });

    calendarHooks.onUpdatingEvent.register('t', (updateData) => ({
      ...updateData,
      patch: { ...updateData.patch, title: 'Modified by update plugin' },
    }));

    await useCalendarStore.getState().updateEvent(client, 'e1', { title: 'Initial Patch' });

    expect(client.updateCalendarEvent).toHaveBeenCalledWith(
      expect.any(Object),
      'e1',
      expect.objectContaining({ title: 'Modified by update plugin' })
    );
  });
});
