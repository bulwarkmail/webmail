// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { calendarArea } from '@/lib/store/calendar';
import type { CalendarConflict } from '@/lib/store/calendar/writes';
import { FakeCalendarJmap } from '@/lib/store/__tests__/helpers/fake-calendar';
import { wire, type Wire } from '@/lib/store/__tests__/helpers/client-wire';
import { isBrowserExpandedOccurrence, isServerRecurrenceInstance } from '@/lib/recurrence-instances';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { CalendarEvent } from '@/lib/jmap/types';
import { saveOccurrenceEdit } from '@/lib/recurrence-scope-edit';
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
    // As 1.0 reads it back: only what differs from the series.
    expect(overrides(w)?.['2026-11-09T10:00:00']).toMatchObject({ 'participants/me/participationStatus': 'accepted' });
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

describe('a change that should reach everyone who answered', () => {
  async function organizer() {
    const server = new FakeCalendarJmap('1.0');
    server.addEvent({
      id: 'series',
      title: 'Weekly',
      start: '2026-11-02T10:00:00',
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly' },
      organizerCalendarAddress: 'mailto:a@example.org',
      participants: {
        me: { '@type': 'Participant', calendarAddress: 'mailto:a@example.org', participationStatus: 'accepted', roles: { owner: true } },
        bob: { '@type': 'Participant', calendarAddress: 'mailto:bob@example.org', participationStatus: 'accepted', roles: { attendee: true } },
      },
    });
    const w = wire(server, [calendarArea], NOW);
    current = w;
    await w.engine.requestSync();
    const client = await w.newClient() as unknown as IJMAPClient;
    await client.getCalendars();
    await useCalendarStore.getState().fetchEvents(client, START, END);
    return { w, client };
  }

  const writes = (w: Wire) => w.server.calls.filter(([name, args]) => name === 'CalendarEvent/set' && !(args.update && 'h333333' in (args.update as object)));

  it('keeps its two steps: the override quietly first, then the change with messages', async () => {
    const { w, client } = await organizer();
    w.online = false;
    await useCalendarStore.getState().updateEvent(client, occurrenceOn('2026-11-09')!.id, { title: 'Moved room' }, true, { asOrganizer: true });
    expect(w.db.all('SELECT send_scheduling FROM calendar_pending ORDER BY seq').map((row) => row.send_scheduling)).toEqual([0, 1]);
    expect(occurrenceOn('2026-11-09')?.title).toBe('Moved room');

    w.online = true;
    w.server.calls.length = 0;
    await flush(w);
    expect(await conflicts(w)).toEqual([]);
    const flags = writes(w).map(([, args]) => args.sendSchedulingMessages);
    expect(flags[0]).toBe(false);
    expect(flags[flags.length - 1]).toBe(true);
    const lastPatch = (writes(w).at(-1)?.[1].update as Record<string, Record<string, unknown>>).series;
    expect(JSON.stringify(lastPatch)).toContain('Moved room');
    const firstPatch = (writes(w)[0][1].update as Record<string, Record<string, unknown>>).series;
    expect(JSON.stringify(firstPatch)).not.toContain('Moved room');
    expect(overrides(w)?.['2026-11-09T10:00:00']).toMatchObject({ title: 'Moved room' });
  });
});

describe('a stand-in id still held by the page once the server is back', () => {
  async function created() {
    const { w, client } = await online();
    w.online = false;
    const event = await useCalendarStore.getState().createEvent(client, {
      title: 'Offline',
      start: '2026-11-11T08:00:00',
      duration: 'PT1H',
      timeZone: 'Europe/Berlin',
      calendarIds: { cal1: true },
    } as Partial<CalendarEvent>);
    expect(event?.id).toMatch(/^local-/);
    return { w, client, standIn: event!.id };
  }
  const realId = (w: Wire) => [...w.server.events.values()].find((event) => event.title !== 'Weekly')!.id;

  it('an open dialog saves after the flush: the change reaches the real event', async () => {
    const { w, client, standIn } = await created();
    w.online = true;
    await flush(w);
    const real = realId(w);
    await useCalendarStore.getState().updateEvent(client, standIn, { title: 'Saved from the dialog' });
    expect(w.server.events.get(real)?.title).toBe('Saved from the dialog');
    expect(w.sent.flatMap(([, args]) => Object.keys((args.update ?? {}) as object))).not.toContain(`${standIn}x`);
    const local = w.server.calls.filter(([, args]) => JSON.stringify(args).includes(standIn));
    expect(local).toEqual([]);
  });

  it('a delete and a read work too, and a refusal still reads as a refusal', async () => {
    const { w, client, standIn } = await created();
    w.online = true;
    await flush(w);
    const real = realId(w);
    expect((await client.getCalendarEvent(standIn))?.id).toBe(real);
    w.server.refuse[real] = { type: 'forbidden', description: 'No rights' };
    await expect(client.updateCalendarEvent(standIn, { title: 'x' })).rejects.toThrow('No rights');
    await client.deleteCalendarEvent(standIn);
    expect(w.server.events.has(real)).toBe(false);
  });

  it('before the flush the change joins the queue instead of asking the server for an unknown id', async () => {
    const { w, client, standIn } = await created();
    w.online = true;
    w.server.calls.length = 0;
    await client.updateCalendarEvent(standIn, { title: 'Still queued' });
    expect(w.server.calls).toEqual([]);
    await flush(w);
    expect(w.server.events.get(realId(w))?.title).toBe('Still queued');
  });
});

describe('this and future while offline', () => {
  it('is refused before anything is written', async () => {
    const { w, client } = await online();
    w.online = false;
    await useCalendarStore.getState().fetchEvents(client, START, END);
    const event = occurrenceOn('2026-11-09')!;
    const updateEvent = useCalendarStore.getState().updateEvent;
    const createEvent = useCalendarStore.getState().createEvent;
    await expect(saveOccurrenceEdit('this_and_future', {
      event,
      updates: { title: 'From here on' },
      sendScheduling: false,
      userEmails: ['a@example.org'],
    }, { client, updateEvent, createEvent, findMasterEvent: async () => client.getCalendarEvent('series') })).rejects.toMatchObject({ name: 'SeriesSplitNeedsServerError' });
    expect(w.db.all('SELECT 1 FROM calendar_pending')).toEqual([]);
  });

  it('still works online', async () => {
    const { w, client } = await online();
    const event = occurrenceOn('2026-11-09')!;
    const { updateEvent, createEvent } = useCalendarStore.getState();
    await saveOccurrenceEdit('this_and_future', {
      event,
      updates: { title: 'From here on' },
      sendScheduling: false,
      userEmails: ['a@example.org'],
    }, { client, updateEvent, createEvent, findMasterEvent: async () => client.getCalendarEvent('series') });
    expect([...w.server.events.values()].some((e) => e.title === 'From here on')).toBe(true);
  });
});
