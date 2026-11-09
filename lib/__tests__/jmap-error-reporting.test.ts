import { beforeEach, describe, expect, it, vi } from 'vitest';

const reported = vi.hoisted(() => ({ calls: [] as string[][], failures: [] as unknown[] }));
vi.mock('@/lib/error-reporting/client', () => ({
  recordJmapCall: (methods: string[]) => { reported.calls.push(methods); },
  reportJmapFailure: (failure: unknown) => { reported.failures.push(failure); },
}));

import { JMAPClient } from '../jmap/client';

type Call = [string, Record<string, unknown>, string];
const SUBJECT = 'Merger plans for Acme Q3';

function clientAnswering(response: Response) {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, { apiUrl: 'https://jmap.example.com/jmap/', accountId: 'me' });
  vi.spyOn(client as unknown as { authenticatedFetch: () => Promise<Response> }, 'authenticatedFetch').mockResolvedValue(response);
  const request = (calls: Call[]) => (client as unknown as { request: (c: Call[]) => Promise<unknown> }).request(calls);
  return request;
}

beforeEach(() => {
  reported.calls = [];
  reported.failures = [];
});

describe('JMAP requests and error reporting', () => {
  it('keeps the method names of each request as a breadcrumb', async () => {
    const request = clientAnswering(new Response(JSON.stringify({ methodResponses: [] })));
    await request([['Email/query', { filter: { subject: SUBJECT } }, '0'], ['Email/get', {}, '1']]);
    expect(reported.calls).toEqual([['Email/query', 'Email/get']]);
    expect(reported.failures).toEqual([]);
  });

  it('reports a failed request by its status only', async () => {
    const request = clientAnswering(new Response(`{"detail":"${SUBJECT}"}`, { status: 503 }));
    await expect(request([['Email/get', {}, '0']])).rejects.toThrow();
    expect(reported.failures).toEqual([{ status: 503 }]);
  });

  it('does not report an expired token or the concurrency limit', async () => {
    const request = clientAnswering(new Response('', { status: 401 }));
    await expect(request([['Email/get', {}, '0']])).rejects.toThrow();
    expect(reported.failures).toEqual([]);
  });

  it('reports method errors by method and type, but not the ones that only mean "sync again"', async () => {
    const request = clientAnswering(new Response(JSON.stringify({
      methodResponses: [
        ['error', { type: 'overQuota', description: SUBJECT }, 'a'],
        ['error', { type: 'cannotCalculateChanges' }, 'b'],
        ['Mailbox/get', { list: [] }, 'c'],
      ],
    })));
    await request([['Email/set', {}, 'a'], ['Email/changes', {}, 'b'], ['Mailbox/get', {}, 'c']]);
    expect(reported.failures).toEqual([{ method: 'Email/set', type: 'overQuota' }]);
  });
});
