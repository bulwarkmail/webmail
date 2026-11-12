// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// What the catch-all of a sign-in, session, hand-off or pairing route logs:
// the error's message, except a JSON parser's. A parser quotes the text it
// read, here a request body with a password in it or a stored record with
// tokens, so the log gets a fixed message instead.

const SECRET = 'TOKEN-SECRET';
const hoisted = vi.hoisted(() => ({
  logged: [] as unknown[][],
  /** A parser's error over a record that holds a token. */
  garbled: () => new SyntaxError('Unexpected token \'T\', "{"t":TOKEN-SECRET}" is not valid JSON'),
  /** Reading these cookies fails like a garbled record. */
  explode: false,
}));

vi.mock('@/lib/logger', () => {
  const record = (...args: unknown[]) => { hoisted.logged.push(args); };
  return { logger: { warn: record, error: record, debug: record, info: record } };
});
vi.mock('@/lib/auth/session-secret', () => ({ getSessionSecret: () => 's'.repeat(64), hasSessionSecret: () => true }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback?: unknown) => (key === 'jmapServerUrl' ? 'https://mail.example' : fallback),
    getPolicy: () => ({}),
  },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => { if (hoisted.explode) throw hoisted.garbled(); return undefined; },
    set: () => {},
    delete: () => {},
    getAll: () => [],
  }),
}));
// The stores and lookups the hand-off and pairing routes read records through.
vi.mock('@/lib/auth/handoff-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/handoff-store')>()),
  reserveHandoffCreate: async () => { throw hoisted.garbled(); },
  confirmHandoff: async () => { throw hoisted.garbled(); },
  reserveHandoffRedeem: async () => { throw hoisted.garbled(); },
  discardDesktopHandoff: async () => { throw hoisted.garbled(); },
}));
vi.mock('@/lib/auth/pairing-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/pairing-store')>()),
  redeemPairingCode: async () => { throw hoisted.garbled(); },
  getPairingStatus: async () => { throw hoisted.garbled(); },
}));
vi.mock('@/lib/auth/desktop-handoff-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/desktop-handoff-server')>()),
  desktopHandoffEnabled: () => true,
  resolveDesktopHandoffServer: async () => { throw hoisted.garbled(); },
}));
vi.mock('@/lib/auth/pair-bundle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/pair-bundle')>()),
  openPhoneRefreshToken: () => ({ refreshToken: 'rt', clientId: 'app', tokenEndpoint: 'https://idp.example/token', trusted: false, serverId: null }),
}));
vi.mock('@/lib/security/url-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/url-guard')>()),
  fetchPublicUrl: async () => { throw hoisted.garbled(); },
}));

const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'content-type': 'application/json', origin: 'https://webmail.example' };
/** Short enough for the parser to quote it whole. */
const GARBLED_BODY = `{"p":${SECRET}}`;
const CHALLENGE = 'c'.repeat(43);
const CODE = 'a'.repeat(64);

const post = (path: string, body: unknown, headers: Record<string, string> = SAME_ORIGIN) => new NextRequest(`https://webmail.example${path}`, {
  method: 'POST',
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const get = (path: string, method = 'GET') => new NextRequest(`https://webmail.example${path}`, { method, headers: SAME_ORIGIN });

const cases: Array<[string, () => Promise<Response>]> = [
  ['password sign-in, a body that is not JSON', async () => (await import('@/app/api/auth/session/route')).POST(post('/api/auth/session', GARBLED_BODY))],
  ['two-factor sign-in, a body that is not JSON', async () => (await import('@/app/api/auth/totp-token-exchange/route')).POST(post('/api/auth/totp-token-exchange', GARBLED_BODY))],
  ['session restore', async () => { hoisted.explode = true; return (await import('@/app/api/auth/session/route')).GET(get('/api/auth/session')); }],
  ['session credentials', async () => { hoisted.explode = true; return (await import('@/app/api/auth/session/route')).PUT(get('/api/auth/session', 'PUT')); }],
  ['sign-out', async () => { hoisted.explode = true; return (await import('@/app/api/auth/session/route')).DELETE(get('/api/auth/session', 'DELETE')); }],
  ['mobile hand-off create', async () => (await import('@/app/api/auth/handoff/create/route')).POST(post('/api/auth/handoff/create', { code_challenge: CHALLENGE, state: 's', server_url: 'https://mail.example', username: 'u', password: 'p' }))],
  ['mobile hand-off confirm', async () => (await import('@/app/api/auth/handoff/confirm/route')).POST(post('/api/auth/handoff/confirm', { code: CODE }))],
  ['mobile hand-off redeem', async () => (await import('@/app/api/auth/handoff/redeem/route')).POST(post('/api/auth/handoff/redeem', { code: CODE, code_verifier: 'v'.repeat(43) }))],
  ['desktop hand-off check', async () => (await import('@/app/api/auth/desktop-handoff/check/route')).POST(post('/api/auth/desktop-handoff/check', { server_url: 'https://mail.example', username: 'u', password: 'p' }))],
  ['desktop hand-off discard', async () => (await import('@/app/api/auth/desktop-handoff/discard/route')).POST(post('/api/auth/desktop-handoff/discard', { code: CODE }))],
  ['desktop hand-off redeem', async () => (await import('@/app/api/auth/desktop-handoff/redeem/route')).POST(post('/api/auth/desktop-handoff/redeem', { code: CODE, code_verifier: 'v'.repeat(43) }))],
  ['desktop hand-off park', async () => (await import('@/app/api/auth/desktop-handoff/park/route')).POST(post('/api/auth/desktop-handoff/park', { code_challenge: CHALLENGE, state: 's', server_url: 'https://mail.example', username: 'u', password: 'p' }))],
  ['pairing create', async () => { hoisted.explode = true; return (await import('@/app/api/auth/pair/create/route')).POST(post('/api/auth/pair/create', { webmail_base: 'https://webmail.example' })); }],
  ['pairing redeem', async () => (await import('@/app/api/auth/pair/redeem/route')).POST(post('/api/auth/pair/redeem', { pairing_code: CODE }))],
  ['pairing status', async () => (await import('@/app/api/auth/pair/status/route')).GET(get(`/api/auth/pair/status?id=${'b'.repeat(32)}`))],
  ['pairing token proxy', async () => (await import('@/app/api/auth/pair/token/route')).POST(post('/api/auth/pair/token', 'grant_type=refresh_token&refresh_token=sealed', { ...SAME_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }))],
];

// Every route is loaded once, on first use.
vi.setConfig({ testTimeout: 30_000 });

describe('what a sign-in, session, hand-off or pairing route logs of a garbled body or record', () => {
  beforeEach(() => {
    hoisted.logged.length = 0;
    hoisted.explode = false;
  });

  it.each(cases)('%s: a fixed message, nothing of the text', async (_name, call) => {
    const res = await call();
    expect(res.status).toBeGreaterThanOrEqual(500);
    const text = JSON.stringify(hoisted.logged);
    expect(hoisted.logged.length).toBeGreaterThan(0);
    expect(text).not.toContain(SECRET);
    expect(text).toContain('Not valid JSON');
  });
});
