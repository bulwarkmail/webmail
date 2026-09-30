import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The redirect flow only exists in the Stalwart target, a build-time switch,
 * so every test imports the modules fresh with the env stubbed.
 */
async function loadModules(target: 'stalwart' | 'static' = 'stalwart') {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_BULWARK_LITE', '1');
  vi.stubEnv('NEXT_PUBLIC_LITE_TARGET', target);
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
  const oauth = await import('@/lib/auth/lite-oauth');
  const tokens = await import('@/lib/auth/lite-tokens');
  return { oauth, tokens };
}

const w = window as unknown as Record<string, unknown>;
const SERVER = 'https://mail.example.com';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** What Stalwart answers for a domain it authenticates itself, over TLS. */
function ownDocument(base = SERVER) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/login`,
    token_endpoint: `${base}/auth/token`,
    scopes_supported: ['openid', 'offline_access', 'urn:ietf:params:oauth:scope:mail'],
  };
}

/** What it relays for a domain whose directory is an external OpenID provider. */
const PROVIDER_DOCUMENT = {
  issuer: 'https://id.example.org',
  authorization_endpoint: 'https://id.example.org/authorize',
  token_endpoint: 'https://id.example.org/api/oidc/token',
  end_session_endpoint: 'https://id.example.org/api/oidc/end-session',
  scopes_supported: ['openid', 'profile', 'email', 'groups'],
};

function stubFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return route();
  });
  vi.stubGlobal('fetch', mock);
  return calls;
}

describe('Lite on Stalwart: OAuth discovery', () => {
  beforeEach(() => {
    delete w.__BULWARK_LITE_MOUNT__;
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    delete w.__BULWARK_LITE_MOUNT__;
  });

  it('registers one locale-free redirect URI below the mount', async () => {
    const { oauth } = await loadModules();
    expect(oauth.getLiteOAuthRedirectUri()).toBe(`${window.location.origin}/oauth/callback`);
    w.__BULWARK_LITE_MOUNT__ = '/webmail';
    expect(oauth.getLiteOAuthRedirectUri()).toBe(`${window.location.origin}/webmail/oauth/callback`);
  });

  it('recognises an account Stalwart signs in itself', async () => {
    const { oauth } = await loadModules();
    const calls = stubFetch({ [`${SERVER}/api/discover/alice%40example.com`]: () => jsonResponse(ownDocument()) });

    const found = await oauth.liteDiscoverOAuth(`${SERVER}/`, ' alice@example.com ');
    expect(found).toEqual({
      external: false,
      scope: 'openid offline_access',
      metadata: {
        issuer: SERVER,
        authorization_endpoint: `${SERVER}/login`,
        token_endpoint: `${SERVER}/auth/token`,
        revocation_endpoint: undefined,
        end_session_endpoint: undefined,
      },
    });
    expect(calls).toEqual([`${SERVER}/api/discover/alice%40example.com`]);
  });

  it('resolves the relative endpoints Stalwart sends over plain HTTP', async () => {
    const { oauth } = await loadModules();
    stubFetch({
      'http://127.0.0.1:8080/api/discover/alice%40example.com': () =>
        jsonResponse({ issuer: '', authorization_endpoint: '/login', token_endpoint: '/auth/token', scopes_supported: ['openid'] }),
    });
    const found = await oauth.liteDiscoverOAuth('http://127.0.0.1:8080', 'alice@example.com');
    expect(found?.external).toBe(false);
    expect(found?.metadata.authorization_endpoint).toBe('http://127.0.0.1:8080/login');
    expect(found?.metadata.token_endpoint).toBe('http://127.0.0.1:8080/auth/token');
  });

  it('sends an account of an external directory to its provider', async () => {
    const { oauth } = await loadModules();
    const calls = stubFetch({
      [`${SERVER}/api/discover/bob%40corp.example`]: () => jsonResponse(PROVIDER_DOCUMENT),
      // The provider is not the mail server: the last resort asks the server about itself.
      [`${SERVER}/.well-known/oauth-authorization-server`]: () => jsonResponse(ownDocument()),
    });

    const found = await oauth.liteDiscoverOAuth(SERVER, 'bob@corp.example');
    expect(found?.external).toBe(true);
    expect(found?.scope).toBe('openid email profile');
    expect(found?.metadata).toEqual({
      issuer: 'https://id.example.org',
      authorization_endpoint: 'https://id.example.org/authorize',
      token_endpoint: 'https://id.example.org/api/oidc/token',
      revocation_endpoint: undefined,
      end_session_endpoint: 'https://id.example.org/api/oidc/end-session',
    });
    expect(calls).toContain(`${SERVER}/.well-known/oauth-authorization-server`);
  });

  it('keeps the password form behind a proxy whose host is not the configured hostname', async () => {
    const { oauth } = await loadModules();
    // The page reaches Stalwart as admin.example.com; Stalwart calls itself mail.example.com.
    const proxied = 'https://admin.example.com';
    stubFetch({
      [`${proxied}/api/discover/alice%40example.com`]: () => jsonResponse(ownDocument(SERVER)),
      [`${proxied}/.well-known/oauth-authorization-server`]: () => jsonResponse(ownDocument(SERVER)),
    });

    const found = await oauth.liteDiscoverOAuth(proxied, 'alice@example.com');
    expect(found?.external).toBe(false);
    // Its own endpoints are used through the URL the browser reaches it under.
    expect(found?.metadata.authorization_endpoint).toBe(`${proxied}/login`);
    expect(found?.metadata.token_endpoint).toBe(`${proxied}/auth/token`);
  });

  it('asks once per account and never remembers a failure', async () => {
    const { oauth } = await loadModules();
    let healthy = false;
    const calls = stubFetch({
      [`${SERVER}/api/discover/alice%40example.com`]: () => (healthy ? jsonResponse(ownDocument()) : new Response('busy', { status: 429 })),
    });

    await expect(oauth.liteDiscoverOAuth(SERVER, 'alice@example.com')).resolves.toBeNull();
    healthy = true;
    await expect(oauth.liteDiscoverOAuth(SERVER, 'alice@example.com')).resolves.not.toBeNull();
    await expect(oauth.liteDiscoverOAuth(SERVER, 'Alice@Example.com')).resolves.not.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('answers null for unusable documents, missing endpoints and unreachable servers', async () => {
    const { oauth } = await loadModules();
    stubFetch({
      [`${SERVER}/api/discover/a%40x.example`]: () => jsonResponse({ authorization_endpoint: 'https://id.example.org/authorize' }),
      [`${SERVER}/api/discover/b%40x.example`]: () => new Response('<html>', { status: 200 }),
      [`${SERVER}/api/discover/c%40x.example`]: () => jsonResponse({ authorization_endpoint: 'javascript:alert(1)', token_endpoint: 'https://id.example.org/token' }),
      [`${SERVER}/api/discover/d%40x.example`]: () => Promise.reject(new TypeError('network')),
    });
    for (const account of ['a@x.example', 'b@x.example', 'c@x.example', 'd@x.example', 'e@x.example']) {
      await expect(oauth.liteDiscoverOAuth(SERVER, account)).resolves.toBeNull();
    }
    await expect(oauth.liteDiscoverOAuth(SERVER, '   ')).resolves.toBeNull();
    await expect(oauth.liteDiscoverOAuth('/relative', 'a@x.example')).resolves.toBeNull();
  });

  it('requests no scope from a provider without OpenID, and the default when none are listed', async () => {
    const { oauth } = await loadModules();
    stubFetch({
      [`${SERVER}/api/discover/a%40x.example`]: () => jsonResponse({ ...ownDocument(), scopes_supported: ['mail'] }),
      [`${SERVER}/api/discover/b%40x.example`]: () => jsonResponse({ ...ownDocument(), scopes_supported: undefined }),
    });
    expect((await oauth.liteDiscoverOAuth(SERVER, 'a@x.example'))?.scope).toBe('');
    expect((await oauth.liteDiscoverOAuth(SERVER, 'b@x.example'))?.scope).toBe('openid email profile');
  });

  it('is switched off in the static-host build', async () => {
    const { oauth } = await loadModules('static');
    const calls = stubFetch({});
    expect(oauth.LITE_OAUTH_AVAILABLE).toBe(false);
    await expect(oauth.liteDiscoverOAuth(SERVER, 'alice@example.com')).resolves.toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('Lite on Stalwart: pending OAuth flow and code exchange', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('parks the flow for the callback and rejects a damaged one', async () => {
    const { oauth } = await loadModules();
    expect(oauth.readLiteOAuthFlow()).toBeNull();

    const flow = { tokenEndpoint: 'https://id.example.org/token', clientId: 'app', redirectUri: 'https://mail.example.com/webmail/oauth/callback', persistent: true };
    oauth.saveLiteOAuthFlow(flow);
    expect(oauth.readLiteOAuthFlow()).toEqual(flow);

    oauth.clearLiteOAuthFlow();
    expect(oauth.readLiteOAuthFlow()).toBeNull();

    sessionStorage.setItem('oauth_lite_flow', JSON.stringify({ ...flow, tokenEndpoint: '' }));
    expect(oauth.readLiteOAuthFlow()).toBeNull();
    sessionStorage.setItem('oauth_lite_flow', '{not json');
    expect(oauth.readLiteOAuthFlow()).toBeNull();
    // Anything but `true` means the token stays with the tab.
    sessionStorage.setItem('oauth_lite_flow', JSON.stringify({ ...flow, persistent: 'yes' }));
    expect(oauth.readLiteOAuthFlow()?.persistent).toBe(false);
  });

  it('redeems the code at the discovered endpoint as a public client', async () => {
    const { tokens } = await loadModules();
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ access_token: 'AT', refresh_token: 'RT', expires_in: 900 });
    }));

    const result = await tokens.liteExchangeAuthorizationCode({
      tokenEndpoint: 'https://id.example.org/token',
      code: 'the-code',
      codeVerifier: 'the-verifier',
      redirectUri: 'https://mail.example.com/webmail/oauth/callback',
      clientId: 'app',
    });
    expect(result).toEqual({ accessToken: 'AT', expiresIn: 900, refreshToken: 'RT' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://id.example.org/token');
    expect(Object.fromEntries(new URLSearchParams(String(calls[0].init?.body)))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      client_id: 'app',
      redirect_uri: 'https://mail.example.com/webmail/oauth/callback',
      code_verifier: 'the-verifier',
    });
    // A public client: PKCE, no secret, no credentials header.
    expect(new Headers(calls[0].init?.headers).has('Authorization')).toBe(false);
  });

  it('reports a rejected code', async () => {
    const { tokens } = await loadModules();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400)));
    await expect(tokens.liteExchangeAuthorizationCode({
      tokenEndpoint: 'https://id.example.org/token', code: 'c', codeVerifier: 'v', redirectUri: 'r', clientId: 'app',
    })).rejects.toMatchObject({ code: 'token_exchange_failed', status: 400 });
  });

  it('renews a provider-issued token at that provider, and a Stalwart one at the server', async () => {
    const { tokens } = await loadModules();
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 60 });
    }));

    tokens.saveLiteRefreshToken(0, { serverUrl: SERVER, username: 'bob@corp.example', refreshToken: 'RT', clientId: 'app', tokenEndpoint: 'https://id.example.org/token' }, true);
    tokens.saveLiteRefreshToken(1, { serverUrl: SERVER, username: 'alice@example.com', refreshToken: 'RT', clientId: 'app' }, true);
    await tokens.liteRefreshTokens(0);
    await tokens.liteRefreshTokens(1);
    expect(urls).toEqual(['https://id.example.org/token', `${SERVER}/auth/token`]);
    // The rotation keeps pointing at the provider.
    expect(tokens.readLiteRefreshToken(0)).toMatchObject({ refreshToken: 'RT2', tokenEndpoint: 'https://id.example.org/token' });
  });

  it('names a token once the session told us the account, where it already lives', async () => {
    const { tokens } = await loadModules();
    tokens.saveLiteRefreshToken(0, { serverUrl: SERVER, username: '', refreshToken: 'RT', clientId: 'app' }, false);
    tokens.nameLiteRefreshToken(0, 'bob@corp.example');
    expect(tokens.readLiteRefreshToken(0)?.username).toBe('bob@corp.example');
    expect(sessionStorage.getItem('bulwark-lite:refresh:0')).not.toBeNull();
    expect(localStorage.getItem('bulwark-lite:refresh:0')).toBeNull();
    // Nothing stored: nothing to name.
    tokens.nameLiteRefreshToken(3, 'nobody');
    expect(tokens.readLiteRefreshToken(3)).toBeNull();
  });
});
