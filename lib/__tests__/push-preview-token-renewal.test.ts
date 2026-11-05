// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * #1509: with no tab open, nothing renews a token sign-in's access token, so
 * the one in the auth context expires and the mail server turns the push
 * preview away. The route renews it with the slot's refresh token, as the
 * token route would for a page, and keeps a rotated refresh token as long as
 * the sign-in asked for.
 */

const SECRET = 's'.repeat(64);
vi.mock('@/lib/auth/session-secret', () => ({ getSessionSecret: () => SECRET, hasSessionSecret: () => true }));
vi.mock('@/lib/logger', () => ({ logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } }));
vi.mock('@/lib/oauth/cookie-config', () => ({
  getCookieOptions: () => ({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 2592000 }),
  getSignInCookieOptions: (remember: boolean) => ({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', ...(remember ? { maxAge: 2592000 } : {}) }),
}));

const jar = new Map<string, string>();
const jarOptions = new Map<string, Record<string, unknown> | undefined>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => { jar.set(name, value); jarOptions.set(name, options); },
    delete: (arg: string | { name: string }) => { jar.delete(typeof arg === 'string' ? arg : arg.name); },
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  }),
}));

vi.mock('@/lib/admin/config-manager', async () => {
  const { DEFAULT_POLICY } = await import('@/lib/admin/types');
  return {
    configManager: {
      ensureLoaded: async () => {},
      get: (_key: string, fallback: unknown) => fallback,
      getPolicy: () => DEFAULT_POLICY,
    },
  };
});

vi.mock('@/lib/oauth/token-exchange', () => ({
  exchangeCodeForTokens: async () => ({}),
  buildOAuthParams: (params: Record<string, string>) => new URLSearchParams(params),
  getMetadata: async () => ({}),
  getRequiredConfig: () => ({ clientId: 'webmail' }),
  getTokenEndpoint: async () => 'https://id.example.org/token',
  defaultClientOptions: async () => ({ fallbackClientId: 'bulwark-webmail' }),
  DEFAULT_CLIENT_ID: 'bulwark-webmail',
}));

vi.mock('@/lib/admin/server-device-policy', () => ({
  serverDevicePolicy: async () => ({ pushWithoutContent: false }),
}));

const SERVER = 'https://mail.example.org';
const NEW_MAIL = { id: 'e1', threadId: 't1', subject: 'Hello', from: [{ email: 'carol@example.org' }] };

/** The mail server: takes only the access token the provider issued last. */
let validToken = 'access-2';
const jmapCalls: string[] = [];
vi.mock('@/lib/stalwart/server-fetch', () => ({
  isTrustedJmapServerUrl: async () => true,
  fetchJmapServer: async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    const auth = init?.headers?.Authorization ?? '';
    jmapCalls.push(auth);
    if (auth !== `Bearer ${validToken}`) return Response.json({ error: 'expired' }, { status: 401 });
    if (url.endsWith('/.well-known/jmap')) {
      return Response.json({ apiUrl: `${SERVER}/jmap/`, primaryAccounts: { 'urn:ietf:params:jmap:mail': 'a' }, accounts: { a: {} } });
    }
    const calls = (JSON.parse(init?.body ?? '{}') as { methodCalls: [string, unknown, string][] }).methodCalls;
    return Response.json({
      methodResponses: calls.map(([name, , id]) => {
        if (name === 'Mailbox/query') return [name, { ids: ['inbox'] }, id];
        if (name === 'Email/query') return [name, { ids: ['e1'], total: 1 }, id];
        return [name, { list: [NEW_MAIL] }, id];
      }),
    });
  },
}));

const stateDir = mkdtempSync(path.join(tmpdir(), 'bw-push-renewal-'));
process.env.ADMIN_STATE_DIR = stateDir;
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

const { readSignInStamp, writeSignInStamp } = await import('@/lib/auth/session-age');
const { setStalwartAuthContextInStore } = await import('@/lib/stalwart/auth-context');
const { cookies } = await import('next/headers');
const previewRoute = await import('@/app/api/push/preview/route');
const tokenRoute = await import('@/app/api/auth/token/route');

/** The provider: rotates the refresh token on each renewal. */
const tokenEndpoint = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }));

/**
 * A browser signed in with a provider an hour ago, its tab closed since: the
 * auth context still holds the first access token.
 */
async function signedInAnHourAgo(remember: boolean | 'not recorded', slot = 0, username = 'bob@example.org', refreshToken = 'refresh-1') {
  const store = await cookies();
  jar.set(slot === 0 ? 'jmap_rt' : `jmap_rt_${slot}`, refreshToken);
  writeSignInStamp(
    store,
    slot,
    { signedInAt: Date.now() - 60 * 60 * 1000, refreshToken, account: username },
    // A stamp written before it recorded the choice.
    remember === 'not recorded' ? undefined : { path: '/', ...(remember ? { maxAge: 2592000 } : {}) },
  );
  setStalwartAuthContextInStore(store, slot, { serverUrl: SERVER, username, authHeader: `Bearer old-${slot}` });
}

async function preview(query = 'accountId=a', headers: Record<string, string> = {}) {
  const res = await previewRoute.GET(new NextRequest(`https://webmail.example/api/push/preview?${query}`, { headers }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

/** The refresh tokens the provider was asked to redeem. */
const redeemed = () => tokenEndpoint.mock.calls.map(([, init]) => new URLSearchParams(String(init?.body)).get('refresh_token'));

describe('push preview after the access token expired (#1509)', () => {
  beforeEach(() => {
    jar.clear();
    jarOptions.clear();
    jmapCalls.length = 0;
    validToken = 'access-2';
    tokenEndpoint.mockClear();
    vi.stubGlobal('fetch', tokenEndpoint);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renews the token and previews the new message', async () => {
    await signedInAnHourAgo(true);

    const { status, body } = await preview();

    expect(status).toBe(200);
    expect(body.email).toMatchObject({ id: 'e1', subject: 'Hello' });
    expect(tokenEndpoint).toHaveBeenCalledTimes(1);
    // The rotated refresh token is kept for the page, for 30 days as signed in,
    // and the stamp follows it.
    expect(jar.get('jmap_rt')).toBe('refresh-2');
    expect(jarOptions.get('jmap_rt')).toMatchObject({ maxAge: 2592000 });
    expect(readSignInStamp(await cookies(), 0, 'refresh-2')).toMatchObject({ remember: true, account: 'bob@example.org' });
    expect(jar.get('jmap_at')).toMatch(/\.access-2$/);
  });

  it('keeps a rotated token for the browser session only when the sign-in was not remembered', async () => {
    await signedInAnHourAgo(false);

    expect((await preview()).status).toBe(200);
    expect(jar.get('jmap_rt')).toBe('refresh-2');
    expect(jarOptions.get('jmap_rt')).not.toHaveProperty('maxAge');
    expect(readSignInStamp(await cookies(), 0, 'refresh-2')).toMatchObject({ remember: false });
  });

  it('takes the token renewed last time instead of renewing again', async () => {
    await signedInAnHourAgo(true);
    await preview();

    const { status } = await preview();

    expect(status).toBe(200);
    expect(tokenEndpoint).toHaveBeenCalledTimes(1);
  });

  it('renews once for previews that arrive together', async () => {
    await signedInAnHourAgo(true);

    const results = await Promise.all([preview(), preview()]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    // A second redemption of refresh-1 would be a replay to the provider.
    expect(tokenEndpoint).toHaveBeenCalledTimes(1);
  });

  it('leaves a sign-in alone when its stamp does not say whether it was remembered', async () => {
    await signedInAnHourAgo('not recorded');

    const { status } = await preview();

    expect(status).toBe(401);
    expect(tokenEndpoint).not.toHaveBeenCalled();
    expect(jar.get('jmap_rt')).toBe('refresh-1');
  });

  it('answers 401 when the provider refuses the refresh token', async () => {
    await signedInAnHourAgo(true);
    tokenEndpoint.mockResolvedValueOnce(Response.json({ error: 'invalid_grant' }, { status: 400 }));

    expect((await preview()).status).toBe(401);
  });

  it('renews only the login the push names', async () => {
    await signedInAnHourAgo(true);
    await signedInAnHourAgo(true, 1, 'carol@example.org', 'carol-refresh');

    const { status } = await preview('accountId=a&login=bob@example.org');

    expect(status).toBe(200);
    expect(redeemed()).toEqual(['refresh-1']);
    expect(jar.get('jmap_rt_1')).toBe('carol-refresh');
  });

  it('renews nothing for a push without a login when several are signed in', async () => {
    await signedInAnHourAgo(true);
    await signedInAnHourAgo(true, 1, 'carol@example.org', 'carol-refresh');

    expect((await preview()).status).toBe(401);
    expect(tokenEndpoint).not.toHaveBeenCalled();
  });

  it('turns away a request from another site, which could spend the refresh token', async () => {
    await signedInAnHourAgo(true);

    const { status } = await preview('accountId=a', { 'sec-fetch-site': 'cross-site' });

    expect(status).toBe(403);
    expect(tokenEndpoint).not.toHaveBeenCalled();
    expect(jar.get('jmap_rt')).toBe('refresh-1');
  });

  it('answers the service worker, whose fetch is same-origin', async () => {
    await signedInAnHourAgo(true);
    expect((await preview('accountId=a', { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
  });

  it('has the page record the choice in a stamp from before', async () => {
    await signedInAnHourAgo('not recorded');
    jar.set('jmap_at', `${Math.floor(Date.now() / 1000) + 600}.old-0`);

    const res = await tokenRoute.PUT(new NextRequest('https://webmail.example/api/auth/token?slot=0&remember=false', {
      method: 'PUT',
      headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
    }));

    expect(res.status).toBe(200);
    expect(readSignInStamp(await cookies(), 0, 'refresh-1')).toMatchObject({ remember: false });
  });
});
