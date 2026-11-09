import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      json: async () => data,
      status: init?.status ?? 200,
    }),
  },
}));

const cookieSet = vi.fn();
const cookieValues = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    set: cookieSet,
    get: (name: string) => (cookieValues.has(name) ? { value: cookieValues.get(name) } : undefined),
  }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

const encrypted = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('@/lib/auth/crypto', () => ({
  encryptPayload: (payload: Record<string, unknown>) => {
    encrypted.last = payload;
    return 'encrypted';
  },
}));

vi.mock('@/lib/oauth/pkce-server', () => ({
  generateCodeVerifierServer: () => 'verifier',
  generateCodeChallengeServer: () => 'challenge',
  generateStateServer: () => 'state-123',
}));

const getRequiredConfig = vi.fn((_serverId?: string | null): { clientId: string; discoveryUrl: string; resource?: string } => ({
  clientId: 'client',
  discoveryUrl: 'https://idp.example.com',
}));
vi.mock('@/lib/oauth/token-exchange', () => ({
  getRequiredConfig: (serverId?: string | null) => getRequiredConfig(serverId),
  getDiscoveryValidator: () => undefined,
}));

vi.mock('@/lib/oauth/discovery', () => ({
  discoverOAuth: async () => ({
    issuer: 'https://idp.example.com',
    authorization_endpoint: 'https://idp.example.com/authorize',
    token_endpoint: 'https://idp.example.com/token',
  }),
}));

vi.mock('@/lib/oauth/tokens', () => ({
  getOauthScopes: () => 'openid email',
  refreshTokenServerCookieName: (slot: number) => `jmap_rt_server_${slot}`,
}));

vi.mock('@/lib/oauth/cookie-config', () => ({
  getCookieOptions: () => ({ httpOnly: true }),
}));

vi.mock('@/lib/auth/session-secret', () => ({
  hasSessionSecret: () => true,
}));

const configValues = vi.hoisted(() => ({ desktopBrowserSignIn: true } as Record<string, unknown>));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { get: (key: string) => (key in configValues ? configValues[key] : '') },
}));

function mockRequest(body: Record<string, unknown>): unknown {
  return {
    json: async () => body,
    headers: {
      get: (k: string) =>
        k === 'origin' ? 'https://mail.example.com' : k === 'host' ? 'mail.example.com' : null,
    },
    nextUrl: { origin: 'https://mail.example.com' },
  };
}

async function callRoute(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/auth/sso/start/route');
  const res = (await POST(mockRequest(body) as Parameters<typeof POST>[0])) as unknown as {
    status: number;
    json: () => Promise<{ authorize_url: string }>;
  };
  return { status: res.status, body: await res.json() };
}

describe('sso start route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cookieValues.clear();
  });

  it('re-authenticates against the paired slot\'s server', async () => {
    cookieValues.set('jmap_rt_server_2', 'server-b');
    const { status } = await callRoute({
      redirect_uri: 'https://mail.example.com/auth/callback',
      purpose: 'reauth',
      slot: 2,
    });

    expect(status).toBe(200);
    expect(getRequiredConfig).toHaveBeenCalledWith('server-b');
  });

  it('ignores the slot cookie for a regular login', async () => {
    cookieValues.set('jmap_rt_server_0', 'server-b');
    await callRoute({ redirect_uri: 'https://mail.example.com/auth/callback' });

    expect(getRequiredConfig).toHaveBeenCalledWith(null);
  });

  it('forces prompt=login without max_age for re-authentication', async () => {
    const { status, body } = await callRoute({
      redirect_uri: 'https://mail.example.com/auth/callback',
      purpose: 'reauth',
    });

    expect(status).toBe(200);
    const url = new URL(body.authorize_url);
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.has('max_age')).toBe(false);
  });

  it('sends neither prompt nor max_age for a regular login', async () => {
    const { status, body } = await callRoute({
      redirect_uri: 'https://mail.example.com/auth/callback',
    });

    expect(status).toBe(200);
    const url = new URL(body.authorize_url);
    expect(url.searchParams.has('prompt')).toBe(false);
    expect(url.searchParams.has('max_age')).toBe(false);
  });

  it('sends the configured RFC 8707 resource with the authorization request (#1461)', async () => {
    getRequiredConfig.mockReturnValueOnce({
      clientId: 'client',
      discoveryUrl: 'https://idp.example.com',
      resource: 'https://mail.example.com',
    });
    const { body } = await callRoute({ redirect_uri: 'https://mail.example.com/auth/callback' });

    expect(new URL(body.authorize_url).searchParams.get('resource')).toBe('https://mail.example.com');
  });

  it('sends no resource when none applies', async () => {
    const { body } = await callRoute({ redirect_uri: 'https://mail.example.com/auth/callback' });

    expect(new URL(body.authorize_url).searchParams.has('resource')).toBe(false);
  });
});

describe('sso start for the mobile app', () => {
  const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  const mobile = (extra: Record<string, unknown> = {}) => callRoute({
    redirect_uri: 'https://mail.example.com/auth/callback',
    mobile_redirect_uri: 'bulwarkmobile://auth/callback',
    mobile_state: 'm-1',
    ...extra,
  });

  beforeEach(() => {
    encrypted.last = null;
  });

  it('keeps the PKCE challenge of the app for the complete route', async () => {
    const { status } = await mobile({ mobile_code_challenge: CHALLENGE });
    expect(status).toBe(200);
    expect(encrypted.last).toMatchObject({
      mobile_redirect_uri: 'bulwarkmobile://auth/callback',
      mobile_state: 'm-1',
      mobile_code_challenge: CHALLENGE,
    });
  });

  it('refuses a malformed challenge instead of falling back to handing over tokens', async () => {
    const { status } = await mobile({ mobile_code_challenge: 'plain-text' });
    expect(status).toBe(400);
    expect(encrypted.last).toBeNull();
  });

  it('starts as before without a challenge', async () => {
    const { status } = await mobile();
    expect(status).toBe(200);
    expect(encrypted.last).not.toHaveProperty('mobile_code_challenge');
  });

  it('drops a challenge sent without the app callback', async () => {
    await callRoute({ redirect_uri: 'https://mail.example.com/auth/callback', mobile_code_challenge: CHALLENGE });
    expect(encrypted.last).not.toHaveProperty('mobile_code_challenge');
  });
});

describe('sso start for the desktop app', () => {
  const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  const LISTENER = 'http://127.0.0.1:51234/bulwark-desktop/callback';
  const desktop = (extra: Record<string, unknown> = {}) => callRoute({
    redirect_uri: 'https://mail.example.com/auth/callback',
    mobile_redirect_uri: LISTENER,
    mobile_state: 'd-1',
    ...extra,
  });

  beforeEach(() => {
    encrypted.last = null;
  });

  it('keeps the loopback target and its challenge for the complete route', async () => {
    const { status } = await desktop({ mobile_code_challenge: CHALLENGE });
    expect(status).toBe(200);
    expect(encrypted.last).toMatchObject({ mobile_redirect_uri: LISTENER, mobile_state: 'd-1', mobile_code_challenge: CHALLENGE });
  });

  it('refuses it when the instance\'s admin turned it off', async () => {
    configValues.desktopBrowserSignIn = false;
    const { status } = await desktop({ mobile_code_challenge: CHALLENGE });
    configValues.desktopBrowserSignIn = true;
    expect(status).toBe(403);
    expect(encrypted.last).toBeNull();
  });

  it('refuses it without a challenge: tokens would come back for a link', async () => {
    const { status } = await desktop();
    expect(status).toBe(400);
    expect(encrypted.last).toBeNull();
  });

  it.each(['http://127.0.0.1:51234/other', 'http://localhost:51234/bulwark-desktop/callback', 'http://evil.example/bulwark-desktop/callback'])('refuses %s as a target', async (target) => {
    const { status } = await desktop({ mobile_code_challenge: CHALLENGE, mobile_redirect_uri: target });
    expect(status).toBe(400);
    expect(encrypted.last).toBeNull();
  });
});
