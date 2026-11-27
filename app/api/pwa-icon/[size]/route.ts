import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { configManager } from '@/lib/admin/config-manager';
import { fetchBrandingAsset } from '@/lib/admin/branding-asset';
import { renderCache } from '@/lib/admin/render-cache';
import { parseHexColor } from '@/lib/tag-hex-color';
import {
  matchDomainBranding,
  parseDomainBranding,
  pickRequestHost,
} from '@/lib/admin/domain-branding';

// 180 is the apple-touch-icon size: iOS takes the home screen icon from
// <link rel="apple-touch-icon">, not from the manifest.
const APPLE_TOUCH_SIZE = 180;
const VALID_SIZES = new Set([APPLE_TOUCH_SIZE, 192, 512]);

// Cache resized images keyed by (size, source URL) so admin re-uploads (the
// URL carries the upload's version) or URL changes invalidate the prior
// render instead of serving stale bytes forever. Capped, and dropped on a
// branding change.
const cache = renderCache('pwa-icon');

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ size: string }> }
) {
  const { size: sizeParam } = await params;
  const size = parseInt(sizeParam, 10);

  if (!VALID_SIZES.has(size)) {
    return new NextResponse('Invalid size. Allowed: 180, 192, 512', { status: 400 });
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
    (size === APPLE_TOUCH_SIZE ? '/apple-touch-icon.png' : `/icon-${size}x${size}.png`);

  // iOS draws transparent pixels of a home screen icon as black, so the
  // apple-touch-icon is flattened onto the PWA background colour. The admin
  // inputs can save any string, and sharp throws on one it can't parse, so
  // only a valid hex colour is used; anything else falls back to white.
  const background =
    size === APPLE_TOUCH_SIZE
      ? parseHexColor(domainOverrides.pwaBackgroundColor ?? '') ??
        parseHexColor(configManager.get<string>('pwaBackgroundColor', '') ?? '') ??
        '#ffffff'
      : '';

  const pngHeaders = {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=86400',
    Vary: 'Host, X-Forwarded-Host',
  };

  const cacheKey = `${size}|${iconUrl}|${background}`;

  try {
    if (cache.has(cacheKey)) {
      return new NextResponse(cache.get(cacheKey)!, { headers: pngHeaders });
    }

    const sourceBuffer = await fetchBrandingAsset(iconUrl, 'PWA icon');
    let resized = await sharp(sourceBuffer)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    // A second pass: in one pipeline sharp flattens before it resizes, which
    // would leave the 'contain' padding transparent.
    if (background) resized = await sharp(resized).flatten({ background }).png().toBuffer();

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
