import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

// #1798: a folder page brings the conversations of the account's drafts
// along, for the rows' "Draft" marker: one keyword query chained onto the
// list request, not a request per row.

type MethodCall = [string, Record<string, unknown>, string];

const session = {
  capabilities: { 'urn:ietf:params:jmap:core': {} },
  accounts: { 'acct-1': { name: 'test', isPersonal: true, accountCapabilities: { 'urn:ietf:params:jmap:mail': {} } } },
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1' },
  apiUrl: 'https://mail.example.com/jmap/api',
  downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
  uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
  eventSourceUrl: 'https://mail.example.com/jmap/eventsource',
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const page = [
  { id: 'e1', threadId: 't1', keywords: {}, receivedAt: '2026-01-02T00:00:00Z', mailboxIds: {}, size: 1, hasAttachment: false },
];

describe('JMAPClient draft conversations (#1798)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const sent: MethodCall[][] = [];

  beforeEach(() => {
    sent.length = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  async function client(draftAnswer: unknown) {
    fetchSpy.mockResolvedValueOnce(json(session));
    const c = JMAPClient.withBearer('https://mail.example.com', 'token', 'user@test.com');
    await c.connect();
    fetchSpy.mockReset();
    fetchSpy.mockImplementation((async (_url: string, init: RequestInit) => {
      const calls = JSON.parse(init.body as string).methodCalls as MethodCall[];
      sent.push(calls);
      if (calls[0][2] === 'asc') {
        return json({ methodResponses: [['Email/query', { ids: [] }, 'asc'], ['Email/query', { ids: [] }, 'desc'], ['Email/get', { list: [] }, 'get']] });
      }
      if (calls[0][2] === 'draftIds') {
        return json({ methodResponses: [['Email/query', { ids: ['d1'] }, 'draftIds'], draftAnswer] });
      }
      return json({ methodResponses: [
        ['Email/query', { ids: ['e1'], total: 1 }, '0'],
        ['Email/get', { state: 's1', list: page }, '1'],
        ['Thread/get', { list: [{ id: 't1', emailIds: ['e1', 'd1'] }] }, '2'],
        ['Email/query', { ids: ['d1', 'd2'] }, 'draftIds'],
        draftAnswer,
      ] });
    }) as never);
    return c;
  }

  it('reads the drafts and their conversations in the same request as the page', async () => {
    const c = await client(['Email/get', { list: [{ id: 'd1', threadId: 't1' }, { id: 'd2', threadId: 't9' }] }, 'draftThreads']);

    const result = await c.getEmails('inbox', undefined, 50, 0);

    expect(sent.filter((calls) => calls[0][2] === '0')).toHaveLength(1);
    const list = sent.find((calls) => calls[0][2] === '0')!;
    expect(list).toContainEqual(['Email/query', {
      accountId: 'acct-1',
      filter: { hasKeyword: '$draft' },
      sort: [{ property: 'receivedAt', isAscending: false }],
      limit: 200,
    }, 'draftIds']);
    expect(list).toContainEqual(['Email/get', {
      accountId: 'acct-1',
      '#ids': { resultOf: 'draftIds', name: 'Email/query', path: '/ids' },
      properties: ['id', 'threadId'],
    }, 'draftThreads']);
    expect(result.draftThreads).toEqual({ d1: 't1', d2: 't9' });
    // The page itself is unchanged.
    expect(result.emails.map((e) => e.id)).toEqual(['e1']);
    expect(result.threadCounts).toEqual({ t1: 2 });
  });

  it('returns none when the server could not answer, and still the page', async () => {
    const c = await client(['error', { type: 'unsupportedFilter' }, 'draftThreads']);
    const result = await c.getEmails('inbox', undefined, 50, 0);
    expect(result.emails.map((e) => e.id)).toEqual(['e1']);
    expect(result.draftThreads).toBeUndefined();
  });

  it('leaves them out where the server takes too few calls in one request', async () => {
    const c = await client(['Email/get', { list: [] }, 'draftThreads']);
    (c as unknown as { capabilities: Record<string, unknown> }).capabilities['urn:ietf:params:jmap:core'] = { maxCallsInRequest: 4 };
    await c.getEmails('inbox', undefined, 50, 0);
    const list = sent.find((calls) => calls[0][2] === '0')!;
    expect(list.map((call) => call[2])).toEqual(['0', '1', '2']);
  });

  it('reads them on their own for a list shown without a page', async () => {
    const c = await client(['Email/get', { list: [{ id: 'd1', threadId: 't1' }] }, 'draftThreads']);
    await expect(c.getDraftThreads()).resolves.toEqual({ d1: 't1' });
    expect(sent.at(-1)!.map((call) => call[2])).toEqual(['draftIds', 'draftThreads']);
  });
});
