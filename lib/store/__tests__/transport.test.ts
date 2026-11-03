// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchTransport, TransportError, type StoreSession } from '../engine/transport';

const SESSION: StoreSession = {
  apiUrl: 'https://fake.test/jmap/',
  downloadUrl: 'https://fake.test/d/{accountId}/{blobId}/{name}?type={type}',
  uploadUrl: 'https://fake.test/u/{accountId}',
  primaryAccounts: {},
  accounts: {},
  capabilities: {},
};

type Pull = (controller: ReadableStreamDefaultController<Uint8Array>) => void | Promise<void>;

/** A response whose body comes as the test says, and that fails when the request is aborted, as fetch does. */
function bodyResponse(signal: AbortSignal | null | undefined, pull: Pull): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
    },
    pull,
  });
  return new Response(stream, { status: 200 });
}

function transportWith(respond: (init: RequestInit) => Response | Promise<Response>): FetchTransport {
  return new FetchTransport({
    session: () => SESSION,
    auth: () => 'Basic x',
    refreshAuth: async () => 'Basic x',
    fetch: (async (_url: string, init: RequestInit) => respond(init)) as unknown as typeof fetch,
  });
}

afterEach(() => vi.useRealTimers());

describe('downloads', () => {
  it('gives a body piece by piece and adds them up for a plain download', async () => {
    const parts = [new Uint8Array([1, 2]), new Uint8Array([3])];
    const open = () => transportWith((init) => {
      let i = 0;
      return bodyResponse(init.signal, (c) => {
        if (i < parts.length) c.enqueue(parts[i++]);
        else c.close();
      });
    });
    const seen: number[] = [];
    await open().downloadStream('a', 'b', 't', 'n', (part) => seen.push(part.length));
    expect(seen).toEqual([2, 1]);
    expect([...await open().download('a', 'b', 't', 'n')]).toEqual([1, 2, 3]);
  });

  it('turns a body that breaks into a TransportError saying so', async () => {
    const open = () => transportWith((init) => {
      let i = 0;
      return bodyResponse(init.signal, (c) => {
        if (i++ === 0) c.enqueue(new Uint8Array(1));
        else c.error(new TypeError('network error'));
      });
    });
    const broken = await open().download('a', 'b', 't', 'n').catch((e: unknown) => e);
    expect(broken).toBeInstanceOf(TransportError);
    expect(broken).toMatchObject({ kind: 'network', interrupted: true });
  });

  it('lets a slow download run past the old total limit while bytes keep coming', async () => {
    vi.useFakeTimers();
    let sent = 0;
    const transport = transportWith((init) => bodyResponse(init.signal, async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      if (sent++ < 10) c.enqueue(new Uint8Array(1));
      else c.close();
    }));
    let bytes = 0;
    const done = transport.downloadStream('a', 'b', 't', 'n', (part) => { bytes += part.length; });
    await vi.advanceTimersByTimeAsync(11 * 30_000);
    await done;
    expect(bytes).toBe(10);
  });

  it('gives up when no bytes come for a while, and says it was this download', async () => {
    vi.useFakeTimers();
    const transport = transportWith((init) => bodyResponse(init.signal, () => new Promise(() => {})));
    const done = transport.downloadStream('a', 'b', 't', 'n', () => {}).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await done).toMatchObject({ kind: 'network', interrupted: true });
  });

  it('lets an error from the sink through and stops reading', async () => {
    let cancelled = false;
    const transport = transportWith(() => new Response(new ReadableStream<Uint8Array>({
      pull: (c) => c.enqueue(new Uint8Array(1)),
      cancel: () => { cancelled = true; },
    })));
    const stop = new Error('over the limit');
    await expect(transport.downloadStream('a', 'b', 't', 'n', () => { throw stop; })).rejects.toBe(stop);
    expect(cancelled).toBe(true);
  });

  it('keeps a plain network failure apart from a broken download', async () => {
    const transport = transportWith(() => { throw new TypeError('Failed to fetch'); });
    const failed = await transport.downloadStream('a', 'b', 't', 'n', () => {}).catch((e: unknown) => e);
    expect(failed).toMatchObject({ kind: 'network' });
    expect((failed as TransportError).interrupted).toBeFalsy();
  });
});

describe('requests', () => {
  it('turns a broken response body into a TransportError', async () => {
    const transport = transportWith((init) => bodyResponse(init.signal, (c) => c.error(new TypeError('network error'))));
    const failed = await transport.request([['Core/echo', {}, '0']], ['urn:ietf:params:jmap:core']).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(TransportError);
    expect(failed).toMatchObject({ kind: 'network' });
  });
});

describe('abort', () => {
  it('ends what is running at once, and anything after it', async () => {
    const transport = transportWith((init) => bodyResponse(init.signal, () => new Promise(() => {})));
    const running = transport.downloadStream('a', 'b', 't', 'n', () => {}).catch((e: unknown) => e);
    const request = transport.request([['Core/echo', {}, '0']], ['x']).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 5));
    transport.abort();
    expect(await running).toBeInstanceOf(TransportError);
    expect(await request).toBeInstanceOf(TransportError);
    await expect(transport.download('a', 'b', 't', 'n')).rejects.toBeInstanceOf(TransportError);
  });
});
