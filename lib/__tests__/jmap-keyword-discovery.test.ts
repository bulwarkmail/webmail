import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KEYWORDS_CAPABILITY, JMAPClient } from '../jmap/client';

// JMAP has no way to ask which keywords an account uses, so `discoverKeywords`
// finds them by walking the message list: an Email/query for the next slice of
// ids and an Email/get back-referencing it. What matters is that the walk pages
// correctly (a skipped page is a tag the user never gets offered) and that it
// admits when it stopped early rather than passing a partial scan off as the
// whole account.

function makeSession(core: Record<string, number> = {}, supportsKeywordGet = false) {
  return {
    capabilities: {
      'urn:ietf:params:jmap:core': core,
      ...(supportsKeywordGet ? { [KEYWORDS_CAPABILITY]: { supportsCounts: true } } : {}),
    },
    accounts: {
      'acct-1': {
        name: 'test',
        isPersonal: true,
        accountCapabilities: supportsKeywordGet ? { [KEYWORDS_CAPABILITY]: {} } : {},
      },
    },
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

/** One page of a walk: the ids the query returns and the keywords the get does. */
function page(ids: string[], keywords: Array<Record<string, boolean>>, total?: number) {
  return {
    methodResponses: [
      ['Email/query', { ids, ...(total === undefined ? {} : { total }) }, '0'],
      ['Email/get', { list: keywords.map((kw, i) => ({ id: ids[i], keywords: kw })) }, '1'],
    ],
  };
}

describe('JMAPClient.discoverKeywords', () => {
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

  async function connectedKeywordGetClient(core?: Record<string, number>): Promise<JMAPClient> {
    fetchSpy.mockResolvedValueOnce(jsonResponse(makeSession(core, true)));
    const client = JMAPClient.withBearer('https://mail.example.com', 'token123', 'user@test.com');
    await client.connect();
    fetchSpy.mockReset();
    return client;
  }

  /** Records the method calls of every request the client makes. */
  function recordRequests(reply: (methodCalls: Array<[string, Record<string, unknown>, string]>, index: number) => unknown) {
    const sent: Array<Array<[string, Record<string, unknown>, string]>> = [];
    fetchSpy.mockImplementation((async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const index = sent.length;
      sent.push(body.methodCalls);
      return jsonResponse(reply(body.methodCalls, index));
    }) as never);
    return sent;
  }

  it('unions the keywords on every message and counts them', async () => {
    const client = await connectedClient({ maxObjectsInGet: 2 });
    recordRequests((_calls, index) =>
      index === 0
        ? page(['m1', 'm2'], [
            { $seen: true, '$label:work': true },
            { '$label:work': true, '$label:receipts': true },
          ], 3)
        : page(['m3'], [{ '$label:receipts': true }]),
    );

    const result = await client.discoverKeywords();

    expect(result.keywords).toEqual({ $seen: 1, '$label:work': 2, '$label:receipts': 2 });
    expect(result.scanned).toBe(3);
    expect(result.complete).toBe(true);
  });

  it('ignores keywords the message does not actually carry', async () => {
    const client = await connectedClient();
    recordRequests(() => page(['m1'], [{ '$label:work': true, '$label:stale': false }], 1));

    const { keywords } = await client.discoverKeywords();

    expect(keywords).toEqual({ '$label:work': 1 });
  });

  it('asks only for keywords, page by page, using the advertised object ceiling', async () => {
    const client = await connectedClient({ maxObjectsInGet: 2 });
    const sent = recordRequests((_calls, index) =>
      index === 0
        ? page(['m1', 'm2'], [{ '$label:a': true }, { '$label:b': true }], 3)
        : page(['m3'], [{ '$label:c': true }]),
    );

    await client.discoverKeywords();

    expect(sent).toHaveLength(2);
    expect(sent[0][0][1]).toMatchObject({ limit: 2, position: 0, calculateTotal: true });
    expect(sent[0][1][0]).toBe('Email/get');
    expect(sent[0][1][1]).toMatchObject({
      properties: ['keywords'],
      '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' },
    });
    expect(sent[1][0][1]).toMatchObject({ limit: 2, position: 2 });
  });

  it('pages by the ids the query returned, so a message destroyed mid-walk skips nothing', async () => {
    const client = await connectedClient({ maxObjectsInGet: 2 });
    const sent = recordRequests((_calls, index) =>
      index === 0
        // Two ids queried, but one was destroyed before the get ran.
        ? { methodResponses: [
            ['Email/query', { ids: ['m1', 'm2'], total: 3 }, '0'],
            ['Email/get', { list: [{ id: 'm1', keywords: { '$label:a': true } }], notFound: ['m2'] }, '1'],
          ] }
        : page(['m3'], [{ '$label:b': true }]),
    );

    const result = await client.discoverKeywords();

    expect(sent[1][0][1]).toMatchObject({ position: 2 });
    expect(result.scanned).toBe(3);
    expect(result.keywords).toEqual({ '$label:a': 1, '$label:b': 1 });
  });

  it('stops at the cap and says the scan is incomplete', async () => {
    const client = await connectedClient({ maxObjectsInGet: 2 });
    const sent = recordRequests(() => page(['m1', 'm2'], [{ '$label:a': true }, { '$label:b': true }], 100));

    const result = await client.discoverKeywords({ limit: 4 });

    expect(sent).toHaveLength(2);
    expect(result.scanned).toBe(4);
    expect(result.total).toBe(100);
    expect(result.complete).toBe(false);
  });

  it('never asks for more messages than the cap leaves', async () => {
    const client = await connectedClient({ maxObjectsInGet: 500 });
    const sent = recordRequests(() => page(['m1', 'm2', 'm3'], [{}, {}, {}], 100));

    await client.discoverKeywords({ limit: 3 });

    expect(sent[0][0][1]).toMatchObject({ limit: 3 });
  });

  it('reports progress as it walks', async () => {
    const client = await connectedClient({ maxObjectsInGet: 2 });
    recordRequests((_calls, index) =>
      index === 0 ? page(['m1', 'm2'], [{}, {}], 3) : page(['m3'], [{}]),
    );

    const progress: Array<[number, number]> = [];
    await client.discoverKeywords({ onProgress: (scanned, total) => progress.push([scanned, total]) });

    expect(progress).toEqual([[2, 3], [3, 3]]);
  });

  it('stops when aborted and reports the scan as incomplete', async () => {
    const client = await connectedClient({ maxObjectsInGet: 2 });
    const controller = new AbortController();
    const sent = recordRequests(() => {
      controller.abort();
      return page(['m1', 'm2'], [{ '$label:a': true }, {}], 100);
    });

    const result = await client.discoverKeywords({ signal: controller.signal });

    expect(sent).toHaveLength(1);
    expect(result.keywords).toEqual({ '$label:a': 1 });
    expect(result.complete).toBe(false);
  });

  it('keeps what it found when a page fails, and calls the scan incomplete', async () => {
    const client = await connectedClient({ maxObjectsInGet: 2 });
    recordRequests((_calls, index) => {
      if (index === 0) return page(['m1', 'm2'], [{ '$label:a': true }, {}], 100);
      throw new Error('network down');
    });

    const result = await client.discoverKeywords();

    expect(result.keywords).toEqual({ '$label:a': 1 });
    expect(result.scanned).toBe(2);
    expect(result.complete).toBe(false);
  });

  it('handles an account with no mail at all', async () => {
    const client = await connectedClient();
    recordRequests(() => page([], [], 0));

    const result = await client.discoverKeywords();

    expect(result).toMatchObject({ keywords: {}, scanned: 0, total: 0, complete: true });
  });

  it('uses JMAP Keyword/get and preserves provider-label metadata', async () => {
    const client = await connectedKeywordGetClient();
    let requestBody: Record<string, unknown> | undefined;
    fetchSpy.mockImplementationOnce((async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(init.body as string);
      return jsonResponse({
        methodResponses: [['Keyword/get', {
          accountId: 'acct-1',
          totalEmails: 42,
          list: [
            { id: '$flagged', name: '$flagged', color: null, total: 8, unread: 3, isProviderLabel: false, source: 'message' },
            { id: '$label:GoogleVoice', name: 'Google Voice', color: null, total: 0, unread: 0, isProviderLabel: true, source: 'provider' },
          ],
          notFound: [],
        }, '0']],
      });
    }) as never);

    const result = await client.getKeywords();

    expect(requestBody).toMatchObject({
      using: ['urn:ietf:params:jmap:core', KEYWORDS_CAPABILITY],
      methodCalls: [['Keyword/get', { accountId: 'acct-1' }, '0']],
    });
    expect(result).toEqual({
      keywords: { $flagged: 8, '$label:GoogleVoice': 0 },
      labels: [
        { id: '$flagged', name: '$flagged', color: null, total: 8, unread: 3, isProviderLabel: false, source: 'message' },
        { id: '$label:GoogleVoice', name: 'Google Voice', color: null, total: 0, unread: 0, isProviderLabel: true, source: 'provider' },
      ],
      scanned: 42,
      total: 42,
      complete: true,
    });
  });

  it('falls back to scanning on ordinary JMAP servers', async () => {
    const client = await connectedClient();
    recordRequests(() => page(['m1'], [{ '$label:work': true, $seen: true }], 1));

    const result = await client.getKeywords();

    expect(result.keywords).toEqual({ '$label:work': 1, $seen: 1 });
    expect(result.labels).toEqual([
      expect.objectContaining({ id: '$label:work', name: 'work', total: 1, source: 'message' }),
      expect.objectContaining({ id: '$seen', name: '$seen', total: 1, source: 'message' }),
    ]);
    expect(result).toMatchObject({ scanned: 1, total: 1, complete: true });
  });
});
