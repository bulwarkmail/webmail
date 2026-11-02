import { describe, it, expect, vi, afterEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

type Call = [string, Record<string, unknown>, string];

function client() {
  const c = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(c, { accountId: 'me', downloadUrl: 'https://jmap.example.com/download/{accountId}/{blobId}/{name}?accept={type}' });
  return c;
}

afterEach(() => vi.unstubAllGlobals());

describe('importUploadedEmails', () => {
  it('imports several uploaded messages in one Email/import into the given account, one result each', async () => {
    const c = client();
    const calls: Call[][] = [];
    vi.spyOn(c as unknown as { request: (c: Call[]) => Promise<unknown> }, 'request').mockImplementation(async (req: Call[]) => {
      calls.push(req);
      return { methodResponses: [['Email/import', { created: { imp0: { id: 'e1' } }, notCreated: { imp1: { type: 'invalidEmail', description: 'Blob does not contain a valid RFC 5322 message.' } } }, '0']] };
    });
    const results = await c.importUploadedEmails([
      { blobId: 'b1', mailboxIds: { inbox: true }, keywords: { $seen: true }, receivedAt: '2020-01-02T03:04:05Z' },
      { blobId: 'b2', mailboxIds: { inbox: true }, keywords: {} },
    ], 'shared');
    expect(calls).toHaveLength(1);
    expect(calls[0][0][0]).toBe('Email/import');
    expect(calls[0][0][1]).toEqual({
      accountId: 'shared',
      emails: {
        imp0: { blobId: 'b1', mailboxIds: { inbox: true }, keywords: { $seen: true }, receivedAt: '2020-01-02T03:04:05Z' },
        imp1: { blobId: 'b2', mailboxIds: { inbox: true }, keywords: {} },
      },
    });
    expect(results).toEqual([{ id: 'e1' }, { error: 'Blob does not contain a valid RFC 5322 message.', type: 'invalidEmail' }]);
  });
});

describe('the transfer\'s own JMAP requests', () => {
  const entry = { blobId: 'b1', mailboxIds: { inbox: true }, keywords: {} };

  it('throw RateLimitError on a 429 without pausing the rest of the client', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '20' } })));
    const c = client();
    Object.assign(c, { apiUrl: 'https://jmap.example.com/jmap/' });
    await expect(c.importUploadedEmails([entry])).rejects.toMatchObject({ name: 'RateLimitError', retryAfterMs: 20_000 });
    expect((c as unknown as { isRateLimited(): boolean }).isRateLimited()).toBe(false);
  });

  it('still go out while the client waits out a 429 of its own', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ methodResponses: [['Email/import', { created: { imp0: { id: 'e1' } } }, '0']] })));
    vi.stubGlobal('fetch', fetch);
    const c = client();
    Object.assign(c, { apiUrl: 'https://jmap.example.com/jmap/' });
    (c as unknown as { setRateLimited(ms: number): void }).setRateLimited(60_000);
    await expect(c.importUploadedEmails([entry])).resolves.toEqual([{ id: 'e1' }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('fetchBlobForTransfer', () => {
  it('downloads with the account in the URL', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetch);
    const bytes = await client().fetchBlobForTransfer('blob1', 'shared');
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain('/download/shared/blob1/');
  });

  it('reports a 429 to the export without pausing the rest of the client', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '30' } })));
    const c = client();
    await expect(c.fetchBlobForTransfer('blob1', undefined)).rejects.toMatchObject({ name: 'RateLimitError', retryAfterMs: 30_000 });
    expect((c as unknown as { isRateLimited(): boolean }).isRateLimited()).toBe(false);
  });
});
