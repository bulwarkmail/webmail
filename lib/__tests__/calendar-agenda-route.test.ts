import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ── module mocks (hoisted) ───────────────────────────────────────────────────
vi.mock('next/server', () => {
  class NextResponse {
    static json(data: unknown, init?: { status?: number }) {
      return { status: init?.status ?? 200, headers: new Headers(), json: async () => data };
    }
  }
  return { NextResponse, NextRequest: class {} };
});
vi.mock('@/lib/logger', () => ({ logger: { error: () => {}, debug: () => {} } }));
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

function makeReq(): Parameters<typeof POST>[0] {
  return { method: 'POST', headers: new Headers(), json: async () => ({}) } as unknown as Parameters<typeof POST>[0];
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
