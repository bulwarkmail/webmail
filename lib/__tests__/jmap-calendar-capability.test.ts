import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

// The server advertises Calendars globally while the per-account
// accountCapabilities independently includes or omits it.
function makeSession(accountCapabilities: Record<string, unknown>, isPersonal = true, serverAdvertises = true, sessionCapabilities: Record<string, unknown> = {}) {
  return {
    capabilities: {
      'urn:ietf:params:jmap:core': {},
      ...(serverAdvertises ? { 'urn:ietf:params:jmap:calendars': {} } : {}),
      ...sessionCapabilities,
    },
    accounts: {
      'acct-1': { name: 'test', isPersonal, accountCapabilities },
    },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1' },
    apiUrl: 'https://mail.example.com/jmap/api',
    downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
    uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
    eventSourceUrl: 'https://mail.example.com/jmap/eventsource',
  };
}

function mockFetchResponse(status: number, body?: unknown): Response {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function connect(accountCapabilities: Record<string, unknown>, isPersonal = true, serverAdvertises = true, sessionCapabilities: Record<string, unknown> = {}): Promise<JMAPClient> {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, makeSession(accountCapabilities, isPersonal, serverAdvertises, sessionCapabilities)));
  const client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
  await client.connect();
  fetchSpy.mockReset();
  return client;
}

describe('JMAPClient.supportsCalendars (account-scoped capability)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns true when the account advertises the calendars capability', async () => {
    const client = await connect({ 'urn:ietf:params:jmap:calendars': {} });
    expect(client.supportsCalendars()).toBe(true);
  });

  it('returns false when the server advertises calendars but the account does not', async () => {
    const client = await connect({ 'urn:ietf:params:jmap:mail': {} });
    expect(client.supportsCalendars()).toBe(false);
  });

  it('treats non-personal (shared/group) accounts as capable even without per-account advertisement', async () => {
    const client = await connect({}, /* isPersonal */ false);
    expect(client.supportsCalendars()).toBe(true);
  });

  it('returns false for a shared account when the server does not advertise calendars', async () => {
    const client = await connect({}, /* isPersonal */ false, /* serverAdvertises */ false);
    expect(client.supportsCalendars()).toBe(false);
  });
});

describe('calendarUsing (principals:owner declaration)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function shareUsing(sessionCapabilities: Record<string, unknown>): Promise<string[]> {
    const client = await connect({ 'urn:ietf:params:jmap:calendars': {} }, true, true, sessionCapabilities);
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockFetchResponse(200, { methodResponses: [['Calendar/set', { updated: { 'cal-1': null } }, '0']] }),
    );
    await client.setCalendarShare('cal-1', 'principal-1', null);
    return JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string).using;
  }

  it('omits principals:owner when the server advertises only base principals', async () => {
    const using = await shareUsing({ 'urn:ietf:params:jmap:principals': {} });
    expect(using).not.toContain('urn:ietf:params:jmap:principals:owner');
  });

  it('declares principals:owner when the server advertises it', async () => {
    const using = await shareUsing({
      'urn:ietf:params:jmap:principals': {},
      'urn:ietf:params:jmap:principals:owner': {},
    });
    expect(using).toContain('urn:ietf:params:jmap:principals:owner');
  });
});
