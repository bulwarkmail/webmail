import { describe, it, expect, vi, beforeEach } from 'vitest';
import { endlessResponse } from './helpers/endless-body';

// #904: the Stalwart JMAP passthrough is registered unconditionally by Next,
// so the server-side switch has to answer 404 inside the handler - before any
// credential lookup or upstream request.

vi.mock('next/server', () => {
  class NextResponse {
    status: number;
    private body: string;
    constructor(body: string, init?: { status?: number }) {
      this.body = body;
      this.status = init?.status ?? 200;
    }
    async json() {
      return JSON.parse(this.body);
    }
    static json(data: unknown, init?: { status?: number }) {
      return new NextResponse(JSON.stringify(data), init);
    }
  }
  return { NextResponse };
});

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

const configValues: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    get: (key: string, def: unknown) => (key in configValues ? configValues[key] : def),
  },
}));

const getStalwartCredentials = vi.fn();
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: (...args: unknown[]) => getStalwartCredentials(...args),
}));

const postJmap = vi.fn();
vi.mock('@/lib/stalwart/jmap-api', () => ({
  JmapRedirectError: class JmapRedirectError extends Error {},
  fetchJmapSession: vi.fn(),
  postJmap: (...args: unknown[]) => postJmap(...args),
  rebaseApiUrl: vi.fn(),
}));

vi.mock('@/lib/security/url-guard', () => ({
  DisallowedUrlError: class DisallowedUrlError extends Error {},
}));

async function callRoute() {
  const { POST } = await import('@/app/api/account/stalwart/jmap/route');
  const request = {
    text: async () => JSON.stringify({ using: [], methodCalls: [] }),
    headers: { get: () => null },
    nextUrl: { searchParams: { get: () => null } },
  };
  const res = (await POST(request as unknown as Parameters<typeof POST>[0])) as unknown as {
    status: number;
    json: () => Promise<Record<string, unknown>>;
  };
  return { status: res.status, body: await res.json() };
}

describe('Stalwart JMAP passthrough switch (#904)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(configValues)) delete configValues[key];
    getStalwartCredentials.mockResolvedValue({
      serverUrl: 'https://mail.example.com',
      authHeader: 'Basic abc',
      trusted: true,
    });
    postJmap.mockResolvedValue(
      new Response(JSON.stringify({ methodResponses: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('returns 404 and never reads credentials or calls upstream when disabled', async () => {
    configValues.stalwartJmapPassthroughEnabled = false;

    const { status } = await callRoute();

    expect(status).toBe(404);
    expect(getStalwartCredentials).not.toHaveBeenCalled();
    expect(postJmap).not.toHaveBeenCalled();
  });

  it('treats disabled Stalwart features as disabling the passthrough too', async () => {
    configValues.stalwartFeaturesEnabled = false;

    const { status } = await callRoute();

    expect(status).toBe(404);
    expect(postJmap).not.toHaveBeenCalled();
  });

  it('proxies to the server by default', async () => {
    const { status } = await callRoute();

    expect(status).toBe(200);
    expect(postJmap).toHaveBeenCalledTimes(1);
    expect(postJmap.mock.calls[0][0]).toBe('https://mail.example.com/jmap/');
  });

  it('answers 502 instead of buffering an answer that never ends', async () => {
    const { response, pulled } = endlessResponse(500);
    postJmap.mockResolvedValueOnce(response);

    const { status } = await callRoute();

    expect(status).toBe(502);
    expect(pulled()).toBeLessThan(60);
  });
});
