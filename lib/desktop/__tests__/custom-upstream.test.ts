import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A desktop account's refresh token belongs to a server only the app knows. A
 * TOTP or browser sign-in has to be able to refresh there, never at a configured
 * server, and never with a configured client secret.
 */

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

vi.mock('@/lib/oauth/cookie-config', () => ({
  getCookieOptions: () => ({ path: '/', maxAge: 2592000 }),
  getSignInCookieOptions: (remember: boolean) => ({ path: '/', ...(remember ? { maxAge: 2592000 } : {}) }),
}));

const config: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key in config ? config[key] : fallback),
  },
}));

vi.mock('@/lib/auth/crypto', () => ({
  encryptPayload: (payload: Record<string, unknown>) => JSON.stringify(payload),
  decryptPayload: (value: string) => JSON.parse(value),
}));

const isPublicHttpUrl = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/lib/security/url-guard', async (original) => ({
  ...(await original<object>()),
  isPublicHttpUrl,
}));

vi.mock('@/lib/stalwart/auth-context', () => ({
  clearStalwartAuthContextInStore: vi.fn(),
  readStalwartAuthContextFromStore: () => null,
}));

vi.setConfig({ testTimeout: 60_000 });

class FakeCookies {
  store = new Map<string, string>();
  get(name: string) {
    const value = this.store.get(name);
    return value === undefined ? undefined : { name, value };
  }
  set(name: string, value: string) {
    this.store.set(name, value);
  }
  delete(arg: string | { name: string }) {
    this.store.delete(typeof arg === 'string' ? arg : arg.name);
  }
}

let cookieStore: FakeCookies;
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));

const SERVER = 'https://mail.typed.example';
const CONFIGURED = 'https://configured.example';

const metadata = (base: string) => ({
  issuer: base,
  authorization_endpoint: `${base}/authorize`,
  token_endpoint: `${base}/auth/token`,
  revocation_endpoint: `${base}/auth/revoke`,
});

function stubUpstream(impl?: (url: string, body: string) => Response) {
  const calls: { url: string; body: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const base = new URL(url).origin;
    if (url.includes('/.well-known/')) return new Response(JSON.stringify(metadata(base)), { status: 200 });
    const body = String(init?.body ?? '');
    calls.push({ url, body });
    return impl ? impl(url, body) : new Response(JSON.stringify({ access_token: 'new-access', expires_in: 3600 }), { status: 200 });
  }));
  return calls;
}

function request(method: string, params: Record<string, string> = {}, body?: unknown): unknown {
  return {
    method,
    headers: new Headers({ 'sec-fetch-site': 'same-origin' }),
    nextUrl: { searchParams: new URLSearchParams(params), basePath: '' },
    json: async () => body,
  };
}

async function loadRoute() {
  vi.resetModules();
  return import('@/app/api/auth/token/route');
}

beforeEach(() => {
  cookieStore = new FakeCookies();
  for (const key of Object.keys(config)) delete config[key];
  isPublicHttpUrl.mockReset();
  isPublicHttpUrl.mockImplementation(async () => true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('PUT /api/auth/token in the desktop build', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    cookieStore.set('jmap_rt', 'refresh-1');
    cookieStore.set('jmap_rtu', JSON.stringify({ s: SERVER, c: 'client-from-register' }));
  });

  it('refreshes at the server of the record, with its client', async () => {
    const calls = stubUpstream();
    const { PUT } = await loadRoute();
    const res = (await PUT(request('PUT', { force: 'true' }) as Parameters<typeof PUT>[0])) as unknown as { status: number };
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${SERVER}/auth/token`);
    const sent = new URLSearchParams(calls[0].body);
    expect(sent.get('client_id')).toBe('client-from-register');
    expect(sent.get('refresh_token')).toBe('refresh-1');
  });

  it('goes to the record even with a configured server, and never sends its secret', async () => {
    config.jmapServerUrl = CONFIGURED;
    config.oauthClientId = 'configured-client';
    config.oauthClientSecret = 'configured-secret';
    const calls = stubUpstream();
    const { PUT } = await loadRoute();
    await PUT(request('PUT', { force: 'true' }) as Parameters<typeof PUT>[0]);
    expect(calls[0].url).toBe(`${SERVER}/auth/token`);
    const sent = new URLSearchParams(calls[0].body);
    expect(sent.get('client_secret')).toBeNull();
    expect(sent.get('client_id')).toBe('client-from-register');
  });

  it('answers 503, not 500, when the mail server is unreachable, so the session stays', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const { PUT } = await loadRoute();
    const res = (await PUT(request('PUT', { force: 'true' }) as Parameters<typeof PUT>[0])) as unknown as { status: number };
    expect(res.status).toBe(503);
    expect(cookieStore.get('jmap_rt')).toBeDefined();
  });

  it('refuses a record whose address no longer passes the guard', async () => {
    isPublicHttpUrl.mockImplementation(async () => false);
    const calls = stubUpstream();
    const { PUT } = await loadRoute();
    const res = (await PUT(request('PUT', { force: 'true' }) as Parameters<typeof PUT>[0])) as unknown as { status: number };
    expect(calls).toHaveLength(0);
    expect(res.status).toBe(503);
  });
});

describe('POST /api/auth/token in the desktop build', () => {
  const body = {
    code: 'code-1',
    code_verifier: 'verifier',
    redirect_uri: 'http://127.0.0.1:51234/bulwark-desktop/callback',
    slot: 2,
    custom_server_url: SERVER,
    client_id: 'client-from-register',
  };

  beforeEach(() => vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1'));

  it('exchanges at the typed server and leaves a record for the refresh', async () => {
    const calls = stubUpstream(() => new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }), { status: 200 }));
    const { POST } = await loadRoute();
    const res = (await POST(request('POST', {}, body) as Parameters<typeof POST>[0])) as unknown as { status: number };
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe(`${SERVER}/auth/token`);
    expect(new URLSearchParams(calls[0].body).get('redirect_uri')).toBe(body.redirect_uri);
    expect(JSON.parse(cookieStore.get('jmap_rtu_2')!.value)).toEqual({ s: SERVER, c: 'client-from-register' });
  });

  it('refuses a private address the user did not approve', async () => {
    isPublicHttpUrl.mockImplementation(async () => false);
    const calls = stubUpstream();
    const { POST } = await loadRoute();
    const res = (await POST(request('POST', {}, { ...body, custom_server_url: 'http://10.0.0.1' }) as Parameters<typeof POST>[0])) as unknown as { status: number };
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('sign-out revokes at the record and removes it', async () => {
    cookieStore.set('jmap_rt', 'refresh-1');
    cookieStore.set('jmap_rtu', JSON.stringify({ s: SERVER, c: 'client-from-register' }));
    const calls = stubUpstream();
    const { DELETE } = await loadRoute();
    await DELETE(request('DELETE') as Parameters<typeof DELETE>[0]);
    expect(calls.map((c) => c.url)).toEqual([`${SERVER}/auth/revoke`]);
    expect(cookieStore.get('jmap_rtu')).toBeUndefined();
    expect(cookieStore.get('jmap_rt')).toBeUndefined();
  });
});

describe('in a server build', () => {
  it('ignores a planted record and a custom_server_url', async () => {
    config.jmapServerUrl = CONFIGURED;
    config.oauthClientId = 'configured-client';
    cookieStore.set('jmap_rt', 'refresh-1');
    cookieStore.set('jmap_rtu', JSON.stringify({ s: SERVER, c: 'client-from-register' }));
    const calls = stubUpstream();
    const { PUT } = await loadRoute();
    await PUT(request('PUT', { force: 'true' }) as Parameters<typeof PUT>[0]);
    expect(calls[0].url).toBe(`${CONFIGURED}/auth/token`);
  });

  it('answers 503 when the provider cannot be reached, so the client waits it out', async () => {
    cookieStore.set('jmap_rt', 'refresh-1');
    stubUpstream();
    const { PUT } = await loadRoute();
    const res = (await PUT(request('PUT', { force: 'true' }) as Parameters<typeof PUT>[0])) as unknown as { status: number };
    expect(res.status).toBe(503);
  });
});
