import { describe, it, expect, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';

type Call = [string, Record<string, unknown>, string];

// A tiny server: `unread` is the set of unread message ids, each in one
// mailbox. Email/query {notKeyword: $seen} pages over it in id order.
function fakeServer(mailboxOf: Record<string, string>, refuse = false) {
  const unread = new Set(Object.keys(mailboxOf));
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, { accountId: 'me', capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 2, maxObjectsInSet: 2 } } });
  const request = vi.spyOn(client as unknown as { request: (c: Call[]) => Promise<unknown> }, 'request')
    .mockImplementation(async (calls: Call[]) => {
      const responses: unknown[] = [];
      let lastIds: string[] = [];
      for (const [method, args, id] of calls) {
        if (method === 'Email/query') {
          const filter = args.filter as { conditions?: Array<{ inMailbox?: string }> };
          const inMailbox = filter.conditions?.find(c => c.inMailbox)?.inMailbox;
          const all = [...unread].sort().filter(m => !inMailbox || mailboxOf[m] === inMailbox);
          const position = (args.position as number) ?? 0;
          lastIds = all.slice(position, position + (args.limit as number));
          responses.push(['Email/query', { ids: lastIds }, id]);
        } else if (method === 'Email/get') {
          responses.push(['Email/get', { list: lastIds.map(m => ({ id: m, mailboxIds: { [mailboxOf[m]]: true } })) }, id]);
        } else if (method === 'Email/set') {
          const ids = Object.keys(args.update as object);
          if (refuse) {
            responses.push(['Email/set', { notUpdated: Object.fromEntries(ids.map(m => [m, { type: 'forbidden' }])) }, id]);
          } else {
            ids.forEach(m => unread.delete(m));
            responses.push(['Email/set', { updated: Object.fromEntries(ids.map(m => [m, null])) }, id]);
          }
        }
      }
      return { methodResponses: responses };
    });
  return { client, unread, request };
}

describe('mark as read paging', () => {
  it('marks every unread message, not every other page', async () => {
    const mailboxOf = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(m => [m, 'inbox']));
    const { client, unread } = fakeServer(mailboxOf);
    expect(await client.markAllAsRead()).toBe(7);
    expect(unread.size).toBe(0);
  });

  it('pages past messages left unread in excluded folders', async () => {
    const { client, unread } = fakeServer({ a: 'junk', b: 'inbox', c: 'junk', d: 'inbox', e: 'inbox' });
    expect(await client.markAllAsRead(['junk'])).toBe(3);
    expect([...unread].sort()).toEqual(['a', 'c']);
  });

  it('stops with an error when the server refuses instead of looping', async () => {
    const { client, request } = fakeServer({ a: 'inbox', b: 'inbox', c: 'inbox' }, true);
    await expect(client.markMailboxAsRead('inbox')).rejects.toThrow(/mark the folder as read/);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
