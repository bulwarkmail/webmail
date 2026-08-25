/**
 * @vitest-environment node
 *
 * The route hands a Blob to NextResponse; jsdom's Blob isn't the one undici's
 * Response accepts, so this file runs under the node environment it ships in.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import sharp from 'sharp';

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn(),
    getAllWithSources: vi.fn(),
  },
}));
vi.mock('@/lib/admin/branding-asset', () => ({ fetchBrandingAsset: vi.fn() }));

import { GET } from '@/app/api/og-image/route';
import { configManager } from '@/lib/admin/config-manager';
import { fetchBrandingAsset } from '@/lib/admin/branding-asset';
import type { NextRequest } from 'next/server';

const mockGet = configManager.get as unknown as Mock;
const mockSources = configManager.getAllWithSources as unknown as Mock;
const mockAsset = fetchBrandingAsset as unknown as Mock;

/**
 * Admin/env config as the route sees it: anything listed here counts as
 * explicitly configured branding, everything else reports source 'default'
 * (a built-in placeholder the route must ignore).
 */
function withConfig(configured: Record<string, string>, domainBranding: unknown[] = []) {
  mockGet.mockImplementation((key: string, fallback: unknown) =>
    key === 'domainBranding' ? domainBranding : fallback,
  );
  mockSources.mockReturnValue(
    new Proxy({} as Record<string, { value: unknown; source: string }>, {
      get: (_t, key: string) =>
        key in configured
          ? { value: configured[key], source: 'admin' }
          : { value: '', source: 'default' },
    }),
  );
}

function request(host = 'mail.example.com'): NextRequest {
  return { headers: new Headers({ host }) } as unknown as NextRequest;
}

/** Which branding URL the route decided to render. */
function renderedFrom(): string {
  return mockAsset.mock.calls[0]![0] as string;
}

beforeEach(async () => {
  vi.clearAllMocks();
  withConfig({});
  // A 4x4 red square stands in for whatever logo the deployment configured.
  const square = await sharp({
    create: { width: 4, height: 4, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
  mockAsset.mockResolvedValue(square);
});

describe('/api/og-image', () => {
  it('renders a 1200x630 PNG card from the bundled wordmark when nothing is branded', async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(renderedFrom()).toBe('/branding/Bulwark_Logo_with_Lettering_Dark_and_Color.png');

    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(meta.format).toBe('png');
    // 1200x630 is the size the sharing platforms crop to.
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(630);
  });

  it('serves the cached render when the branding has not changed', async () => {
    // A logo URL no other test renders, so the first call here is a cache miss
    // (the cache is module-level and outlives a single test).
    withConfig({ appLogoLightUrl: '/api/admin/branding/cache-me.png' });
    const first = await GET(request());
    const second = await GET(request());
    expect(second.status).toBe(200);
    expect(second.headers.get('Content-Type')).toBe('image/png');
    // Same (logo, background) key - the source image is read and resized once.
    expect(mockAsset).toHaveBeenCalledTimes(1);
    expect(Buffer.from(await second.arrayBuffer()).equals(Buffer.from(await first.arrayBuffer()))).toBe(true);
  });

  it('uses the configured app logo over the bundled default', async () => {
    withConfig({ appLogoLightUrl: '/api/admin/branding/acme.png' });
    await GET(request());
    expect(renderedFrom()).toBe('/api/admin/branding/acme.png');
  });

  it('picks the dark-background logo variant when the background is dark', async () => {
    withConfig({
      pwaBackgroundColor: '#101014',
      appLogoLightUrl: '/api/admin/branding/acme-light.png',
      appLogoDarkUrl: '/api/admin/branding/acme-dark.png',
    });
    await GET(request());
    expect(renderedFrom()).toBe('/api/admin/branding/acme-dark.png');
  });

  it('renders the card on the configured background colour', async () => {
    withConfig({ pwaBackgroundColor: '#101014' });
    const res = await GET(request());
    // Sample a corner pixel - the logo sits centred inside a safe area, so the
    // edges are pure background.
    const { data } = await sharp(Buffer.from(await res.arrayBuffer()))
      .extract({ left: 0, top: 0, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([0x10, 0x10, 0x14]);
  });

  it('falls back to the square app icon when no logo is configured', async () => {
    withConfig({ pwaIconUrl: '/api/admin/branding/icon.png' });
    await GET(request());
    expect(renderedFrom()).toBe('/api/admin/branding/icon.png');
  });

  it('prefers the requesting host per-domain override', async () => {
    withConfig({ appLogoLightUrl: '/api/admin/branding/global.png' }, [
      { host: 'partner.example.com', appLogoLightUrl: '/api/admin/branding/partner.png' },
    ]);
    await GET(request('partner.example.com'));
    expect(renderedFrom()).toBe('/api/admin/branding/partner.png');
  });

  it('returns 500 rather than a broken image when the source cannot be read', async () => {
    withConfig({ appLogoLightUrl: '/api/admin/branding/missing.png' });
    mockAsset.mockRejectedValue(new Error('ENOENT'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await GET(request())).status).toBe(500);
  });
});
