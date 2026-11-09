import { afterEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';
import { jmapErrorType } from '../jmap/jmap-error';
import { ACCOUNT, LICENSE_REFUSAL, archivedEmail, bigArchive, fakeArchiveServer } from '../recovery/__tests__/fixtures';

type Call = [string, Record<string, unknown>, string];
type Body = { using: string[]; methodCalls: Call[] };

function client(core: Record<string, number> = {}, stalwart = true) {
  const c = new JMAPClient('https://jmap.example.com', 'user', 'pass');
  const accounts = {
    [ACCOUNT]: {
      name: 'org-alice@example.org', isPersonal: true,
      accountCapabilities: stalwart ? { 'urn:ietf:params:jmap:mail': {}, 'urn:stalwart:jmap': {} } : { 'urn:ietf:params:jmap:mail': {} },
    },
  };
  Object.assign(c, {
    apiUrl: 'https://jmap.example.com/api',
    accountId: ACCOUNT,
    capabilities: { 'urn:ietf:params:jmap:core': { maxCallsInRequest: 16, maxObjectsInGet: 500, maxObjectsInSet: 500, ...core } },
    accounts,
    session: { accounts },
  });
  return c;
}

function respondWith(handler: (body: Body) => unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as RequestInit).body as string) as Body;
    const response = handler(body);
    return { ok: true, status: 200, text: async () => JSON.stringify(response), json: async () => response } as Response;
  });
}

const bodies = (spy: ReturnType<typeof respondWith>) => spy.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as Body);
const queries = (spy: ReturnType<typeof respondWith>) => bodies(spy).flatMap((b) => b.methodCalls).filter(([m]) => m === 'x:ArchivedItem/query');

afterEach(() => vi.restoreAllMocks());

describe('JMAPClient archived items', () => {
  it('advertises them only on Stalwart', () => {
    expect(client().advertisesArchivedItems()).toBe(true);
    expect(client({}, false).advertisesArchivedItems()).toBe(false);
  });

  it('asks the account filter first and, once refused, never again for that account', async () => {
    const server = fakeArchiveServer([archivedEmail('a')]);
    const spy = respondWith(server.answer);
    const c = client();
    await expect(c.queryArchivedItemIds(undefined, { limit: 1 })).resolves.toEqual({ ids: ['a'], total: null });
    await c.queryArchivedItemIds(undefined, { limit: 1 });
    expect(queries(spy).map(([, args]) => args)).toEqual([
      { accountId: ACCOUNT, limit: 1, filter: { accountId: ACCOUNT } },
      { accountId: ACCOUNT, limit: 1 },
      { accountId: ACCOUNT, limit: 1 },
    ]);
    expect(bodies(spy)[0].using).toEqual(['urn:ietf:params:jmap:core', 'urn:stalwart:jmap']);
  });

  it("keeps an admin's answer to the account through the filter, and drops other accounts' items anyway", async () => {
    const server = fakeArchiveServer([
      archivedEmail('i3'),
      archivedEmail('i2', { accountId: 'cz' }),
      archivedEmail('i1', { accountId: undefined }),
    ], { impersonate: true });
    const spy = respondWith(server.answer);
    const result = await client().listArchivedEmails(undefined, { days: 0 });
    expect(result.items.map((i) => i.id)).toEqual(['i3']);
    expect(queries(spy).every(([, args]) => (args.filter as { accountId?: string })?.accountId === ACCOUNT)).toBe(true);
  });

  it('drops the other accounts in an unfiltered mixed answer and keeps items without accountId', async () => {
    // A server that ignores the filter and answers with every account. 'n' has
    // no accountId, the way Stalwart sends items to a user without Impersonate (#1480).
    respondWith((body) => ({
      methodResponses: body.methodCalls.map(([method, , id]) => method === 'x:ArchivedItem/query'
        ? [method, { ids: ['a', 'z', 'n'], total: 3 }, id]
        : [method, { list: [archivedEmail('a'), archivedEmail('z', { accountId: 'cz' }), archivedEmail('n', { accountId: undefined })] }, id]),
    }));
    const result = await client().listArchivedEmails(undefined, { days: 0 });
    expect(result.items.map((i) => i.id)).toEqual(['a', 'n']);
  });

  it('throws the refusal with its type when the server has no license', async () => {
    respondWith(() => ({ methodResponses: [['error', LICENSE_REFUSAL, 'q']] }));
    const error = await client().queryArchivedItemIds().catch((e: unknown) => e);
    expect(jmapErrorType(error)).toBe('forbidden');
  });

  it('pages with calculateTotal, so the newest of more than 5000 items comes first', async () => {
    const now = Date.now();
    const server = fakeArchiveServer(bigArchive(6000, now));
    const spy = respondWith(server.answer);
    const first = await client().listArchivedEmails(undefined, { days: 0 });
    expect(first.items[0].id).toBe('i006000');
    expect(first.nextPosition).toBe(2000);
    const pages = queries(spy).filter(([, args]) => args.calculateTotal && !args.filter);
    expect(pages.map(([, args]) => [args.position ?? 0, args.limit])).toEqual([[0, 500], [500, 500], [1000, 500], [1500, 500]]);
    const gets = bodies(spy).flatMap((b) => b.methodCalls).filter(([m]) => m === 'x:ArchivedItem/get');
    expect(gets.every(([, args]) => (args.ids as string[]).length <= 500)).toBe(true);
    const older = await client().listArchivedEmails(undefined, { days: 0, startPosition: 2000 });
    expect(older.items[0].id).toBe('i004000');
  });

  it('checks for the Trash link with one-item pages and stops at the first message', async () => {
    const now = Date.now();
    const server = fakeArchiveServer(bigArchive(30, now));
    const spy = respondWith(server.answer);
    await expect(client().hasArchivedEmail(undefined, { days: 7 })).resolves.toBe(true);
    expect(queries(spy).filter(([, args]) => args.calculateTotal && !args.filter).map(([, args]) => args.limit)).toEqual([1]);
  });

  it('restores with requestRestore and reports notFound and failures per item', async () => {
    const server = fakeArchiveServer([archivedEmail('a')]);
    const spy = respondWith(server.answer);
    const results = await client().restoreArchivedItems(['a', 'b']);
    expect(results).toEqual([{ id: 'a', ok: true }, { id: 'b', ok: false, error: 'notFound', type: 'notFound' }]);
    expect(bodies(spy)[0].methodCalls).toEqual([
      ['x:ArchivedItem/set', { accountId: ACCOUNT, update: { a: { status: 'requestRestore' }, b: { status: 'requestRestore' } } }, 'r0'],
    ]);
  });

  it('fails every item of a request that fails instead of throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const results = await client().restoreArchivedItems(['a']);
    expect(results).toEqual([{ id: 'a', ok: false, error: expect.any(String) }]);
  });
});
