import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// ── module mocks (hoisted) ───────────────────────────────────────────────────
vi.mock('next/server', () => {
  class NextResponse {
    status: number;
    headers: Headers;
    body: unknown;
    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
    }
    static json(data: unknown, init?: { status?: number }) {
      const res = new NextResponse(data, init);
      return Object.assign(res, { json: async () => data });
    }
  }
  return { NextResponse, NextRequest: class {} };
});
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: vi.fn() }));

const guardedFetch = vi.fn();
vi.mock('@/lib/security/url-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/url-guard')>();
  return {
    ...actual,
    fetchPublicUrl: (...args: unknown[]) => guardedFetch(...args),
  };
});

import { POST } from '@/app/api/fetch-ical/route';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { DisallowedUrlError } from '@/lib/security/url-guard';

const mockCreds = getStalwartCredentials as unknown as Mock;

type RouteResponse = { status: number; headers: Headers; body: unknown; json?: () => Promise<unknown> };

function makeReq(body: unknown): Parameters<typeof POST>[0] {
  return { method: 'POST', headers: new Headers(), json: async () => body } as unknown as Parameters<typeof POST>[0];
}

function ics(status = 200, headers: Record<string, string> = {}) {
  return new Response('BEGIN:VCALENDAR\nEND:VCALENDAR\n', {
    status,
    headers: { 'content-type': 'text/calendar', ...headers },
  });
}

describe('POST /api/fetch-ical', () => {
  beforeEach(() => {
    mockCreds.mockReset();
    guardedFetch.mockReset();
    mockCreds.mockResolvedValue({ serverUrl: 'https://mail.example.com', authHeader: 'Basic x', username: 'u' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('response size limit (#692)', () => {
    const bigBody = 'X'.repeat(26 * 1024 * 1024); // above the 25 MB default

    it('returns 413 with the limit in the message for an over-limit body', async () => {
      guardedFetch.mockResolvedValueOnce(new Response(bigBody, { status: 200, headers: { 'content-type': 'text/calendar' } }));
      const res = (await POST(makeReq({ url: 'https://calendar.example.com/feed.ics' }))) as unknown as RouteResponse;
      expect(res.status).toBe(413);
      await expect(res.json?.()).resolves.toEqual({ error: expect.stringMatching(/25 MB limit.*ICAL_MAX_BYTES/) });
    });

    it('honours ICAL_MAX_BYTES to raise the cap', async () => {
      vi.stubEnv('ICAL_MAX_BYTES', String(30 * 1024 * 1024));
      guardedFetch.mockResolvedValueOnce(new Response(bigBody, { status: 200, headers: { 'content-type': 'text/calendar' } }));
      const res = (await POST(makeReq({ url: 'https://calendar.example.com/feed.ics' }))) as unknown as RouteResponse;
      expect(res.status).toBe(200);
    });

    it('honours ICAL_MAX_BYTES to lower the cap via content-length', async () => {
      vi.stubEnv('ICAL_MAX_BYTES', '1024');
      guardedFetch.mockResolvedValueOnce(ics(200, { 'content-length': '4096' }));
      const res = (await POST(makeReq({ url: 'https://calendar.example.com/feed.ics' }))) as unknown as RouteResponse;
      expect(res.status).toBe(413);
    });
  });

  it('rejects unauthenticated callers before touching the network', async () => {
    mockCreds.mockResolvedValue(null);
    const res = (await POST(makeReq({ url: 'https://calendar.example.com/feed.ics' }))) as unknown as RouteResponse;
    expect(res.status).toBe(401);
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it('fetches through the rebinding-safe fetch and returns the calendar body', async () => {
    guardedFetch.mockResolvedValueOnce(ics());
    const res = (await POST(makeReq({ url: 'https://calendar.example.com/feed.ics' }))) as unknown as RouteResponse;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar');
    expect(Buffer.from(res.body as ArrayBuffer).toString()).toContain('BEGIN:VCALENDAR');
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    expect(guardedFetch).toHaveBeenCalledWith(
      'https://calendar.example.com/feed.ics',
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': 'JMAP-Webmail/1.0 Calendar-Fetcher' }) }),
    );
  });

  it('returns 400 when the guard rejects the initial URL', async () => {
    guardedFetch.mockRejectedValueOnce(new DisallowedUrlError('http://169.254.169.254/'));
    const res = (await POST(makeReq({ url: 'http://169.254.169.254/latest/meta-data/' }))) as unknown as RouteResponse;
    expect(res.status).toBe(400);
    await expect(res.json?.()).resolves.toEqual({ error: 'Invalid or disallowed URL' });
  });

  it('passes redirect targets back through the guard and rejects a disallowed hop', async () => {
    guardedFetch
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/internal.ics' } }))
      .mockRejectedValueOnce(new DisallowedUrlError('http://10.0.0.5/internal.ics'));
    const res = (await POST(makeReq({ url: 'https://calendar.example.com/feed.ics' }))) as unknown as RouteResponse;
    expect(res.status).toBe(400);
    await expect(res.json?.()).resolves.toEqual({ error: 'Redirect to disallowed URL' });
    expect(guardedFetch).toHaveBeenCalledTimes(2);
    expect(guardedFetch.mock.calls[1][0]).toBe('http://10.0.0.5/internal.ics');
  });

  it('follows an allowed redirect and only sends Basic auth to the original origin', async () => {
    guardedFetch
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: 'https://cdn.example.net/feed.ics' } }))
      .mockResolvedValueOnce(ics());
    const res = (await POST(makeReq({ url: 'https://user:pw@calendar.example.com/feed.ics' }))) as unknown as RouteResponse;
    expect(res.status).toBe(200);
    const [firstUrl, firstInit] = guardedFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    const [secondUrl, secondInit] = guardedFetch.mock.calls[1] as [string, { headers: Record<string, string> }];
    expect(firstUrl).toBe('https://calendar.example.com/feed.ics');
    expect(firstInit.headers.Authorization).toBe(`Basic ${Buffer.from('user:pw').toString('base64')}`);
    expect(secondUrl).toBe('https://cdn.example.net/feed.ics');
    expect(secondInit.headers.Authorization).toBeUndefined();
  });

  it('maps a non-2xx upstream to 502', async () => {
    guardedFetch.mockResolvedValueOnce(ics(404));
    const res = (await POST(makeReq({ url: 'https://calendar.example.com/missing.ics' }))) as unknown as RouteResponse;
    expect(res.status).toBe(502);
  });
});
