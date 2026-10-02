import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

/**
 * #907: Stalwart lazily creates an account's default calendar / address book on
 * the first request that touches the collection. When Bulwark's login burst
 * fires Calendar/get and CalendarEvent/query concurrently against a clustered
 * server, each node can create its own default - duplicating the "Personal"
 * calendar. The client must therefore not put a second calendar (or contacts)
 * request on the wire until the first one for that account has settled, while
 * leaving unrelated mailbox requests unaffected.
 */

function makeSession() {
  return {
    capabilities: {
      'urn:ietf:params:jmap:core': {},
      'urn:ietf:params:jmap:mail': {},
      'urn:ietf:params:jmap:calendars': {},
      'urn:ietf:params:jmap:contacts': {},
    },
    accounts: {
      'acct-1': {
        name: 'test',
        isPersonal: true,
        accountCapabilities: {
          'urn:ietf:params:jmap:mail': {},
          'urn:ietf:params:jmap:calendars': {},
          'urn:ietf:params:jmap:contacts': {},
        },
      },
    },
    primaryAccounts: {
      'urn:ietf:params:jmap:mail': 'acct-1',
      'urn:ietf:params:jmap:calendars': 'acct-1',
      'urn:ietf:params:jmap:contacts': 'acct-1',
    },
    apiUrl: 'https://mail.example.com/jmap/api',
    downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
    uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
    eventSourceUrl: 'https://mail.example.com/jmap/eventsource',
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

interface Pending {
  methods: string[];
  resolve: (body: unknown) => void;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('JMAPClient first-touch ordering (#907)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let onWire: Pending[];

  beforeEach(async () => {
    onWire = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  async function connectedClient(): Promise<JMAPClient> {
    fetchSpy.mockResolvedValueOnce(jsonResponse(makeSession()));
    const client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
    await client.connect();
    // Every API call from here on is parked until the test releases it, in the
    // order it reached the (mock) network.
    fetchSpy.mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { methodCalls?: [string][] };
      return new Promise<Response>((resolve) => {
        onWire.push({
          methods: (body.methodCalls ?? []).map((c) => c[0]),
          resolve: (responseBody) => resolve(jsonResponse(responseBody)),
        });
      });
    });
    return client;
  }

  const emptyResponse = (method: string) => method === 'Mailbox/query'
    ? { methodResponses: [['Mailbox/query', { ids: [], queryState: 's', total: 0 }, 'query'], ['Mailbox/get', { list: [] }, 'get']] }
    : { methodResponses: [[method, { list: [], ids: [] }, '0']] };

  it('holds CalendarEvent/query until the first Calendar/get for the account has settled', async () => {
    const client = await connectedClient();

    const calendars = client.getAllCalendars();
    const events = client.queryCalendarEvents({ after: '2026-01-01T00:00:00Z', before: '2026-02-01T00:00:00Z' });
    await flush();

    expect(onWire.map((p) => p.methods[0])).toEqual(['Calendar/get']);

    onWire[0].resolve(emptyResponse('Calendar/get'));
    await expect(calendars).resolves.toEqual([]);
    await flush();

    // The synthetic-id probe (lib/recurrence-instances.ts) rides along in
    // the Calendar/get request, so the query needs no request of its own first.
    expect(onWire[0].methods).toEqual(['Calendar/get', 'CalendarEvent/set']);
    expect(onWire.map((p) => p.methods[0])).toEqual(['Calendar/get', 'CalendarEvent/query']);
    onWire[1].resolve(emptyResponse('CalendarEvent/query'));
    await expect(events).resolves.toEqual([]);
  });

  it('does not delay unrelated requests, nor contacts behind calendars', async () => {
    const client = await connectedClient();

    const calendars = client.getAllCalendars();
    const mailboxes = client.getMailboxes();
    const books = client.getAddressBooks();
    await flush();

    expect(onWire.map((p) => p.methods[0]).sort()).toEqual(['AddressBook/get', 'Calendar/get', 'Mailbox/query']);

    for (const p of onWire) p.resolve(emptyResponse(p.methods[0]));
    await Promise.all([calendars, mailboxes, books]);
  });

  it('lets calendar requests run concurrently after the first touch', async () => {
    const client = await connectedClient();

    const warm = client.getAllCalendars();
    await flush();
    onWire[0].resolve(emptyResponse('Calendar/get'));
    await warm;
    onWire = [];

    const a = client.queryCalendarEvents({ after: '2026-01-01T00:00:00Z', before: '2026-02-01T00:00:00Z' });
    const b = client.getAllCalendars();
    await flush();

    expect(onWire.map((p) => p.methods[0]).sort()).toEqual(['Calendar/get', 'CalendarEvent/query']);
    for (const p of onWire) p.resolve(emptyResponse(p.methods[0]));
    await Promise.all([a, b]);
  });
});
