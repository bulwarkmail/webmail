import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';
import { batched, itemsPerRequest } from '../jmap/request-limits';

// Stalwart allows 16 method calls and 500 objects per request by default. A
// batch built from a list the user controls - tags, a multi-select, an import -
// reaches those ceilings with ordinary use, and going over fails the *whole*
// request: nine tags used to blank every tag badge in the sidebar.

function makeSession(core: Record<string, number> = {}) {
  return {
    capabilities: { 'urn:ietf:params:jmap:core': core },
    accounts: { 'acct-1': { name: 'test', isPersonal: true, accountCapabilities: {} } },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1' },
    apiUrl: 'https://mail.example.com/jmap/api',
    downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
    uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
    eventSourceUrl: 'https://mail.example.com/jmap/eventsource',
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** RFC 8620 §3.6.1: an over-sized request is refused whole, before any method runs. */
function limitErrorResponse(limit: string): Response {
  return new Response(
    JSON.stringify({ type: 'urn:ietf:params:jmap:error:limit', status: 400, limit }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('batched', () => {
  it('returns one batch when everything fits', () => {
    expect(batched([1, 2, 3], 5)).toEqual([[1, 2, 3]]);
  });

  it('splits into consecutive batches of at most `size`', () => {
    expect(batched([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns nothing for an empty list', () => {
    expect(batched([], 10)).toEqual([]);
  });

  it('never produces an empty batch for a nonsensical size', () => {
    expect(batched([1, 2], 0)).toEqual([[1], [2]]);
    expect(batched([1, 2], -5)).toEqual([[1], [2]]);
  });
});

describe('itemsPerRequest', () => {
  it('divides the call budget by the cost of one item', () => {
    expect(itemsPerRequest(16, 2)).toBe(8);
    expect(itemsPerRequest(16, 1)).toBe(16);
    expect(itemsPerRequest(50, 3)).toBe(16);
  });

  it('always allows at least one item, however expensive', () => {
    expect(itemsPerRequest(1, 2)).toBe(1);
  });
});

describe('JMAPClient request limits', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  async function connectedClient(core?: Record<string, number>): Promise<JMAPClient> {
    fetchSpy.mockResolvedValueOnce(jsonResponse(makeSession(core)));
    const client = JMAPClient.withBearer('https://mail.example.com', 'token123', 'user@test.com');
    await client.connect();
    fetchSpy.mockReset();
    return client;
  }

  /** Records the method calls of every request the client makes. */
  function recordRequests(reply: (methodCalls: Array<[string, Record<string, unknown>, string]>) => unknown) {
    const sent: Array<Array<[string, Record<string, unknown>, string]>> = [];
    fetchSpy.mockImplementation((async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      sent.push(body.methodCalls);
      return jsonResponse(reply(body.methodCalls));
    }) as never);
    return sent;
  }

  describe('getTagCounts', () => {
    // Two Email/query calls per tag: nine tags is 18 calls against a ceiling of 16.
    const tags = Array.from({ length: 9 }, (_, i) => `tag-${i}`);

    it('splits the tags so no request exceeds maxCallsInRequest', async () => {
      const client = await connectedClient({ maxCallsInRequest: 16 });
      const sent = recordRequests((methodCalls) => ({
        methodResponses: methodCalls.map(([, , callId], i) => [
          'Email/query',
          { total: i + 1 },
          callId,
        ]),
      }));

      const counts = await client.getTagCounts(tags);

      expect(sent.map(calls => calls.length)).toEqual([16, 2]);
      expect(Object.keys(counts)).toEqual(tags);
      expect(counts['tag-8']).toEqual({ total: 1, unread: 2 });
    });

    it('keeps the tags of the batches that did succeed when one is refused', async () => {
      const client = await connectedClient({ maxCallsInRequest: 16 });
      let call = 0;
      fetchSpy.mockImplementation((async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        if (call++ === 0) return limitErrorResponse('maxCallsInRequest');
        return jsonResponse({
          methodResponses: body.methodCalls.map(([, , callId]: [string, unknown, string]) => [
            'Email/query', { total: 7 }, callId,
          ]),
        });
      }) as never);

      const counts = await client.getTagCounts(tags);

      expect(Object.keys(counts)).toEqual(['tag-8']);
      expect(counts['tag-8']).toEqual({ total: 7, unread: 7 });
    });

    it('honours a lower ceiling advertised by the server', async () => {
      const client = await connectedClient({ maxCallsInRequest: 4 });
      const sent = recordRequests((methodCalls) => ({
        methodResponses: methodCalls.map(([, , callId]) => ['Email/query', { total: 0 }, callId]),
      }));

      await client.getTagCounts(tags);

      expect(sent.map(calls => calls.length)).toEqual([4, 4, 4, 4, 2]);
    });
  });

  describe('getCategoryUnreadCounts', () => {
    it('splits the tabs across requests and keeps every tab id', async () => {
      const client = await connectedClient({ maxCallsInRequest: 16 });
      const tabs = Array.from({ length: 20 }, (_, i) => ({ id: `tab-${i}`, filter: null }));
      const sent = recordRequests((methodCalls) => ({
        methodResponses: methodCalls.map(([, , callId]) => ['Email/query', { total: 3 }, callId]),
      }));

      const counts = await client.getCategoryUnreadCounts('inbox', tabs);

      expect(sent.map(calls => calls.length)).toEqual([16, 4]);
      expect(Object.keys(counts)).toHaveLength(20);
      expect(counts['tab-19']).toBe(3);
    });
  });

  describe('Email/set batches', () => {
    const ids = Array.from({ length: 1200 }, (_, i) => `email-${i}`);

    it('splits batchDeleteEmails at maxObjectsInSet', async () => {
      const client = await connectedClient({ maxObjectsInSet: 500 });
      const sent = recordRequests(() => ({ methodResponses: [['Email/set', { destroyed: [] }, '0']] }));

      await client.batchDeleteEmails(ids);

      expect(sent.map(calls => (calls[0][1].destroy as string[]).length)).toEqual([500, 500, 200]);
    });

    it('splits batchMarkAsRead at maxObjectsInSet', async () => {
      const client = await connectedClient({ maxObjectsInSet: 500 });
      const sent = recordRequests(() => ({ methodResponses: [['Email/set', { updated: {} }, '0']] }));

      await client.batchMarkAsRead(ids, true);

      const updated = sent.flatMap(calls => Object.keys(calls[0][1].update as object));
      expect(sent).toHaveLength(3);
      expect(updated).toEqual(ids);
    });

    it('splits batchMoveEmails at a ceiling the server lowered', async () => {
      const client = await connectedClient({ maxObjectsInSet: 100 });
      const sent = recordRequests(() => ({ methodResponses: [['Email/set', { updated: {} }, '0']] }));

      await client.batchMoveEmails(ids, 'mailbox-2');

      expect(sent).toHaveLength(12);
      expect(Object.keys(sent[0][0][1].update as object)).toHaveLength(100);
    });
  });

  describe('Email/get batches', () => {
    it('splits getSomeEmails at maxObjectsInGet and returns every message', async () => {
      const client = await connectedClient({ maxObjectsInGet: 500 });
      const sent = recordRequests((methodCalls) => ({
        methodResponses: [[
          'Email/get',
          {
            list: (methodCalls[0][1].ids as string[]).map(id => ({
              id,
              receivedAt: '2026-03-14T10:00:00Z',
            })),
          },
          '0',
        ]],
      }));

      const emails = await client.getSomeEmails(Array.from({ length: 1100 }, (_, i) => `email-${i}`));

      expect(sent.map(calls => (calls[0][1].ids as string[]).length)).toEqual([500, 500, 100]);
      expect(emails).toHaveLength(1100);
    });
  });

  it('falls back to the documented defaults when the session advertises no limits', async () => {
    const client = await connectedClient();

    expect(client.getMaxObjectsInGet()).toBe(500);
    expect(client.getMaxObjectsInSet()).toBe(500);
  });
});
