import { afterEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../client';

/** The browser's cache isn't encrypted, and Stalwart lets it keep a download for a year. */
describe('what the client fetches stays out of the HTTP cache', () => {
  afterEach(() => vi.unstubAllGlobals());

  function clientWithFetch() {
    const seen: Array<{ url: string; cache?: RequestCache }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), cache: init?.cache });
      return new Response('raw message', { status: 200 });
    }));
    const client = JMAPClient.withBearer('https://mail.example.test', 'token', 'alice');
    const fields = client as unknown as { downloadUrl: string; accountId: string };
    fields.downloadUrl = 'https://mail.example.test/d/{accountId}/{blobId}/{name}?accept={type}';
    fields.accountId = 'a';
    return { client, seen };
  }

  it('a blob, as attachments and inline images use it', async () => {
    const { client, seen } = clientWithFetch();
    await client.fetchBlob('b1', 'photo.png', 'image/png');
    expect(seen).toEqual([expect.objectContaining({ cache: 'no-store' })]);
  });

  it('a raw message for an export or a move', async () => {
    const { client, seen } = clientWithFetch();
    await client.fetchBlobForTransfer('b2', 'a');
    expect(seen).toEqual([expect.objectContaining({ cache: 'no-store' })]);
  });

  it('bytes for a preview', async () => {
    const { client, seen } = clientWithFetch();
    await client.fetchBlobArrayBuffer('b3', 'report.pdf', 'application/pdf');
    expect(seen).toEqual([expect.objectContaining({ cache: 'no-store' })]);
  });
});
