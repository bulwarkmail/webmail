// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// With several servers on the list, one of them can pass the browser on to
// another server's sign-in page (same redirect URI, state and PKCE challenge).
// The callback names the issuer that answered (RFC 9207, `iss`); a code from
// another issuer than the one the sign-in was sent to is refused before the
// code or the PKCE verifier is sent anywhere.

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/security/url-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/url-guard')>()),
  isPublicHttpUrl: async () => true,
}));

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback?: unknown) => (key === 'jmapServers'
      ? [
          { id: 'honest', label: 'Honest', url: 'https://honest.example', oauth: { clientId: 'webmail' } },
          { id: 'other', label: 'Other', url: 'https://other.example', oauth: { clientId: 'webmail' } },
        ]
      : fallback),
    getPolicy: () => ({}),
  },
}));

let jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string | { name: string }) => { jar.delete(typeof name === 'string' ? name : name.name); },
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  }),
}));

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'content-type': 'application/json', origin: 'https://webmail.example' };
const CALLBACK = 'https://webmail.example/en/auth/callback';

/** Whether the providers advertise authorization_response_iss_parameter_supported. */
let issSupported = true;
let tokenRequests: Array<{ host: string; body: string }>;
function providers(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  if (url.pathname.startsWith('/.well-known/')) {
    return Promise.resolve(Response.json({
      issuer: url.origin,
      authorization_endpoint: `${url.origin}/authorize`,
      token_endpoint: `${url.origin}/auth/token`,
      ...(issSupported ? { authorization_response_iss_parameter_supported: true } : {}),
    }));
  }
  tokenRequests.push({ host: url.host, body: String(init?.body ?? '') });
  return Promise.resolve(Response.json({ error: 'invalid_grant' }, { status: 400 }));
}

async function startAt(serverId: string, extra: Record<string, unknown> = {}) {
  const { POST: start } = await import('@/app/api/auth/sso/start/route');
  const started = await start(new NextRequest('https://webmail.example/api/auth/sso/start', {
    method: 'POST',
    headers: SAME_ORIGIN,
    body: JSON.stringify({ redirect_uri: CALLBACK, server_id: serverId, ...extra }),
  }));
  const { state, authorize_url: authorizeUrl } = await started.json();
  expect(new URL(authorizeUrl).host).toBe(`${serverId}.example`);
  return state as string;
}

async function complete(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/auth/sso/complete/route');
  return POST(new NextRequest('https://webmail.example/api/auth/sso/complete', {
    method: 'POST',
    headers: SAME_ORIGIN,
    body: JSON.stringify(body),
  }));
}

const codeSentTo = (host: string, code: string) => tokenRequests.filter((r) => r.host === host && r.body.includes(code));

describe('an authorization code from another issuer than the one the sign-in started with', () => {
  beforeEach(() => {
    vi.resetModules();
    jar = new Map();
    tokenRequests = [];
    issSupported = true;
    vi.stubGlobal('fetch', vi.fn(providers));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is not sent to the server the sign-in started with', async () => {
    const state = await startAt('other');

    // other.example sends the browser on to honest.example's sign-in page with the same
    // redirect URI, state and challenge. honest.example signs the user in and answers
    //   https://webmail.example/en/auth/callback?code=CODE-FROM-HONEST&state=...&iss=https://honest.example
    const res = await complete({ code: 'CODE-FROM-HONEST', state, iss: 'https://honest.example' });

    expect(tokenRequests.filter((r) => r.host === 'other.example' && r.body.includes('CODE-FROM-HONEST'))).toEqual([]);
    expect(tokenRequests).toEqual([]);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('is sent on when the issuer is the one asked, with or without a trailing slash (control)', async () => {
    let state = await startAt('other');
    await complete({ code: 'CODE-FROM-OTHER', state, iss: 'https://other.example' });
    expect(codeSentTo('other.example', 'CODE-FROM-OTHER')).toHaveLength(1);

    state = await startAt('other');
    await complete({ code: 'CODE-FROM-OTHER-2', state, iss: 'https://other.example/' });
    expect(codeSentTo('other.example', 'CODE-FROM-OTHER-2')).toHaveLength(1);
  });

  it('keeps working with a provider that never sends iss', async () => {
    issSupported = false;
    const state = await startAt('other');
    await complete({ code: 'CODE-NO-ISS', state });
    expect(codeSentTo('other.example', 'CODE-NO-ISS')).toHaveLength(1);
  });

  it('refuses a mobile hand-off whose callback lacks the iss its provider sends', async () => {
    const verifier = 'm'.repeat(64);
    const state = await startAt('other', {
      mobile_redirect_uri: 'bulwarkmobile://auth/callback',
      mobile_state: 'app-state',
      mobile_code_challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url'),
    });
    const res = await complete({ code: 'CODE-HANDOFF', state });
    expect(res.status).toBe(400);
    expect(tokenRequests).toEqual([]);
  });

  it('refuses a pairing step-up answered by another issuer, or without the iss its provider sends', async () => {
    const { POST: reauthComplete } = await import('@/app/api/auth/reauth/sso/complete/route');
    const reauth = (body: Record<string, unknown>) => reauthComplete(new NextRequest('https://webmail.example/api/auth/reauth/sso/complete', {
      method: 'POST',
      headers: SAME_ORIGIN,
      body: JSON.stringify(body),
    }));

    let state = await startAt('other', { purpose: 'reauth', slot: 0 });
    expect((await reauth({ code: 'CODE-FROM-HONEST', state, iss: 'https://honest.example' })).status).toBe(400);

    state = await startAt('other', { purpose: 'reauth', slot: 0 });
    expect((await reauth({ code: 'CODE-NO-ISS', state })).status).toBe(400);
    expect(tokenRequests).toEqual([]);
  });

  it('refuses a page-driven code exchange whose iss is another server', async () => {
    const { POST: exchange } = await import('@/app/api/auth/token/route');
    const res = await exchange(new NextRequest('https://webmail.example/api/auth/token', {
      method: 'POST',
      headers: SAME_ORIGIN,
      body: JSON.stringify({ code: 'CODE-FROM-HONEST', code_verifier: 'v'.repeat(43), redirect_uri: CALLBACK, server_id: 'other', slot: 0, iss: 'https://honest.example' }),
    }));
    expect(res.status).toBe(400);
    expect(tokenRequests).toEqual([]);

    // The issuer asked: on to its token endpoint.
    await exchange(new NextRequest('https://webmail.example/api/auth/token', {
      method: 'POST',
      headers: SAME_ORIGIN,
      body: JSON.stringify({ code: 'CODE-FROM-OTHER', code_verifier: 'v'.repeat(43), redirect_uri: CALLBACK, server_id: 'other', slot: 0, iss: 'https://other.example' }),
    }));
    expect(codeSentTo('other.example', 'CODE-FROM-OTHER')).toHaveLength(1);
  });
});
