import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('next/server', () => {
  class NextResponse {
    status: number;
    json: () => Promise<unknown>;
    constructor(body: unknown, init?: { status?: number }) {
      this.status = init?.status ?? 200;
      this.json = async () => body;
    }
    static json(data: unknown, init?: { status?: number }) {
      return new NextResponse(data, init);
    }
  }
  return { NextResponse };
});

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/oauth/cookie-config', () => ({
  getCookieOptions: () => ({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 2592000 }),
}));

vi.mock('@/lib/oauth/token-exchange', () => ({
  exchangeCodeForTokens: vi.fn(),
  buildOAuthParams: (params: Record<string, string>) => new URLSearchParams(params),
  getMetadata: vi.fn().mockResolvedValue(null),
  getTokenEndpoint: vi.fn().mockResolvedValue('https://auth.example.com/token'),
  DEFAULT_CLIENT_ID: 'bulwark-webmail',
}));

/** In-memory stand-in for the Next.js cookie store, shared by concurrent requests like a browser jar. */
class FakeCookies {
  store = new Map<string, string>();
  deleted: string[] = [];
  get(name: string) {
    const value = this.store.get(name);
    return value === undefined ? undefined : { name, value };
  }
  set(name: string, value: string) { this.store.set(name, value); }
  delete(name: string) { this.deleted.push(name); this.store.delete(name); }
}

let cookieStore: FakeCookies;
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));

function mockRequest(params: Record<string, string> = {}): unknown {
  return {
    nextUrl: { searchParams: { get: (k: string) => params[k] ?? null } },
    headers: { get: () => null },
  };
}

type RouteResult = { status: number; json: () => Promise<Record<string, unknown> | null> };

async function callPut(params?: Record<string, string>) {
  const { PUT } = await import('@/app/api/auth/token/route');
  const res = (await PUT(mockRequest(params) as Parameters<typeof PUT>[0])) as unknown as RouteResult;
  return { status: res.status, body: (await res.json()) ?? {} };
}

/**
 * Fake IdP with one-time refresh tokens (PocketID, Keycloak with rotation,
 * Rauthy...): redeeming a refresh token rotates it and the old one is
 * rejected with invalid_grant from then on.
 */
function makeIdp() {
  let current = 'rt-1';
  let n = 1;
  const calls: string[] = [];
  const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const presented = new URLSearchParams(init?.body ?? '').get('refresh_token') ?? '';
    calls.push(presented);
    // Simulate network latency so concurrent requests overlap.
    await new Promise((r) => setTimeout(r, 5));
    if (presented !== current) {
      return { ok: false, status: 400, text: async () => 'invalid_grant', json: async () => ({ error: 'invalid_grant' }) };
    }
    n += 1;
    current = `rt-${n}`;
    return { ok: true, json: async () => ({ access_token: `at-${n}`, refresh_token: current, expires_in: 3600 }) };
  });
  return { fetchMock, calls, get current() { return current; } };
}

describe('oauth token route - concurrent and stale refreshes must not evict the slot', () => {
  beforeEach(() => {
    vi.resetModules();
    cookieStore = new FakeCookies();
    cookieStore.set('jmap_rt', 'rt-1');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('two forced refreshes racing on the same refresh token both succeed and redeem it once', async () => {
    const idp = makeIdp();
    vi.stubGlobal('fetch', idp.fetchMock);

    const [a, b] = await Promise.all([callPut({ force: 'true' }), callPut({ force: 'true' })]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.access_token).toBe('at-2');
    expect(b.body.access_token).toBe('at-2');
    expect(idp.calls).toEqual(['rt-1']);
    expect(cookieStore.get('jmap_rt')?.value).toBe('rt-2');
    expect(cookieStore.deleted).toEqual([]);
  });

  it('a refresh that arrives with the just-rotated token (other tab, slow cookie) gets the rotated result', async () => {
    const idp = makeIdp();
    vi.stubGlobal('fetch', idp.fetchMock);

    const first = await callPut({ force: 'true' });
    expect(first.body.access_token).toBe('at-2');

    // A second context still holds rt-1 in its request (cookie set after its
    // request was sent). The IdP would reject rt-1 now.
    cookieStore.set('jmap_rt', 'rt-1');
    const second = await callPut({ force: 'true' });

    expect(second.status).toBe(200);
    expect(second.body.access_token).toBe('at-2');
    expect(cookieStore.get('jmap_rt')?.value).toBe('rt-2');
    expect(cookieStore.deleted).toEqual([]);
    // The IdP is asked first and refuses; only then does the rotation record
    // answer. Deliberate: a replayed (stolen) token must still reach an IdP
    // whose reuse detection exists to catch it, even at the cost of a
    // sign-out when the IdP revokes the family.
    expect(idp.calls).toEqual(['rt-1', 'rt-1']);
  });

  it('a stale token presented while its refresh is still in flight joins that refresh', async () => {
    const idp = makeIdp();
    vi.stubGlobal('fetch', idp.fetchMock);

    const first = callPut({ force: 'true' });
    await new Promise((r) => setTimeout(r, 1)); // let the first request reach the IdP
    const second = await callPut({ force: 'true' });
    expect((await first).body.access_token).toBe('at-2');
    expect(second.body.access_token).toBe('at-2');
    expect(idp.calls).toEqual(['rt-1']);
  });

  it('a genuinely revoked refresh token is still rejected and its cookies dropped', async () => {
    const idp = makeIdp();
    vi.stubGlobal('fetch', idp.fetchMock);

    cookieStore.set('jmap_rt', 'rt-revoked');
    const { status } = await callPut({ force: 'true' });

    expect(status).toBe(401);
    expect(cookieStore.deleted).toContain('jmap_rt');
  });
});
