/**
 * api.http.eventSource on the host: the same origins as http.fetch, the
 * events of a text/event-stream handed to the frame that subscribed, a
 * dropped connection opened again, and the connection closed with the
 * subscription, its frame or its plugin.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { EventStreamMsg } from '../plugin-sandbox/protocol';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall } from '../plugin-sandbox/host-api';
import {
  closeEventStreamsOf, closePluginEventStreams, eventStreamCount, EventStreamParser, openEventStream,
  DEFAULT_RETRY_MS, MAX_EVENT_CHARS, MAX_EVENT_STREAMS_PER_PLUGIN,
} from '../plugin-sandbox/event-streams';

function plugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'p1',
    name: 'Test plugin',
    version: '1.0.0',
    author: 'test',
    description: '',
    type: 'hook',
    permissions: ['http:fetch'],
    grantedPermissions: ['http:fetch'],
    httpOrigins: ['https://api.example.com'],
    entrypoint: 'index.js',
    enabled: true,
    status: 'running',
    settings: {},
    ...overrides,
  };
}

const URL_OK = 'https://api.example.com/events';

/** A frame: what the host posted to it, and whether it is gone. */
function frame() {
  const sent: EventStreamMsg[] = [];
  return {
    sent,
    closed: false,
    sendEventStream(msg: EventStreamMsg) { sent.push(msg); },
    events: () => sent.map((m) => m.event),
  };
}

/** A server's event stream the test writes to and ends. */
function stream(url = URL_OK, init: ResponseInit = {}) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const res = new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' }, ...init });
  Object.defineProperty(res, 'url', { value: url });
  const encoder = new TextEncoder();
  return {
    res,
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    drop: () => controller.error(new Error('connection reset')),
  };
}

function answer(status: number, url = URL_OK, headers: Record<string, string> = {}): Response {
  const res = new Response(status === 204 ? null : 'no', { status, headers });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

let ids = 0;
const nextId = () => `stream${String(++ids).padStart(4, '0')}`;

function open(sink: ReturnType<typeof frame>, opts: { url?: string; headers?: Record<string, string>; plugin?: InstalledPlugin; streamId?: string } = {}) {
  const streamId = opts.streamId ?? nextId();
  return dispatchApiCall(opts.plugin ?? plugin(), 'http.openEventStream', [opts.url ?? URL_OK, { headers: opts.headers, streamId }], { eventSink: sink })
    .then(() => streamId);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  closePluginEventStreams('p1');
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Let the host's pending reads and timers of the next `ms` run. */
const pass = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe('EventStreamParser', () => {
  it('reads events with a name, several data lines, comments and an id', () => {
    const parser = new EventStreamParser();
    const events = parser.feed(': hello\n\nevent: ringing\ndata: one\ndata: two\nid: 7\n\ndata:plain\n\n');
    expect(events).toEqual([
      { type: 'ringing', data: 'one\ntwo', lastEventId: '7' },
      { type: 'message', data: 'plain', lastEventId: '7' },
    ]);
    expect(parser.lastEventId).toBe('7');
  });

  it('takes LF, CR and CRLF line ends, also when a chunk splits one', () => {
    const parser = new EventStreamParser();
    expect(parser.feed('﻿data: a\r')).toEqual([]);
    expect(parser.feed('\n\r\ndata: b\r\rdata: c')).toEqual([
      { type: 'message', data: 'a', lastEventId: '' },
      { type: 'message', data: 'b', lastEventId: '' },
    ]);
    expect(parser.feed('\n\n')).toEqual([{ type: 'message', data: 'c', lastEventId: '' }]);
  });

  it('sends no event without data, and keeps the retry time', () => {
    const parser = new EventStreamParser();
    expect(parser.feed('event: ping\n\nretry: 5000\nretry: soon\n\n')).toEqual([]);
    expect(parser.retry).toBe(5000);
  });

  it('refuses an event larger than the cap', () => {
    const parser = new EventStreamParser();
    expect(() => parser.feed('data: ' + 'x'.repeat(MAX_EVENT_CHARS))).toThrow(/larger than/);
  });
});

describe('http.eventSource', () => {
  it('hands the frame each event the server sends, without asking again', async () => {
    const s = stream();
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => s.res);
    vi.stubGlobal('fetch', fetchSpy);
    const sink = frame();

    await open(sink, { headers: { Authorization: 'Bearer t', Cookie: 'no', Accept: 'text/html' } });
    await pass();
    s.write('event: ringing\ndata: [1]\n\n');
    await pass();
    s.write('event: ringing\ndata: []\n\n');
    await pass();

    expect(sink.events()).toEqual([
      { kind: 'open' },
      { kind: 'event', type: 'ringing', data: '[1]', lastEventId: '' },
      { kind: 'event', type: 'ringing', data: '[]', lastEventId: '' },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1];
    expect(init.headers).toEqual({ Authorization: 'Bearer t', Accept: 'text/event-stream' });
    expect(init.credentials).toBe('omit');
  });

  it('refuses an origin that is not in the allowlist, as http.fetch does', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const sink = frame();

    await expect(open(sink, { url: 'https://evil.example/events' })).rejects.toThrow(/not in plugin httpOrigins/);
    await expect(open(sink, { plugin: plugin({ httpOrigins: [] }) })).rejects.toThrow(/no httpOrigins declared/);
    await expect(open(sink, { plugin: plugin({ grantedPermissions: [], permissions: [] }) })).rejects.toThrow(/lacks permission "http:fetch"/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(eventStreamCount('p1')).toBe(0);
  });

  it('gives up when a redirect leads off the allowlist', async () => {
    const s = stream('https://mail.example.org/events');
    vi.stubGlobal('fetch', vi.fn(async () => s.res));
    const sink = frame();

    await open(sink);
    await pass(DEFAULT_RETRY_MS * 10);

    expect(sink.events()).toEqual([
      { kind: 'error', message: expect.stringMatching(/redirected to https:\/\/mail\.example\.org/), closed: true },
    ]);
    expect(eventStreamCount('p1')).toBe(0);
  });

  it('opens a dropped connection again, with the last event id', async () => {
    const first = stream();
    const second = stream();
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(first.res)
      .mockResolvedValueOnce(second.res);
    vi.stubGlobal('fetch', fetchSpy);
    const sink = frame();

    await open(sink);
    await pass();
    first.write('id: 41\ndata: a\n\n');
    await pass();
    first.drop();
    await pass();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await pass(DEFAULT_RETRY_MS);
    second.write('data: b\n\n');
    await pass();

    expect(sink.events()).toEqual([
      { kind: 'open' },
      { kind: 'event', type: 'message', data: 'a', lastEventId: '41' },
      { kind: 'error', message: 'connection reset', closed: false },
      { kind: 'open' },
      { kind: 'event', type: 'message', data: 'b', lastEventId: '41' },
    ]);
    expect(fetchSpy.mock.calls[1][1].headers).toMatchObject({ 'Last-Event-ID': '41' });
  });

  it('reconnects after the server ends the stream, a 503 or a network error, waiting longer each time', async () => {
    const first = stream();
    const last = stream();
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(first.res)
      .mockResolvedValueOnce(answer(503))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(last.res);
    vi.stubGlobal('fetch', fetchSpy);
    const sink = frame();

    await open(sink);
    await pass();
    first.end();
    await pass(DEFAULT_RETRY_MS);          // the server ended it: the plain wait
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await pass(DEFAULT_RETRY_MS);          // first failure: the plain wait again
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    await pass(DEFAULT_RETRY_MS);          // second failure in a row: twice as long
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    await pass(DEFAULT_RETRY_MS);
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    expect(sink.events()).toEqual([
      { kind: 'open' },
      { kind: 'error', message: 'The server closed the connection', closed: false },
      { kind: 'error', message: 'The server answered 503', status: 503, closed: false },
      { kind: 'error', message: 'Failed to fetch', closed: false },
      { kind: 'open' },
    ]);
  });

  it('waits as long as the server asks with retry:', async () => {
    const first = stream();
    const fetchSpy = vi.fn().mockResolvedValueOnce(first.res).mockResolvedValue(stream().res);
    vi.stubGlobal('fetch', fetchSpy);

    await open(frame());
    await pass();
    first.write('retry: 20000\n\n');
    await pass();
    first.end();
    await pass(19_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await pass(1000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('gives up on an answer the plugin has to deal with', async () => {
    for (const [res, error] of [
      [answer(401), { kind: 'error', message: 'The server answered 401', status: 401, closed: true }],
      [answer(204), { kind: 'error', message: 'The server answered 204', status: 204, closed: true }],
      [answer(200, URL_OK, { 'content-type': 'application/json' }), { kind: 'error', message: 'The answer is not a text/event-stream', status: 200, closed: true }],
    ] as const) {
      const fetchSpy = vi.fn(async () => res);
      vi.stubGlobal('fetch', fetchSpy);
      const sink = frame();

      await open(sink);
      await pass(DEFAULT_RETRY_MS * 10);

      expect(sink.events()).toEqual([error]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(eventStreamCount('p1')).toBe(0);
    }
  });

  it('closes the connection when the plugin closes the subscription', async () => {
    const s = stream();
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => s.res);
    vi.stubGlobal('fetch', fetchSpy);
    const sink = frame();

    const streamId = await open(sink);
    await pass();
    await dispatchApiCall(plugin(), 'http.closeEventStream', [streamId], { eventSink: sink });
    expect(fetchSpy.mock.calls[0][1].signal!.aborted).toBe(true);
    expect(eventStreamCount('p1')).toBe(0);
    await pass(DEFAULT_RETRY_MS * 10);

    expect(sink.events()).toEqual([{ kind: 'open' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('closes a frame\'s connections when the frame goes, and no other frame\'s', async () => {
    const mine = stream();
    const other = stream();
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(mine.res)
      .mockResolvedValueOnce(other.res);
    vi.stubGlobal('fetch', fetchSpy);
    const gone = frame();
    const stays = frame();

    await open(gone);
    await open(stays);
    await pass();
    gone.closed = true;
    closeEventStreamsOf(gone);
    await pass(DEFAULT_RETRY_MS * 10);

    expect(fetchSpy.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetchSpy.mock.calls[1][1].signal.aborted).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(eventStreamCount('p1')).toBe(1);
    other.write('data: still\n\n');
    await pass();
    expect(stays.events()).toContainEqual({ kind: 'event', type: 'message', data: 'still', lastEventId: '' });
    expect(gone.events()).toEqual([{ kind: 'open' }]);
  });

  it('closes every connection of a plugin that is turned off', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => stream().res);
    vi.stubGlobal('fetch', fetchSpy);

    await open(frame());
    await open(frame());
    await pass();
    closePluginEventStreams('p1');

    expect(fetchSpy.mock.calls.every((c) => c[1].signal!.aborted)).toBe(true);
    expect(eventStreamCount('p1')).toBe(0);
  });

  it('holds only so many connections for one plugin', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => stream().res));
    const sink = frame();

    for (let i = 0; i < MAX_EVENT_STREAMS_PER_PLUGIN; i++) await open(sink);
    await expect(open(sink)).rejects.toThrow(/At most/);
  });

  it('refuses headers fetch would refuse, once, instead of retrying', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(open(frame(), { headers: { 'bad name': 'x' } })).rejects.toThrow(/Invalid headers/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('http.eventSource against a server', () => {
  let server: Server | null = null;

  afterEach(async () => {
    closePluginEventStreams('p1');
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)));
    server = null;
  });

  it('receives a real server\'s events and comes back after the server cuts the connection', async () => {
    vi.useRealTimers();
    const asked: (string | undefined)[] = [];
    server = createServer((req, res) => {
      asked.push(req.headers['last-event-id'] as string | undefined);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      if (asked.length === 1) {
        res.write('retry: 1000\nid: 1\nevent: ringing\ndata: [1]\n\n');
        setTimeout(() => res.destroy(), 50);
      } else {
        res.write(': heartbeat\n\nid: 2\nevent: ringing\ndata: []\n\n');
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/events`);
    const sink = frame();

    openEventStream('p1', url, () => true, { streamId: nextId(), headers: { Authorization: 'Bearer t' } }, sink);
    await vi.waitFor(() => expect(sink.events().filter((e) => e.kind === 'event')).toHaveLength(2), { timeout: 10_000 });

    expect(sink.events().filter((e) => e.kind !== 'error')).toEqual([
      { kind: 'open' },
      { kind: 'event', type: 'ringing', data: '[1]', lastEventId: '1' },
      { kind: 'open' },
      { kind: 'event', type: 'ringing', data: '[]', lastEventId: '2' },
    ]);
    expect(sink.events().filter((e) => e.kind === 'error')).toEqual([expect.objectContaining({ closed: false })]);
    expect(asked).toEqual([undefined, '1']);
  }, 15_000);
});
