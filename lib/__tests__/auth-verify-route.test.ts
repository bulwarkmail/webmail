import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      json: async () => data,
      status: init?.status ?? 200,
    }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

const config: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key in config ? config[key] : fallback),
  },
}));

const TRUSTED = 'https://mail.example.com';

function mockRequest(body: unknown): unknown {
  return {
    json: async () => body,
    headers: { get: () => null },
    nextUrl: { searchParams: new URLSearchParams() },
  };
}

async function callRoute(body: unknown) {
  const { POST } = await import('@/app/api/auth/verify/route');
  const res = (await POST(mockRequest(body) as Parameters<typeof POST>[0])) as unknown as {
    json: () => Promise<{ result?: string; error?: string }>;
    status: number;
  };
  return { status: res.status, body: await res.json() };
}

function upstream(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

describe('POST /api/auth/verify (#969 login pre-check)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of Object.keys(config)) delete config[k];
    config.jmapServerUrl = TRUSTED;
    vi.resetModules();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('reports a definitive 401 from the JMAP server as unauthorized', async () => {
    fetchSpy.mockResolvedValue(upstream(401) as unknown as Response);

    const { status, body } = await callRoute({ serverUrl: TRUSTED, username: 'alice', password: 'wrong' });

    expect(status).toBe(200);
    expect(body).toEqual({ result: 'unauthorized' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${TRUSTED}/.well-known/jmap`);
    expect((init.headers as Record<string, string>).Authorization)
      .toBe(`Basic ${Buffer.from('alice:wrong').toString('base64')}`);
  });

  it('reports ok when the session fetch succeeds', async () => {
    fetchSpy.mockResolvedValue(upstream(200, { apiUrl: `${TRUSTED}/jmap`, accounts: { a: {} } }) as unknown as Response);

    const { body } = await callRoute({ serverUrl: TRUSTED, username: 'alice', password: 'right' });

    expect(body).toEqual({ result: 'ok' });
  });

  it.each([
    ['network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['5xx outage', () => Promise.resolve(upstream(503) as unknown as Response)],
    ['TOTP challenge (402)', () => Promise.resolve(upstream(402, { title: 'MFA code required' }) as unknown as Response)],
    ['403', () => Promise.resolve(upstream(403) as unknown as Response)],
  ])('is inconclusive on %s so the browser-side connect still decides', async (_label, impl) => {
    fetchSpy.mockImplementation(impl as typeof fetch);

    const { status, body } = await callRoute({ serverUrl: TRUSTED, username: 'alice', password: 'pw' });

    expect(status).toBe(200);
    expect(body).toEqual({ result: 'inconclusive' });
  });

  it('is inconclusive for a server URL that is neither configured nor allowed as custom', async () => {
    const { body } = await callRoute({ serverUrl: 'https://other.example.net', username: 'alice', password: 'pw' });

    expect(body).toEqual({ result: 'inconclusive' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is inconclusive when only OAuth logins are allowed', async () => {
    config.oauthEnabled = true;
    config.oauthOnly = true;

    const { body } = await callRoute({ serverUrl: TRUSTED, username: 'alice', password: 'pw' });

    expect(body).toEqual({ result: 'inconclusive' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects requests with missing fields', async () => {
    const { status } = await callRoute({ serverUrl: TRUSTED, username: 'alice' });
    expect(status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
