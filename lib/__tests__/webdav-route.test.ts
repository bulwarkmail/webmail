import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// ── module mocks (hoisted) ───────────────────────────────────────────────────
vi.mock('next/server', () => {
  class NextResponse {
    body: unknown;
    status: number;
    headers: Headers;
    constructor(body: unknown, init?: { status?: number; headers?: Headers }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = init?.headers ?? new Headers();
    }
    static json(data: unknown, init?: { status?: number }) {
      return { status: init?.status ?? 200, headers: new Headers(), json: async () => data };
    }
  }
  return { NextResponse, NextRequest: class {} };
});
vi.mock('@/lib/logger', () => ({ logger: { error: () => {}, warn: () => {}, debug: () => {} } }));
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: vi.fn() }));

import { POST } from '@/app/api/webdav/route';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { endlessResponse } from './helpers/endless-body';

const mockCreds = getStalwartCredentials as unknown as Mock;
const CREDS = { serverUrl: 'https://mail.example.com', username: 'user@example.com', authHeader: 'Basic abc' };

type Resp = { status: number; headers: Headers; body?: unknown; text?: () => Promise<string> };
let fetchSpy: Mock;

function makeReq(headers: Record<string, string> = {}, body: unknown = null): Parameters<typeof POST>[0] {
  const lc: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lc[k.toLowerCase()] = v;
  return {
    headers: { get: (n: string) => lc[n.toLowerCase()] ?? null },
    arrayBuffer: async () => new ArrayBuffer(0),
    body,
  } as unknown as Parameters<typeof POST>[0];
}

// The route returns either our mocked NextResponse instance or NextResponse.json's object.
function read(res: unknown): { status: number; headers?: Headers; json?: () => Promise<unknown>; body?: unknown } {
  return res as { status: number; headers?: Headers; json?: () => Promise<unknown>; body?: unknown };
}

beforeEach(() => {
  mockCreds.mockResolvedValue(CREDS);
  fetchSpy = vi.fn(async (): Promise<Resp> => ({
    status: 207,
    headers: new Headers({ 'Content-Type': 'text/plain' }),
    body: 'UPSTREAM-BODY',
    text: async () => '<xml/>',
  }));
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('POST /api/webdav — guards', () => {
  it('401 when there are no credentials', async () => {
    mockCreds.mockResolvedValue(null);
    const res = read(await POST(makeReq({ 'X-WebDAV-Method': 'GET' })));
    expect(res.status).toBe(401);
    await expect(res.json!()).resolves.toEqual({ error: 'Not authenticated' });
  });

  it('400 for a missing or disallowed method', async () => {
    expect(read(await POST(makeReq({}))).status).toBe(400);
    const res = read(await POST(makeReq({ 'X-WebDAV-Method': 'BOGUS' })));
    expect(res.status).toBe(400);
    await expect(res.json!()).resolves.toEqual({ error: 'Invalid WebDAV method' });
  });

  it('400 on a path-traversal segment', async () => {
    const res = read(await POST(makeReq({ 'X-WebDAV-Method': 'PROPFIND', 'X-WebDAV-Path': '../etc' })));
    expect(res.status).toBe(400);
    await expect(res.json!()).resolves.toEqual({ error: 'Invalid WebDAV path segment' });
  });

  it('400 on bad percent-encoding in the path', async () => {
    const res = read(await POST(makeReq({ 'X-WebDAV-Method': 'PUT', 'X-WebDAV-Path': '%zz' })));
    expect(res.status).toBe(400);
    await expect(res.json!()).resolves.toEqual({ error: 'Invalid WebDAV path encoding' });
  });
});

describe('POST /api/webdav — proxying', () => {
  it('GET builds the upstream URL, forwards auth, and streams the body back', async () => {
    const res = read(await POST(makeReq({ 'X-WebDAV-Method': 'get', 'X-WebDAV-Path': 'file.txt' })));
    const target = 'https://mail.example.com/dav/file/user%40example.com/file.txt';
    expect(fetchSpy).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Basic abc' }) }),
    );
    expect(res.status).toBe(207);
    expect(res.body).toBe('UPSTREAM-BODY');
    expect(res.headers!.get('Content-Type')).toBe('text/plain');
    expect(res.headers!.get('X-WebDAV-Request-URI')).toBe(target);
  });

  it('PROPFIND forwards Depth and returns XML', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('<xml/>', { status: 207 }));
    const res = read(await POST(makeReq({ 'X-WebDAV-Method': 'PROPFIND', 'X-WebDAV-Path': 'dir', Depth: '1' })));
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://mail.example.com/dav/file/user%40example.com/dir',
      expect.objectContaining({ method: 'PROPFIND', headers: expect.objectContaining({ Depth: '1' }) }),
    );
    expect(res.status).toBe(207);
    expect(res.body).toBe('<xml/>');
    expect(res.headers!.get('Content-Type')).toBe('application/xml; charset=utf-8');
  });

  it('PROPFIND refuses a request body over 1 MB without sending it on', async () => {
    const big = endlessResponse(50);
    const req = { ...makeReq({ 'X-WebDAV-Method': 'PROPFIND', 'X-WebDAV-Path': 'dir' }), body: big.response.body };
    const res = read(await POST(req as unknown as Parameters<typeof POST>[0]));
    expect(res.status).toBe(413);
    expect(big.pulled()).toBeLessThan(5);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('PROPFIND answers 502 instead of buffering a listing that never ends', async () => {
    const { response, pulled } = endlessResponse(500, { status: 207 });
    fetchSpy.mockResolvedValueOnce(response);
    const res = read(await POST(makeReq({ 'X-WebDAV-Method': 'PROPFIND', 'X-WebDAV-Path': 'dir', Depth: '1' })));
    expect(res.status).toBe(502);
    expect(pulled()).toBeLessThan(60);
  });

  it('MOVE rebuilds the Destination URL and forwards Overwrite', async () => {
    await POST(makeReq({
      'X-WebDAV-Method': 'MOVE',
      'X-WebDAV-Path': 'old.txt',
      'X-WebDAV-Destination': 'sub/new.txt',
      Overwrite: 'F',
    }));
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://mail.example.com/dav/file/user%40example.com/old.txt',
      expect.objectContaining({
        method: 'MOVE',
        headers: expect.objectContaining({
          Destination: 'https://mail.example.com/dav/file/user%40example.com/sub/new.txt',
          Overwrite: 'F',
        }),
      }),
    );
  });
});

describe('POST /api/webdav — calendar collections (#760)', () => {
  it('MKCALENDAR targets the cal root and forwards the XML body', async () => {
    const res = read(await POST(makeReq({
      'X-WebDAV-Method': 'MKCALENDAR',
      'X-WebDAV-Collection': 'cal',
      'X-WebDAV-Path': 'abc123',
      'Content-Type': 'application/xml; charset=utf-8',
    })));
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://mail.example.com/dav/cal/user%40example.com/abc123',
      expect.objectContaining({
        method: 'MKCALENDAR',
        headers: expect.objectContaining({ Authorization: 'Basic abc', 'Content-Type': 'application/xml; charset=utf-8' }),
        body: expect.any(ArrayBuffer),
      }),
    );
    expect(res.status).toBe(207);
  });

  it('defaults to the file root when no collection header is given', async () => {
    await POST(makeReq({ 'X-WebDAV-Method': 'MKCOL', 'X-WebDAV-Path': 'dir' }));
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://mail.example.com/dav/file/user%40example.com/dir',
      expect.objectContaining({ method: 'MKCOL' }),
    );
  });

  it('400 on an unknown collection', async () => {
    const res = read(await POST(makeReq({ 'X-WebDAV-Method': 'PROPFIND', 'X-WebDAV-Collection': 'card' })));
    expect(res.status).toBe(400);
    await expect(res.json!()).resolves.toEqual({ error: 'Invalid WebDAV collection' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
