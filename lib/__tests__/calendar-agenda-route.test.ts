import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import {
  EXPAND_DURATION_TOO_LARGE,
  OVERRIDES_WITH_UTC_ERROR,
  asksForOverridesWithUtc,
  type StalwartVersion,
} from './helpers/stalwart-calendar';
import { endlessResponse } from './helpers/endless-body';

// ── module mocks (hoisted) ───────────────────────────────────────────────────
vi.mock('next/server', () => {
  class NextResponse {
    static json(data: unknown, init?: { status?: number }) {
      return { status: init?.status ?? 200, headers: new Headers(), json: async () => data };
    }
  }
  return { NextResponse, NextRequest: class {} };
});
vi.mock('@/lib/logger', () => ({ logger: { error: () => {}, warn: () => {}, debug: () => {} } }));
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: vi.fn() }));
vi.mock('@/lib/stalwart/jmap-api', () => ({
  fetchJmapSession: vi.fn(),
  postJmap: vi.fn(),
  rebaseApiUrl: vi.fn(() => 'https://mail.example.com/jmap/'),
}));

import { POST } from '@/app/api/calendar-agenda/route';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { fetchJmapSession, postJmap } from '@/lib/stalwart/jmap-api';

const mockCreds = getStalwartCredentials as unknown as Mock;
const mockSession = fetchJmapSession as unknown as Mock;
const mockPost = postJmap as unknown as Mock;

const CALENDAR_CAP = 'urn:ietf:params:jmap:calendars';

function makeSession(capabilities: Record<string, unknown>, accounts?: Record<string, unknown>) {
  return {
    capabilities,
    primaryAccounts: { [CALENDAR_CAP]: 'acct-1' },
    accounts,
    apiUrl: 'https://mail.example.com/jmap/',
  };
}

const BASE_CAPS = { 'urn:ietf:params:jmap:core': {}, [CALENDAR_CAP]: {} };

/** An event tomorrow, as Stalwart returns it (local date-time plus zone). */
function upcomingEvent(id: string, title: string, calendarId: string) {
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  start.setSeconds(0, 0);
  return {
    id,
    '@type': 'Event',
    uid: `${id}@example.com`,
    title,
    calendarIds: { [calendarId]: true },
    start: start.toISOString().slice(0, 19),
    timeZone: 'Etc/UTC',
    duration: 'PT1H',
  };
}

type Call = [string, Record<string, unknown>, string];

/**
 * Answers each JMAP request from a per-account fixture; `accountId` is read
 * off the method call so the test sees which account the route asked for.
 */
function answerPerAccount(fixtures: Record<string, {
  events?: ReturnType<typeof upcomingEvent>[];
  calendars?: Array<{ id: string; name: string; color: string | null }>;
  queryError?: string;
}>) {
  mockPost.mockImplementation(async (_url: string, _auth: string, body: string) => {
    const { methodCalls } = JSON.parse(body) as { methodCalls: Call[] };
    const methodResponses = methodCalls.map(([name, args, callId]) => {
      const fixture = fixtures[args.accountId as string] ?? {};
      if (name === 'CalendarEvent/query') {
        if (fixture.queryError) return ['error', { type: fixture.queryError }, callId];
        return [name, { ids: (fixture.events ?? []).map((e) => e.id) }, callId];
      }
      if (name === 'Calendar/get') return [name, { list: fixture.calendars ?? [] }, callId];
      if (name === 'CalendarEvent/get') {
        const ids = args.ids as string[];
        return [name, { list: (fixture.events ?? []).filter((e) => ids.includes(e.id)) }, callId];
      }
      return ['error', { type: 'unknownMethod' }, callId];
    });
    return { ok: true, json: async () => ({ methodResponses }) };
  });
}

function queriedAccountIds(): string[] {
  return mockPost.mock.calls.flatMap((call) => {
    const { methodCalls } = JSON.parse(call[2] as string) as { methodCalls: Call[] };
    return methodCalls.filter(([name]) => name === 'CalendarEvent/query').map(([, args]) => args.accountId as string);
  });
}

function makeReq(body: Record<string, unknown> = {}): Parameters<typeof POST>[0] {
  return { method: 'POST', headers: new Headers(), json: async () => body } as unknown as Parameters<typeof POST>[0];
}

async function agendaUsing(capabilities: Record<string, unknown>): Promise<string[]> {
  mockSession.mockResolvedValue(makeSession(capabilities));
  mockPost.mockResolvedValue({
    ok: true,
    json: async () => ({
      methodResponses: [
        ['CalendarEvent/query', { ids: [] }, '0'],
        ['Calendar/get', { list: [] }, 'c'],
      ],
    }),
  });

  const res = await POST(makeReq());
  expect(res.status).toBe(200);
  return JSON.parse(mockPost.mock.calls[0][2] as string).using;
}

describe('calendar-agenda route (principals:owner declaration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreds.mockResolvedValue({
      serverUrl: 'https://mail.example.com',
      username: 'user@example.com',
      authHeader: 'Basic abc',
    });
  });

  it('omits principals:owner when the server advertises only base principals', async () => {
    const using = await agendaUsing({
      'urn:ietf:params:jmap:core': {},
      [CALENDAR_CAP]: {},
      'urn:ietf:params:jmap:principals': {},
    });
    expect(using).toContain(CALENDAR_CAP);
    expect(using).not.toContain('urn:ietf:params:jmap:principals:owner');
  });

  it('declares principals:owner when the server advertises it', async () => {
    const using = await agendaUsing({
      'urn:ietf:params:jmap:core': {},
      [CALENDAR_CAP]: {},
      'urn:ietf:params:jmap:principals': {},
      'urn:ietf:params:jmap:principals:owner': {},
    });
    expect(using).toContain('urn:ietf:params:jmap:principals:owner');
  });
});

// The agenda lets Stalwart expand recurring series (expandRecurrences) and
// fills in the series context from the base events, so it never needs
// `recurrenceOverrides` next to utcStart/utcEnd - a get Stalwart 1.0 refuses.
describe.each<StalwartVersion>(['0.16', '1.0'])('calendar-agenda route on Stalwart %s', (version) => {
  type Call = { method: string; args: Record<string, unknown>; request: number };
  let calls: Call[];
  let requests: number;
  let answer: (call: Call) => [string, Record<string, unknown>] | undefined;

  const OCCURRENCES: Record<string, Record<string, unknown>> = {
    // A timed occurrence of the weekly series "b".
    maaaaab: {
      id: 'maaaaab', baseEventId: 'b', '@type': 'Event', uid: 'b@example.com', title: 'Standup',
      start: '2026-09-26T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin',
      utcStart: '2026-09-26T08:00:00Z', utcEnd: '2026-09-26T09:00:00Z',
      recurrenceId: '2026-09-26T10:00:00', calendarIds: { cal: true },
    },
    // An all-day occurrence of "c": the server drops showWithoutTime.
    maaaaac: {
      id: 'maaaaac', baseEventId: 'c', '@type': 'Event', uid: 'c@example.com', title: 'Holiday',
      start: '2026-09-27T00:00:00', duration: 'PT24H', timeZone: 'UTC',
      utcStart: '2026-09-27T00:00:00Z', utcEnd: '2026-09-28T00:00:00Z',
      recurrenceId: '2026-09-27T00:00:00', calendarIds: { cal: true },
    },
  };
  const BASES: Record<string, Record<string, unknown>> = {
    b: { id: 'b', recurrenceRule: { frequency: 'weekly' }, recurrenceOverrides: null, showWithoutTime: false, timeZone: 'Europe/Berlin', duration: 'PT1H' },
    c: { id: 'c', recurrenceRule: { frequency: 'yearly' }, recurrenceOverrides: null, showWithoutTime: true, timeZone: null, duration: 'P1D' },
  };

  function defaultAnswer({ method, args }: Call): [string, Record<string, unknown>] {
    if (method === 'CalendarEvent/query') return ['CalendarEvent/query', { ids: Object.keys(OCCURRENCES) }];
    if (method === 'Calendar/get') return ['Calendar/get', { list: [{ id: 'cal', name: 'Personal', color: '#336699' }] }];
    if (version === '1.0' && asksForOverridesWithUtc(args)) return ['error', { ...OVERRIDES_WITH_UTC_ERROR }];
    const properties = args.properties as string[];
    const list = (args.ids as string[]).map((id) => {
      const source = OCCURRENCES[id] ?? BASES[id] ?? { id };
      return Object.fromEntries(Object.entries(source).filter(([key]) => key === 'id' || properties.includes(key)));
    });
    return ['CalendarEvent/get', { list }];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T08:00:00Z'));
    calls = [];
    requests = 0;
    answer = () => undefined;
    mockCreds.mockResolvedValue({ serverUrl: 'https://mail.example.com', username: 'user@example.com', authHeader: 'Basic abc' });
    mockSession.mockResolvedValue(makeSession({ 'urn:ietf:params:jmap:core': {}, [CALENDAR_CAP]: {} }));
    mockPost.mockImplementation(async (_url: string, _auth: string, body: string) => {
      const request = requests++;
      const methodResponses = JSON.parse(body).methodCalls.map(([method, args, callId]: [string, Record<string, unknown>, string]) => {
        const call = { method, args, request };
        calls.push(call);
        return [...(answer(call) ?? defaultAnswer(call)), callId];
      });
      return { ok: true, json: async () => ({ methodResponses }) };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const gets = () => calls.filter((c) => c.method === 'CalendarEvent/get');

  it(`lets the server expand series and hydrates the occurrences on Stalwart ${version}`, async () => {
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const { events } = await res.json() as { events: Array<Record<string, unknown>> };

    const query = calls.find((c) => c.method === 'CalendarEvent/query')!;
    expect(query.args.expandRecurrences).toBe(true);
    // The earliest first, so the query's limit keeps the next occurrences.
    expect(query.args.sort).toEqual([{ property: 'start', isAscending: true }]);
    expect(gets().filter((g) => asksForOverridesWithUtc(g.args))).toEqual([]);
    const [instanceGet, baseGet] = gets();
    expect(instanceGet.args.properties).not.toContain('recurrenceOverrides');
    expect(instanceGet.args.properties).not.toContain('recurrenceRule');
    expect(baseGet.args.ids).toEqual(['b', 'c']);
    expect(baseGet.args.properties).not.toContain('utcStart');

    expect(events.map((e) => [e.id, e.title, e.allDay, e.color])).toEqual([
      ['acct-1:maaaaab', 'Standup', false, '#336699'],
      ['acct-1:maaaaac', 'Holiday', true, '#336699'],
    ]);
    expect(events[0]).toMatchObject({ start: '2026-09-26T08:00:00.000Z', end: '2026-09-26T09:00:00.000Z' });
  });

  it(`hands out an all-day event as its own date, not midnight in the server's zone, on Stalwart ${version}`, async () => {
    // As the server answered live: 0.16 drops showWithoutTime and names
    // Etc/UTC, 1.0 keeps showWithoutTime and names no zone.
    const holiday = {
      id: 'maaaaac', baseEventId: 'c', '@type': 'Event', uid: 'c@example.com', title: 'Holiday',
      start: '2026-09-27T00:00:00', duration: 'P1D',
      utcStart: '2026-09-27T00:00:00Z', utcEnd: '2026-09-28T00:00:00Z', calendarIds: { cal: true },
      ...(version === '1.0' ? { showWithoutTime: true } : { timeZone: 'Etc/UTC' }),
    };
    answer = ({ method, args }) => method === 'CalendarEvent/get' && (args.ids as string[]).includes('maaaaac')
      ? ['CalendarEvent/get', { list: [OCCURRENCES.maaaaab, holiday] }]
      : undefined;
    const { events } = await (await POST(makeReq())).json() as { events: Array<Record<string, unknown>> };

    // The plugin files events under new Date(start) in the viewer's zone. An
    // instant for midnight in the server's zone put the holiday on 26
    // September for anyone west of the server; a date-time without an offset
    // is read as the viewer's own midnight.
    expect(events[1]).toMatchObject({ allDay: true, start: '2026-09-27T00:00:00', end: '2026-09-28T00:00:00' });
    expect(new Date(events[1].start as string).getDate()).toBe(27);
  });

  it(`answers 502 when a get fails on Stalwart ${version}`, async () => {
    answer = ({ method }) => method === 'CalendarEvent/get' ? ['error', { type: 'serverFail', description: 'Store unavailable' }] : undefined;

    const res = await POST(makeReq());

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Store unavailable' });
  });

  it(`looks less far ahead when the range expands to too many occurrences on Stalwart ${version}`, async () => {
    const tooMany = version === '1.0'
      ? { type: 'cannotCalculateOccurrences', description: 'The number of expanded recurrences exceeds the server limit' }
      : { type: 'invalidArguments', description: 'The number of expanded recurrences exceeds the server limit' };
    let refusals = 2;
    answer = ({ method }) => method === 'CalendarEvent/query' && refusals-- > 0 ? ['error', tooMany] : undefined;

    const res = await POST(makeReq({ days: 80 }));

    expect(res.status).toBe(200);
    const spans = calls.filter((c) => c.method === 'CalendarEvent/query').map((c) => {
      const filter = c.args.filter as { after: string; before: string };
      return (Date.parse(filter.before) - Date.parse('2026-09-25T08:00:00Z')) / 86_400_000;
    });
    expect(spans).toEqual([80, 40, 20]);
    expect(((await res.json()) as { events: unknown[] }).events).toHaveLength(2);
  });

  it(`looks less far ahead when the range is longer than the server expands on Stalwart ${version}`, async () => {
    // An administrator set maxExpandedQueryDuration to 30 days. 1.0 refuses a
    // longer expanded range; 0.16 never checks.
    answer = ({ method, args }) => {
      if (method !== 'CalendarEvent/query' || version !== '1.0') return undefined;
      const filter = args.filter as { after: string; before: string };
      return Date.parse(filter.before) - Date.parse(filter.after) > 30 * 86_400_000
        ? ['error', { ...EXPAND_DURATION_TOO_LARGE }]
        : undefined;
    };

    const res = await POST(makeReq({ days: 80 }));

    expect(res.status).toBe(200);
    const spans = calls.filter((c) => c.method === 'CalendarEvent/query').map((c) => {
      const filter = c.args.filter as { after: string; before: string };
      return (Date.parse(filter.before) - Date.parse('2026-09-25T08:00:00Z')) / 86_400_000;
    });
    expect(spans).toEqual(version === '1.0' ? [80, 40, 20] : [80]);
    expect(((await res.json()) as { events: unknown[] }).events).toHaveLength(2);
  });

  it(`fetches many occurrences with several gets per request on Stalwart ${version}`, async () => {
    const many = [...Object.keys(OCCURRENCES), ...Array.from({ length: 248 }, (_, i) => `x${i}`)];
    answer = ({ method }) => method === 'CalendarEvent/query' ? ['CalendarEvent/query', { ids: many }] : undefined;

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    const occurrenceGets = gets().filter((g) => !(g.args.ids as string[]).includes('b'));
    expect(occurrenceGets.map((g) => (g.args.ids as string[]).length)).toEqual([100, 100, 50]);
    expect(new Set(occurrenceGets.map((g) => g.request)).size).toBe(1);
    expect(((await res.json()) as { events: unknown[] }).events).toHaveLength(2);
  });

  it(`keeps to the session's maxCallsInRequest when fetching occurrences on Stalwart ${version}`, async () => {
    mockSession.mockResolvedValue(makeSession({ 'urn:ietf:params:jmap:core': { maxCallsInRequest: 2 }, [CALENDAR_CAP]: {} }));
    const many = [...Object.keys(OCCURRENCES), ...Array.from({ length: 248 }, (_, i) => `x${i}`)];
    answer = ({ method }) => method === 'CalendarEvent/query' ? ['CalendarEvent/query', { ids: many }] : undefined;

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    const occurrenceGets = gets().filter((g) => !(g.args.ids as string[]).includes('b'));
    const [first, , last] = occurrenceGets;
    expect(occurrenceGets.map((g) => g.request)).toEqual([first.request, first.request, first.request + 1]);
    expect((last.args.ids as string[]).length).toBe(50);
  });
});

describe('calendar-agenda route (shared and group accounts)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreds.mockResolvedValue({
      serverUrl: 'https://mail.example.com',
      username: 'user@example.com',
      authHeader: 'Basic abc',
    });
  });

  it('includes events from a shared group account next to the primary account', async () => {
    mockSession.mockResolvedValue(makeSession(BASE_CAPS, {
      'acct-1': { name: 'user@example.com', isPersonal: true, accountCapabilities: { [CALENDAR_CAP]: {} } },
      // Stalwart does not advertise the calendar capability on group accounts
      'acct-family': { name: 'family@example.com', isPersonal: false, accountCapabilities: {} },
    }));
    answerPerAccount({
      'acct-1': {
        events: [upcomingEvent('ev-1', 'Dentist', 'cal-1')],
        calendars: [{ id: 'cal-1', name: 'Personal', color: '#3b82f6' }],
      },
      'acct-family': {
        events: [upcomingEvent('ev-1', 'Holiday', 'cal-1')],
        calendars: [{ id: 'cal-1', name: 'Family', color: '#a855f7' }],
      },
    });

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const { events } = await res.json() as { events: Array<Record<string, unknown>> };

    expect(queriedAccountIds()).toEqual(['acct-1', 'acct-family']);
    expect(events.map((e) => e.title).sort()).toEqual(['Dentist', 'Holiday']);
    // Ids repeat across accounts, so each event is scoped by its account and
    // the colour comes from that account's calendar, not a same-named one.
    const holiday = events.find((e) => e.title === 'Holiday')!;
    expect(holiday.id).toBe('acct-family:ev-1');
    expect(holiday.accountId).toBe('acct-family');
    expect(holiday.color).toBe('#a855f7');
    expect(events.find((e) => e.title === 'Dentist')!.color).toBe('#3b82f6');
  });

  it('leaves out personal accounts without calendars and the primary account itself', async () => {
    mockSession.mockResolvedValue(makeSession(BASE_CAPS, {
      'acct-1': { isPersonal: true, accountCapabilities: { [CALENDAR_CAP]: {} } },
      'acct-mail-only': { isPersonal: true, accountCapabilities: { 'urn:ietf:params:jmap:mail': {} } },
      'acct-shared': { isPersonal: true, accountCapabilities: { [CALENDAR_CAP]: {} } },
    }));
    answerPerAccount({});

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(queriedAccountIds()).toEqual(['acct-1', 'acct-shared']);
  });

  it('skips a shared account whose calendars cannot be read instead of failing the agenda', async () => {
    mockSession.mockResolvedValue(makeSession(BASE_CAPS, {
      'acct-1': { isPersonal: true, accountCapabilities: { [CALENDAR_CAP]: {} } },
      'acct-team': { isPersonal: false },
    }));
    answerPerAccount({
      'acct-1': { events: [upcomingEvent('ev-1', 'Standup', 'cal-1')] },
      'acct-team': { queryError: 'forbidden' },
    });

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const { events } = await res.json() as { events: Array<Record<string, unknown>> };
    expect(events.map((e) => e.title)).toEqual(['Standup']);
  });

  it('still reports a failure of the primary account', async () => {
    mockSession.mockResolvedValue(makeSession(BASE_CAPS, {
      'acct-1': { isPersonal: true, accountCapabilities: { [CALENDAR_CAP]: {} } },
    }));
    answerPerAccount({ 'acct-1': { queryError: 'serverFail' } });

    const res = await POST(makeReq());
    expect(res.status).toBe(502);
  });
});

describe('calendar-agenda route (response size)', () => {
  it('answers 502 instead of buffering an answer that never ends', async () => {
    vi.clearAllMocks();
    mockCreds.mockResolvedValue({ serverUrl: 'https://mail.example.com', username: 'user@example.com', authHeader: 'Basic abc' });
    mockSession.mockResolvedValue(makeSession(BASE_CAPS));
    const endless = endlessResponse(500);
    mockPost.mockResolvedValue(endless.response);

    const res = await POST(makeReq());
    expect(res.status).toBe(502);
    expect(endless.pulled()).toBeLessThan(30);
  });
});
