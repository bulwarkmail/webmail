import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';

// getThreadEmails with `newest`: Thread/get first, then Email/get only for
// the newest messages, so a thread of thousands never loads all its bodies.

function mockFetchResponse(status: number, body?: unknown): Response {
  return new Response(body ? JSON.stringify(body) : null, { status, headers: { 'Content-Type': 'application/json' } });
}

const session = {
  capabilities: { 'urn:ietf:params:jmap:core': {} },
  accounts: { 'acct-1': { name: 'test', isPersonal: true, accountCapabilities: {} } },
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1' },
  apiUrl: 'https://mail.example.com/jmap/api',
  downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
  uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
  eventSourceUrl: 'https://mail.example.com/jmap/eventsource',
};

describe('JMAPClient.getThreadEmails newest', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch'); });
  afterEach(() => { fetchSpy.mockRestore(); });

  async function threadOf(ids: string[], options?: { newest?: number }): Promise<string[][]> {
    fetchSpy.mockResolvedValueOnce(mockFetchResponse(200, session));
    const client = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
    await client.connect();
    fetchSpy.mockReset();
    const asked: string[][] = [];
    fetchSpy.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      const [name, args] = JSON.parse((init as RequestInit).body as string).methodCalls[0];
      if (name === 'Thread/get') return mockFetchResponse(200, { methodResponses: [['Thread/get', { list: [{ id: 't', emailIds: ids }] }, '0']] });
      asked.push(args.ids);
      return mockFetchResponse(200, { methodResponses: [['Email/get', { list: [] }, '0']] });
    });
    await client.getThreadEmails('t', undefined, options);
    return asked;
  }

  it('fetches only the newest messages of the thread', async () => {
    const ids = Array.from({ length: 80 }, (_, i) => `e${i}`);
    expect((await threadOf(ids, { newest: 50 })).flat()).toEqual(ids.slice(30));
  });

  it('fetches every message without it, as before', async () => {
    expect((await threadOf(['a', 'b', 'c'])).flat()).toEqual(['a', 'b', 'c']);
  });
});
