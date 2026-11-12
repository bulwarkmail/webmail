// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// A sign-in takes a provider's metadata only when it names the server it was
// fetched from as its issuer (RFC 8414 section 3.3). Otherwise a listed server
// could claim another listed server's issuer, or none at all, and receive the
// code that server issued together with its PKCE verifier, since the
// callback's `iss` is checked against that issuer. A provider on another host
// than the mail server is configured with its own issuer URL, which is then
// the discovery base, so it keeps working.

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

const TWO_SERVERS = [
  { id: 'honest', label: 'Honest', url: 'https://honest.example', oauth: { clientId: 'webmail' } },
  { id: 'other', label: 'Other', url: 'https://other.example', oauth: { clientId: 'webmail' } },
];
let config: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback?: unknown) => (key in config ? config[key] : fallback),
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
const KEYCLOAK = 'https://id.example/realms/mail';
const INTERNAL = 'http://stalwart:8080';
const PUBLIC_NAME = 'https://mail.example';

let tokenRequests: Array<{ host: string; path: string; body: string }>;
/** What other.example names as its issuer: honest.example's, or nothing at all. */
let otherIssuer: string | undefined;

/**
 * Each host is its own provider and names its discovery base as issuer;
 * other.example names `otherIssuer`. id.example is an identity provider with a
 * realm path, as Keycloak publishes it.
 */
function providers(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  // A Stalwart reached by an internal address publishes its public name,
  // or (bare) no issuer at all.
  if (url.pathname.includes('/.well-known/') && (url.host === 'stalwart:8080' || url.host === 'bare:8080')) {
    return Promise.resolve(Response.json({
      ...(url.host === 'stalwart:8080' ? { issuer: PUBLIC_NAME } : {}),
      authorization_endpoint: `${PUBLIC_NAME}/authorize`,
      token_endpoint: `${PUBLIC_NAME}/token`,
      authorization_response_iss_parameter_supported: true,
    }));
  }
  if (url.pathname.includes('/.well-known/')) {
    const base = `${url.origin}${url.pathname.replace(/\/\.well-known\/.*$/, '')}`;
    return Promise.resolve(Response.json({
      issuer: url.host === 'other.example' ? otherIssuer : base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      authorization_response_iss_parameter_supported: true,
    }));
  }
  tokenRequests.push({ host: url.host, path: url.pathname, body: String(init?.body ?? '') });
  // The public Stalwart issues tokens; every other provider refuses the code.
  if (url.host === 'mail.example') return Promise.resolve(Response.json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }));
  return Promise.resolve(Response.json({ error: 'invalid_grant' }, { status: 400 }));
}

async function start(serverId: string | null) {
  const { POST } = await import('@/app/api/auth/sso/start/route');
  return POST(new NextRequest('https://webmail.example/api/auth/sso/start', {
    method: 'POST',
    headers: SAME_ORIGIN,
    body: JSON.stringify({ redirect_uri: CALLBACK, ...(serverId ? { server_id: serverId } : {}) }),
  }));
}

async function complete(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/auth/sso/complete/route');
  return POST(new NextRequest('https://webmail.example/api/auth/sso/complete', {
    method: 'POST',
    headers: SAME_ORIGIN,
    body: JSON.stringify(body),
  }));
}

async function exchange(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/auth/token/route');
  return POST(new NextRequest('https://webmail.example/api/auth/token', {
    method: 'POST',
    headers: SAME_ORIGIN,
    body: JSON.stringify({ code_verifier: 'v'.repeat(43), redirect_uri: CALLBACK, slot: 0, ...body }),
  }));
}

const codeSentTo = (host: string, code: string) => tokenRequests.filter((r) => r.host === host && r.body.includes(code));

// Every test loads the routes afresh (vi.resetModules), which takes a while.
vi.setConfig({ testTimeout: 30_000 });

describe("a listed server that claims another listed server's issuer in its metadata", () => {
  beforeEach(() => {
    vi.resetModules();
    jar = new Map();
    tokenRequests = [];
    config = { jmapServers: TWO_SERVERS };
    otherIssuer = 'https://honest.example';
    vi.stubGlobal('fetch', vi.fn(providers));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does not get the code honest.example issued when its metadata names no issuer at all', async () => {
    otherIssuer = undefined;
    const started = await start('other');
    const state = started.ok ? (await started.json()).state : 'none';
    await complete({ code: 'CODE-FROM-HONEST', state, iss: 'https://honest.example' });
    expect(codeSentTo('other.example', 'CODE-FROM-HONEST')).toEqual([]);
    expect(started.status).toBe(502);
  });

  it('does not get the code honest.example issued, through the server-side flow', async () => {
    const started = await start('other');
    const state = started.ok ? (await started.json()).state : 'none';
    // honest.example answers with its own iss, which is what other.example claims.
    await complete({ code: 'CODE-FROM-HONEST', state, iss: 'https://honest.example' });
    expect(codeSentTo('other.example', 'CODE-FROM-HONEST')).toEqual([]);
    expect(started.status).toBe(502);
  });

  it('does not get the code honest.example issued, through the page-driven exchange', async () => {
    const res = await exchange({ code: 'CODE-FROM-HONEST', server_id: 'other', iss: 'https://honest.example' });
    expect(codeSentTo('other.example', 'CODE-FROM-HONEST')).toEqual([]);
    expect(res.status).toBe(400);
    // Without iss, no token endpoint is taken from that metadata either.
    const quiet = await exchange({ code: 'CODE-FROM-HONEST', server_id: 'other' });
    expect(codeSentTo('other.example', 'CODE-FROM-HONEST')).toEqual([]);
    expect(quiet.ok).toBe(false);
  });

  it('keeps signing in at a server whose metadata names itself (control)', async () => {
    const started = await start('honest');
    expect(started.status).toBe(200);
    const { state } = await started.json();
    await complete({ code: 'CODE-FROM-HONEST', state, iss: 'https://honest.example' });
    expect(codeSentTo('honest.example', 'CODE-FROM-HONEST')).toHaveLength(1);
  });
});

describe('an identity provider on another host than the mail server', () => {
  beforeEach(() => {
    vi.resetModules();
    jar = new Map();
    tokenRequests = [];
    vi.stubGlobal('fetch', vi.fn(providers));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("signs in through a listed server's own issuer URL", async () => {
    config = { jmapServers: [{ id: 'mail', label: 'Mail', url: 'https://mail.example', oauth: { clientId: 'webmail', issuerUrl: KEYCLOAK } }] };
    const started = await start('mail');
    expect(started.status).toBe(200);
    const { state, authorize_url: authorizeUrl } = await started.json();
    expect(authorizeUrl.startsWith(`${KEYCLOAK}/authorize`)).toBe(true);
    await complete({ code: 'CODE-FROM-KEYCLOAK', state, iss: KEYCLOAK });
    expect(codeSentTo('id.example', 'CODE-FROM-KEYCLOAK')).toEqual([expect.objectContaining({ path: '/realms/mail/token' })]);
  });

  it('signs in through the configured issuer URL of the configured server, also page-driven', async () => {
    config = { jmapServerUrl: 'https://mail.example', oauthIssuerUrl: KEYCLOAK, oauthClientId: 'webmail' };
    const started = await start(null);
    expect(started.status).toBe(200);
    const { state } = await started.json();
    await complete({ code: 'CODE-SERVER-SIDE', state, iss: KEYCLOAK });
    expect(codeSentTo('id.example', 'CODE-SERVER-SIDE')).toHaveLength(1);

    await exchange({ code: 'CODE-PAGE-DRIVEN', iss: KEYCLOAK });
    expect(codeSentTo('id.example', 'CODE-PAGE-DRIVEN')).toHaveLength(1);
  });

  it('refuses the provider when the issuer URL points at the mail server instead of the provider', async () => {
    // mail.example's metadata names mail.example; an issuer URL set to it while
    // the codes come from id.example is a configuration that can't be checked.
    config = { jmapServerUrl: 'https://mail.example', oauthClientId: 'webmail' };
    const started = await start(null);
    expect(started.status).toBe(200);
    const { state } = await started.json();
    expect((await complete({ code: 'CODE-FROM-KEYCLOAK', state, iss: KEYCLOAK })).status).toBe(400);
    expect(tokenRequests).toEqual([]);
  });
});

// With one sign-in server there is no other server whose codes could be
// collected, so an issuer that differs from the discovery address is taken
// (and logged once). With a second one the issuer URL has to name it.
describe('a mail server reached by an internal address whose metadata names its public name', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  const logged = (spy: ReturnType<typeof vi.spyOn>): string[] => spy.mock.calls.map((call: unknown[]) => String(call[0]));
  beforeEach(() => {
    vi.resetModules();
    jar = new Map();
    tokenRequests = [];
    vi.stubGlobal('fetch', vi.fn(providers));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    warn.mockRestore();
    error.mockRestore();
  });

  it('signs in on an install with only that server, and says once which setting would name the issuer', async () => {
    config = { jmapServerUrl: INTERNAL, oauthClientId: 'webmail' };
    const started = await start(null);
    expect(started.status).toBe(200);
    const { state } = await started.json();
    expect((await complete({ code: 'CODE-SERVER-SIDE', state, iss: PUBLIC_NAME })).status).toBe(200);
    expect(codeSentTo('mail.example', 'CODE-SERVER-SIDE')).toHaveLength(1);

    expect((await exchange({ code: 'CODE-PAGE-DRIVEN', iss: PUBLIC_NAME })).status).toBe(200);
    expect(codeSentTo('mail.example', 'CODE-PAGE-DRIVEN')).toHaveLength(1);

    const notes = logged(warn).filter((line) => line.includes('OAUTH_ISSUER_URL'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(PUBLIC_NAME);
    expect(notes[0]).toContain('oauth.issuerUrl');
  });

  it('still refuses metadata that names no issuer on such an install', async () => {
    config = { jmapServerUrl: 'http://bare:8080', oauthClientId: 'webmail' };
    expect((await start(null)).status).toBe(502);
    expect((await exchange({ code: 'CODE-BARE' })).ok).toBe(false);
    expect(tokenRequests).toEqual([]);
  });

  it('refuses it beside a second listed server until the issuer URL names the issuer, and tells the admin which setting to set', async () => {
    const second = { id: 'other', label: 'Other', url: 'https://other.example', oauth: { clientId: 'webmail' } };
    config = { jmapServerUrl: INTERNAL, oauthClientId: 'webmail', jmapServers: [second] };
    expect((await start(null)).status).toBe(502);
    expect((await exchange({ code: 'CODE-REFUSED', iss: PUBLIC_NAME })).ok).toBe(false);
    expect(tokenRequests).toEqual([]);
    const refusal = logged(error).find((line) => line.includes(INTERNAL));
    expect(refusal).toContain('OAUTH_ISSUER_URL');
    expect(refusal).toContain('oauthIssuerUrl');
    expect(refusal).toContain('oauth.issuerUrl');
    expect(refusal).toContain(PUBLIC_NAME);

    // With the issuer URL set to the public name, discovery runs against it.
    vi.resetModules();
    config = { jmapServerUrl: INTERNAL, oauthIssuerUrl: PUBLIC_NAME, oauthClientId: 'webmail', jmapServers: [second] };
    const started = await start(null);
    expect(started.status).toBe(200);
    const { state } = await started.json();
    expect((await complete({ code: 'CODE-WITH-ISSUER-URL', state, iss: PUBLIC_NAME })).status).toBe(200);
    expect(codeSentTo('mail.example', 'CODE-WITH-ISSUER-URL')).toHaveLength(1);
  });
});
