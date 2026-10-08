import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

// #1173: moving many folders at once goes through one Mailbox/set per
// maxObjectsInSet chunk, and a refused folder doesn't fail the others.

function makeSession(maxObjectsInSet?: number) {
  return {
    capabilities: { 'urn:ietf:params:jmap:core': maxObjectsInSet ? { maxObjectsInSet } : {} },
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

describe('JMAPClient.updateMailboxes', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  async function connectedClient(maxObjectsInSet?: number): Promise<JMAPClient> {
    fetchSpy.mockResolvedValueOnce(jsonResponse(makeSession(maxObjectsInSet)));
    const client = JMAPClient.withBearer('https://mail.example.com', 'token123', 'user@test.com');
    await client.connect();
    fetchSpy.mockReset();
    return client;
  }

  const sentUpdates = (): Record<string, unknown>[] => fetchSpy.mock.calls.map((call: unknown[]) => {
    const init = call[1] as RequestInit;
    const [name, args] = JSON.parse(init.body as string).methodCalls[0];
    expect(name).toBe('Mailbox/set');
    return args.update as Record<string, unknown>;
  });

  it('sends every update in one Mailbox/set and returns the refused ids', async () => {
    const client = await connectedClient();
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      methodResponses: [
        ['Mailbox/set', { updated: { a: null, c: null }, notUpdated: { b: { type: 'invalidProperties' } } }, '0'],
      ],
    }));

    const failed = await client.updateMailboxes({
      a: { parentId: 'old' },
      b: { parentId: 'old' },
      c: { parentId: 'old' },
    });

    expect(failed).toEqual({ b: 'invalidProperties' });
    expect(sentUpdates()).toEqual([
      { a: { parentId: 'old' }, b: { parentId: 'old' }, c: { parentId: 'old' } },
    ]);
  });

  it('splits the updates by maxObjectsInSet', async () => {
    const client = await connectedClient(2);
    fetchSpy.mockImplementation(async () => jsonResponse({
      methodResponses: [['Mailbox/set', { updated: {} }, '0']],
    }));

    const failed = await client.updateMailboxes({
      a: { parentId: null },
      b: { parentId: null },
      c: { parentId: null },
    });

    expect(failed).toEqual({});
    expect(sentUpdates().map(u => Object.keys(u))).toEqual([['a', 'b'], ['c']]);
  });

  it('throws when the server rejects the whole call', async () => {
    const client = await connectedClient();
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      methodResponses: [['error', { type: 'forbidden' }, '0']],
    }));

    await expect(client.updateMailboxes({ a: { parentId: null } })).rejects.toThrow('forbidden');
  });
});
