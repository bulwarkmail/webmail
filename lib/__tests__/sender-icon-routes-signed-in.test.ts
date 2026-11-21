// @vitest-environment node
/**
 * /api/bimi and /api/favicon for a signed-in user, with the real session check: the mail view's
 * requests are served, uncached lookups are counted per user (60 a minute and route), and a user
 * past that gets "no logo" without a lookup and without anything a cache may keep.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

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

import { encryptPayload } from '@/lib/auth/crypto';
import { stalwartAuthContextCookieName } from '@/lib/stalwart/auth-context';
import { LOOKUPS_PER_MINUTE } from '@/lib/sender-icon-access';
import { GET as bimi } from '@/app/api/bimi/route';
import { GET as favicon } from '@/app/api/favicon/route';

const icon = () => new Response(new Uint8Array(64).fill(7), { headers: { 'content-type': 'image/png' } });
const upstream = vi.fn(async (_url: unknown, _init?: RequestInit) => icon());

beforeEach(() => {
  resolveTxt.mockClear();
  upstream.mockReset();
  upstream.mockImplementation(async () => icon());
  vi.stubGlobal('fetch', upstream);
});

/** Requests of `username`'s mail view: the session cookie, and same-origin unless `site` says otherwise. */
function signedIn(username: string) {
  const name = stalwartAuthContextCookieName(0);
  const token = encryptPayload({ serverUrl: 'https://mail.example', username, authHeader: 'Basic eDp4' }, 'session-context');
  return (path: string, site: string | null = 'same-origin') => {
    jar.clear();
    jar.set(name, token);
    return new NextRequest(`https://webmail.example${path}`, {
      headers: { cookie: `${name}=${token}`, ...(site === null ? {} : { 'sec-fetch-site': site }) },
    });
  };
}

const lookedUp = (domain: string) => resolveTxt.mock.calls.some(([name]) => name === `_dmarc.${domain}`);

describe('/api/bimi for a signed-in user', () => {
  it('serves the mail view, and a browser that sends no Sec-Fetch-Site', async () => {
    const as = signedIn('ana@mail.example');
    const res = await bimi(as('/api/bimi?domain=served.example'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(lookedUp('served.example')).toBe(true);
    expect((await bimi(as('/api/bimi?domain=old-browser.example', null))).status).toBe(200);
    expect(lookedUp('old-browser.example')).toBe(true);
  });

  it('refuses other sites, other subdomains and typed addresses even with the session', async () => {
    const as = signedIn('ana@mail.example');
    for (const site of ['cross-site', 'same-site', 'none']) {
      expect((await bimi(as(`/api/bimi?domain=${site}.example`, site))).status).toBe(403);
    }
    expect(resolveTxt).not.toHaveBeenCalled();
  });

  it('looks up at most 60 new domains a minute for one user', async () => {
    const as = signedIn('ben@mail.example');
    for (let i = 0; i < LOOKUPS_PER_MINUTE; i++) {
      expect((await bimi(as(`/api/bimi?domain=b${i}.example`))).headers.get('cache-control')).toBe('private, max-age=3600');
    }
    expect(resolveTxt).toHaveBeenCalledTimes(LOOKUPS_PER_MINUTE);

    for (const query of ['domain=over.example', 'domain=over.example&format=json']) {
      const res = await bimi(as(`/api/bimi?${query}`));
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(lookedUp('over.example')).toBe(false);
    // What is cached is still answered, and another user has a budget of their own.
    expect((await bimi(as('/api/bimi?domain=b0.example'))).headers.get('cache-control')).toBe('private, max-age=3600');
    await bimi(signedIn('cleo@mail.example')('/api/bimi?domain=over.example'));
    expect(lookedUp('over.example')).toBe(true);
  });

  it('answers "no logo for now" uncached while the server runs as many lookups as it may', async () => {
    const as = signedIn('erik@mail.example');
    const held: Array<() => void> = [];
    resolveTxt.mockImplementation((name: string) => (name.startsWith('_dmarc.busy')
      ? new Promise((_resolve, reject) => { held.push(() => reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))); })
      : Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))));
    const busy = Array.from({ length: 16 }, (_, i) => bimi(as(`/api/bimi?domain=busy${i}.example`)));
    await vi.waitFor(() => expect(held).toHaveLength(16));

    const res = await bimi(as('/api/bimi?domain=waiting.example'));
    expect(res.headers.get('x-bulwark-bimi')).toBe('missing');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(lookedUp('waiting.example')).toBe(false);

    for (const release of held) release();
    await Promise.all(busy);
    resolveTxt.mockImplementation(async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); });
  });
});

describe('/api/favicon for a signed-in user', () => {
  it('serves the mail view, and a browser that sends no Sec-Fetch-Site', async () => {
    const as = signedIn('ana@mail.example');
    const res = await favicon(as('/api/favicon?domain=served.example'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=1209600');
    expect((await favicon(as('/api/favicon?domain=old-browser.example', null))).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('refuses other sites, other subdomains and typed addresses even with the session', async () => {
    const as = signedIn('ana@mail.example');
    for (const site of ['cross-site', 'same-site', 'none']) {
      expect((await favicon(as(`/api/favicon?domain=${site}.example`, site))).status).toBe(403);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('does not follow redirects and refuses an answer too large to be an icon', async () => {
    const as = signedIn('ana@mail.example');
    await favicon(as('/api/favicon?domain=redirect.example'));
    expect(upstream.mock.calls[0][1]?.redirect).toBe('error');

    upstream.mockImplementationOnce(async () => new Response(new Uint8Array(300 * 1024).fill(7), { headers: { 'content-type': 'image/png' } }));
    const large = await favicon(as('/api/favicon?domain=large.example'));
    expect(large.headers.get('x-bulwark-favicon')).toBe('missing');
    expect(new Uint8Array(await large.arrayBuffer()).byteLength).toBeLessThan(1024);
  });

  it('fetches at most 60 new icons a minute for one user', async () => {
    const as = signedIn('dora@mail.example');
    for (let i = 0; i < LOOKUPS_PER_MINUTE; i++) await favicon(as(`/api/favicon?domain=f${i}.example`));
    expect(upstream).toHaveBeenCalledTimes(LOOKUPS_PER_MINUTE);

    const res = await favicon(as('/api/favicon?domain=over.example'));
    expect(res.headers.get('x-bulwark-favicon')).toBe('missing');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(upstream).toHaveBeenCalledTimes(LOOKUPS_PER_MINUTE);
    // A cached icon is still served.
    expect((await favicon(as('/api/favicon?domain=f0.example'))).headers.get('cache-control')).toBe('private, max-age=1209600');
    expect(upstream).toHaveBeenCalledTimes(LOOKUPS_PER_MINUTE);
  });
});
