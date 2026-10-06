import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCalendarStore } from '../calendar-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';

const personal = { id: 'calendar-1', originalId: 'calendar-1', accountId: 'alice', name: 'Personal' } as Calendar;
const shared = { id: 'team:calendar-1', originalId: 'calendar-1', accountId: 'team', name: 'Team', isShared: true } as Calendar;
const event = {
  id: 'event-1', originalId: 'event-1', uid: 'meeting@example.test', title: 'Planning',
  start: '2026-04-15T10:00:00', duration: 'PT1H', timeZone: 'Etc/UTC',
  accountId: 'alice', calendarIds: { 'calendar-1': true },
} as unknown as CalendarEvent;

function fakeClient() {
  return {
    getCalendarsAccountId: vi.fn().mockReturnValue('alice'),
    updateCalendarEvent: vi.fn().mockResolvedValue(undefined),
    moveCalendarEvent: vi.fn().mockResolvedValue({ ...event, id: 'copied-event', calendarIds: { 'calendar-1': true } }),
  };
}

beforeEach(() => {
  useCalendarStore.getState().clearState();
  useCalendarStore.setState({ calendars: [personal, shared], events: [event], selectedCalendarIds: [personal.id] });
});

describe('calendar moves between JMAP accounts', () => {
  it('moves to the shared account even when both calendars have the same raw id', async () => {
    const client = fakeClient();
    await useCalendarStore.getState().updateEvent(client as unknown as IJMAPClient, event.id, {
      calendarIds: { [shared.id]: true }, title: 'Planning update',
    }, false);

    expect(client.updateCalendarEvent).not.toHaveBeenCalled();
    expect(client.moveCalendarEvent).toHaveBeenCalledWith('event-1', {
      calendarIds: { 'calendar-1': true }, title: 'Planning update',
    }, 'alice', 'team');
    expect(useCalendarStore.getState().events).toEqual([expect.objectContaining({
      id: 'team:copied-event', originalId: 'copied-event', accountId: 'team',
      calendarIds: { [shared.id]: true }, originalCalendarIds: { 'calendar-1': true }, isShared: true,
    })]);
    expect(useCalendarStore.getState().selectedCalendarIds).toContain(shared.id);
  });

  it('moves across accounts when the calendar ids differ', async () => {
    const client = fakeClient();
    const destination = { ...shared, id: 'team:calendar-2', originalId: 'calendar-2' };
    useCalendarStore.setState({ calendars: [personal, destination] });
    client.moveCalendarEvent.mockResolvedValue({ ...event, id: 'copied-event', calendarIds: { 'calendar-2': true } });
    await useCalendarStore.getState().updateEvent(client as unknown as IJMAPClient, event.id, { calendarIds: { [destination.id]: true } });
    expect(client.moveCalendarEvent).toHaveBeenCalledWith('event-1', { calendarIds: { 'calendar-2': true } }, 'alice', 'team');
    expect(useCalendarStore.getState().events[0].calendarIds).toEqual({ [destination.id]: true });
  });

  it('keeps the connected-login namespace when the Pro store aggregates multiple servers', async () => {
    const client = fakeClient();
    const own = { ...personal, id: 'login::calendar-1', localAccountId: 'login' };
    const destination = { ...shared, id: 'login::team:calendar-1', localAccountId: 'login' };
    const unrelated = { ...shared, id: 'other::team:calendar-1', localAccountId: 'other' };
    const source = { ...event, id: 'login::event-1', localAccountId: 'login', calendarIds: { [own.id]: true } };
    useCalendarStore.setState({ events: [source], calendars: [unrelated, own, destination] });
    await useCalendarStore.getState().updateEvent(client as unknown as IJMAPClient, source.id, { calendarIds: { [destination.id]: true } });
    expect(useCalendarStore.getState().events[0]).toMatchObject({
      id: 'login::team:copied-event', localAccountId: 'login', accountId: 'team', calendarIds: { [destination.id]: true },
    });
  });

  it('also moves from a shared account back to the personal account', async () => {
    const client = fakeClient();
    const source = { ...event, id: 'team:event-1', accountId: 'team', isShared: true, calendarIds: { [shared.id]: true } };
    useCalendarStore.setState({ events: [source] });
    await useCalendarStore.getState().updateEvent(client as unknown as IJMAPClient, source.id, { calendarIds: { [personal.id]: true } });
    expect(client.moveCalendarEvent).toHaveBeenCalledWith('event-1', { calendarIds: { 'calendar-1': true } }, 'team', 'alice');
    expect(useCalendarStore.getState().events[0]).toMatchObject({ id: 'copied-event', accountId: 'alice', isShared: false });
  });

  it('retains namespaced calendar ids for ordinary moves within a shared account', async () => {
    const client = fakeClient();
    const other = { ...shared, id: 'team:calendar-2', originalId: 'calendar-2' };
    const source = { ...event, id: 'team:event-1', accountId: 'team', calendarIds: { [shared.id]: true } };
    useCalendarStore.setState({ events: [source], calendars: [personal, shared, other] });
    await useCalendarStore.getState().updateEvent(client as unknown as IJMAPClient, source.id, { calendarIds: { [other.id]: true } });
    expect(client.moveCalendarEvent).not.toHaveBeenCalled();
    expect(client.updateCalendarEvent).toHaveBeenCalledWith('event-1', { calendarIds: { 'calendar-2': true } }, undefined, 'team');
    expect(useCalendarStore.getState().events[0].calendarIds).toEqual({ [other.id]: true });
  });

  it('keeps the source in the store when a move fails', async () => {
    const client = fakeClient();
    client.moveCalendarEvent.mockRejectedValue(new Error('Copy refused'));
    await expect(useCalendarStore.getState().updateEvent(client as unknown as IJMAPClient, event.id, {
      calendarIds: { [shared.id]: true },
    })).rejects.toThrow('Copy refused');
    expect(useCalendarStore.getState().events).toEqual([event]);
    expect(client.updateCalendarEvent).not.toHaveBeenCalled();
  });

  it('uses the base id for a server-expanded non-recurring event', async () => {
    const client = fakeClient();
    const source = { ...event, id: 'instance-1', originalId: 'instance-1', baseEventId: 'event-1', recurrenceId: null };
    useCalendarStore.setState({ events: [source] });
    await useCalendarStore.getState().updateEvent(client as unknown as IJMAPClient, source.id, { calendarIds: { [shared.id]: true } });
    expect(client.moveCalendarEvent.mock.calls[0][0]).toBe('event-1');
  });

  it.each([
    { recurrenceRules: [{ frequency: 'daily' }] },
    { recurrenceId: '2026-04-15T10:00:00' },
    { recurrenceOverrides: { '2026-04-16T10:00:00': { excluded: true } } },
  ])('rejects unsupported recurring moves before writing: %j', async (recurrence) => {
    const client = fakeClient();
    useCalendarStore.setState({ events: [{ ...event, ...recurrence } as CalendarEvent] });
    await expect(useCalendarStore.getState().updateEvent(client as unknown as IJMAPClient, event.id, {
      calendarIds: { [shared.id]: true },
    })).rejects.toThrow();
    expect(client.moveCalendarEvent).not.toHaveBeenCalled();
    expect(client.updateCalendarEvent).not.toHaveBeenCalled();
  });

  it('rejects destinations belonging to a different connected login even when account ids collide', async () => {
    const client = fakeClient();
    const other = { ...personal, id: 'other::calendar-1', localAccountId: 'other' };
    useCalendarStore.setState({ calendars: [personal, other] });
    await expect(useCalendarStore.getState().updateEvent(client as unknown as IJMAPClient, event.id, {
      calendarIds: { [other.id]: true },
    })).rejects.toThrow();
    expect(client.updateCalendarEvent).not.toHaveBeenCalled();
    expect(client.moveCalendarEvent).not.toHaveBeenCalled();
  });
});
