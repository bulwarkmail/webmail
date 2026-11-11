// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// A provider's token answer is never written to the log. An answer without
// access_token can still hold a refresh or id token, and an error body can
// repeat what was sent: the log gets the field names, or the OAuth error code.

const logged = vi.hoisted(() => [] as unknown[][]);
vi.mock('@/lib/logger', () => {
  const record = (...args: unknown[]) => { logged.push(args); };
  return { logger: { warn: record, error: record, debug: record, info: record } };
});
vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback?: unknown) => ({ jmapServerUrl: 'https://mail.example', oauthClientId: 'webmail' } as Record<string, unknown>)[key] ?? fallback,
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

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'content-type': 'application/json' };
const SECRETS = ['RT-ROTATED-SECRET', 'ID-TOKEN-SECRET', 'RT-SENT-SECRET', 'the grant RT-SENT-SECRET was revoked'];

/** What the token endpoint answers next. */
let tokenAnswer: Response;
function provider(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input));
  if (url.pathname.startsWith('/.well-known/')) {
    return Promise.resolve(Response.json({
      issuer: url.origin,
      authorization_endpoint: `${url.origin}/authorize`,
      token_endpoint: `${url.origin}/token`,
    }));
  }
  return Promise.resolve(tokenAnswer);
}

const missingAccessToken = () => Response.json({ refresh_token: 'RT-ROTATED-SECRET', id_token: 'ID-TOKEN-SECRET', token_type: 'Bearer' });
const errorWithBody = () => Response.json(
  { error: 'invalid_grant', error_description: 'the grant RT-SENT-SECRET was revoked', refresh_token: 'RT-SENT-SECRET' },
  { status: 400 },
);

function logText(): string {
  return JSON.stringify(logged);
}

async function renew() {
  jar.set('jmap_rt', 'RT-SENT-SECRET');
  const { PUT } = await import('@/app/api/auth/token/route');
  return PUT(new NextRequest('https://webmail.example/api/auth/token?slot=0&force=true', { method: 'PUT', headers: SAME_ORIGIN }));
}

describe('what goes into the log from a token answer', () => {
  beforeEach(() => {
    vi.resetModules();
    jar = new Map();
    logged.length = 0;
    vi.stubGlobal('fetch', vi.fn(provider));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('names the fields of a renewal answer without access_token, not their values', async () => {
    tokenAnswer = missingAccessToken();
    const res = await renew();
    expect(res.status).toBe(502);
    for (const secret of SECRETS) expect(logText()).not.toContain(secret);
    expect(logText()).toContain('refresh_token');
  });

  it('gives the OAuth error code of a refused renewal, not its body', async () => {
    tokenAnswer = errorWithBody();
    const res = await renew();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_grant' });
    for (const secret of SECRETS) expect(logText()).not.toContain(secret);
    expect(logText()).toContain('invalid_grant');
  });

  it('does the same for a code exchange', async () => {
    const { exchangeCodeForTokens } = await import('@/lib/oauth/token-exchange');
    tokenAnswer = missingAccessToken();
    await expect(exchangeCodeForTokens('code', 'v'.repeat(43), 'https://webmail.example/en/auth/callback')).rejects.toThrow();
    tokenAnswer = errorWithBody();
    await expect(exchangeCodeForTokens('code', 'v'.repeat(43), 'https://webmail.example/en/auth/callback')).rejects.toThrow();
    for (const secret of SECRETS) expect(logText()).not.toContain(secret);
    expect(logText()).toContain('invalid_grant');
  });
});
