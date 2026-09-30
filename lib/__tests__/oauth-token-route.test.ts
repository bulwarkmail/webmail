import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture status from NextResponse.json - this route's behavior is expressed
// almost entirely through status codes and cookie side effects.
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
  getCookieOptions: () => ({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 2592000 }),
}));

const getTokenEndpoint = vi.fn();
const buildOAuthParams = vi.fn();
const getMetadata = vi.fn();
const getRequiredConfig = vi.fn();
const exchangeCodeForTokens = vi.fn();
vi.mock('@/lib/oauth/token-exchange', () => ({
  exchangeCodeForTokens: (...args: unknown[]) => exchangeCodeForTokens(...args),
  buildOAuthParams: (...args: unknown[]) => buildOAuthParams(...args),
  getMetadata: (...args: unknown[]) => getMetadata(...args),
  getRequiredConfig: (...args: unknown[]) => getRequiredConfig(...args),
  getTokenEndpoint: (...args: unknown[]) => getTokenEndpoint(...args),
  DEFAULT_CLIENT_ID: 'bulwark-webmail',
}));

let configValues: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    get: (key: string, fallback?: unknown) => (key in configValues ? configValues[key] : fallback),
  },
}));

/** Minimal in-memory stand-in for the Next.js cookie store. */
class FakeCookies {
  store = new Map<string, string>();
  options = new Map<string, Record<string, unknown> | undefined>();
  deleted: string[] = [];
  deletedPaths = new Map<string, string | undefined>();
  get(name: string) {
    const value = this.store.get(name);
    return value === undefined ? undefined : { name, value };
  }
  set(name: string, value: string, opts?: Record<string, unknown>) {
    this.store.set(name, value);
    this.options.set(name, opts);
  }
  delete(arg: string | { name: string; path?: string }) {
    const name = typeof arg === 'string' ? arg : arg.name;
    this.deleted.push(name);
    this.deletedPaths.set(name, typeof arg === 'string' ? undefined : arg.path);
    this.store.delete(name);
  }
}

let cookieStore: FakeCookies;
vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
}));

function mockRequest(params: Record<string, string> = {}, method = 'PUT', body?: unknown): unknown {
  return {
    method,
    headers: { get: () => null },
    nextUrl: { searchParams: { get: (k: string) => params[k] ?? null }, basePath: '' },
    json: async () => body,
  };
}

async function callPut(params?: Record<string, string>) {
  const { PUT } = await import('@/app/api/auth/token/route');
  const res = (await PUT(mockRequest(params) as Parameters<typeof PUT>[0])) as unknown as {
    status: number;
    json: () => Promise<Record<string, unknown>>;
  };
  return { status: res.status, body: await res.json() };
}

/** Seed the access-token cache cookie with a token expiring in `expiresIn` seconds. */
function seedCachedToken(token: string, expiresIn: number, name = 'jmap_at') {
  cookieStore.set(name, `${Math.floor(Date.now() / 1000) + expiresIn}.${token}`);
}

const fetchMock = vi.fn();

describe('oauth token route - access token cache (#552)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieStore = new FakeCookies();
    getTokenEndpoint.mockResolvedValue('https://auth.example.com/token');
    buildOAuthParams.mockReturnValue(new URLSearchParams({ grant_type: 'refresh_token' }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serves the cached access token without contacting the IdP', async () => {
    cookieStore.set('jmap_rt', 'refresh-token');
    seedCachedToken('cached-access-token', 1500);

    const { status, body } = await callPut();

    expect(status).toBe(200);
    expect(body.access_token).toBe('cached-access-token');
    // The whole point: no refresh is spent, so an nbf-gated IdP never sees an
    // early redemption attempt.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports remaining lifetime, not the original lifetime', async () => {
    cookieStore.set('jmap_rt', 'refresh-token');
    seedCachedToken('cached-access-token', 900);

    const { body } = await callPut();

    // Client schedules its renewal off this value; handing back the full
    // lifetime would push the timer past the token's actual expiry.
    expect(body.expires_in as number).toBeGreaterThan(880);
    expect(body.expires_in as number).toBeLessThanOrEqual(900);
  });

  it('refreshes for real once the cached token is inside the renewal margin', async () => {
    cookieStore.set('jmap_rt', 'refresh-token');
    seedCachedToken('nearly-expired', 30);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'fresh-token', expires_in: 1800 }),
    });

    const { status, body } = await callPut();

    expect(status).toBe(200);
    expect(body.access_token).toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never follows a redirect with the refresh token in the body', async () => {
    cookieStore.set('jmap_rt', 'refresh-token');
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'fresh-token', expires_in: 1800 }),
    });

    await callPut();

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error' });
  });

  it('keeps the refresh token when the token endpoint redirects', async () => {
    cookieStore.set('jmap_rt', 'refresh-token');
    fetchMock.mockRejectedValue(new TypeError('fetch failed: unexpected redirect'));

    const { status } = await callPut();

    expect(status).toBe(500);
    expect(cookieStore.get('jmap_rt')).toBeTruthy();
  });

  it('ignores an expired cached token', async () => {
    cookieStore.set('jmap_rt', 'refresh-token');
    seedCachedToken('long-gone', -600);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'fresh-token', expires_in: 1800 }),
    });

    const { body } = await callPut();

    expect(body.access_token).toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bypasses the cache when force=true', async () => {
    cookieStore.set('jmap_rt', 'refresh-token');
    seedCachedToken('rejected-by-jmap', 1500);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'fresh-token', expires_in: 1800 }),
    });

    const { body } = await callPut({ force: 'true' });

    // A token the resource server rejected must not be handed back again.
    expect(body.access_token).toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches the newly minted token after a real refresh', async () => {
    cookieStore.set('jmap_rt', 'refresh-token');
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'fresh-token', expires_in: 1800 }),
    });

    await callPut();

    expect(cookieStore.get('jmap_at')?.value).toMatch(/^\d+\.fresh-token$/);
  });

  it('preserves dots inside a JWT access token', async () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl';
    cookieStore.set('jmap_rt', 'refresh-token');
    seedCachedToken(jwt, 1500);

    const { body } = await callPut();

    expect(body.access_token).toBe(jwt);
  });

  it('uses slot-scoped cache cookies', async () => {
    cookieStore.set('jmap_rt_2', 'refresh-token');
    seedCachedToken('slot-two-token', 1500, 'jmap_at_2');

    const { body } = await callPut({ slot: '2' });

    expect(body.access_token).toBe('slot-two-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops the cached token when the IdP definitively rejects the refresh', async () => {
    cookieStore.set('jmap_rt', 'refresh-token');
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'invalid_grant',
    });

    const { status } = await callPut({ force: 'true' });

    expect(status).toBe(401);
    expect(cookieStore.deleted).toContain('jmap_at');
    expect(cookieStore.deleted).toContain('jmap_rt');
  });

  it('keeps the cached token when the token endpoint is merely unavailable', async () => {
    cookieStore.set('jmap_rt', 'refresh-token');
    seedCachedToken('still-good', 1500);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'upstream down',
    });

    const { status } = await callPut({ force: 'true' });

    expect(status).toBe(503);
    // An outage must not cost the user their session.
    expect(cookieStore.deleted).not.toContain('jmap_at');
    expect(cookieStore.deleted).not.toContain('jmap_rt');
  });

  it('refreshes with the default client id fallback so TOTP sessions survive reloads (#873)', async () => {
    cookieStore.set('jmap_rt', 'totp-minted-refresh-token');
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'fresh-token', expires_in: 1800 }),
    });

    const { status } = await callPut({ force: 'true' });

    expect(status).toBe(200);
    // Tokens minted by the TOTP login route exist even when no OAuth client is
    // configured; the refresh must offer the same default client id instead of
    // failing on the missing OAUTH_CLIENT_ID.
    expect(getTokenEndpoint).toHaveBeenCalledWith(null, { fallbackClientId: 'bulwark-webmail' });
    expect(buildOAuthParams).toHaveBeenCalledWith(
      { grant_type: 'refresh_token', refresh_token: 'totp-minted-refresh-token' },
      null,
      { fallbackClientId: 'bulwark-webmail' },
    );
  });

  it('does not serve a cached token once the refresh token is gone', async () => {
    seedCachedToken('orphan-token', 1500);

    const { status } = await callPut();

    expect(status).toBe(401);
    expect(cookieStore.deleted).toContain('jmap_at');
  });
});

// --- RP-initiated logout (#905) ---------------------------------------------

const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzaWQiOiJzZXNzaW9uLTEifQ.c2ln';

const KEYCLOAK = {
  issuer: 'https://id.example.com/realms/mail',
  authorization_endpoint: 'https://id.example.com/realms/mail/protocol/openid-connect/auth',
  token_endpoint: 'https://id.example.com/realms/mail/protocol/openid-connect/token',
  revocation_endpoint: 'https://id.example.com/realms/mail/protocol/openid-connect/revoke',
  end_session_endpoint: 'https://id.example.com/realms/mail/protocol/openid-connect/logout',
};

async function callRoute(
  method: 'POST' | 'DELETE',
  params: Record<string, string> = {},
  body?: unknown,
) {
  const route = await import('@/app/api/auth/token/route');
  const handler = route[method];
  const res = (await handler(mockRequest(params, method, body) as Parameters<typeof handler>[0])) as unknown as {
    status: number;
    json: () => Promise<Record<string, unknown>>;
  };
  return { status: res.status, body: await res.json() };
}

function endSessionParams(url: unknown): URLSearchParams {
  expect(typeof url).toBe('string');
  return new URL(url as string).searchParams;
}

describe('oauth token route - sign-in keeps the id token (#905)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieStore = new FakeCookies();
    configValues = {};
  });

  it('stores the id token, scoped to the token route', async () => {
    exchangeCodeForTokens.mockResolvedValue({ access_token: 'at', expires_in: 300, refresh_token: 'rt', id_token: ID_TOKEN });

    await callRoute('POST', {}, { code: 'c', code_verifier: 'v', redirect_uri: 'https://mail.example.com/en/auth/callback', slot: 1 });

    expect(cookieStore.get('jmap_idt_1')?.value).toBe(ID_TOKEN);
    // Kept off every other request, so several accounts' id tokens cannot
    // push the Cookie header past the server's limit.
    expect(cookieStore.options.get('jmap_idt_1')?.path).toBe('/api/auth/token');
  });

  it('does not store an id token too large for a cookie', async () => {
    exchangeCodeForTokens.mockResolvedValue({ access_token: 'at', expires_in: 300, id_token: 'x'.repeat(5000) });
    cookieStore.set('jmap_idt', 'stale');

    await callRoute('POST', {}, { code: 'c', code_verifier: 'v', redirect_uri: 'https://mail.example.com/en/auth/callback' });

    expect(cookieStore.get('jmap_idt')).toBeUndefined();
  });

  // Sizes of a stock Keycloak realm's tokens.
  it('stores the id token beside tokens of a typical size', async () => {
    exchangeCodeForTokens.mockResolvedValue({
      access_token: 'a'.repeat(1130), expires_in: 300, refresh_token: 'r'.repeat(650), id_token: 'i'.repeat(1080),
    });

    await callRoute('POST', {}, { code: 'c', code_verifier: 'v', redirect_uri: 'https://mail.example.com/en/auth/callback' });

    expect(cookieStore.get('jmap_idt')?.value).toBe('i'.repeat(1080));
  });

  it('leaves the id token out when the response would outgrow a proxy header buffer (#1096)', async () => {
    // A Keycloak realm with roles and a groups claim: together the three
    // cookies exceed nginx's default 4 KB proxy_buffer_size, and the
    // sign-in failed with 502.
    exchangeCodeForTokens.mockResolvedValue({
      access_token: 'a'.repeat(1700), expires_in: 300, refresh_token: 'r'.repeat(650), id_token: 'i'.repeat(1300),
    });
    cookieStore.set('jmap_idt', 'stale');

    const { status } = await callRoute('POST', {}, { code: 'c', code_verifier: 'v', redirect_uri: 'https://mail.example.com/en/auth/callback' });

    expect(status).toBe(200);
    expect(cookieStore.get('jmap_idt')).toBeUndefined();
    expect(cookieStore.get('jmap_rt')?.value).toBe('r'.repeat(650));
    expect(cookieStore.get('jmap_at')?.value).toMatch(/^\d+\.a+$/);
  });
});

describe('oauth token route - refresh keeps the id token current (#905)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieStore = new FakeCookies();
    configValues = {};
    getTokenEndpoint.mockResolvedValue(KEYCLOAK.token_endpoint);
    buildOAuthParams.mockReturnValue(new URLSearchParams({ grant_type: 'refresh_token' }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('replaces the stored id token with a reissued one', async () => {
    cookieStore.set('jmap_rt', 'rt');
    cookieStore.set('jmap_idt', 'old-id-token');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'at', expires_in: 300, id_token: ID_TOKEN }) });

    await callPut({ force: 'true' });

    expect(cookieStore.get('jmap_idt')?.value).toBe(ID_TOKEN);
  });

  it('forgets the id token when a reissued one would outgrow a proxy header buffer (#1096)', async () => {
    cookieStore.set('jmap_rt', 'rt');
    cookieStore.set('jmap_idt', ID_TOKEN);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'a'.repeat(1700), expires_in: 300, refresh_token: 'r'.repeat(650), id_token: 'i'.repeat(1300),
      }),
    });

    const { status } = await callPut({ force: 'true' });

    expect(status).toBe(200);
    expect(cookieStore.get('jmap_idt')).toBeUndefined();
    expect(cookieStore.get('jmap_rt')?.value).toBe('r'.repeat(650));
  });

  it('does not start keeping an id token for a password sign-in', async () => {
    cookieStore.set('jmap_rt', 'rt');
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'at', expires_in: 300, id_token: ID_TOKEN }) });

    await callPut({ force: 'true' });

    expect(cookieStore.get('jmap_idt')).toBeUndefined();
  });

  it('forgets the id token with a rejected refresh token', async () => {
    cookieStore.set('jmap_rt', 'rt');
    cookieStore.set('jmap_idt', ID_TOKEN);
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid_grant' });

    await callPut({ force: 'true' });

    expect(cookieStore.get('jmap_idt')).toBeUndefined();
  });
});

describe('oauth token route - sign-out (#905)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieStore = new FakeCookies();
    configValues = {};
    getMetadata.mockResolvedValue(KEYCLOAK);
    getRequiredConfig.mockReturnValue({ clientId: 'webmail' });
    buildOAuthParams.mockImplementation((base: Record<string, string>) => new URLSearchParams(base));
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function seedSlot(slot: number, { idToken = ID_TOKEN, serverId }: { idToken?: string | null; serverId?: string } = {}) {
    const suffix = slot === 0 ? '' : `_${slot}`;
    cookieStore.set(`jmap_rt${suffix}`, `refresh-${slot}`);
    cookieStore.set(`jmap_at${suffix}`, `${Math.floor(Date.now() / 1000) + 600}.access-${slot}`);
    if (serverId) cookieStore.set(`jmap_rts${suffix}`, serverId);
    if (idToken) cookieStore.set(`jmap_idt${suffix}`, idToken);
  }

  it('builds the provider logout with client_id and id_token_hint', async () => {
    seedSlot(0);

    const { body } = await callRoute('DELETE', { slot: '0', end_session: 'true' });

    const url = new URL(body.end_session_url as string);
    expect(`${url.origin}${url.pathname}`).toBe(KEYCLOAK.end_session_endpoint);
    expect(url.searchParams.get('client_id')).toBe('webmail');
    expect(url.searchParams.get('id_token_hint')).toBe(ID_TOKEN);
    // Nothing configured: the provider shows its own signed-out page.
    expect(url.searchParams.has('post_logout_redirect_uri')).toBe(false);
  });

  it('revokes and clears the slot before answering', async () => {
    seedSlot(0);

    await callRoute('DELETE', { slot: '0', end_session: 'true' });

    expect(fetchMock).toHaveBeenCalledWith(KEYCLOAK.revocation_endpoint, expect.objectContaining({ method: 'POST' }));
    for (const name of ['jmap_rt', 'jmap_at', 'jmap_idt']) expect(cookieStore.get(name)).toBeUndefined();
    expect(cookieStore.deletedPaths.get('jmap_idt')).toBe('/api/auth/token');
  });

  it('identifies the client alone when no id token was kept', async () => {
    seedSlot(0, { idToken: null });

    const { body } = await callRoute('DELETE', { slot: '0', end_session: 'true' });

    const params = endSessionParams(body.end_session_url);
    expect(params.get('client_id')).toBe('webmail');
    expect(params.has('id_token_hint')).toBe(false);
  });

  it('keeps query parameters the provider put on its endpoint', async () => {
    seedSlot(0);
    getMetadata.mockResolvedValue({ ...KEYCLOAK, end_session_endpoint: 'https://id.example.com/logout?tenant=mail' });

    const { body } = await callRoute('DELETE', { slot: '0', end_session: 'true' });

    expect(endSessionParams(body.end_session_url).get('tenant')).toBe('mail');
  });

  it('sends the configured post-logout redirect verbatim', async () => {
    seedSlot(0);
    configValues.oauthPostLogoutRedirectUri = 'https://mail.example.com/en/login';

    const { body } = await callRoute('DELETE', { slot: '0', end_session: 'true' });

    expect(endSessionParams(body.end_session_url).get('post_logout_redirect_uri')).toBe('https://mail.example.com/en/login');
  });

  it.each([
    ['plain http', 'http://mail.example.com/en/login'],
    ['credentials', 'https://user:pass@mail.example.com/'],
    ['a fragment', 'https://mail.example.com/#/login'],
    ['a non-URL', 'mail.example.com/login'],
  ])('rejects a configured post-logout redirect with %s', async (_label, uri) => {
    seedSlot(0);
    configValues.oauthPostLogoutRedirectUri = uri;

    const { body } = await callRoute('DELETE', { slot: '0', end_session: 'true' });

    // The logout itself still happens, just without a way back.
    const params = endSessionParams(body.end_session_url);
    expect(params.has('post_logout_redirect_uri')).toBe(false);
  });

  it('allows an http post-logout redirect on a loopback host for local setups', async () => {
    seedSlot(0);
    configValues.oauthPostLogoutRedirectUri = 'http://localhost:3000/en/login';

    const { body } = await callRoute('DELETE', { slot: '0', end_session: 'true' });

    expect(endSessionParams(body.end_session_url).get('post_logout_redirect_uri')).toBe('http://localhost:3000/en/login');
  });

  it('does not offer a provider logout unless asked', async () => {
    seedSlot(0);

    const { body } = await callRoute('DELETE', { slot: '0' });

    expect(body.end_session_url).toBeUndefined();
  });

  it('does not offer a provider logout when the admin turned it off', async () => {
    seedSlot(0);
    configValues.oauthEndSession = false;

    const { body } = await callRoute('DELETE', { slot: '0', end_session: 'true' });

    expect(body.end_session_url).toBeUndefined();
  });

  it('does not offer a provider logout the provider does not advertise', async () => {
    seedSlot(0);
    getMetadata.mockResolvedValue({ ...KEYCLOAK, end_session_endpoint: undefined });

    const { body } = await callRoute('DELETE', { slot: '0', end_session: 'true' });

    expect(body.end_session_url).toBeUndefined();
  });

  it.each([
    ['non-https', 'http://id.example.com/logout'],
    ['malformed', 'not a url'],
  ])('does not offer a %s end_session_endpoint', async (_label, endpoint) => {
    seedSlot(0);
    getMetadata.mockResolvedValue({ ...KEYCLOAK, end_session_endpoint: endpoint });

    const { body } = await callRoute('DELETE', { slot: '0', end_session: 'true' });

    expect(body.end_session_url).toBeUndefined();
    expect(cookieStore.get('jmap_rt')).toBeUndefined();
  });

  it.each([
    ['answers with an error', () => fetchMock.mockResolvedValue({ ok: false, status: 503 })],
    ['cannot be reached', () => fetchMock.mockRejectedValue(new TypeError('fetch failed'))],
  ])('still clears the slot and offers the logout when revocation %s', async (_label, arrange) => {
    seedSlot(0);
    arrange();

    const { status, body } = await callRoute('DELETE', { slot: '0', end_session: 'true' });

    expect(status).toBe(200);
    expect(body.end_session_url).toEqual(expect.any(String));
    for (const name of ['jmap_rt', 'jmap_at', 'jmap_idt']) expect(cookieStore.get(name)).toBeUndefined();
  });

  it('bounds the revocation request so sign-out cannot hang on it', async () => {
    seedSlot(0);

    await callRoute('DELETE', { slot: '0' });

    const [, init] = fetchMock.mock.calls.find(([url]) => url === KEYCLOAK.revocation_endpoint)!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('signs out every slot and builds the logout for the named one, with its own provider', async () => {
    // Slot 0 and slot 2 signed in at different providers.
    seedSlot(0, { idToken: 'id-token-0', serverId: 'corp' });
    seedSlot(2, { idToken: 'id-token-2', serverId: 'partner' });
    getMetadata.mockImplementation(async (serverId: string | null) => (serverId === 'partner'
      ? { ...KEYCLOAK, end_session_endpoint: 'https://partner.example.org/logout', revocation_endpoint: undefined }
      : KEYCLOAK));
    getRequiredConfig.mockImplementation((serverId: string | null) => ({ clientId: serverId === 'partner' ? 'partner-webmail' : 'webmail' }));

    const { body } = await callRoute('DELETE', { all: 'true', end_session_slot: '2' });

    const url = new URL(body.end_session_url as string);
    expect(`${url.origin}${url.pathname}`).toBe('https://partner.example.org/logout');
    expect(url.searchParams.get('client_id')).toBe('partner-webmail');
    expect(url.searchParams.get('id_token_hint')).toBe('id-token-2');
    for (const name of ['jmap_rt', 'jmap_rt_2', 'jmap_idt', 'jmap_idt_2', 'jmap_rts', 'jmap_rts_2']) {
      expect(cookieStore.get(name)).toBeUndefined();
    }
    // Slot 0's token is revoked at its own provider.
    expect(fetchMock).toHaveBeenCalledWith(KEYCLOAK.revocation_endpoint, expect.anything());
  });

  it('signs out every slot without a provider logout unless one is named', async () => {
    seedSlot(0);
    seedSlot(3);

    const { body } = await callRoute('DELETE', { all: 'true' });

    expect(body.end_session_url).toBeUndefined();
    expect(cookieStore.get('jmap_rt_3')).toBeUndefined();
    // Only cookies the browser sent get a clearing Set-Cookie: 50 slots of
    // them would overflow proxy header buffers.
    expect(cookieStore.deleted).not.toContain('jmap_rt_1');
  });
});
