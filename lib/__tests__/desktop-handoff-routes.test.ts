import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';

/**
 * The desktop app's sign-in on an instance: what the browser parks, and what the app's
 * own page gets for the code. The real store and routes, with the mail server faked.
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

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } }));

// This file parks more sign-ins than one client may in a quarter of an hour.
vi.mock('@/lib/auth/handoff-store', async (original) => ({
  ...(await original<object>()),
  reserveHandoffCreate: async () => true,
  reserveHandoffRedeem: async () => async () => {},
}));

const { POST: park } = await import('@/app/api/auth/desktop-handoff/park/route');
const { POST: redeem } = await import('@/app/api/auth/desktop-handoff/redeem/route');
const { POST: mobileRedeem } = await import('@/app/api/auth/handoff/redeem/route');
const { JmapAuthVerificationError } = await import('@/lib/auth/verify-jmap-auth');
const { confirmHandoff, resetHandoffStoreForTests, stashHandoff } = await import('@/lib/auth/handoff-store');
const { desktopHandoffTarget, mobileHandoffTarget } = await import('@/lib/auth/mobile-handoff');
const { isDesktopBlockedRoute } = await import('@/lib/desktop/blocked-routes');

const ORIGIN = 'https://bulwark.example';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER, 'ascii').digest('base64url');
const SERVER = 'https://mail.example';

function post(path: string, body: unknown, origin = ORIGIN) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Host: 'bulwark.example' },
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

async function parkedCode(extra: Record<string, unknown> = {}): Promise<string> {
  const answer = await park(post('/api/auth/desktop-handoff/park', parkBody(extra)));
  expect(answer.status).toBe(200);
  const { code } = (await answer.json()) as { code: string };
  // What the page does when the user confirms.
  expect(await confirmHandoff(code)).toBe(true);
  return code;
}

const redeemBody = (code: string, extra: Record<string, unknown> = {}) => ({ code, code_verifier: VERIFIER, slot: 1, remember: true, allowed_servers: null, ...extra });

beforeEach(() => {
  cookieJar.clear();
  resetHandoffStoreForTests();
  config.values = { jmapServerUrl: SERVER };
  verifyJmapAuth.mockReset();
  verifyJmapAuth.mockResolvedValue(undefined);
  stalwartPasswordLogin.mockReset();
  reserveLoginAttempt.mockReset();
  reserveLoginAttempt.mockResolvedValue(async () => {});
});

afterEach(() => {
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

  it('the embedded build has none of these routes', () => {
    expect(isDesktopBlockedRoute('/api/auth/desktop-handoff/park')).toBe(true);
    expect(isDesktopBlockedRoute('/api/auth/desktop-handoff/redeem')).toBe(true);
    expect(isDesktopBlockedRoute('/api/auth/desktop-oauth')).toBe(false);
  });
});

describe('parking a sign-in, in the browser', () => {
  it('leaves this browser with no session', async () => {
    await parkedCode();
    expect([...cookieJar.keys()]).toEqual([]);
  });

  it('refuses another origin', async () => {
    const answer = await park(post('/api/auth/desktop-handoff/park', parkBody(), 'https://evil.example'));
    expect(answer.status).toBe(403);
    expect(verifyJmapAuth).not.toHaveBeenCalled();
  });

  it.each([
    ['no challenge', { code_challenge: '' }],
    ['a bad challenge', { code_challenge: 'short' }],
    ['no state', { state: '' }],
    ['no password', { password: '' }],
  ])('refuses %s', async (_name, extra) => {
    const answer = await park(post('/api/auth/desktop-handoff/park', parkBody(extra)));
    expect(answer.status).toBe(400);
    expect(verifyJmapAuth).not.toHaveBeenCalled();
  });

  it('holds no password on an OAuth-only instance', async () => {
    config.values = { jmapServerUrl: SERVER, oauthEnabled: true, oauthOnly: true };
    const answer = await park(post('/api/auth/desktop-handoff/park', parkBody()));
    expect(answer.status).toBe(403);
    expect(verifyJmapAuth).not.toHaveBeenCalled();
  });

  it('a wrong password parks nothing and says so', async () => {
    verifyJmapAuth.mockRejectedValue(new JmapAuthVerificationError('no', 401, 401));
    const answer = await park(post('/api/auth/desktop-handoff/park', parkBody()));
    expect(answer.status).toBe(401);
    expect(await answer.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('asks for the second factor when the server answers 402', async () => {
    verifyJmapAuth.mockRejectedValue(new JmapAuthVerificationError('no', 401, 402));
    const answer = await park(post('/api/auth/desktop-handoff/park', parkBody()));
    expect(await answer.json()).toEqual({ error: 'totp_required' });
  });

  it('over the login budget, nothing reaches the mail server', async () => {
    reserveLoginAttempt.mockResolvedValue(null);
    const answer = await park(post('/api/auth/desktop-handoff/park', parkBody()));
    expect(answer.status).toBe(429);
    expect(verifyJmapAuth).not.toHaveBeenCalled();
  });

  it('what was checked is what is parked: the body can\'t name another server for the app', async () => {
    config.values = { jmapServerUrl: SERVER, jmapServers: [{ id: 'two', url: 'https://two.example', name: 'Two' }] };
    const code = await parkedCode({ server_id: 'two', server_url: 'https://evil.example' });
    expect(verifyJmapAuth.mock.calls[0][0]).toBe('https://two.example');
    const answer = await redeem(post('/api/auth/desktop-handoff/redeem', redeemBody(code)));
    expect(await answer.json()).toMatchObject({ server_url: 'https://two.example' });
  });

  it('never goes to a server the instance does not know', async () => {
    const answer = await park(post('/api/auth/desktop-handoff/park', parkBody({ server_url: 'https://evil.example' })));
    expect(answer.status).toBe(400);
    expect(verifyJmapAuth).not.toHaveBeenCalled();
  });

  it('a code is not live until the user confirms', async () => {
    const answer = await park(post('/api/auth/desktop-handoff/park', parkBody()));
    const { code } = (await answer.json()) as { code: string };
    const redeemed = await redeem(post('/api/auth/desktop-handoff/redeem', redeemBody(code)));
    expect(redeemed.status).toBe(400);
  });
});

describe('redeeming, in the app', () => {
  it('a password goes to the page, once, and no cookie is written for it', async () => {
    const code = await parkedCode();
    const answer = await redeem(post('/api/auth/desktop-handoff/redeem', redeemBody(code)));
    expect(answer.status).toBe(200);
    expect(answer.headers.get('Cache-Control')).toBe('no-store');
    expect(await answer.json()).toEqual({ flow: 'password', server_url: SERVER, username: 'a@example.org', password: 'secret' });
    expect([...cookieJar.keys()]).toEqual([]);

    const again = await redeem(post('/api/auth/desktop-handoff/redeem', redeemBody(code)));
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: 'invalid_code' });
  });

  it('a wrong verifier gets nothing, and spends the code', async () => {
    const code = await parkedCode();
    const wrong = await redeem(post('/api/auth/desktop-handoff/redeem', redeemBody(code, { code_verifier: 'w'.repeat(64) })));
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: 'invalid_verifier' });
    const right = await redeem(post('/api/auth/desktop-handoff/redeem', redeemBody(code)));
    expect(right.status).toBe(400);
  });

  it('a late code is told so', async () => {
    const code = await parkedCode();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    const answer = await redeem(post('/api/auth/desktop-handoff/redeem', redeemBody(code)));
    expect(answer.status).toBe(400);
    expect(await answer.json()).toEqual({ error: 'expired_code' });
  });

  it('a two-factor sign-in parks tokens, not the password, and the app gets its own cookie', async () => {
    stalwartPasswordLogin.mockResolvedValue({
      ok: true,
      tokens: { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 },
      tokenEndpoint: `${SERVER}/auth/token`,
      clientId: 'x',
    });
    const code = await parkedCode({ totp: '123456' });
    expect(stalwartPasswordLogin.mock.calls[0][0]).toMatchObject({ serverUrl: SERVER, totp: '123456', trusted: true });
    expect(verifyJmapAuth).not.toHaveBeenCalled();
    expect([...cookieJar.keys()]).toEqual([]);

    const answer = await redeem(post('/api/auth/desktop-handoff/redeem', redeemBody(code)));
    const body = await answer.json();
    expect(body).toMatchObject({ flow: 'tokens', server_url: SERVER, access_token: 'access', remember: true });
    expect(JSON.stringify(body)).not.toContain('refresh');
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(cookieJar.get('jmap_rt_1')?.value).toBe('refresh');
    expect(cookieJar.get('jmap_rt_1')?.options).toMatchObject({ httpOnly: true });
  });

  it('keeps the instance\'s strict cookies strict', async () => {
    config.values = { jmapServerUrl: SERVER, cookieSameSite: 'strict' };
    stalwartPasswordLogin.mockResolvedValue({ ok: true, tokens: { access_token: 'a', refresh_token: 'r', expires_in: 60 }, tokenEndpoint: 't', clientId: 'x' });
    const code = await parkedCode({ totp: '123456' });
    await redeem(post('/api/auth/desktop-handoff/redeem', redeemBody(code)));
    expect(cookieJar.get('jmap_rt_1')?.options).toMatchObject({ sameSite: 'strict' });
  });

  it('a wrong code from the server\'s side parks nothing', async () => {
    stalwartPasswordLogin.mockResolvedValue({ ok: false, error: 'invalid_credentials' });
    const answer = await park(post('/api/auth/desktop-handoff/park', parkBody({ totp: '000000' })));
    expect(answer.status).toBe(401);
  });

  it('a server off the device\'s list gets nothing written, and the code is gone', async () => {
    stalwartPasswordLogin.mockResolvedValue({ ok: true, tokens: { access_token: 'a', refresh_token: 'r', expires_in: 60 }, tokenEndpoint: 't', clientId: 'x' });
    const code = await parkedCode({ totp: '123456' });
    const answer = await redeem(post('/api/auth/desktop-handoff/redeem', redeemBody(code, { allowed_servers: ['https://other.example'] })));
    expect(answer.status).toBe(403);
    expect(await answer.json()).toMatchObject({ code: 'blocked_by_policy' });
    expect([...cookieJar.keys()]).toEqual([]);
    const again = await redeem(post('/api/auth/desktop-handoff/redeem', redeemBody(code)));
    expect(again.status).toBe(400);
  });

  it('a list that names the server lets it through', async () => {
    const code = await parkedCode();
    const answer = await redeem(post('/api/auth/desktop-handoff/redeem', redeemBody(code, { allowed_servers: [SERVER] })));
    expect(answer.status).toBe(200);
  });

  it('refuses another origin', async () => {
    const code = await parkedCode();
    const answer = await redeem(post('/api/auth/desktop-handoff/redeem', redeemBody(code), 'https://evil.example'));
    expect(answer.status).toBe(403);
  });
});

describe('the two kinds of code stay apart', () => {
  it('the phone\'s redeem gives away nothing of a desktop sign-in', async () => {
    const code = await parkedCode();
    const answer = await mobileRedeem(post('/api/auth/handoff/redeem', { code, code_verifier: VERIFIER }));
    expect(answer.status).toBe(400);
    expect(JSON.stringify(await answer.json())).not.toContain('secret');
  });

  it('the desktop redeem takes no phone code', async () => {
    const code = await stashHandoff({ flow: 'password', server_url: SERVER, username: 'a', password: 'secret' }, { challenge: CHALLENGE, state: 's' });
    const answer = await redeem(post('/api/auth/desktop-handoff/redeem', redeemBody(code)));
    expect(answer.status).toBe(400);
    expect(JSON.stringify(await answer.json())).not.toContain('secret');
  });
});
