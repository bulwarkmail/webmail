import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';
import * as webdav from '../webdav/calendar-collection';

function makeMultiAccountSession() {
  return {
    capabilities: {
      'urn:ietf:params:jmap:core': {},
      'urn:ietf:params:jmap:calendars': {},
    },
    accounts: {
      'acct-primary': { name: 'primary', isPersonal: true, accountCapabilities: { 'urn:ietf:params:jmap:calendars': {} } },
      'acct-shared-1': { name: 'team', isPersonal: false, accountCapabilities: { 'urn:ietf:params:jmap:calendars': {} } },
      'acct-shared-2': { name: 'family', isPersonal: false, accountCapabilities: { 'urn:ietf:params:jmap:calendars': {} } },
    },
    primaryAccounts: {
      'urn:ietf:params:jmap:mail': 'acct-primary',
      'urn:ietf:params:jmap:calendars': 'acct-primary',
    },
    apiUrl: 'https://mail.example.com/jmap/api',
    downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
    uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
    eventSourceUrl: '',
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('getAllCalendars CalDAV PROPFIND deduplication', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let fetchDavSpy: ReturnType<typeof vi.spyOn>;
  let client: JMAPClient;

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(jsonResponse(makeMultiAccountSession()));

    client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
    await client.connect();
    fetchSpy.mockReset();

    fetchSpy.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const [method, args] = body.methodCalls?.[0] ?? [];
      if (method === 'Calendar/get') {
        return jsonResponse({
          methodResponses: [
            ['Calendar/get', {
              list: [
                { id: `cal-${args.accountId}`, name: `Calendar ${args.accountId}` }
              ]
            }, '0']
          ]
        });
      }
      return jsonResponse({ methodResponses: [] });
    });

    fetchDavSpy = vi.spyOn(webdav, 'fetchCalendarCollectionComponents').mockResolvedValue({
      'cal-acct-primary': ['VEVENT'],
      'cal-acct-shared-1': ['VTODO'],
      'cal-acct-shared-2': ['VEVENT', 'VTODO'],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queries CalDAV components only once during getAllCalendars across all accounts', async () => {
    const calendars = await client.getAllCalendars();
    expect(calendars.length).toBe(3);
    // With 3 accounts, it must NOT call fetchCalendarCollectionComponents 3 times!
    expect(fetchDavSpy).toHaveBeenCalledTimes(1);
  });

  it("doesn't match a shared account's calendar against the login's own collections", async () => {
    // The PROPFIND lists the login's own calendar home; a collection there
    // whose path happens to equal a shared calendar's id says nothing about it.
    const calendars = await client.getAllCalendars();
    const shared = calendars.find((c) => (c.originalId ?? c.id) === 'cal-acct-shared-1');
    expect(shared).toBeDefined();
    expect(shared?.isTasksOnly).not.toBe(true);
  });

  it('keeps scanning a calendar that advertises both VEVENT and VTODO to check its content', async () => {
    // When a collection has both components (e.g. Stalwart default), it must
    // still be scanned rather than discarded from detection.
    const querySpy = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const [method, args, callId] = body.methodCalls?.[0] ?? [];
      if (method === 'Calendar/get') {
        return jsonResponse({
          methodResponses: [
            ['Calendar/get', { list: [{ id: 'cal-dual', name: 'Dual' }] }, callId]
          ]
        });
      }
      if (method === 'CalendarEvent/query') {
        querySpy(args.filter?.inCalendar);
        return jsonResponse({
          methodResponses: [
            ['CalendarEvent/query', { ids: ['task-1'] }, callId]
          ]
        });
      }
      if (method === 'CalendarEvent/get') {
        return jsonResponse({
          methodResponses: [
            ['CalendarEvent/get', {
              list: [
                { id: 'task-1', '@type': 'Task', due: '2026-10-10' }
              ]
            }, callId]
          ]
        });
      }
      return jsonResponse({ methodResponses: [] });
    });

    vi.spyOn(webdav, 'fetchCalendarCollectionComponents').mockResolvedValue({
      'cal-dual': ['VEVENT', 'VTODO'],
    });

    const calendars = await client.getAllCalendars();
    expect(querySpy).toHaveBeenCalledWith('cal-dual');
    expect(calendars.find((c) => c.id === 'cal-dual')?.isTasksOnly).toBe(true);
  });
});

// A CalDAV collection's path is not the JMAP calendar id on Stalwart (a
// phone's UUID, or mkCalendarCollection's random name), so an empty task list
// was found by neither path nor content. The PROPFIND reads
// the login's own calendar home: only its calendars are matched by name.
describe('getAllCalendars finds task-only collections by display name', () => {
  let client: JMAPClient;

  beforeEach(async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(jsonResponse(makeMultiAccountSession()));
    client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
    await client.connect();
    fetchSpy.mockReset();
    fetchSpy.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const [method, args] = body.methodCalls?.[0] ?? [];
      if (method === 'Calendar/get') {
        return jsonResponse({ methodResponses: [['Calendar/get', { list: [{ id: `cal-${args.accountId}`, name: 'Errands' }] }, '0']] });
      }
      return jsonResponse({ methodResponses: [] });
    });
    vi.spyOn(webdav, 'fetchCalendarCollectionComponents').mockResolvedValue(
      webdav.parseCalendarCollectionComponents(`<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:" xmlns:A="urn:ietf:params:xml:ns:caldav">
<D:response><D:href>/dav/cal/user%40test.com/4f0c2a9e-uuid/</D:href><D:propstat><D:prop>
<D:displayname>Errands</D:displayname><D:resourcetype><D:collection/><A:calendar/></D:resourcetype>
<A:supported-calendar-component-set><A:comp name="VTODO"/></A:supported-calendar-component-set>
</D:prop></D:propstat></D:response></D:multistatus>`),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies the login's own empty list as task-only, and no other account's list of the same name", async () => {
    const calendars = await client.getAllCalendars();
    const byId = Object.fromEntries(calendars.map((c) => [c.originalId ?? c.id, c]));
    expect(byId['cal-acct-primary']).toMatchObject({ isTasksOnly: true });
    expect(byId['cal-acct-shared-1']?.isTasksOnly).not.toBe(true);
  });
});
