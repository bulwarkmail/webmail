import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';

/**
 * The desktop app's sign-in on an instance: what the browser checks and parks, and what the
 * app's own page gets for the code. The real store, budgets and routes, with the mail server faked.
 */

const cookieJar = vi.hoisted(() => new Map<string, { value: string; options?: Record<string, unknown> }>());
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      cookieJar.set(name, { value, options });
    },
    delete: (name: string) => {
      cookieJar.delete(name);
    },
    getAll: () => [...cookieJar.entries()].map(([name, { value }]) => ({ name, value })),
  }),
}));

const config = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key in config.values ? config.values[key] : fallback),
  },
}));

const verifyJmapAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/verify-jmap-auth', async (original) => ({
  ...(await original<object>()),
  verifyJmapAuth,
}));

const stalwartPasswordLogin = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/stalwart-password-login', async (original) => ({
  ...(await original<object>()),
  stalwartPasswordLogin,
}));

const reserveLoginAttempt = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/verify-budget', async (original) => ({
  ...(await original<object>()),
  reserveLoginAttempt,
}));

const discoverOAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/oauth/discovery', () => ({ discoverOAuth }));

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } }));

const { POST: check } = await import('@/app/api/auth/desktop-handoff/check/route');
const { POST: park } = await import('@/app/api/auth/desktop-handoff/park/route');
const { POST: redeem } = await import('@/app/api/auth/desktop-handoff/redeem/route');
const { POST: discard } = await import('@/app/api/auth/desktop-handoff/discard/route');
const { POST: mobileRedeem } = await import('@/app/api/auth/handoff/redeem/route');
const { JmapAuthVerificationError } = await import('@/lib/auth/verify-jmap-auth');
const { HANDOFF_CONFIRM_TTL_MS, HANDOFF_TTL_MS, resetHandoffStoreForTests, stashHandoff } = await import('@/lib/auth/handoff-store');
const { desktopHandoffDeclineUrl, desktopHandoffPort, desktopHandoffTarget, mobileHandoffTarget } = await import('@/lib/auth/mobile-handoff');
const { isDesktopBlockedRoute } = await import('@/lib/desktop/blocked-routes');

const ORIGIN = 'https://bulwark.example';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER, 'ascii').digest('base64url');
const SERVER = 'https://mail.example';
const TOKENS = { ok: true, tokens: { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }, tokenEndpoint: `${SERVER}/auth/token`, clientId: 'x' };

/** A client of its own per test, so the budgets don't carry over: the real ones, unmocked. */
let clientAddress = '';
let nextClient = 1;

function post(path: string, body: unknown, origin = ORIGIN) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Host: 'bulwark.example', 'x-forwarded-for': clientAddress },
    body: JSON.stringify(body),
  });
}

const parkBody = (extra: Record<string, unknown> = {}) => ({
  code_challenge: CHALLENGE,
  state: 'state-1',
  server_url: SERVER,
  username: 'a@example.org',
  password: 'secret',
  ...extra,
});
const checkBody = (extra: Record<string, unknown> = {}) => ({ server_url: SERVER, username: 'a@example.org', password: 'secret', ...extra });

const parkIt = (extra: Record<string, unknown> = {}) => park(post('/api/auth/desktop-handoff/park', parkBody(extra)));

async function parkedCode(extra: Record<string, unknown> = {}): Promise<string> {
  const answer = await parkIt(extra);
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { code: string }).code;
}

const redeemBody = (code: string, extra: Record<string, unknown> = {}) => ({ code, code_verifier: VERIFIER, slot: 1, remember: true, allowed_servers: null, custom_servers_allowed: true, ...extra });
const redeemIt = (code: string, extra: Record<string, unknown> = {}) => redeem(post('/api/auth/desktop-handoff/redeem', redeemBody(code, extra)));

/** Everything the store holds, in the open. Nothing secret may be in it after its use. */
const heldInMemory = () => JSON.stringify([...((globalThis as unknown as { __bulwarkMobileHandoffStore?: Map<string, unknown> }).__bulwarkMobileHandoffStore ?? new Map()).values()]);

let revoked: string[];

beforeEach(() => {
  cookieJar.clear();
  resetHandoffStoreForTests();
  clientAddress = `203.0.113.${(nextClient += 1)}`;
  config.values = { jmapServerUrl: SERVER };
  verifyJmapAuth.mockReset();
  verifyJmapAuth.mockResolvedValue(undefined);
  stalwartPasswordLogin.mockReset();
  stalwartPasswordLogin.mockResolvedValue(TOKENS);
  reserveLoginAttempt.mockReset();
  reserveLoginAttempt.mockResolvedValue(async () => {});
  discoverOAuth.mockReset();
  discoverOAuth.mockResolvedValue({ revocation_endpoint: `${SERVER}/revoke` });
  revoked = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/revoke')) revoked.push(new URLSearchParams(String(init?.body)).get('token') ?? '');
    return new Response('{}', { status: 200 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the target', () => {
  it('is only ever this computer on the one path', () => {
    expect(desktopHandoffTarget('http://127.0.0.1:51234/bulwark-desktop/callback')).toBe('http://127.0.0.1:51234/bulwark-desktop/callback');
    for (const bad of [
      'http://127.0.0.1/bulwark-desktop/callback',
      'http://127.0.0.1:99999/bulwark-desktop/callback',
      'http://localhost:51234/bulwark-desktop/callback',
      'https://127.0.0.1:51234/bulwark-desktop/callback',
      'http://127.0.0.1:51234/other',
      'http://127.0.0.1:51234/bulwark-desktop/callback?x=1',
      'http://127.0.0.1@evil.example:51234/bulwark-desktop/callback',
      'http://evil.example/bulwark-desktop/callback',
      'bulwarkmobile://auth/callback',
      null,
    ]) {
      expect(desktopHandoffTarget(bad), String(bad)).toBe('');
    }
  });

  it('leaves the phone\'s rule as it was', () => {
    expect(mobileHandoffTarget('http://127.0.0.1:51234/bulwark-desktop/callback')).toBe('');
  });

  it('a no goes back with the state and no code', () => {
    const target = 'http://127.0.0.1:51234/bulwark-desktop/callback';
    expect(desktopHandoffPort(target)).toBe('51234');
    expect(desktopHandoffDeclineUrl(target, 's t')).toBe(`${target}?error=access_denied&state=s+t`);
  });

  it('the embedded build has none of these routes', () => {
    for (const route of ['check', 'park', 'redeem', 'discard']) expect(isDesktopBlockedRoute(`/api/auth/desktop-handoff/${route}`)).toBe(true);
    expect(isDesktopBlockedRoute('/api/auth/desktop-oauth')).toBe(false);
  });
});

describe('checking, before the question', () => {
  const checkIt = (extra: Record<string, unknown> = {}, origin = ORIGIN) => check(post('/api/auth/desktop-handoff/check', checkBody(extra), origin));

  it('keeps nothing: no record, no cookie, and the password appears nowhere', async () => {
    const answer = await checkIt();
    expect(answer.status).toBe(200);
    expect(heldInMemory()).toBe('[]');
    expect([...cookieJar.keys()]).toEqual([]);
    expect(stalwartPasswordLogin).not.toHaveBeenCalled();
  });

  it('refuses another origin', async () => {
    expect((await checkIt({}, 'https://evil.example')).status).toBe(403);
    expect(verifyJmapAuth).not.toHaveBeenCalled();
  });

  it('says a wrong password is wrong, and that a second factor is needed', async () => {
    verifyJmapAuth.mockRejectedValueOnce(new JmapAuthVerificationError('no', 401, 401));
    expect(await (await checkIt()).json()).toEqual({ error: 'invalid_credentials' });
    verifyJmapAuth.mockRejectedValueOnce(new JmapAuthVerificationError('no', 401, 402));
    expect(await (await checkIt()).json()).toEqual({ error: 'totp_required' });
  });

  it('holds no password on an OAuth-only instance', async () => {
    config.values = { jmapServerUrl: SERVER, oauthEnabled: true, oauthOnly: true };
    expect((await checkIt()).status).toBe(403);
    expect(verifyJmapAuth).not.toHaveBeenCalled();
  });

  it('takes a password on an OAuth-only instance whose admin turned on the password fallback', async () => {
    config.values = { jmapServerUrl: SERVER, oauthEnabled: true, oauthOnly: true, oauthPasswordFallbackEnabled: true };
    await checkIt();
    expect(verifyJmapAuth).toHaveBeenCalled();
  });

  it('over the login budget, nothing reaches the mail server, and the answer says why', async () => {
    reserveLoginAttempt.mockResolvedValue(null);
    const answer = await checkIt();
    expect(answer.status).toBe(429);
    expect(await answer.json()).toEqual({ error: 'too_many_attempts' });
    expect(verifyJmapAuth).not.toHaveBeenCalled();
  });

  it('never goes to a server the instance does not know', async () => {
    expect((await checkIt({ server_url: 'https://evil.example' })).status).toBe(400);
    expect(verifyJmapAuth).not.toHaveBeenCalled();
  });
});

describe('the instance admin\'s switch', () => {
  it('closes every route, with nothing checked, parked or redeemed', async () => {
    const code = await parkedCode();
    verifyJmapAuth.mockClear();
    stalwartPasswordLogin.mockClear();
    config.values = { jmapServerUrl: SERVER, desktopBrowserSignIn: false };
    expect((await check(post('/api/auth/desktop-handoff/check', checkBody()))).status).toBe(403);
    expect((await parkIt()).status).toBe(403);
    expect(verifyJmapAuth).not.toHaveBeenCalled();
    expect(stalwartPasswordLogin).not.toHaveBeenCalled();
    expect((await redeemIt(code)).status).toBe(403);
  });
});

describe('parking, after the yes', () => {
  it('hands over tokens wherever the server can give them, and leaves this browser with no session', async () => {
    const code = await parkedCode();
    expect(verifyJmapAuth).not.toHaveBeenCalled();
    expect([...cookieJar.keys()]).toEqual([]);
    expect(heldInMemory()).not.toContain('secret');
    const answer = await redeemIt(code);
    const body = await answer.json();
    expect(body).toMatchObject({ flow: 'tokens', password_login: true, username: 'a@example.org', access_token: 'access' });
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(JSON.stringify(body)).not.toContain('"refresh"');
    expect(cookieJar.get('jmap_rt_1')?.value).toBe('refresh');
  });

  it.each(['login_endpoint_missing', 'login_rejected', 'login_unreachable', 'token_exchange_failed'])('a password only as the last resort: %s', async (error) => {
    stalwartPasswordLogin.mockResolvedValue({ ok: false, error });
    const code = await parkedCode();
    expect(verifyJmapAuth).toHaveBeenCalledOnce();
    expect(await (await redeemIt(code)).json()).toEqual({ flow: 'password', server_url: SERVER, username: 'a@example.org', password: 'secret' });
  });

  it('a password that turns out wrong, on the way, parks nothing', async () => {
    stalwartPasswordLogin.mockResolvedValue({ ok: false, error: 'invalid_credentials' });
    const answer = await parkIt();
    expect(answer.status).toBe(401);
    expect(await answer.json()).toEqual({ error: 'invalid_credentials' });
    expect(heldInMemory()).toBe('[]');
  });

  it('a wrong two-factor code gets no fallback to a password', async () => {
    stalwartPasswordLogin.mockResolvedValue({ ok: false, error: 'login_rejected' });
    expect((await parkIt({ totp: '000000' })).status).toBe(502);
    expect(verifyJmapAuth).not.toHaveBeenCalled();
    expect(heldInMemory()).toBe('[]');
  });

  it('refuses another origin', async () => {
    expect((await park(post('/api/auth/desktop-handoff/park', parkBody(), 'https://evil.example'))).status).toBe(403);
    expect(stalwartPasswordLogin).not.toHaveBeenCalled();
  });

  it.each([
    ['no challenge', { code_challenge: '' }],
    ['a bad challenge', { code_challenge: 'short' }],
    ['no state', { state: '' }],
    ['no password', { password: '' }],
  ])('refuses %s', async (_name, extra) => {
    expect((await parkIt(extra)).status).toBe(400);
    expect(stalwartPasswordLogin).not.toHaveBeenCalled();
  });

  it('what was checked is what is parked: the body can\'t name another server for the app', async () => {
    config.values = { jmapServerUrl: SERVER, jmapServers: [{ id: 'two', url: 'https://two.example', name: 'Two' }] };
    const code = await parkedCode({ server_id: 'two', server_url: 'https://evil.example' });
    expect(stalwartPasswordLogin.mock.calls[0][0]).toMatchObject({ serverUrl: 'https://two.example' });
    expect(await (await redeemIt(code)).json()).toMatchObject({ server_url: 'https://two.example' });
  });
});

describe('the budget, with one address for a whole office', () => {
  it('sign-ins that work never run out', async () => {
    clientAddress = '198.51.100.7';
    for (let i = 0; i < 25; i += 1) expect((await parkIt()).status, `sign-in ${i}`).toBe(200);
  });

  it('after ten failures it refuses before going upstream, so no code is spent, and says why', async () => {
    clientAddress = '198.51.100.8';
    stalwartPasswordLogin.mockResolvedValue({ ok: false, error: 'invalid_credentials' });
    for (let i = 0; i < 10; i += 1) expect((await parkIt({ totp: '000000' })).status).toBe(401);
    stalwartPasswordLogin.mockClear();
    const answer = await parkIt({ totp: '123456' });
    expect(answer.status).toBe(429);
    expect(await answer.json()).toEqual({ error: 'too_many_attempts' });
    expect(answer.headers.get('Retry-After')).toBeTruthy();
    expect(stalwartPasswordLogin).not.toHaveBeenCalled();
  });

  it('a bad code to redeem is what its budget counts, and a good one gives it back', async () => {
    clientAddress = '198.51.100.9';
    for (let i = 0; i < 12; i += 1) expect((await redeemIt(await parkedCode())).status).toBe(200);
    for (let i = 0; i < 10; i += 1) expect((await redeemIt('f'.repeat(64))).status).toBe(400);
    expect((await redeemIt('f'.repeat(64))).status).toBe(429);
  });
});

describe('redeeming, in the app', () => {
  it('a code can be used once', async () => {
    const code = await parkedCode();
    expect((await redeemIt(code)).status).toBe(200);
    const again = await redeemIt(code);
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: 'invalid_code' });
  });

  it('a wrong verifier gets nothing, and spends the code', async () => {
    const code = await parkedCode();
    const wrong = await redeemIt(code, { code_verifier: 'w'.repeat(64) });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: 'invalid_verifier' });
    expect((await redeemIt(code)).status).toBe(400);
    expect([...cookieJar.keys()]).toEqual([]);
  });

  it('a late code is told so', async () => {
    const code = await parkedCode();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    const answer = await redeemIt(code);
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: 'expired_code' });
  });

  it('keeps the instance\'s strict cookies strict', async () => {
    config.values = { jmapServerUrl: SERVER, cookieSameSite: 'strict' };
    await redeemIt(await parkedCode());
    expect(cookieJar.get('jmap_rt_1')?.options).toMatchObject({ sameSite: 'strict', httpOnly: true });
  });

  it('a server off the device\'s list gets nothing written, the token is revoked, and the code is gone', async () => {
    const code = await parkedCode();
    const answer = await redeemIt(code, { allowed_servers: ['https://other.example'] });
    expect(answer.status).toBe(403);
    expect(await answer.json()).toMatchObject({ code: 'blocked_by_policy' });
    expect([...cookieJar.keys()]).toEqual([]);
    expect(revoked).toEqual(['refresh']);
    expect((await redeemIt(code)).status).toBe(400);
  });

  it('a list that names the server lets it through', async () => {
    expect((await redeemIt(await parkedCode(), { allowed_servers: [SERVER] })).status).toBe(200);
  });

  describe('a server of the user\'s own, on an instance that allows them', () => {
    const OWN = 'https://1.1.1.1';
    beforeEach(() => {
      config.values = { jmapServerUrl: SERVER, allowCustomJmapEndpoint: true };
    });

    it('is refused when the device\'s rule says no: forced InstanceUrl, or AllowStandalone off', async () => {
      const code = await parkedCode({ server_url: OWN });
      const answer = await redeemIt(code, { custom_servers_allowed: false });
      expect(answer.status).toBe(403);
      expect(await answer.json()).toMatchObject({ code: 'blocked_by_policy' });
      expect([...cookieJar.keys()]).toEqual([]);
    });

    it('is refused when a page says nothing about it', async () => {
      const code = await parkedCode({ server_url: OWN });
      const { custom_servers_allowed: _left, ...withoutRule } = redeemBody(code);
      expect((await redeem(post('/api/auth/desktop-handoff/redeem', withoutRule))).status).toBe(403);
    });

    it('goes through when the device allows it', async () => {
      expect((await redeemIt(await parkedCode({ server_url: OWN }))).status).toBe(200);
    });

    it('the instance\'s own server is no such thing', async () => {
      expect((await redeemIt(await parkedCode(), { custom_servers_allowed: false })).status).toBe(200);
    });
  });

  it('refuses another origin', async () => {
    const code = await parkedCode();
    expect((await redeem(post('/api/auth/desktop-handoff/redeem', redeemBody(code), 'https://evil.example'))).status).toBe(403);
  });
});

describe('what stays behind', () => {
  const ssoBundle = {
    flow: 'desktop-tokens' as const,
    server_url: SERVER,
    server_id: null,
    custom: false,
    access_token: 'sso-access',
    refresh_token: 'sso-refresh',
    expires_in: 3600,
    signed_in_at: 1,
  };
  const parkedSso = () => stashHandoff(ssoBundle, { challenge: CHALLENGE, state: 's', awaitConfirm: true });
  const discardIt = (code: string) => discard(post('/api/auth/desktop-handoff/discard', { code }));

  it('"Not now" takes the tokens out of the store and revokes the refresh token', async () => {
    const code = await parkedSso();
    expect(heldInMemory()).toContain('sso-refresh');
    expect((await discardIt(code)).status).toBe(200);
    expect(heldInMemory()).not.toContain('sso-refresh');
    expect(heldInMemory()).not.toContain('sso-access');
    expect(revoked).toEqual(['sso-refresh']);
    expect((await redeemIt(code)).status).toBe(400);
  });

  it('a provider with no revocation endpoint: the store is still emptied', async () => {
    discoverOAuth.mockResolvedValue({});
    const code = await parkedSso();
    expect((await discardIt(code)).status).toBe(200);
    expect(heldInMemory()).not.toContain('sso-refresh');
    expect(revoked).toEqual([]);
  });

  it('discards only the desktop\'s, and nothing twice', async () => {
    const phone = await stashHandoff({ flow: 'password', server_url: SERVER, username: 'a', password: 'phone-secret' }, { challenge: CHALLENGE, state: 's' });
    await discardIt(phone);
    expect(heldInMemory()).toContain('phone-secret');
    const code = await parkedSso();
    await discardIt(code);
    await discardIt(code);
    expect(revoked).toEqual(['sso-refresh']);
  });

  it('a code no one knows gets nothing', async () => {
    expect((await discardIt('nonsense')).status).toBe(400);
  });

  it('with nobody coming back, a timer wipes what was parked, at its real expiry', async () => {
    vi.useFakeTimers();
    await stashHandoff({ flow: 'desktop-password', server_url: SERVER, server_id: null, custom: false, username: 'a', password: 'timer-secret' }, { challenge: CHALLENGE, state: 's' });
    await parkedSso();
    expect(heldInMemory()).toContain('timer-secret');
    vi.advanceTimersByTime(HANDOFF_TTL_MS + 2);
    expect(heldInMemory()).not.toContain('timer-secret');
    expect(heldInMemory()).toContain('sso-refresh');
    vi.advanceTimersByTime(HANDOFF_CONFIRM_TTL_MS);
    expect(heldInMemory()).not.toContain('sso-refresh');
  });
});

describe('the two kinds of code stay apart', () => {
  it('the phone\'s redeem gives away nothing of a desktop sign-in', async () => {
    const code = await parkedCode();
    const answer = await mobileRedeem(post('/api/auth/handoff/redeem', { code, code_verifier: VERIFIER }));
    expect(answer.status).toBe(400);
    const body = JSON.stringify(await answer.json());
    expect(body).not.toContain('refresh');
    expect(body).not.toContain('access');
  });

  it('the desktop redeem takes no phone code', async () => {
    const code = await stashHandoff({ flow: 'password', server_url: SERVER, username: 'a', password: 'secret' }, { challenge: CHALLENGE, state: 's' });
    const answer = await redeemIt(code);
    expect(answer.status).toBe(400);
    expect(JSON.stringify(await answer.json())).not.toContain('secret');
  });
});
