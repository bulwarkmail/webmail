import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { configManager } from '@/lib/admin/config-manager';
import { fetchBrandingAsset } from '@/lib/admin/branding-asset';
import {
  matchDomainBranding,
  parseDomainBranding,
  pickRequestHost,
} from '@/lib/admin/domain-branding';

/**
 * Link-preview (OpenGraph / Twitter card) image.
 *
 * Chat clients and social platforms render the URL from <meta property="og:image">
 * when someone shares a link to the webmail. 1200x630 is the size those
 * platforms crop to, so we render exactly that: the deployment's logo centred on
 * the configured PWA background colour, honoring per-domain branding like
 * app/manifest.ts and /api/pwa-icon already do.
 *
 * No text is drawn - rendering text server-side would need fonts present in the
 * container, and the bundled lettering logos already carry the wordmark as
 * artwork.
 */

// Not exported: Next.js only allows its own route fields (GET, dynamic, ...) as
// exports from a route module and fails the build on anything else.
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

// The logo never fills the whole canvas; platforms crop the edges of a preview
// card at some aspect ratios, so keep the artwork well inside a safe area.
const CONTENT_WIDTH = Math.round(OG_WIDTH * 0.66);
const CONTENT_HEIGHT = Math.round(OG_HEIGHT * 0.55);

// Bundled lettering logos, used when a deployment has no branding configured.
const DEFAULT_LOGO_ON_LIGHT = '/branding/Bulwark_Logo_with_Lettering_Dark_and_Color.png';
const DEFAULT_LOGO_ON_DARK = '/branding/Bulwark_Logo_with_Lettering_White_and_Color.png';

type Rgb = { r: number; g: number; b: number };

const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/** Parse `#rgb` / `#rrggbb`. Returns null for anything else so callers can fall back. */
function parseHexColor(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, '');
  if (hex.length === 3) {
    const [r, g, b] = hex.split('').map((c) => parseInt(c + c, 16));
    return Number.isNaN(r! + g! + b!) ? null : { r: r!, g: g!, b: b! };
  }
  if (hex.length === 6) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return Number.isNaN(r + g + b) ? null : { r, g, b };
  }
  return null;
}

/** Perceived brightness (0-255) - decides whether the light or dark logo reads better. */
function isDarkColor({ r, g, b }: Rgb): boolean {
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

// Cache rendered cards keyed by (source logo, background) so a branding change
// invalidates the previous render instead of serving stale bytes forever.
const cache = new Map<string, Blob>();

export async function GET(req: NextRequest) {
  await configManager.ensureLoaded();

  const host = pickRequestHost(req);
  const domainOverrides = matchDomainBranding(
    host,
    parseDomainBranding(configManager.get<unknown>('domainBranding', [])),
  );
  const sources = configManager.getAllWithSources();
  /** Configured value for `key`, ignoring built-in defaults (those are placeholders, not branding). */
  const configured = (key: keyof typeof domainOverrides): string => {
    const override = domainOverrides[key];
    if (typeof override === 'string' && override.length > 0) return override;
    const entry = sources[key];
    return entry && entry.source !== 'default' ? ((entry.value as string) ?? '') : '';
  };

  const background = parseHexColor(configured('pwaBackgroundColor')) ?? WHITE;
  const dark = isDarkColor(background);

  // Prefer the app logo for the matching background, then the other logo
  // variant, then the square app icon / favicon, then the bundled wordmark.
  const logoUrl =
    (dark ? configured('appLogoDarkUrl') : configured('appLogoLightUrl')) ||
    (dark ? configured('appLogoLightUrl') : configured('appLogoDarkUrl')) ||
    (dark ? configured('loginLogoDarkUrl') : configured('loginLogoLightUrl')) ||
    configured('pwaIconUrl') ||
    configured('faviconUrl') ||
    (dark ? DEFAULT_LOGO_ON_DARK : DEFAULT_LOGO_ON_LIGHT);

  const pngHeaders = {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=86400',
    Vary: 'Host, X-Forwarded-Host',
  };
  const cacheKey = `${logoUrl}|${background.r},${background.g},${background.b}`;

  try {
    if (cache.has(cacheKey)) {
      return new NextResponse(cache.get(cacheKey)!, { headers: pngHeaders });
    }

    const sourceBuffer = await fetchBrandingAsset(logoUrl, 'OG image logo');
    // 'contain' pads the logo out to exactly CONTENT_WIDTH x CONTENT_HEIGHT with
    // transparency, so compositing it centre-gravity keeps the original aspect
    // ratio without any arithmetic on the intrinsic size. withoutEnlargement is
    // off deliberately: a small favicon should still fill the card.
    const logo = await sharp(sourceBuffer)
      .resize(CONTENT_WIDTH, CONTENT_HEIGHT, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

    const card = await sharp({
      create: {
        width: OG_WIDTH,
        height: OG_HEIGHT,
        channels: 4,
        background: { ...background, alpha: 1 },
      },
    })
      .composite([{ input: logo, gravity: 'center' }])
      .png()
      .toBuffer();

    const ab = new ArrayBuffer(card.byteLength);
    new Uint8Array(ab).set(card);
    const blob = new Blob([ab], { type: 'image/png' });
    cache.set(cacheKey, blob);

    return new NextResponse(blob, { headers: pngHeaders });
  } catch (err) {
    console.error('Failed to generate OG image:', err);
    return new NextResponse('Failed to generate OG image', { status: 500 });
  }
}
