import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

function makeSession() {
  return {
    capabilities: { 'urn:ietf:params:jmap:core': {} },
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

/**
 * Stand-in for a Stalwart mailbox: Email/query returns one page of remaining
 * ids, Email/set destroys them. `includeTotal` mirrors the server's freedom to
 * omit `total` when the query did not ask for `calculateTotal` (RFC 8620 5.5).
 */
function makeMailboxServer(opts: {
  count: number;
  includeTotal?: boolean;
  destroyFails?: boolean;
}) {
  let remaining = Array.from({ length: opts.count }, (_, i) => `email-${i}`);
  const requests: number[] = [];

  const handler = async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(init.body as string);
    const [, queryArgs] = body.methodCalls[0];
    const limit: number = queryArgs.limit;
    const page = remaining.slice(0, limit);
    requests.push(page.length);

    const destroyed = opts.destroyFails ? [] : page;
    remaining = remaining.slice(destroyed.length);

    return jsonResponse({
      methodResponses: [
        ['Email/query', { ids: page, ...(opts.includeTotal ? { total: page.length } : {}) }, '0'],
        ['Email/set', { destroyed, notDestroyed: {} }, '1'],
      ],
    });
  };

  return { handler, requests, remainingCount: () => remaining.length };
}

describe('JMAPClient.emptyMailbox', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  async function connectedClient(): Promise<JMAPClient> {
    fetchSpy.mockResolvedValueOnce(jsonResponse(makeSession()));
    const client = JMAPClient.withBearer('https://mail.example.com', 'token123', 'user@test.com');
    await client.connect();
    fetchSpy.mockReset();
    return client;
  }

  it('destroys every email in a mailbox larger than one batch', async () => {
    const client = await connectedClient();
    const server = makeMailboxServer({ count: 1200 });
    fetchSpy.mockImplementation(server.handler as never);

    const destroyed = await client.emptyMailbox('mailbox-1');

    expect(destroyed).toBe(1200);
    expect(server.remainingCount()).toBe(0);
    expect(server.requests).toEqual([500, 500, 200]);
  });

  // Regression for #711: the loop used to stop after one batch when the server
  // omitted `total`, leaving folders with thousands of emails nearly full.
  it('keeps paging when the server omits Email/query total', async () => {
    const client = await connectedClient();
    const server = makeMailboxServer({ count: 2300, includeTotal: false });
    fetchSpy.mockImplementation(server.handler as never);

    const destroyed = await client.emptyMailbox('mailbox-1');

    expect(destroyed).toBe(2300);
    expect(server.remainingCount()).toBe(0);
  });

  it('issues a final confirming query when the count is an exact multiple of the batch size', async () => {
    const client = await connectedClient();
    const server = makeMailboxServer({ count: 1000 });
    fetchSpy.mockImplementation(server.handler as never);

    const destroyed = await client.emptyMailbox('mailbox-1');

    expect(destroyed).toBe(1000);
    expect(server.requests).toEqual([500, 500, 0]);
  });

  it('stops instead of looping forever when the server refuses to destroy', async () => {
    const client = await connectedClient();
    const server = makeMailboxServer({ count: 1200, destroyFails: true });
    fetchSpy.mockImplementation(server.handler as never);

    const destroyed = await client.emptyMailbox('mailbox-1');

    expect(destroyed).toBe(0);
    expect(server.requests).toEqual([500]);
  });

  it('returns zero without extra requests for an already empty mailbox', async () => {
    const client = await connectedClient();
    const server = makeMailboxServer({ count: 0 });
    fetchSpy.mockImplementation(server.handler as never);

    const destroyed = await client.emptyMailbox('mailbox-1');

    expect(destroyed).toBe(0);
    expect(server.requests).toEqual([0]);
  });
});
