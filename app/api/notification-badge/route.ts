import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { configManager } from '@/lib/admin/config-manager';
import { fetchBrandingAsset } from '@/lib/admin/branding-asset';
import { renderCache } from '@/lib/admin/render-cache';
import {
  matchDomainBranding,
  parseDomainBranding,
  pickRequestHost,
} from '@/lib/admin/domain-branding';

/**
 * GET /api/notification-badge - the small mark Android shows in the status
 * bar for a push notification (public/sw.js sets it as `badge`).
 *
 * Android draws only the image's transparency, so an opaque app icon turns
 * into a solid blob there (#915). This serves the admin's own badge when the
 * branding sets one (per host or global), and otherwise the bundled Bulwark
 * mark, white on transparency. It never falls back to the PWA icon.
 */

const SIZE = 96;
const DEFAULT_BADGE = '/notification-badge-96x96.png';

const cache = renderCache('notification-badge');

export async function GET(req: NextRequest) {
  await configManager.ensureLoaded();
  const domainOverrides = matchDomainBranding(
    pickRequestHost(req),
    parseDomainBranding(configManager.get<unknown>('domainBranding', [])),
  );
  const source = configManager.getAllWithSources().notificationBadgeUrl;
  const configured =
    domainOverrides.notificationBadgeUrl ||
    (source && source.source !== 'default' ? (source.value as string) : '') ||
    '';

  const headers = {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=86400',
    Vary: 'Host, X-Forwarded-Host',
  };

  const render = async (url: string): Promise<Blob> => {
    const cached = cache.get(url);
    if (cached) return cached;
    const png = await sharp(await fetchBrandingAsset(url, 'notification badge'))
      .resize(SIZE, SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    const blob = new Blob([new Uint8Array(png)], { type: 'image/png' });
    cache.set(url, blob);
    return blob;
  };

  try {
    return new NextResponse(await render(configured || DEFAULT_BADGE), { headers });
  } catch (err) {
    if (!configured) {
      console.error('Failed to render the notification badge:', err);
      return new NextResponse('Failed to render the badge', { status: 500 });
    }
    // A broken custom badge still gets a usable mark in the status bar.
    console.error('Failed to render the custom notification badge, using the default:', err);
    try {
      return new NextResponse(await render(DEFAULT_BADGE), { headers });
    } catch {
      return new NextResponse('Failed to render the badge', { status: 500 });
    }
  }
}
