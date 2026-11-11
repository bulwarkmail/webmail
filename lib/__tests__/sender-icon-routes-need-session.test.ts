// @vitest-environment node
/**
 * /api/bimi and /api/favicon make the server ask DNS (up to four TXT lookups), fetch an https
 * address the name's record gives, draw a picture and keep the result in a cache shared by all
 * users; /api/favicon asks icons.duckduckgo.com. Only the mail view uses them, and it is always
 * signed in. A request without any session must be refused before the first lookup.
 * (bimi-favicon-from-plugin-frame.test.ts in app/api/bimi/__tests__ asks the same for a
 * cross-site request from a plugin frame.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const resolveTxt = vi.fn(async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); });
vi.mock('node:dns/promises', () => ({ resolveTxt, lookup: vi.fn(), default: { resolveTxt, lookup: vi.fn() } }));
vi.mock('@/lib/admin/third-party-mode', () => ({
  isNoThirdPartyTrafficOn: vi.fn(async () => false),
  thirdPartyRefusal: () => new Response(null, { status: 403 }),
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: vi.fn(async () => {}), get: vi.fn((_k: string, fallback: unknown) => fallback), getPolicy: () => ({ features: {} }) },
}));
// A deployment that can tell sessions apart (a session secret exists), and a browser with no cookies.
vi.mock('@/lib/auth/session-secret', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session-secret')>()),
  hasSessionSecret: () => true,
  getSessionSecret: () => 's'.repeat(64),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));

const upstream = vi.fn(async () => new Response(null, { status: 404 }));

beforeEach(() => {
  resolveTxt.mockClear();
  upstream.mockClear();
  vi.stubGlobal('fetch', upstream);
});

/** A same-origin request (so only the missing session can be the reason to refuse it). */
const anonymous = (path: string) => new NextRequest(`https://webmail.example${path}`, {
  headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
});

describe('sender icon routes without a session', () => {
  it('/api/bimi does no DNS lookup', async () => {
    const { GET } = await import('@/app/api/bimi/route');
    const res = await GET(anonymous('/api/bimi?domain=anything.unknown.example'));
    expect(resolveTxt).not.toHaveBeenCalled();
    expect([401, 403]).toContain(res.status);
    // A refusal must not be kept by a shared cache as the answer for signed-in users.
    expect((res.headers.get('cache-control') ?? '').toLowerCase()).not.toContain('public');
  });

  it('/api/bimi?format=json does no DNS lookup', async () => {
    const { GET } = await import('@/app/api/bimi/route');
    const res = await GET(anonymous('/api/bimi?domain=anything.unknown.example&format=json'));
    expect(resolveTxt).not.toHaveBeenCalled();
    expect([401, 403]).toContain(res.status);
  });

  it('/api/favicon asks no outside service', async () => {
    const { GET } = await import('@/app/api/favicon/route');
    const res = await GET(anonymous('/api/favicon?domain=anything.unknown.example'));
    expect(upstream).not.toHaveBeenCalled();
    expect([401, 403]).toContain(res.status);
    expect((res.headers.get('cache-control') ?? '').toLowerCase()).not.toContain('public');
  });
});
