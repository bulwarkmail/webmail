import { describe, it, expect, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';

type Call = [string, Record<string, unknown>, string];

describe('getPrincipals', () => {
  it('pages the directory instead of asking Principal/get for every id at once', async () => {
    const ids = Array.from({ length: 1203 }, (_, i) => `p${i}`);
    const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
    Object.assign(client, {
      accountId: 'me',
      capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 500 }, 'urn:ietf:params:jmap:principals': {} },
    });
    vi.spyOn(client as unknown as { supportsPrincipals: () => boolean }, 'supportsPrincipals').mockReturnValue(true);
    const queries: Record<string, unknown>[] = [];
    vi.spyOn(client as unknown as { request: (c: Call[]) => Promise<unknown> }, 'request')
      .mockImplementation(async (calls: Call[]) => {
        const args = calls[0][1];
        queries.push(args);
        const page = ids.slice(args.position as number, (args.position as number) + (args.limit as number));
        return {
          methodResponses: [
            ['Principal/query', { ids: page }, '0'],
            ['Principal/get', { list: page.map((id) => ({ id, name: id })) }, '1'],
          ],
        };
      });

    const principals = await client.getPrincipals();
    expect(principals).toHaveLength(1203);
    expect(queries.map((q) => [q.position, q.limit])).toEqual([[0, 500], [500, 500], [1000, 500]]);
  });
});
