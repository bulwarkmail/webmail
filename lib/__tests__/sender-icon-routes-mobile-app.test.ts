// @vitest-environment node
/**
 * The mobile app (0.1.88 and later) shows brand logos from the webmail it signed in through:
 * src/lib/avatar-bimi.ts builds `<webmail>/api/bimi?domain=<From domain>` and SenderAvatar loads
 * it with a React Native <Image>, i.e. the platform's HTTP client: no webmail session, and none of
 * the headers a browser page or frame sends (Origin, Referer, Sec-Fetch-*). It never calls
 * /api/favicon (it asks DuckDuckGo itself). Shipped apps can't change, so /api/bimi serves such a
 * request with a strict budget per client address; anything that looks like a browser still needs
 * a session.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const notFound = () => Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
const resolveTxt = vi.hoisted(() => vi.fn(async (_name: string): Promise<string[][]> => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); }));
vi.mock('node:dns/promises', () => ({ resolveTxt, lookup: vi.fn(), default: { resolveTxt, lookup: vi.fn() } }));
vi.mock('@/lib/admin/third-party-mode', () => ({
  isNoThirdPartyTrafficOn: vi.fn(async () => false),
  thirdPartyRefusal: () => new Response(null, { status: 403 }),
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: vi.fn(async () => {}), get: vi.fn((_k: string, fallback: unknown) => fallback), getPolicy: () => ({ features: {} }) },
}));
// A deployment that tells sessions apart; the app sends no cookies.
vi.mock('@/lib/auth/session-secret', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session-secret')>()),
  hasSessionSecret: () => true,
  getSessionSecret: () => 's'.repeat(64),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));

import { SESSIONLESS_LOOKUPS_PER_MINUTE, SESSIONLESS_RUNNING_PER_CALLER } from '@/lib/sender-icon-access';
import { GET as bimi } from '@/app/api/bimi/route';
import { GET as favicon } from '@/app/api/favicon/route';

const upstream = vi.fn(async () => new Response(new Uint8Array(64).fill(7), { headers: { 'content-type': 'image/png' } }));

beforeEach(() => {
  resolveTxt.mockReset();
  resolveTxt.mockImplementation(async () => { throw notFound(); });
  upstream.mockClear();
  vi.stubGlobal('fetch', upstream);
});

/** What the app's image loader sends on Android (OkHttp) and iOS (CFNetwork), from the client address `address`. */
const android = (address: string) => ({ 'user-agent': 'okhttp/4.12.0', 'accept-encoding': 'gzip', 'x-forwarded-for': address });
const ios = (address: string) => ({
  'user-agent': 'Bulwark/92 CFNetwork/1568.100.1 Darwin/24.0.0', accept: 'image/*,*/*;q=0.8', 'accept-language': 'de-DE,de;q=0.9', 'accept-encoding': 'gzip, deflate, br', 'x-forwarded-for': address,
});
const get = (path: string, headers: Record<string, string>) => new NextRequest(`https://webmail.example${path}`, { headers });
const lookedUp = (domain: string) => resolveTxt.mock.calls.some(([name]) => name === `_dmarc.${domain}`);

describe('/api/bimi for the mobile app, without a session', () => {
  it.each([['Android', android('192.0.2.10')], ['iOS', ios('192.0.2.11')]])('serves the logo request the app makes on %s', async (_name, headers) => {
    const res = await bimi(get(`/api/bimi?domain=app-${headers['user-agent'].length}.example`, headers));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-bulwark-bimi')).toBe('missing');
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(resolveTxt).toHaveBeenCalled();
  });

  it.each([
    ['another site\'s page', { referer: 'https://elsewhere.example/page' }],
    ['a sandboxed frame', { origin: 'null' }],
    ['a browser that sends fetch metadata', { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }],
    ['a page of this webmail without a session', { 'sec-fetch-site': 'same-origin' }],
  ])('refuses %s without a lookup', async (_name, extra) => {
    const res = await bimi(get('/api/bimi?domain=browser-like.example', { ...android('192.0.2.12'), ...extra }));
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(lookedUp('browser-like.example')).toBe(false);
  });

  it('gives only the logo: what backs it is for the signed-in message view', async () => {
    const res = await bimi(get('/api/bimi?domain=details.example&format=json', android('192.0.2.13')));
    expect(res.status).toBe(401);
    expect(lookedUp('details.example')).toBe(false);
  });

  it('does not serve /api/favicon, which the app never calls', async () => {
    const res = await favicon(get('/api/favicon?domain=icon.example', android('192.0.2.14')));
    expect(res.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it(`looks up at most ${SESSIONLESS_LOOKUPS_PER_MINUTE} new domains a minute for one client address`, async () => {
    for (let i = 0; i < SESSIONLESS_LOOKUPS_PER_MINUTE; i++) await bimi(get(`/api/bimi?domain=n${i}.example`, android('192.0.2.20')));
    expect(resolveTxt).toHaveBeenCalledTimes(SESSIONLESS_LOOKUPS_PER_MINUTE);
    const over = await bimi(get('/api/bimi?domain=over.example', android('192.0.2.20')));
    expect(over.headers.get('x-bulwark-bimi')).toBe('missing');
    expect(over.headers.get('cache-control')).toBe('no-store');
    expect(lookedUp('over.example')).toBe(false);
    // Another address has its own budget.
    await bimi(get('/api/bimi?domain=over.example', android('192.0.2.21')));
    expect(lookedUp('over.example')).toBe(true);
  });

  it(`runs at most ${SESSIONLESS_RUNNING_PER_CALLER} lookups at once for one client address`, async () => {
    const held: Array<() => void> = [];
    resolveTxt.mockImplementation((name: string) => (name.includes('.slowapp')
      ? new Promise((_resolve, reject) => { held.push(() => reject(notFound())); })
      : Promise.reject(notFound())));
    const slow = Array.from({ length: SESSIONLESS_RUNNING_PER_CALLER }, (_, i) => bimi(get(`/api/bimi?domain=slowapp${i}.example`, ios('192.0.2.30'))));
    await vi.waitFor(() => expect(held).toHaveLength(SESSIONLESS_RUNNING_PER_CALLER));

    const waiting = await bimi(get('/api/bimi?domain=waiting.example', ios('192.0.2.30')));
    expect(waiting.headers.get('cache-control')).toBe('no-store');
    expect(lookedUp('waiting.example')).toBe(false);

    for (const release of held) release();
    await Promise.all(slow);
    // Once they are done, the next one runs.
    await bimi(get('/api/bimi?domain=waiting.example', ios('192.0.2.30')));
    expect(lookedUp('waiting.example')).toBe(true);
  });
});
