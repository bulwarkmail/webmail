import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

// The calendar fan-out probes shared accounts on suspicion (Stalwart does not
// always advertise calendar capability on group accounts), so a shared account
// without any calendar access answers every probe with an access rejection.
// That rejection must be remembered and the account skipped afterwards -
// before, every calendar interaction re-probed it and logged a console error.

function makeSession() {
  return {
    capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:calendars': {} },
    accounts: {
      'acct-1': { name: 'test', isPersonal: true, accountCapabilities: {} },
      // Shared account without calendar access: probed because it is
      // non-personal, rejected by the server.
      'ev': { name: 'shared', isPersonal: false, accountCapabilities: {} },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1' },
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

// How each version turns away a calendar call to an account that only shared
// a mail folder, as seen live.
const DENIALS = {
  '0.16': { type: 'forbidden', description: 'You do not have access to account ev' },
  '1.0': { type: 'accountNotSupportedByMethod', description: 'The accountId given corresponds to a valid account, but the account does not support this method or data type.' },
};

describe('calendar fan-out to shared accounts without access', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let client: JMAPClient;
  let denial: { type: string; description: string };

  beforeEach(async () => {
    denial = { type: 'accountNotFound', description: 'You do not have access to account ev' };
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(jsonResponse(makeSession()));
    client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
    await client.connect();
    fetchSpy.mockReset();

    fetchSpy.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const [method, args] = body.methodCalls?.[0] ?? [];
      if (args?.accountId === 'ev') {
        return jsonResponse({
          methodResponses: [
            ['error', denial, '0'],
          ],
        });
      }
      if (method === 'CalendarEvent/query') {
        return jsonResponse({ methodResponses: [['CalendarEvent/query', { ids: [] }, '0']] });
      }
      return jsonResponse({ methodResponses: [['Calendar/get', { list: [] }, '0']] });
    });
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it.each(Object.entries(DENIALS))('takes the answer of Stalwart %s as no access', async (_version, answer) => {
    denial = answer;
    const { failedAccountIds } = await client.getAllCalendarsWithFailures();
    await client.queryAllCalendarEvents({});
    await client.queryAllCalendarEvents({});

    expect(failedAccountIds).toEqual([]);
    expect(callsForAccount('ev')).toHaveLength(2);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  afterEach(() => {
    client.disconnect();
    consoleErrorSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  function callsForAccount(accountId: string): unknown[][] {
    return fetchSpy.mock.calls.filter((call: unknown[]) => {
      const body = (call[1] as RequestInit | undefined)?.body;
      return typeof body === 'string' && body.includes(`"accountId":"${accountId}"`);
    });
  }

  it('probes a no-access shared account once, then skips it without console noise', async () => {
    await client.queryAllCalendarEvents({});
    await client.queryAllCalendarEvents({});

    expect(callsForAccount('ev')).toHaveLength(1);
    // The primary account keeps being queried normally.
    expect(callsForAccount('acct-1')).toHaveLength(2);
    // An expected rejection is not an error worth red console output.
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('getAllCalendars skips an account already known to be inaccessible', async () => {
    await client.queryAllCalendarEvents({});
    fetchSpy.mockClear();

    await client.getAllCalendars();

    expect(callsForAccount('ev')).toHaveLength(0);
    expect(callsForAccount('acct-1')).toHaveLength(1);
  });
});

describe('calendar fan-out when an account fails', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let client: JMAPClient;
  let failing: Record<string, { type: string; description: string }>;

  beforeEach(async () => {
    failing = {};
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(jsonResponse(makeSession()));
    client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
    await client.connect();
    fetchSpy.mockReset();

    fetchSpy.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const methodResponses = (body.methodCalls ?? []).map(([method, args, callId]: [string, Record<string, unknown>, string]) => {
        const failure = failing[args.accountId as string];
        if (failure) return ['error', failure, callId];
        if (method === 'CalendarEvent/query') return ['CalendarEvent/query', { ids: ['e1'] }, callId];
        return ['CalendarEvent/get', {
          list: [{ id: 'e1', '@type': 'Event', title: `Event of ${args.accountId}`, start: '2026-09-22T10:00:00', calendarIds: { c: true } }],
        }, callId];
      });
      return jsonResponse({ methodResponses });
    });
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    client.disconnect();
    consoleErrorSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('fails the whole query when the user’s own calendars fail on Stalwart 1.0', async () => {
    failing['acct-1'] = { type: 'invalidArguments', description: 'recurrenceOverrides cannot be requested together with utcStart or utcEnd' };

    await expect(client.queryAllCalendarEvents({})).rejects.toThrow(/recurrenceOverrides cannot be requested/);
  });

  it('does not take a refusal of the user’s own account for a share without access on 0.16', async () => {
    failing['acct-1'] = { type: 'forbidden', description: 'You do not have access to this account' };
    await expect(client.queryAllCalendarEvents({})).rejects.toThrow(/do not have access/);

    // Not remembered as "no access": the next load asks again.
    delete failing['acct-1'];
    const events = await client.queryAllCalendarEvents({});
    expect(events.map((e) => e.title)).toEqual(['Event of acct-1', 'Event of ev']);
  });

  it('leaves out a shared account that fails for another reason and keeps the rest on 0.16', async () => {
    failing.ev = { type: 'serverFail', description: 'Temporary failure' };

    const events = await client.queryAllCalendarEvents({});

    expect(events.map((e) => e.title)).toEqual(['Event of acct-1']);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });
});
