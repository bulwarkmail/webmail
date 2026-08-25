import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { configManager } from '@/lib/admin/config-manager';
import { fetchBrandingAsset } from '@/lib/admin/branding-asset';
import {
  matchDomainBranding,
  parseDomainBranding,
  pickRequestHost,
} from '@/lib/admin/domain-branding';

const VALID_SIZES = new Set([192, 512]);

// Cache resized images keyed by (size, source URL) so admin re-uploads or URL
// changes invalidate the prior render instead of serving stale bytes forever.
const cache = new Map<string, Blob>();

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ size: string }> }
) {
  const { size: sizeParam } = await params;
  const size = parseInt(sizeParam, 10);

  if (!VALID_SIZES.has(size)) {
    return new NextResponse('Invalid size. Allowed: 192, 512', { status: 400 });
  }

  await configManager.ensureLoaded();
  const host = pickRequestHost(req);
  const domainOverrides = matchDomainBranding(
    host,
    parseDomainBranding(configManager.get<unknown>('domainBranding', [])),
  );
  const sources = configManager.getAllWithSources();
  const iconUrl =
    domainOverrides.pwaIconUrl ||
    domainOverrides.faviconUrl ||
    (sources.pwaIconUrl?.source !== 'default' ? (sources.pwaIconUrl?.value as string) : '') ||
    (sources.faviconUrl?.source !== 'default' ? (sources.faviconUrl?.value as string) : '') ||
    // Fall back to the built-in default so this endpoint ALWAYS returns an app
    // icon (custom if configured, else the bundled default). This lets callers
    // that can't run the custom-vs-default check themselves - notably the
    // service worker's notifications - use a single stable URL.
    `/icon-${size}x${size}.png`;

  const pngHeaders = {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=86400',
    Vary: 'Host, X-Forwarded-Host',
  };

  const cacheKey = `${size}|${iconUrl}`;

  try {
    if (cache.has(cacheKey)) {
      return new NextResponse(cache.get(cacheKey)!, { headers: pngHeaders });
    }

    const sourceBuffer = await fetchBrandingAsset(iconUrl, 'PWA icon');
    const resized = await sharp(sourceBuffer)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    const ab = new ArrayBuffer(resized.byteLength);
    new Uint8Array(ab).set(resized);
    const blob = new Blob([ab], { type: 'image/png' });
    cache.set(cacheKey, blob);

    return new NextResponse(blob, { headers: pngHeaders });
  } catch (err) {
    console.error('Failed to generate PWA icon:', err);
    return new NextResponse('Failed to generate icon', { status: 500 });
  }
}
