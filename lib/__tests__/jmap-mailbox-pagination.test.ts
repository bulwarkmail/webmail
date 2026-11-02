import { afterEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';

type RawMailbox = { id: string; name: string; parentId?: string };
type MethodCall = [string, Record<string, unknown>, string];
type RequestTarget = { request(calls: MethodCall[]): Promise<unknown> };

function createClient(
  maxObjectsInGet = 2,
  accounts: Record<string, { name: string }> = { primary: { name: 'user@example.com' } },
): JMAPClient {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, {
    apiUrl: 'https://jmap.example.com/api',
    accountId: 'primary',
    username: 'user@example.com',
    accounts,
    capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet } },
  });
  return client;
}

function serve(client: JMAPClient, mailboxes: Record<string, RawMailbox[]>, clamp = Infinity, withTotal = true): MethodCall[][] {
  const requests: MethodCall[][] = [];
  vi.spyOn(client as unknown as RequestTarget, 'request').mockImplementation(async (calls) => {
    if (calls[0][0] === 'Mailbox/get') {
      return { methodResponses: calls.map(([, args, tag]) => [
        'Mailbox/get', { list: (mailboxes[args.accountId as string] ?? []).slice(0, client.getMaxObjectsInGet()), state: 'm' }, tag,
      ]) };
    }
    requests.push(calls);
    const accountId = calls[0][1].accountId as string;
    const position = calls[0][1].position as number;
    const limit = calls[0][1].limit as number;
    const all = mailboxes[accountId] ?? [];
    const page = all.slice(position, position + Math.min(limit, clamp));
    return { methodResponses: [
      ['Mailbox/query', { ids: page.map(({ id }) => id), queryState: 's', ...(withTotal && calls[0][1].calculateTotal ? { total: all.length } : {}) }, 'query'],
      ['Mailbox/get', { list: page, state: 'm', notFound: [] }, 'get'],
    ] };
  });
  return requests;
}

afterEach(() => vi.restoreAllMocks());

describe('JMAP mailbox pagination', () => {
  it('loads a complete hierarchy across server-clamped pages', async () => {
    const client = createClient(2);
    const requests = serve(client, { primary: [
      { id: 'grandchild', name: 'Grandchild', parentId: 'child' },
      { id: 'other', name: 'Other' },
      { id: 'child', name: 'Child', parentId: 'root' },
      { id: 'root', name: 'Root' },
    ] }, 1);

    const mailboxes = await client.getMailboxes();

    expect(mailboxes.map(({ id, parentId }) => [id, parentId])).toEqual([
      ['grandchild', 'child'], ['other', undefined], ['child', 'root'], ['root', undefined],
    ]);
    expect(requests.map(([query]) => query[1].position)).toEqual([0, 1, 2, 3]);
    expect(requests.map(([query]) => query[1].calculateTotal)).toEqual([true, false, false, false]);
    expect(requests.every((calls) => calls.length === 2 && calls[1][1]['#ids'] && !calls[1][1].ids)).toBe(true);
  });

  it.each([
    ['missing ids', undefined, 's', []],
    ['mixed ids', ['third', 4], 's', []],
    ['duplicate ids', ['parent'], 's', [{ id: 'parent', name: 'Parent' }]],
    ['changed state', ['third'], 's2', [{ id: 'third', name: 'Third' }]],
    ['early empty page', [], 's', []],
    ['missing object', ['third'], 's', []],
  ])('rejects %s instead of publishing a partial hierarchy', async (_label, ids, queryState, list) => {
    const client = createClient();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(client as unknown as RequestTarget, 'request')
      .mockResolvedValueOnce({ methodResponses: [
        ['Mailbox/get', { list: [{ id: 'child' }, { id: 'parent' }] }, '0'],
      ] })
      .mockResolvedValueOnce({ methodResponses: [
        ['Mailbox/query', { ids: ['child', 'parent'], queryState: 's', total: 3 }, 'query'],
        ['Mailbox/get', { list: [{ id: 'child', name: 'Child' }, { id: 'parent', name: 'Parent' }] }, 'get'],
      ] })
      .mockResolvedValueOnce({ methodResponses: [
        ['Mailbox/query', { ids, queryState }, 'query'],
        ['Mailbox/get', { list }, 'get'],
      ] });

    await expect(client.getMailboxes()).rejects.toThrow();
  });

  it('prefixes shared mailbox and parent ids', async () => {
    const client = createClient(1, { primary: { name: 'user@example.com' }, shared: { name: 'team@example.com' } });
    serve(client, {
      primary: [{ id: 'inbox', name: 'Inbox' }],
      shared: [{ id: 'child', name: 'Child', parentId: 'parent' }, { id: 'parent', name: 'Parent' }],
    });

    expect((await client.getAllMailboxes()).find(({ name }) => name === 'Child')).toMatchObject({
      id: 'shared:child', originalId: 'child', parentId: 'shared:parent', accountId: 'shared', isShared: true,
    });
  });

  it('keeps small accounts on the existing single-request fast path', async () => {
    const client = createClient(3);
    const requests = serve(client, { primary: [{ id: 'inbox', name: 'Inbox' }] });
    expect(await client.getMailboxes()).toHaveLength(1);
    expect(requests).toHaveLength(0);
    expect(client['request']).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('loads an exact page multiple (total returned: %s)', async (withTotal) => {
    const client = createClient(2);
    const list = Array.from({ length: 4 }, (_, i) => ({ id: String(i), name: String(i) }));
    const requests = serve(client, { primary: list }, Infinity, withTotal);
    expect(await client.getMailboxes()).toHaveLength(4);
    expect(requests.map(([query]) => query[1].position)).toEqual(withTotal ? [0, 2] : [0, 2, 4]);
    expect(requests.map(([query]) => query[1].calculateTotal)).toEqual(withTotal ? [true, false] : [true, false, false]);
  });

  it('retains Mailbox collection state and packed small-account retrieval', async () => {
    const client = createClient(2, { primary: { name: 'Self' }, shared: { name: 'Shared' } });
    serve(client, {
      primary: [{ id: 'inbox', name: 'Inbox' }],
      shared: [{ id: 'parent', name: 'Parent' }, { id: 'child', name: 'Child', parentId: 'parent' }, { id: 'other', name: 'Other' }],
    });
    const result = await client.getAllMailboxesWithState();
    expect(result.mailboxes.map(({ id }) => id)).toEqual(['inbox', 'shared:parent', 'shared:child', 'shared:other']);
    expect(result.states).toEqual({ primary: 'm', shared: 'm' });
    expect(vi.mocked(client['request']).mock.calls[0][0].map(([name]) => name)).toEqual(['Mailbox/get', 'Mailbox/get']);
  });

  it('does not drop later accounts in a packed batch when one paginated account fails', async () => {
    const client = createClient(2, { primary: { name: 'Self' }, shared: { name: 'Shared' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(client as unknown as RequestTarget, 'request')
      .mockResolvedValueOnce({ methodResponses: [
        ['Mailbox/get', { list: [{ id: 'a' }, { id: 'b' }] }, '0'],
        ['Mailbox/get', { state: 'shared-state', list: [{ id: 'inbox', name: 'Shared Inbox' }] }, '1'],
      ] })
      .mockRejectedValueOnce(new Error('page failed'));
    const result = await client.getAllMailboxesWithState();
    expect(result.mailboxes.map(({ id }) => id)).toEqual(['shared:inbox']);
    expect(result.states).toEqual({ shared: 'shared-state' });
  });

  it('pages when an unbounded get is rejected as tooManyObjects', async () => {
    const client = createClient();
    const list = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
    serve(client, { primary: list });
    vi.mocked(client['request']).mockResolvedValueOnce({ methodResponses: [
      ['error', { type: 'tooManyObjects' }, '0'],
    ] });
    expect((await client.getMailboxes()).map(({ id }) => id)).toEqual(['a', 'b', 'c']);
  });
});
