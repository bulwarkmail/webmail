import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';
import { SYNTHETIC_ID_PROBE } from '../recurrence-instances';

// CalendarEvent/query?expandRecurrences=true hands out one synthetic id per
// occurrence. Stalwart accepts those ids in CalendarEvent/set from 0.16.20
// on; older releases reject them. The client probes that once (an update on
// a synthetic id that cannot exist: `notFound` on a supporting server,
// `invalidProperties` before) and only asks for server-side expansion when
// the ids are usable, then pulls the series' recurrence rule / overrides
// from the base events so an occurrence looks like the client-expanded ones.

function makeSession() {
  return {
    capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:calendars': {} },
    accounts: {
      'acct-1': { name: 'test', isPersonal: true, accountCapabilities: { 'urn:ietf:params:jmap:calendars': {} } },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1', 'urn:ietf:params:jmap:calendars': 'acct-1' },
    apiUrl: 'https://mail.example.com/jmap/api',
    downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
    uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
    eventSourceUrl: '',
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const RANGE = { after: '2026-09-01T00:00:00', before: '2026-09-30T00:00:00' };

// What 0.16.19 returned for the probe series (see lib/recurrence-instances.ts).
const OCCURRENCE = {
  id: 'maaaaab', baseEventId: 'b', uid: 'series@example.com', title: 'Daily standup',
  start: '2026-09-08T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin',
  utcStart: '2026-09-08T08:00:00Z', utcEnd: '2026-09-08T09:00:00Z',
  recurrenceId: '2026-09-08T10:00:00', recurrenceIdTimeZone: 'Europe/Berlin',
  calendarIds: { f: true }, isDraft: false, isOrigin: true, useDefaultAlerts: true,
};
const SINGLE = {
  id: 'eaaaaad', baseEventId: 'd', uid: 'single@example.com', title: 'One off',
  start: '2026-09-08T09:00:00', duration: 'PT30M', timeZone: 'Europe/Berlin',
  utcStart: '2026-09-08T07:00:00Z', utcEnd: '2026-09-08T07:30:00Z',
  calendarIds: { f: true }, isDraft: false, isOrigin: true, useDefaultAlerts: true,
};
const BASE = {
  id: 'b', duration: 'PT1H', timeZone: 'Europe/Berlin',
  recurrenceRule: { frequency: 'daily', count: 5 },
  recurrenceOverrides: { '2026-09-10T10:00:00': { excluded: true } },
};
const MASTER = {
  ...BASE, baseEventId: 'b', uid: 'series@example.com', title: 'Daily standup',
  start: '2026-09-07T10:00:00', utcStart: '2026-09-07T08:00:00Z', utcEnd: '2026-09-07T09:00:00Z',
  calendarIds: { f: true }, isDraft: false, isOrigin: true, useDefaultAlerts: true,
};

type Call = { method: string; args: Record<string, unknown> };

describe('server-side recurrence expansion with synthetic ids', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let client: JMAPClient;
  let calls: Call[];
  let serverSupportsSyntheticIds: boolean;
  let probeFails: boolean;

  beforeEach(async () => {
    calls = [];
    serverSupportsSyntheticIds = true;
    probeFails = false;
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(jsonResponse(makeSession()));
    client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
    await client.connect();
    fetchSpy.mockReset();

    fetchSpy.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const methodResponses: unknown[] = [];
      for (const [method, args, callId] of body.methodCalls ?? []) {
        calls.push({ method, args });
        methodResponses.push([...answer(method, args), callId]);
      }
      return jsonResponse({ methodResponses });
    });

    function answer(method: string, args: Record<string, unknown>): [string, unknown] {
      const update = args.update as Record<string, unknown> | undefined;
      if (method === 'CalendarEvent/set' && update?.[SYNTHETIC_ID_PROBE]) {
        if (probeFails) throw new Error('network down');
        const failure = serverSupportsSyntheticIds
          ? { type: 'notFound' }
          : { type: 'invalidProperties', description: 'Updating synthetic ids is not yet supported.', properties: ['id'] };
        return ['CalendarEvent/set', { notUpdated: { [SYNTHETIC_ID_PROBE]: failure } }];
      }
      if (method === 'CalendarEvent/set') {
        return ['CalendarEvent/set', { updated: Object.fromEntries(Object.keys(update ?? {}).map((id) => [id, null])) }];
      }
      if (method === 'CalendarEvent/query') {
        const ids = args.expandRecurrences ? ['maaaaab', 'eaaaaad'] : ['b', 'd'];
        return ['CalendarEvent/query', { ids }];
      }
      if (method === 'CalendarEvent/get') {
        const ids = args.ids as string[];
        const byId: Record<string, unknown> = { maaaaab: OCCURRENCE, eaaaaad: SINGLE, d: { ...SINGLE, id: 'd' } };
        // The base-event hydration get asks only for recurrence properties.
        byId.b = (args.properties as string[]).includes('title') ? MASTER : BASE;
        return ['CalendarEvent/get', { list: ids.map((id) => byId[id]).filter(Boolean) }];
      }
      return ['Calendar/get', { list: [] }];
    }
  });

  afterEach(() => {
    client.disconnect();
    fetchSpy.mockRestore();
  });

  const probes = () => calls.filter((c) => c.method === 'CalendarEvent/set' && c.args.update && SYNTHETIC_ID_PROBE in (c.args.update as object));
  const queries = () => calls.filter((c) => c.method === 'CalendarEvent/query');
  const gets = () => calls.filter((c) => c.method === 'CalendarEvent/get');

  it('probes once, then asks a supporting server to expand recurrences', async () => {
    const events = await client.queryCalendarEvents(RANGE);
    await client.queryCalendarEvents(RANGE);

    expect(probes()).toHaveLength(1);
    // The probe is a side-effect-free update of an id that cannot exist.
    expect(probes()[0].args).toMatchObject({ accountId: 'acct-1', update: { [SYNTHETIC_ID_PROBE]: {} } });
    expect(queries()).toHaveLength(2);
    for (const query of queries()) {
      expect(query.args.expandRecurrences).toBe(true);
      expect(query.args.filter).toEqual(RANGE);
    }
    expect(events.map((e) => e.id)).toEqual(['maaaaab', 'eaaaaad']);
  });

  it('lets the probe ride along in the first Calendar/get instead of a request of its own', async () => {
    await client.getAllCalendars();
    const events = await client.queryCalendarEvents(RANGE);

    // One request carried both Calendar/get and the probe; the range query
    // then already knew the verdict and asked for server-side expansion.
    expect(probes()).toHaveLength(1);
    const firstRequest = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(firstRequest.methodCalls.map((c: unknown[]) => c[0])).toEqual(['Calendar/get', 'CalendarEvent/set']);
    expect(queries()[0].args.expandRecurrences).toBe(true);
    expect(events.map((e) => e.id)).toEqual(['maaaaab', 'eaaaaad']);
  });

  it('hydrates occurrences with the series context of their base event', async () => {
    const events = await client.queryCalendarEvents(RANGE);

    // One extra get for the distinct base ids of recurring occurrences only
    // (the non-recurring one needs nothing), asking for recurrence data only.
    const baseGet = gets().find((g) => (g.args.ids as string[]).includes('b'));
    expect(baseGet).toBeDefined();
    expect(baseGet!.args.ids).toEqual(['b']);
    expect(baseGet!.args.properties).toEqual(expect.arrayContaining(['recurrenceRule', 'recurrenceOverrides', 'showWithoutTime']));
    expect(baseGet!.args.properties).not.toContain('title');

    const occurrence = events.find((e) => e.id === 'maaaaab')!;
    expect(occurrence.baseEventId).toBe('b');
    expect(occurrence.recurrenceId).toBe('2026-09-08T10:00:00');
    expect(occurrence.recurrenceRules).toEqual([{ frequency: 'daily', count: 5 }]);
    expect(occurrence.recurrenceOverrides).toEqual({ '2026-09-10T10:00:00': { excluded: true } });
    expect(occurrence.start).toBe('2026-09-08T10:00:00');

    const single = events.find((e) => e.id === 'eaaaaad')!;
    expect(single.baseEventId).toBe('d');
    expect(single.recurrenceRules ?? null).toBeNull();
  });

  it('keeps client-side expansion (no expandRecurrences) when the server rejects synthetic ids', async () => {
    serverSupportsSyntheticIds = false;
    const events = await client.queryCalendarEvents(RANGE);
    await client.queryCalendarEvents(RANGE);

    expect(probes()).toHaveLength(1);
    for (const query of queries()) {
      expect(query.args.expandRecurrences).toBeUndefined();
    }
    // Raw base events with real ids come back for the browser to expand -
    // one full get per query, no base-event hydration get.
    expect(events.map((e) => e.id)).toEqual(['b', 'd']);
    expect(events[0].recurrenceRules).toEqual([{ frequency: 'daily', count: 5 }]);
    expect(gets()).toHaveLength(2);
    for (const get of gets()) {
      expect(get.args.properties).toContain('title');
    }
  });

  it('treats a failed probe as unsupported', async () => {
    probeFails = true;
    const events = await client.queryCalendarEvents(RANGE);
    expect(queries()[0].args.expandRecurrences).toBeUndefined();
    expect(events.map((e) => e.id)).toEqual(['b', 'd']);
  });

  it('never expands a query without both range bounds (the server requires them)', async () => {
    await client.queryCalendarEvents({ uid: 'series@example.com' });
    await client.queryCalendarEvents({ after: RANGE.after });

    expect(probes()).toHaveLength(0);
    for (const query of queries()) {
      expect(query.args.expandRecurrences).toBeUndefined();
    }
  });

  it('strips baseEventId from an update patch', async () => {
    await client.updateCalendarEvent('maaaaab', { title: 'Renamed', baseEventId: 'b' });
    const update = calls.find((c) => c.method === 'CalendarEvent/set')!;
    expect(update.args.update).toEqual({ maaaaab: { title: 'Renamed' } });
  });

  it('strips sequence unless the caller asks to keep it', async () => {
    await client.updateCalendarEvent('maaaaab', { title: 'Renamed', sequence: 2 });
    await client.updateCalendarEvent('maaaaab', { title: 'Renamed', sequence: 2 }, true, undefined, { keepSequence: true });
    const updates = calls.filter((c) => c.method === 'CalendarEvent/set').map((c) => c.args.update);
    expect(updates).toEqual([
      { maaaaab: { title: 'Renamed' } },
      { maaaaab: { title: 'Renamed', sequence: 2 } },
    ]);
  });
});
