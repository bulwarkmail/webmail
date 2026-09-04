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

function serve(client: JMAPClient, mailboxes: Record<string, RawMailbox[]>, clamp = Infinity): MethodCall[][] {
  const requests: MethodCall[][] = [];
  vi.spyOn(client as unknown as RequestTarget, 'request').mockImplementation(async (calls) => {
    requests.push(calls);
    const accountId = calls[0][1].accountId as string;
    const position = calls[0][1].position as number;
    const limit = calls[0][1].limit as number;
    const all = mailboxes[accountId] ?? [];
    const page = all.slice(position, position + Math.min(limit, clamp));
    return { methodResponses: [
      ['Mailbox/query', { ids: page.map(({ id }) => id), queryState: 's', total: all.length }, 'query'],
      ['Mailbox/get', { list: page, notFound: [] }, 'get'],
    ] };
  });
  return requests;
}

afterEach(() => vi.restoreAllMocks());

describe('JMAP mailbox pagination', () => {
  it('loads a complete hierarchy across server-clamped pages', async () => {
    const client = createClient(3);
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
  ])('rejects %s instead of publishing a partial hierarchy', async (_label, ids, queryState, list) => {
    const client = createClient();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(client as unknown as RequestTarget, 'request')
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
});
