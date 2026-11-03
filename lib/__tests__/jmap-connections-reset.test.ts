import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient, RequestTimeoutError } from '../jmap/client';
import { UploadXHR, uploadClient } from './helpers/upload-xhr';

/**
 * The desktop app closed its connections under the page. A request under way then never settles
 * by itself, so all that ends it is being told.
 */

const session = {
  capabilities: { 'urn:ietf:params:jmap:core': {} },
  accounts: { 'acct-1': { name: 'test', isPersonal: true, accountCapabilities: {} } },
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1' },
  apiUrl: 'https://mail.example.com/jmap/api',
  downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
  uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
  eventSourceUrl: 'https://mail.example.com/jmap/eventsource',
};

let reset: () => void;

function withBridge(): void {
  const listeners = new Set<() => void>();
  reset = () => {
    for (const listener of listeners) listener();
  };
  (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = {
    version: 1,
    certificates: {
      onConnectionsReset: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

/** Takes the request, and nothing ever comes back. Only an abort ends it. */
const silent = (_url: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError')));
  });

/** The one all of the client's calls go through. */
const requestOf = (client: JMAPClient) => (client as unknown as { request(calls: unknown[]): Promise<unknown> }).request.bind(client);

async function connectedClient(): Promise<JMAPClient> {
  const client = new JMAPClient('https://mail.example.com', 'alice', 'secret');
  vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify(session), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await client.connect();
  return client;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  delete (window as { bulwarkDesktop?: unknown }).bulwarkDesktop;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('when the desktop app closes its connections', () => {
  it('a send under way fails as "may have sent", at once, and isn\'t sent again', async () => {
    withBridge();
    const client = await connectedClient();
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockImplementation(silent);
    const send = requestOf(client)([['EmailSubmission/set', { accountId: 'acct-1', create: { s: {} } }, '0']]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    reset();
    await expect(send).rejects.toBeInstanceOf(RequestTimeoutError);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(fetch, 'the client retries other failures of a read after 1 s: never this').toHaveBeenCalledTimes(1);
  });

  it('a read under way fails too, and nothing waits for its deadline', async () => {
    withBridge();
    const client = await connectedClient();
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockImplementation(silent);
    const read = requestOf(client)([['Mailbox/get', { accountId: 'acct-1' }, '0']]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    reset();
    await expect(read).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it('a body still being read is caught as well', async () => {
    withBridge();
    const client = await connectedClient();
    vi.mocked(fetch).mockClear();
    let signal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      signal = init?.signal ?? undefined;
      return new Response('{}', { status: 200 });
    });
    await requestOf(client)([['Mailbox/get', { accountId: 'acct-1' }, '0']]).catch(() => {});
    expect(signal?.aborted).toBe(false);
    reset();
    expect(signal?.reason).toBeInstanceOf(RequestTimeoutError);
  });

  it('an upload under way fails the same way, not five minutes later', async () => {
    withBridge();
    UploadXHR.instances = [];
    vi.stubGlobal('XMLHttpRequest', UploadXHR);
    const upload = uploadClient().uploadBlob(new File(['x'], 'a.txt', { type: 'text/plain' }), { onProgress: () => {} });
    await vi.waitFor(() => expect(UploadXHR.instances).toHaveLength(1));
    reset();
    await expect(upload).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(UploadXHR.instances[0].abort).toHaveBeenCalledOnce();
    expect(UploadXHR.instances).toHaveLength(1);
  });

  it('nothing changes in a browser, where a deadline is all there is', async () => {
    const client = await connectedClient();
    vi.mocked(fetch).mockClear();
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(silent);
    const read = requestOf(client)([['Mailbox/get', { accountId: 'acct-1' }, '0']]);
    const failed = expect(read).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount(), 'only the deadline').toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await failed;
  });
});
