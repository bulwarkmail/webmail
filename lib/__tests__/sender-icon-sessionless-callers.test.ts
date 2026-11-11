// @vitest-environment node
/**
 * /api/bimi serves the mobile app without a session. What that opening must not become:
 *  1. a way in for a browser. A page or a sandboxed frame is told from the app by the headers a
 *     browser adds, but a browser adds none of Origin, Referer and Sec-Fetch-* to an image request
 *     when the webmail is served over plain HTTP (fetch metadata is only sent to HTTPS and
 *     localhost) or when the browser predates fetch metadata (Safari before 16.4), and the frame
 *     asks for no referrer. Such a request still says it is a browser in its User-Agent, which a
 *     page cannot change; the app's HTTP clients (OkHttp, CFNetwork) don't.
 *  2. a way to take the lookups from signed-in users. The limits for sessionless clients are per
 *     client address, and a caller has as many addresses as it likes (an IPv6 prefix, or any
 *     X-Forwarded-For it writes when the server is reached without a proxy). So together they may
 *     not hold every lookup the server runs, nor look up an unbounded number of names a minute.
 *
 * So all sessionless clients together have a small pool of their own: a few lookups at once, a
 * number of new names a minute, and answers kept apart from the ones signed-in lookups cached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('@/lib/auth/session-secret', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session-secret')>()),
  hasSessionSecret: () => true,
  getSessionSecret: () => 's'.repeat(64),
}));
// next/headers reads the cookies of the request being handled.
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined), getAll: () => [] }),
}));
// The logo host of the one sender that has a logo here.
const LOGO = '<svg version="1.2" baseProfile="tiny-ps" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Brand</title><rect width="10" height="10" fill="#c00"/></svg>';
const fetchPublicUrl = vi.hoisted(() => vi.fn());
vi.mock('@/lib/security/url-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/url-guard')>()),
  fetchPublicUrl,
}));

import { encryptPayload } from '@/lib/auth/crypto';
import { SESSIONLESS_MAX_IN_FLIGHT } from '@/lib/bimi/lookup';
import { stalwartAuthContextCookieName } from '@/lib/stalwart/auth-context';
import { RUNNING_PER_CALLER, SESSIONLESS_LOOKUPS_PER_MINUTE_TOTAL } from '@/lib/sender-icon-access';
import { GET as bimi } from '@/app/api/bimi/route';

// Each case runs in a minute of its own, so the counts of one don't reach into the next.
let minute = 0;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 10, 2) + minute++ * 10 * 60_000);
  resolveTxt.mockReset();
  resolveTxt.mockImplementation(async () => { throw notFound(); });
  fetchPublicUrl.mockReset();
  fetchPublicUrl.mockImplementation(async () => new Response(LOGO, { headers: { 'content-type': 'image/svg+xml' } }));
  jar.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

type Headers = Record<string, string>;
/** A request without cookies, from the client address `address` as the reverse proxy reports it. */
function sessionless(path: string, address: string, headers: Headers) {
  jar.clear();
  return new NextRequest(`https://webmail.example${path}`, { headers: { 'x-forwarded-for': address, ...headers } });
}
/** A request of the signed-in mail view. */
function signedIn(path: string, username: string) {
  jar.clear();
  const name = stalwartAuthContextCookieName(0);
  const value = encryptPayload({ serverUrl: 'https://mail.example', username, authHeader: 'Basic eDp4' }, 'session-context');
  jar.set(name, value);
  return new NextRequest(`https://webmail.example${path}`, { headers: { cookie: `${name}=${value}`, 'sec-fetch-site': 'same-origin' } });
}
const lookedUp = (domain: string) => resolveTxt.mock.calls.some(([name]) => name === `_dmarc.${domain}`);
const lookups = (of?: string) => resolveTxt.mock.calls.filter(([name]) => (of ? name === `_dmarc.${of}` : name.startsWith('_dmarc.'))).length;

/** What the app's image loader sends. */
const ANDROID = { 'user-agent': 'okhttp/4.12.0', 'accept-encoding': 'gzip' };
const IOS = { 'user-agent': 'Bulwark/92 CFNetwork/1568.100.1 Darwin/24.0.0', accept: 'image/*,*/*;q=0.8', 'accept-language': 'de-DE,de;q=0.9', 'accept-encoding': 'gzip, deflate, br' };
/**
 * What a browser sends for <img referrerpolicy="no-referrer" src="/api/bimi?domain=..."> in a
 * sandboxed frame, where it sends no fetch metadata: no cookie (the frame is another site to the
 * webmail), no Origin, no Referer, no Sec-Fetch-*.
 */
const CHROME_ON_PLAIN_HTTP = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', 'accept-encoding': 'gzip, deflate',
};
const FIREFOX_ON_PLAIN_HTTP = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0',
  accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5', 'accept-language': 'en-US,en;q=0.5', 'accept-encoding': 'gzip, deflate',
};
const SAFARI_15 = {
  'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
  accept: 'image/webp,image/png,image/svg+xml,image/*;q=0.8,video/*;q=0.8,*/*;q=0.5', 'accept-language': 'en-GB,en;q=0.9', 'accept-encoding': 'gzip, deflate, br',
};

/** DNS answers that hang for the senders whose name starts with `prefix` until `release` is called, and how many hang now. */
function slowSenders(prefix: string) {
  const held: Array<() => void> = [];
  resolveTxt.mockImplementation((name: string) => (name.startsWith(`_dmarc.${prefix}`)
    ? new Promise((_resolve, reject) => { held.push(() => reject(notFound())); })
    : Promise.reject(notFound())));
  return { held, release: () => { for (const go of held.splice(0)) go(); } };
}
/** Time for requests that may start a lookup to reach DNS. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

describe('/api/bimi without a session', () => {
  // Control: the app keeps its logos.
  it.each([['Android', ANDROID], ['iOS', IOS]])('serves the app on %s', async (name, headers) => {
    const res = await bimi(sessionless(`/api/bimi?domain=app-on-${name.toLowerCase()}.example`, '192.0.2.10', headers));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(lookedUp(`app-on-${name.toLowerCase()}.example`)).toBe(true);
  });

  it.each([
    ['Chromium, webmail on plain HTTP', 'frame-chromium.example', CHROME_ON_PLAIN_HTTP],
    ['Firefox, webmail on plain HTTP', 'frame-firefox.example', FIREFOX_ON_PLAIN_HTTP],
    ['Safari 15, which sends no fetch metadata', 'frame-safari.example', SAFARI_15],
  ])('looks nothing up for an image request of a browser frame that asked for no referrer (%s)', async (_name, domain, headers) => {
    const res = await bimi(sessionless(`/api/bimi?domain=${domain}`, '192.0.2.11', headers));
    expect(lookedUp(domain)).toBe(false);
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('leaves lookups for signed-in users while sessionless clients of many addresses have lookups running', async () => {
    const held: Array<() => void> = [];
    resolveTxt.mockImplementation((name: string) => (name.includes('.slow-zone.')
      ? new Promise((_resolve, reject) => { held.push(() => reject(notFound())); })
      : Promise.reject(notFound())));
    // 16 addresses of one IPv6 prefix, each with as many slow lookups as one address may run.
    const running: Array<Promise<Response>> = [];
    for (let a = 1; a <= 16; a++) {
      for (let i = 0; i < 4; i++) running.push(bimi(sessionless(`/api/bimi?domain=n${a}-${i}.slow-zone.example`, `2001:db8:1:1::${a.toString(16)}`, ANDROID)));
    }
    // Time for those that may start to reach DNS (none do where sessionless clients are refused).
    await new Promise((resolve) => setTimeout(resolve, 200));

    const res = await bimi(signedIn('/api/bimi?domain=a-real-sender.example', 'anna@example.org'));
    const started = lookedUp('a-real-sender.example');
    const cacheControl = res.headers.get('cache-control');
    for (const release of held) release();
    await Promise.all(running);

    expect(started).toBe(true);
    expect(cacheControl).toBe('private, max-age=3600');
  });

  it('looks up a bounded number of new names a minute for sessionless clients together, whatever address each request names', async () => {
    // As many names as the shared cache holds, each request under another address.
    const total = 2000;
    for (let i = 0; i < total; i++) {
      await bimi(sessionless(`/api/bimi?domain=made-up-${i}.example`, `198.51.${Math.floor(i / 250)}.${i % 250}`, ANDROID));
    }
    expect(lookups()).toBeLessThan(total);
  }, 60_000);
});

describe('the pool that sessionless clients share', () => {
  it('gives the app its logo while the pool has room', async () => {
    resolveTxt.mockImplementation(async (name: string) => {
      if (name === '_dmarc.brand.example') return [['v=DMARC1; p=reject']];
      if (name === 'default._bimi.brand.example') return [['v=BIMI1; l=https://cdn.brand.example/logo.svg']];
      throw notFound();
    });
    for (const [address, headers] of [['192.0.2.40', ANDROID], ['192.0.2.41', IOS]] as const) {
      const res = await bimi(sessionless('/api/bimi?domain=brand.example', address, headers));
      expect(res.status).toBe(200);
      expect(res.headers.get('x-bulwark-bimi')).toBe('self-asserted');
      expect(res.headers.get('cache-control')).toBe('private, max-age=21600');
      expect(Buffer.from(await res.arrayBuffer()).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    }
    // The second app was answered from what the first one's lookup found.
    expect(lookups('brand.example')).toBe(1);
    expect(fetchPublicUrl).toHaveBeenCalledTimes(1);
  }, 30_000);

  it(`runs ${SESSIONLESS_MAX_IN_FLIGHT} lookups at once for all of them, while signed-in users run every one of theirs`, async () => {
    const zone = slowSenders('slow-');
    // Eight addresses, two new names each.
    const app: Array<Promise<Response>> = [];
    for (let a = 1; a <= 8; a++) {
      for (let i = 0; i < 2; i++) app.push(bimi(sessionless(`/api/bimi?domain=slow-app${a}-${i}.example`, `2001:db8:2::${a}`, a % 2 ? ANDROID : IOS)));
    }
    await settle();
    expect(zone.held).toHaveLength(SESSIONLESS_MAX_IN_FLIGHT);
    // The others were answered at once: no logo for now, and nothing for a cache to keep.
    const answered = (await Promise.all(app.map((request) => Promise.race([request, settle().then(() => null)])))).filter((res) => res !== null);
    expect(answered).toHaveLength(app.length - SESSIONLESS_MAX_IN_FLIGHT);
    expect(answered.every((res) => res.headers.get('cache-control') === 'no-store' && res.headers.get('x-bulwark-bimi') === 'missing')).toBe(true);

    // Four signed-in users with as many slow lookups as one user may run: all 64 start.
    const users = ['ada@example.org', 'ben@example.org', 'cleo@example.org', 'dev@example.org'];
    const mail = users.flatMap((user, u) => Array.from({ length: RUNNING_PER_CALLER }, (_, i) => bimi(signedIn(`/api/bimi?domain=slow-user${u}-${i}.example`, user))));
    await vi.waitFor(() => expect(zone.held).toHaveLength(SESSIONLESS_MAX_IN_FLIGHT + users.length * RUNNING_PER_CALLER));
    expect(users.length * RUNNING_PER_CALLER).toBe(64);
    // That is all the server runs for signed-in users, with or without the sessionless ones.
    const over = await bimi(signedIn('/api/bimi?domain=slow-one-more.example', 'erik@example.org'));
    expect(over.headers.get('cache-control')).toBe('no-store');
    expect(lookedUp('slow-one-more.example')).toBe(false);

    zone.release();
    await Promise.all([...app, ...mail]);
  }, 30_000);

  it(`looks up ${SESSIONLESS_LOOKUPS_PER_MINUTE_TOTAL} new names a minute for all of them, and counts no signed-in user against that`, async () => {
    for (let i = 0; i < 100; i++) {
      await bimi(sessionless(`/api/bimi?domain=minute-${i}.example`, `203.0.113.${i}`, ANDROID));
    }
    expect(lookups()).toBe(SESSIONLESS_LOOKUPS_PER_MINUTE_TOTAL);
    const over = await bimi(sessionless('/api/bimi?domain=minute-over.example', '203.0.113.200', IOS));
    expect(over.status).toBe(200);
    expect(over.headers.get('x-bulwark-bimi')).toBe('missing');
    expect(over.headers.get('cache-control')).toBe('no-store');
    expect(lookedUp('minute-over.example')).toBe(false);

    // A signed-in user's lookups go on.
    const res = await bimi(signedIn('/api/bimi?domain=minute-over.example', 'fay@example.org'));
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(lookedUp('minute-over.example')).toBe(true);

    // The next minute has room again.
    vi.setSystemTime(Date.now() + 61_000);
    await bimi(sessionless('/api/bimi?domain=next-minute.example', '203.0.113.201', ANDROID));
    expect(lookedUp('next-minute.example')).toBe(true);
  }, 30_000);

  it('answers a name that is already cached without a lookup, also when the minute is spent', async () => {
    await bimi(signedIn('/api/bimi?domain=known-sender.example', 'gus@example.org'));
    await bimi(sessionless('/api/bimi?domain=app-sender.example', '192.0.2.50', ANDROID));
    expect([lookups('known-sender.example'), lookups('app-sender.example')]).toEqual([1, 1]);
    for (let i = 0; i < SESSIONLESS_LOOKUPS_PER_MINUTE_TOTAL; i++) {
      await bimi(sessionless(`/api/bimi?domain=filler-${i}.example`, `192.0.2.${60 + i}`, ANDROID));
    }
    expect(lookedUp(`filler-${SESSIONLESS_LOOKUPS_PER_MINUTE_TOTAL - 1}.example`)).toBe(false);

    for (const domain of ['known-sender.example', 'app-sender.example']) {
      const res = await bimi(sessionless(`/api/bimi?domain=${domain}`, '192.0.2.51', IOS));
      expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
      expect(lookups(domain)).toBe(1);
    }
  }, 30_000);

  it('keeps what a sessionless lookup found away from signed-in users, who look the name up themselves', async () => {
    await bimi(sessionless('/api/bimi?domain=asked-by-app.example', '192.0.2.52', ANDROID));
    expect(lookups('asked-by-app.example')).toBe(1);
    const res = await bimi(signedIn('/api/bimi?domain=asked-by-app.example', 'hana@example.org'));
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(lookups('asked-by-app.example')).toBe(2);
    // After that the app is answered from the signed-in lookup's answer.
    await bimi(sessionless('/api/bimi?domain=asked-by-app.example', '192.0.2.53', IOS));
    expect(lookups('asked-by-app.example')).toBe(2);
  });
});
