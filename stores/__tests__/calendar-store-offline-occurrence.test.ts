// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { calendarArea } from '@/lib/store/calendar';
import type { CalendarConflict } from '@/lib/store/calendar/writes';
import { FakeCalendarJmap } from '@/lib/store/__tests__/helpers/fake-calendar';
import { wire, type Wire } from '@/lib/store/__tests__/helpers/client-wire';
import { isBrowserExpandedOccurrence, isServerRecurrenceInstance } from '@/lib/recurrence-instances';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useCalendarStore } from '../calendar-store';

const NOW = Date.UTC(2026, 10, 3, 12);
const START = '2026-11-02T00:00:00';
const END = '2026-11-23T00:00:00';
const ME = { '@type': 'Participant', calendarAddress: 'mailto:a@example.org', participationStatus: 'needs-action', roles: { attendee: true } };
const ORGANIZER = { '@type': 'Participant', calendarAddress: 'mailto:boss@example.org', participationStatus: 'accepted', roles: { owner: true } };

let current: Wire | null = null;

afterEach(() => {
  current?.restore();
  current = null;
  useCalendarStore.setState({ events: [], calendars: [] });
});

async function online() {
  const server = new FakeCalendarJmap('1.0');
  server.addEvent({
    id: 'series',
    title: 'Weekly',
    start: '2026-11-02T10:00:00',
    recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly' },
    organizerCalendarAddress: 'mailto:boss@example.org',
    participants: { me: ME, boss: ORGANIZER },
  });
  const w = wire(server, [calendarArea], NOW);
  current = w;
  await w.engine.requestSync();
  const client = await w.newClient() as unknown as IJMAPClient;
  await client.getCalendars();
  await useCalendarStore.getState().fetchEvents(client, START, END);
  return { w, client };
}

const overrides = (w: Wire) => w.server.events.get('series')?.recurrenceOverrides as Record<string, Record<string, unknown>> | undefined;
const flush = (w: Wire) => w.engine.areaCall('calendar.flush', undefined) as Promise<{ sent: number; conflicts: number; pending: number }>;
const conflicts = (w: Wire) => w.engine.areaCall('calendar.conflicts', undefined) as Promise<CalendarConflict[]>;
const occurrenceOn = (day: string) => useCalendarStore.getState().events.find((event) => event.start.startsWith(day));

describe('an occurrence on screen from before the connection went', () => {
  it('RSVP: goes in as an override on the master, shows after the refetch, reaches the server', async () => {
    const { w, client } = await online();
    const instance = occurrenceOn('2026-11-09');
    expect(instance && isServerRecurrenceInstance(instance)).toBe(true);
    w.online = false;

    await useCalendarStore.getState().rsvpEvent(client, instance!.id, 'me', 'accepted', undefined, 'occurrence');
    expect(overrides(w)).toBeUndefined();

    // The refetch after the answer came from the store, with occurrences of its own.
    const again = occurrenceOn('2026-11-09');
    expect(again && isBrowserExpandedOccurrence(again)).toBe(true);
    expect(again?.participants?.me.participationStatus).toBe('accepted');
    expect(occurrenceOn('2026-11-16')?.participants?.me.participationStatus).toBe('needs-action');

    w.online = true;
    expect(await flush(w)).toMatchObject({ sent: 1, pending: 0 });
    expect(await conflicts(w)).toEqual([]);
    const entry = overrides(w)?.['2026-11-09T10:00:00'] as { participants?: Record<string, { participationStatus: string }> };
    expect(entry.participants?.me.participationStatus).toBe('accepted');
  });

  it('RSVP for the whole series: a pointer patch on the master, every occurrence shows it', async () => {
    const { w, client } = await online();
    const instance = occurrenceOn('2026-11-09');
    w.online = false;
    await useCalendarStore.getState().rsvpEvent(client, instance!.id, 'me', 'accepted');
    expect(occurrenceOn('2026-11-16')?.participants?.me.participationStatus).toBe('accepted');
    w.online = true;
    expect(await flush(w)).toMatchObject({ sent: 1, pending: 0 });
    const master = w.server.events.get('series') as unknown as { participants: Record<string, { participationStatus: string }> };
    expect(master.participants.me.participationStatus).toBe('accepted');
    expect(master.participants.boss.participationStatus).toBe('accepted');
  });

  it('delete of one occurrence: excluded on the master, gone from the grid', async () => {
    const { w, client } = await online();
    const instance = occurrenceOn('2026-11-16');
    w.online = false;
    await useCalendarStore.getState().deleteEvent(client, instance!.id);
    expect(occurrenceOn('2026-11-16')).toBeUndefined();
    expect(occurrenceOn('2026-11-09')).toBeTruthy();
    w.online = true;
    await flush(w);
    expect(overrides(w)?.['2026-11-16T10:00:00']).toMatchObject({ excluded: true });
  });

  it('edit of one occurrence, then another, of the same series: both reach the server in one write', async () => {
    const { w, client } = await online();
    w.online = false;
    await useCalendarStore.getState().updateEvent(client, occurrenceOn('2026-11-09')!.id, { title: 'First change' });
    expect(occurrenceOn('2026-11-09')?.title).toBe('First change');
    await useCalendarStore.getState().updateEvent(client, occurrenceOn('2026-11-16')!.id, { title: 'Second change' });
    expect(occurrenceOn('2026-11-09')?.title).toBe('First change');
    expect(occurrenceOn('2026-11-16')?.title).toBe('Second change');
    expect(occurrenceOn('2026-11-02')?.title).toBe('Weekly');

    w.online = true;
    const before = w.server.calls.length;
    await flush(w);
    const writes = w.server.calls.slice(before).filter(([name]) => name === 'CalendarEvent/set');
    expect(writes).toHaveLength(2); // series keys refused once by 1.0, then without them
    expect(await conflicts(w)).toEqual([]);
    expect(overrides(w)?.['2026-11-09T10:00:00']).toMatchObject({ title: 'First change' });
    expect(overrides(w)?.['2026-11-16T10:00:00']).toMatchObject({ title: 'Second change' });
    expect(overrides(w)?.['2026-11-09T10:00:00']).not.toHaveProperty('organizerCalendarAddress');
  });
});
