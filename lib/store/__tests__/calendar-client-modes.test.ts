// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import type { JMAPClient } from '@/lib/jmap/client';
import type { CalendarEvent } from '@/lib/jmap/types';
import { expandRecurringEvents } from '@/lib/recurrence-expansion';
import { isBrowserExpandedOccurrence, isServerRecurrenceInstance } from '@/lib/recurrence-instances';
import { calendarArea } from '../calendar';
import { FakeCalendarJmap, type StalwartVersion } from './helpers/fake-calendar';
import { wire, type Wire } from './helpers/client-wire';

const NOW = Date.UTC(2026, 10, 3, 12);
const RANGE = { after: '2026-11-02T00:00:00', before: '2026-11-23T00:00:00' };

let current: Wire | null = null;

afterEach(() => {
  current?.restore();
  current = null;
});

function seeded(version: StalwartVersion): Wire {
  const server = new FakeCalendarJmap(version);
  server.addEvent({
    id: 'series',
    title: 'Weekly',
    start: '2026-01-05T10:00:00',
    recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly' },
    recurrenceOverrides: {
      '2026-11-09T10:00:00': { title: 'Special' },
      '2026-11-16T10:00:00': { excluded: true },
    },
  });
  server.addEvent({ id: 'single', title: 'One off', start: '2026-11-10T09:00:00' });
  current = wire(server, [calendarArea], NOW);
  return current;
}

/** What the calendar grid shows for a range: the client's query, then the store's expansion. */
async function grid(client: JMAPClient, range = RANGE): Promise<CalendarEvent[]> {
  const raw = await client.queryAllCalendarEvents(range);
  return expandRecurringEvents(raw, range.after, range.before);
}

function summary(events: CalendarEvent[]): Array<[string, string]> {
  return events.map((event): [string, string] => [event.start, event.title]).sort();
}

const SHOWN = [
  ['2026-11-02T10:00:00', 'Weekly'],
  ['2026-11-09T10:00:00', 'Special'],
  ['2026-11-10T09:00:00', 'One off'],
];

const expandedAsked = (w: Wire) => w.sent.some(([name, args]) => name === 'CalendarEvent/query' && args.expandRecurrences === true);

describe('a client that probed online and keeps its mode', () => {
  for (const version of ['1.0', '0.16'] as const) {
    it(`synthetic-id mode on ${version}: the expanded query gets a correct grid`, async () => {
      const w = seeded(version);
      await w.engine.requestSync();
      const client = await w.newClient();
      await client.getCalendars();
      expect(await client.supportsSyntheticCalendarIds()).toBe(true);
      const online = await grid(client);
      expect(online.some(isServerRecurrenceInstance)).toBe(true);
      expect(summary(online)).toEqual(SHOWN);

      w.online = false;
      w.sent.length = 0;
      const offline = await grid(client);
      expect(expandedAsked(w)).toBe(true);
      expect(summary(offline)).toEqual(SHOWN);
      // Occurrences the calendar store can write back as overrides on the master.
      const occurrences = offline.filter((event) => event.recurrenceId);
      expect(occurrences.length).toBe(2);
      for (const occurrence of occurrences) {
        expect(isBrowserExpandedOccurrence(occurrence)).toBe(true);
        expect(occurrence.originalId).toBe('series');
      }
      // Back online, the same client still asks the server to expand.
      w.online = true;
      expect((await grid(client)).some(isServerRecurrenceInstance)).toBe(true);
    });
  }

  it('client-expansion mode on an old server: never asks to expand, same grid', async () => {
    const w = seeded('0.16.19');
    await w.engine.requestSync();
    const client = await w.newClient();
    await client.getCalendars();
    expect(await client.supportsSyntheticCalendarIds()).toBe(false);
    w.online = false;
    w.sent.length = 0;
    expect(summary(await grid(client))).toEqual(SHOWN);
    expect(expandedAsked(w)).toBe(false);
    // The second get with the overrides went out, as the online path sends it.
    const gets = w.sent.filter(([name]) => name === 'CalendarEvent/get');
    expect(gets.some(([, args]) => (args.properties as string[]).join() === 'id,recurrenceOverrides')).toBe(true);
  });

  it('gives the grid across a range longer than one expanded query may span', async () => {
    const w = seeded('1.0');
    await w.engine.requestSync();
    const client = await w.newClient();
    await client.getCalendars();
    w.online = false;
    w.sent.length = 0;
    const range = { after: '2026-11-02T00:00:00', before: '2028-11-02T00:00:00' };
    const events = await grid(client, range);
    const queries = w.sent.filter(([name]) => name === 'CalendarEvent/query');
    expect(queries.length).toBeGreaterThan(1);
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
    expect(events.filter((event) => event.title === 'Weekly').length).toBeGreaterThan(90);
    expect(events.filter((event) => event.title === 'Special')).toHaveLength(1);
  });
});

describe('a client started offline', () => {
  it('takes the mode the server had at the last sync, so it behaves the same once the server is back', async () => {
    const w = seeded('1.0');
    await w.engine.requestSync();
    w.online = false;
    const client = await w.newClient();
    await client.getCalendars();
    expect(await client.supportsSyntheticCalendarIds()).toBe(true);
    expect(summary(await grid(client))).toEqual(SHOWN);
    w.online = true;
    expect((await grid(client)).some(isServerRecurrenceInstance)).toBe(true);
  });

  it('does not ask to expand on a server that had no synthetic ids', async () => {
    const w = seeded('0.16.19');
    await w.engine.requestSync();
    w.online = false;
    w.sent.length = 0;
    const client = await w.newClient();
    await client.getCalendars();
    expect(await client.supportsSyntheticCalendarIds()).toBe(false);
    expect(summary(await grid(client))).toEqual(SHOWN);
    expect(expandedAsked(w)).toBe(false);
  });

  it('uses client-side expansion before any sync, and a failed read does not look like an empty calendar', async () => {
    const w = seeded('1.0');
    w.online = false;
    const client = await w.newClient();
    expect(await client.supportsSyntheticCalendarIds()).toBe(false);
    await expect(client.queryAllCalendarEvents(RANGE)).rejects.toThrow();
  });
});

describe('reads and writes through the real client', () => {
  it('reads back a created event under its stand-in id, then edits and deletes it', async () => {
    const w = seeded('1.0');
    await w.engine.requestSync();
    const client = await w.newClient();
    await client.getCalendars();
    w.online = false;

    const created = await client.createCalendarEvent({
      title: 'Offline',
      start: '2026-11-11T08:00:00',
      duration: 'PT1H',
      timeZone: 'Europe/Berlin',
      calendarIds: { cal1: true },
    } as Partial<CalendarEvent>);
    expect(created.id).toMatch(/^local-/);
    expect(created.title).toBe('Offline');
    expect(created.utcStart).toBe('2026-11-11T07:00:00Z');
    expect(summary(await grid(client))).toContainEqual(['2026-11-11T08:00:00', 'Offline']);

    await client.updateCalendarEvent(created.id, { title: 'Renamed' });
    expect(summary(await grid(client))).toContainEqual(['2026-11-11T08:00:00', 'Renamed']);

    await client.deleteCalendarEvent(created.id);
    expect(summary(await grid(client))).toEqual(SHOWN);
    expect(await client.getCalendarEvent(created.id)).toBeNull();
    expect(w.server.events.size).toBe(2);
  });

  it('fetches overrides with its one-event read', async () => {
    const w = seeded('1.0');
    await w.engine.requestSync();
    const client = await w.newClient();
    w.online = false;
    const event = await client.getCalendarEvent('series');
    expect(event?.recurrenceRules).toEqual([{ '@type': 'RecurrenceRule', frequency: 'weekly' }]);
    expect(Object.keys(event?.recurrenceOverrides ?? {})).toHaveLength(2);
    expect(event?.utcStart).toBe('2026-01-05T09:00:00Z');
  });

  it('lists tasks through the shape fetchTaskObjects reads', async () => {
    const w = seeded('1.0');
    w.server.addEvent({ id: 'task', '@type': 'Task', title: 'To do', start: undefined, due: '2026-11-12T10:00:00', progress: 'needs-action' });
    await w.engine.requestSync();
    const client = await w.newClient();
    w.online = false;
    const tasks = await client.getCalendarTasks();
    expect(tasks.map((task) => [task.id, task.title, task.due])).toEqual([['task', 'To do', '2026-11-12T10:00:00']]);
    expect(summary(await grid(client)).map(([, title]) => title)).not.toContain('To do');
  });

  it('marks tasks-only calendars and reads identities from the last sync', async () => {
    const w = seeded('1.0');
    await w.engine.requestSync();
    const client = await w.newClient();
    w.online = false;
    const calendars = await client.getCalendars();
    expect(calendars.map((calendar) => [calendar.id, calendar.isTasksOnly])).toEqual([['cal1', false]]);
    expect((await client.getParticipantIdentities())[0].calendarAddress).toBe('mailto:a@example.org');
  });
});
