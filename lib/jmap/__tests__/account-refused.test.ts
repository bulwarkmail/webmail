import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountUnavailableError, JMAPClient } from '../client';

// Stalwart answers every request of an account deleted while signed in with a
// 403 problem document. A burst of them got the user's address banned by
// CrowdSec (#1539), so after the first one the client sends nothing more.

const SERVER = 'https://mail.example.test';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const problem = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/problem+json' } });
const refused = () => problem({ type: 'about:blank', status: 403, title: 'Forbidden', detail: 'You do not have enough permissions to access this resource.' }, 403);
const session = () => json({
  apiUrl: `${SERVER}/jmap`, downloadUrl: `${SERVER}/d/{accountId}/{blobId}/{name}`, uploadUrl: `${SERVER}/u/{accountId}`, eventSourceUrl: '', username: 'alice',
  capabilities: { 'urn:ietf:params:jmap:core': {} }, accounts: { a: { name: 'alice', isPersonal: true, accountCapabilities: {} } }, primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a' },
});
const echo = () => json({ methodResponses: [['Core/echo', { ping: 'pong' }, '0']], sessionState: 's' });

let answers: { api: () => Response; session: () => Response };
let fetchMock: ReturnType<typeof vi.fn>;

async function connected(): Promise<{ client: JMAPClient; refusals: number[] }> {
  answers = { session, api: echo };
  const client = new JMAPClient(SERVER, 'alice', 'secret');
  await client.connect();
  const refusals: number[] = [];
  client.onAccessRefused(() => refusals.push(Date.now()));
  fetchMock.mockClear();
  return { client, refusals };
}

beforeEach(() => {
  fetchMock = vi.fn(async (input: unknown) => (String(input).includes('/.well-known/jmap') ? answers.session() : answers.api()));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a login the server refuses as a whole', () => {
  it('sends nothing more after the first 403 for the API', async () => {
    const { client, refusals } = await connected();
    answers = { api: refused, session: refused };

    await expect(client.ping()).rejects.toThrow('403');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.isAccessRefused()).toBe(true);
    expect(refusals).toHaveLength(1);

    // What a switch to the account starts at once: folders, identities, the list...
    const loads = await Promise.allSettled(Array.from({ length: 10 }, () => client.ping()));
    expect(loads.every((load) => load.status === 'rejected' && load.reason instanceof AccountUnavailableError)).toBe(true);
    await expect(client.reconnect()).rejects.toBeInstanceOf(AccountUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refusals).toHaveLength(1);
    client.disconnect();
  });

  it('stops on a 403 for the session too', async () => {
    const { client, refusals } = await connected();
    answers = { api: echo, session: refused };
    await expect(client.reconnect()).rejects.toThrow('403');
    expect(refusals).toHaveLength(1);
    await expect(client.ping()).rejects.toBeInstanceOf(AccountUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    client.disconnect();
  });
});

describe('what is not a refusal of the whole login', () => {
  it('a forbidden method inside a good answer', async () => {
    const { client, refusals } = await connected();
    answers = { api: () => json({ methodResponses: [['error', { type: 'forbidden' }, '0']], sessionState: 's' }), session };
    await client.ping().catch(() => {});
    expect(client.isAccessRefused()).toBe(false);
    expect(refusals).toEqual([]);
    answers = { api: echo, session };
    await client.ping();
    client.disconnect();
  });

  it("Stalwart's IP block, which lifts again", async () => {
    const { client, refusals } = await connected();
    answers = { api: () => problem({ type: 'about:blank', status: 403, title: 'Forbidden', detail: 'Forbidden' }, 403), session };
    await expect(client.ping()).rejects.toThrow('403');
    expect(client.isAccessRefused()).toBe(false);
    answers = { api: echo, session };
    await client.ping();
    expect(refusals).toEqual([]);
    client.disconnect();
  });

  it("a gateway's JSON 403", async () => {
    const { client, refusals } = await connected();
    answers = { api: () => json({ status: 403, error: 'Forbidden', message: 'denied by policy' }, 403), session };
    await expect(client.ping()).rejects.toThrow('403');
    expect(client.isAccessRefused()).toBe(false);
    answers = { api: echo, session };
    await client.ping();
    expect(refusals).toEqual([]);
    client.disconnect();
  });

  it('a 403 page from a proxy', async () => {
    const { client, refusals } = await connected();
    answers = { api: () => new Response('<html>Blocked by the firewall</html>', { status: 403, headers: { 'Content-Type': 'text/html' } }), session };
    await expect(client.ping()).rejects.toThrow('403');
    expect(client.isAccessRefused()).toBe(false);
    answers = { api: echo, session };
    await client.ping();
    expect(refusals).toEqual([]);
    client.disconnect();
  });

  it('a 403 for a download', async () => {
    const { client, refusals } = await connected();
    answers = { api: refused, session };
    await expect(client.fetchBlob('b1', 'x.txt')).rejects.toThrow('403');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    answers = { api: echo, session };
    await client.ping();
    expect(client.isAccessRefused()).toBe(false);
    expect(refusals).toEqual([]);
    client.disconnect();
  });
});
