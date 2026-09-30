// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// /api/favicon answers on the webmail origin without authentication and used
// to pass the upstream Content-Type through: an SVG or HTML "favicon" opened
// on its own would run script as the webmail.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function favicon(domain: string, upstream: Response) {
  vi.stubGlobal('fetch', vi.fn(async () => upstream));
  const { GET } = await import('@/app/api/favicon/route');
  return GET(new NextRequest(`https://webmail.example/api/favicon?domain=${domain}`));
}

describe('favicon route', () => {
  it('serves a raster favicon inert: nosniff and a sandboxing CSP', async () => {
    const res = await favicon('example.org', new Response(new Uint8Array(64), { headers: { 'content-type': 'image/png' } }));
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });

  it.each(['image/svg+xml', 'text/html; charset=utf-8'])('does not pass %s through', async (type) => {
    const res = await favicon('example.com', new Response('<svg><script>alert(1)</script></svg>'.padEnd(64), { headers: { 'content-type': type } }));
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-bulwark-favicon')).toBe('missing');
  });
});
