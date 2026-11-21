/**
 * @vitest-environment node
 *
 * The plugin frame's CSP allows connect-src and img-src 'self'. /api/bimi and /api/favicon make
 * the server look up or fetch a name the caller chose: the BIMI route asks DNS for
 * default._bimi.<domain>, the favicon route asks DuckDuckGo for <root domain>. A frame that may
 * reach no host must not be able to have the server do that for it.
 *
 * A request from a plugin frame is cross-site (opaque origin): the browser marks it
 * `Sec-Fetch-Site: cross-site` and sends no session cookie. The mail UI's own requests are
 * same-origin. The cross-site one is refused before any lookup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const resolveTxt = vi.fn(async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); });
vi.mock('node:dns/promises', () => ({ resolveTxt, default: { resolveTxt } }));
vi.mock('@/lib/admin/third-party-mode', () => ({
  isNoThirdPartyTrafficOn: vi.fn(async () => false),
  thirdPartyRefusal: () => new Response(null, { status: 403 }),
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: vi.fn(async () => {}), get: vi.fn(() => false), getPolicy: () => ({ features: {} }) },
}));

const upstream = vi.fn(async () => new Response(null, { status: 404 }));

beforeEach(() => {
  resolveTxt.mockClear();
  upstream.mockClear();
  vi.stubGlobal('fetch', upstream);
});

/** What Chrome sends for fetch() or <img> from a sandbox="allow-scripts" frame of the webmail. */
function fromPluginFrame(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
  });
}

describe('server-side lookups asked for by a plugin frame', () => {
  it('/api/bimi does no DNS lookup for it', async () => {
    const { GET } = await import('@/app/api/bimi/route');
    const res = await GET(fromPluginFrame('/api/bimi?domain=c2VjcmV0LWRhdGE.collector.example'));
    expect(resolveTxt).not.toHaveBeenCalled();
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('/api/favicon asks nobody for it', async () => {
    const { GET } = await import('@/app/api/favicon/route');
    const res = await GET(fromPluginFrame('/api/favicon?domain=c2VjcmV0LWRhdGE-collector.example'));
    expect(upstream).not.toHaveBeenCalled();
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
