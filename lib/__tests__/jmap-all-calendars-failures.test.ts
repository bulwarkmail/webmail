import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

// The calendar store reconciles its persisted selection against the calendars
// list. getAllCalendars() swallowed every failure into an empty (or partial)
// list, which the store read as "these calendars are gone" and dropped from
// the selection for good. getAllCalendarsWithFailures() lets it tell the two
// apart.

function makeSession() {
  return {
    capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:calendars': {} },
    accounts: {
      'acct-1': { name: 'test', isPersonal: true, accountCapabilities: { 'urn:ietf:params:jmap:calendars': {} } },
      // Shared accounts are probed on suspicion because they are non-personal.
      'team': { name: 'Team', isPersonal: false, accountCapabilities: {} },
      'ev': { name: 'No access', isPersonal: false, accountCapabilities: {} },
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

type Answer = 'ok' | 'serverFail' | 'network';

describe('getAllCalendarsWithFailures', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let client: JMAPClient;
  let answers: Record<string, Answer>;

  beforeEach(async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(jsonResponse(makeSession()));
    client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
    await client.connect();
    fetchSpy.mockReset();

    answers = { 'acct-1': 'ok', team: 'ok' };
    fetchSpy.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const [method, args] = body.methodCalls?.[0] ?? [];
      const accountId = args?.accountId as string;
      if (accountId === 'ev') {
        return jsonResponse({
          methodResponses: [['error', { type: 'accountNotFound', description: 'You do not have access to account ev' }, '0']],
        });
      }
      if (method === 'CalendarEvent/query') {
        return jsonResponse({ methodResponses: [['CalendarEvent/query', { ids: [] }, '0']] });
      }
      const answer = answers[accountId];
      if (answer === 'network') throw new TypeError('Failed to fetch');
      if (answer === 'serverFail') {
        return jsonResponse({ methodResponses: [['error', { type: 'serverFail', description: 'Try again' }, '0']] });
      }
      return jsonResponse({ methodResponses: [['Calendar/get', { list: [{ id: 'b', name: `${accountId} cal` }] }, '0']] });
    });
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    client.disconnect();
    consoleErrorSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('lists every account and reports nothing failed when all load', async () => {
    const { calendars, failedAccountIds } = await client.getAllCalendarsWithFailures();

    expect(calendars.map((c) => c.id)).toEqual(['b', 'team:b']);
    expect(failedAccountIds).toEqual([]);
  });

  it('throws when the primary account answers with a method error', async () => {
    answers['acct-1'] = 'serverFail';

    await expect(client.getAllCalendarsWithFailures()).rejects.toThrow('Try again');
  });

  it('throws when the primary account cannot be reached', async () => {
    answers['acct-1'] = 'network';

    await expect(client.getAllCalendarsWithFailures()).rejects.toThrow();
  });

  it('names a shared account that failed instead of silently leaving it out', async () => {
    answers.team = 'serverFail';

    const { calendars, failedAccountIds } = await client.getAllCalendarsWithFailures();

    expect(calendars.map((c) => c.id)).toEqual(['b']);
    expect(failedAccountIds).toEqual(['team']);
  });

  it('does not count a shared account without calendar access as failed', async () => {
    const { failedAccountIds } = await client.getAllCalendarsWithFailures();

    expect(failedAccountIds).not.toContain('ev');
  });

  it('keeps getAllCalendars lenient for callers that only display the list', async () => {
    answers['acct-1'] = 'serverFail';

    await expect(client.getAllCalendars()).resolves.toEqual([]);
  });
});
