// @vitest-environment node
import diagnostics from 'node:diagnostics_channel';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

import {
  PER_REQUEST_MAX_BYTES,
  UNCOUNTED_MAX_BYTES,
  bodyBudgetBytes,
  bodyWeight,
  createBodyBudget,
  type BodyBudget,
} from '@/lib/security/request-body-budget';

// Next copies the body of every request proxy.ts runs for into memory, up to
// 10 MB each, before any check. Requests that start such a body and never
// finish it held that memory with no limit on their number.

const MB = 1024 * 1024;

describe('bodyWeight', () => {
  const post = (headers: IncomingMessage['headers'], url = '/api/auth/session') => bodyWeight('POST', url, headers);

  it('counts what Next may copy: the announced length, at most 10 MB', () => {
    expect(post({ 'content-length': String(2 * MB) })).toBe(2 * MB);
    expect(post({ 'content-length': String(10 * MB) })).toBe(PER_REQUEST_MAX_BYTES);
    expect(post({ 'content-length': String(500 * MB) })).toBe(PER_REQUEST_MAX_BYTES);
  });

  it('counts a body without an announced length in full', () => {
    expect(post({ 'transfer-encoding': 'chunked' })).toBe(PER_REQUEST_MAX_BYTES);
    // Both headers: the length is not what will arrive.
    expect(post({ 'transfer-encoding': 'chunked', 'content-length': '10' })).toBe(PER_REQUEST_MAX_BYTES);
  });

  it('counts a length that is not a number in full', () => {
    expect(post({ 'content-length': '1e9' })).toBe(PER_REQUEST_MAX_BYTES);
    expect(post({ 'content-length': '-1' })).toBe(PER_REQUEST_MAX_BYTES);
    expect(post({ 'content-length': '9'.repeat(40) })).toBe(PER_REQUEST_MAX_BYTES);
  });

  it('does not count small bodies, requests without one, or methods without one', () => {
    expect(post({ 'content-length': '0' })).toBe(0);
    expect(post({ 'content-length': '300' })).toBe(0);
    expect(post({ 'content-length': String(UNCOUNTED_MAX_BYTES) })).toBe(0);
    expect(post({ 'content-length': String(UNCOUNTED_MAX_BYTES + 1) })).toBe(UNCOUNTED_MAX_BYTES + 1);
    expect(post({})).toBe(0);
    expect(bodyWeight('GET', '/api/config', { 'content-length': String(5 * MB) })).toBe(0);
    expect(bodyWeight('head', '/', { 'transfer-encoding': 'chunked' })).toBe(0);
    expect(bodyWeight(undefined, undefined, { 'content-length': String(5 * MB) })).toBe(0);
  });

  it('does not count the routes the proxy is skipped for, with a base path too', () => {
    const big = { 'content-length': String(8 * MB) };
    expect(post(big, '/api/webdav')).toBe(0);
    expect(post(big, '/api/plugin-proxy?x=1')).toBe(0);
    expect(post(big, '/api/wopi/files/abc/contents')).toBe(0);
    expect(post(big, '/webmail/api/webdav')).toBe(0);
  });

  it('counts a path that only looks like one of them', () => {
    const big = { 'content-length': String(8 * MB) };
    expect(post(big, '/api/webdav/x')).toBe(8 * MB);
    expect(post(big, '/api/settings?next=/api/webdav')).toBe(8 * MB);
    expect(post(big, '/api/wopi/files/a/b/contents')).toBe(8 * MB);
    // Next skips the proxy only when the raw and the decoded path both match.
    expect(post(big, '/api/settings%2F..%2Fwebdav')).toBe(8 * MB);
    expect(post(big, '/api/wopi/files/a%2Fb/contents')).toBe(8 * MB);
  });
});

describe('bodyBudgetBytes', () => {
  it('defaults to 128 MB, takes whole megabytes, and 0 turns it off', () => {
    expect(bodyBudgetBytes(undefined)).toBe(128 * MB);
    expect(bodyBudgetBytes('')).toBe(128 * MB);
    expect(bodyBudgetBytes('32')).toBe(32 * MB);
    expect(bodyBudgetBytes('0')).toBeNull();
  });

  it.each(['-1', '1.5', 'lots', ' '])('keeps the default for %j', (value) => {
    expect(bodyBudgetBytes(value)).toBe(128 * MB);
  });
});

// A real HTTP server whose requests pass the budget on Node's own
// diagnostics channel, as instrumentation.node.ts wires it.
interface Harness {
  port: number;
  budget: BodyBudget;
  /** Requests the server's own listener was handed, by URL. */
  seen: string[];
  /** Body bytes the listener read, by URL. */
  read: Map<string, number>;
  /** The connections the server accepted. */
  sockets: Set<net.Socket>;
  close(): Promise<void>;
}

const open: Harness[] = [];

async function harness(budgetBytes: number | null): Promise<Harness> {
  const budget = createBodyBudget({ budgetBytes: () => budgetBytes });
  const seen: string[] = [];
  const read = new Map<string, number>();
  const sockets = new Set<net.Socket>();
  const server = http.createServer((request, response) => {
    sockets.add(request.socket);
    seen.push(request.url ?? '');
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      read.set(request.url ?? '', bytes);
    });
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end(`read ${bytes}`);
    });
    request.on('error', () => {});
  });
  const onStart = (message: unknown) => {
    const { request, response, server: source } = message as { request: IncomingMessage; response: ServerResponse; server: http.Server };
    if (source === server) budget.admit(request, response);
  };
  diagnostics.subscribe('http.server.request.start', onStart);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const h: Harness = {
    port: (server.address() as AddressInfo).port,
    budget,
    seen,
    read,
    sockets,
    close: () =>
      new Promise<void>((resolve) => {
        diagnostics.unsubscribe('http.server.request.start', onStart);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  open.push(h);
  return h;
}

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

/** Send the head of a POST and `sent` bytes of its body, then leave the connection open. */
function partial(port: number, path: string, declared: number, sent: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${declared}\r\n\r\n`);
      if (sent > 0) socket.write(Buffer.alloc(sent, 0x41));
      // Let the server parse the head before the test goes on.
      setTimeout(() => resolve(socket), 50);
    });
    socket.on('error', reject);
  });
}

/** Everything the server answered on a socket, once it closed the connection. */
function answer(socket: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    socket.on('data', (chunk) => (text += chunk.toString()));
    socket.on('close', () => resolve(text));
    socket.on('error', () => resolve(text));
  });
}

async function post(port: number, path: string, size: number): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: Buffer.alloc(size, 0x41) });
  return { status: response.status, body: await response.text() };
}

const until = async (condition: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
};

describe('request body budget on a live server', () => {
  it('serves complete requests of any size and gives the reservation back', async () => {
    const h = await harness(32 * MB);
    expect(await post(h.port, '/api/settings', 2 * MB)).toEqual({ status: 200, body: `read ${2 * MB}` });
    expect(await post(h.port, '/api/auth/session', 200)).toEqual({ status: 200, body: 'read 200' });
    await until(() => h.budget.reserved() === 0);
    expect(h.budget.reserved()).toBe(0);
    expect(h.budget.refused()).toBe(0);
  });

  it('refuses the request that would take unfinished bodies over the budget, and reads none of it', async () => {
    const h = await harness(32 * MB);
    // Three requests that each start a 10 MB body and stop one byte short.
    const held = [];
    for (let i = 0; i < 3; i++) held.push(await partial(h.port, `/api/auth/verify?n=${i}`, 10 * MB, 1024));
    expect(h.budget.reserved()).toBe(30 * MB);

    const fourth = await partial(h.port, '/api/auth/verify?n=3', 10 * MB, 1024);
    const text = await answer(fourth);
    expect(text.startsWith('HTTP/1.1 503 ')).toBe(true);
    expect(text).toContain('Retry-After: 5');
    expect(text).toContain('Connection: close');
    expect(h.budget.reserved()).toBe(30 * MB);
    expect(h.budget.refused()).toBe(1);
    expect(h.read.get('/api/auth/verify?n=3') ?? 0).toBe(0);

    for (const socket of held) socket.destroy();
  });

  it('keeps serving small requests while the budget is used up', async () => {
    const h = await harness(32 * MB);
    const held = [];
    for (let i = 0; i < 3; i++) held.push(await partial(h.port, `/api/auth/verify?n=${i}`, 10 * MB, 1024));
    expect(await post(h.port, '/api/auth/session', 300)).toEqual({ status: 200, body: 'read 300' });
    expect(await post(h.port, '/api/account/stalwart/jmap', UNCOUNTED_MAX_BYTES)).toEqual({ status: 200, body: `read ${UNCOUNTED_MAX_BYTES}` });
    expect(h.budget.refused()).toBe(0);
    for (const socket of held) socket.destroy();
  });

  it('frees the reservation when a client drops its unfinished request', async () => {
    const h = await harness(32 * MB);
    const held = [];
    for (let i = 0; i < 3; i++) held.push(await partial(h.port, `/api/auth/verify?n=${i}`, 10 * MB, 1024));
    for (const socket of held) socket.destroy();
    await until(() => h.budget.reserved() === 0);
    expect(h.budget.reserved()).toBe(0);
    // Room again for a large upload.
    expect(await post(h.port, '/api/settings', 2 * MB)).toEqual({ status: 200, body: `read ${2 * MB}` });
  });

  it('counts the requests of one keep-alive connection one after the other', async () => {
    const h = await harness(32 * MB);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const send = () =>
      new Promise<number>((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: h.port, path: '/api/settings', method: 'POST', agent }, (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        });
        request.on('error', reject);
        request.end(Buffer.alloc(20 * MB, 0x41));
      });
    // 20 MB each, counted as 10: five in a row would be 50 MB if none were given back.
    for (let i = 0; i < 5; i++) expect(await send()).toBe(200);
    expect(h.sockets.size).toBe(1);
    agent.destroy();
    await until(() => h.budget.reserved() === 0);
    expect(h.budget.reserved()).toBe(0);
    expect(h.budget.refused()).toBe(0);
  });

  it('leaves no listener behind on a connection that serves many uploads', async () => {
    const h = await harness(32 * MB);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const send = () =>
      new Promise<number>((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: h.port, path: '/api/settings', method: 'POST', agent }, (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        });
        request.on('error', reject);
        request.end(Buffer.alloc(200 * 1024, 0x41));
      });
    expect(await send()).toBe(200);
    const [socket] = [...h.sockets];
    const before = socket.listenerCount('close');
    // More than Node's default of ten listeners per event.
    for (let i = 0; i < 15; i++) expect(await send()).toBe(200);
    expect(h.sockets.size).toBe(1);
    expect(socket.listenerCount('close')).toBe(before);
    agent.destroy();
  });

  it('does not count the routes that stream their uploads', async () => {
    const h = await harness(32 * MB);
    const held = [];
    for (let i = 0; i < 6; i++) held.push(await partial(h.port, '/api/webdav', 10 * MB, 1024));
    expect(h.budget.reserved()).toBe(0);
    expect(h.budget.refused()).toBe(0);
    for (const socket of held) socket.destroy();
  });

  it('does nothing when it is turned off', async () => {
    const h = await harness(null);
    const held = [];
    for (let i = 0; i < 6; i++) held.push(await partial(h.port, '/api/auth/verify', 10 * MB, 1024));
    expect(h.budget.reserved()).toBe(0);
    expect(h.budget.refused()).toBe(0);
    expect(h.seen.length).toBe(6);
    for (const socket of held) socket.destroy();
  });
});
