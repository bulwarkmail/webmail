import { NextRequest, NextResponse } from 'next/server';
import { isNoThirdPartyTrafficOn, thirdPartyRefusal } from '@/lib/admin/third-party-mode';
import { getRootDomain } from '@/lib/root-domain';
import { readBodyCapped } from '@/lib/security/capped-body';
import { lookupLease, NO_STORE, senderIconAccess } from '@/lib/sender-icon-access';

// In-memory LRU cache: domain -> { data, contentType, fetchedAt }
const CACHE_MAX_SIZE = 1000;
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks
/**
 * Concurrent upstream icon fetches across all callers (see GET). One caller
 * may run a quarter of them (RUNNING_PER_CALLER in lib/sender-icon-access.ts).
 */
const MAX_UPSTREAM_IN_FLIGHT = 64;
let upstreamInFlight = 0;
/** Icons are a few KB; a larger answer is not one. */
const MAX_ICON_BYTES = 256 * 1024;

interface CacheEntry {
  data: ArrayBuffer;
  contentType: string;
  fetchedAt: number;
}

interface NegativeCacheEntry {
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const negativeCache = new Map<string, NegativeCacheEntry>();
const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const NEGATIVE_CACHE_MAX_SIZE = 2000;
// A refresh request (?v=<ms>) refetches a domain at most this often, so
// refresh stamps can't be used to hammer the upstream icon service.
const MIN_REFRESH_INTERVAL_MS = 60 * 1000;

// 1x1 transparent PNG. Returned with HTTP 200 (instead of 404) when no
// favicon exists for a domain, so the browser's <img> tag loads it cleanly
// without spamming the DevTools console with red 404 errors. Avatar.tsx
// checks `naturalWidth <= 1` in onLoad and falls back to initials.
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=',
  'base64',
);
const MISSING_FAVICON_HEADERS = {
  'Content-Type': 'image/png',
  'Cache-Control': 'private, max-age=86400', // 1 day
  'X-Bulwark-Favicon': 'missing',
};
// Nothing was fetched yet (busy, or this caller's budget or running fetches
// are used up): the next request asks again.
const NOT_YET_HEADERS = { ...MISSING_FAVICON_HEADERS, ...NO_STORE };

// Strict domain validation to prevent SSRF
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

function isValidDomain(domain: string): boolean {
  if (domain.length > 253) return false;
  if (!DOMAIN_RE.test(domain)) return false;
  // Block internal/private hostnames
  const lower = domain.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.arpa')
  ) {
    return false;
  }
  return true;
}

function evictOldest() {
  if (cache.size < CACHE_MAX_SIZE) return;
  // Evict the oldest entry
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, entry] of cache) {
    if (entry.fetchedAt < oldestTime) {
      oldestTime = entry.fetchedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) cache.delete(oldestKey);
}

export async function GET(request: NextRequest) {
  // Sender icons come from DuckDuckGo: off, before anything else, while the
  // server must not contact outside services (#903).
  if (await isNoThirdPartyTrafficOn()) return thirdPartyRefusal('Sender icons');
  // Only for the webmail's own signed-in pages (lib/sender-icon-access.ts),
  // so answers may be kept by the browser but never by a cache shared by users.
  // The mobile app asks DuckDuckGo itself and never calls this route.
  const access = await senderIconAccess(request, 'favicon');
  if ('refusal' in access) return access.refusal;

  const domain = request.nextUrl.searchParams.get('domain');

  if (!domain || !isValidDomain(domain)) {
    return new NextResponse(null, { status: 400, headers: NO_STORE });
  }

  // Resolve to root domain so subdomains share the same favicon lookup
  const normalizedDomain = getRootDomain(domain.toLowerCase());
  const refreshAfter = parseRefreshAfter(request.nextUrl.searchParams.get('v'));

  // Check negative cache (domains known to have no favicon)
  const neg = negativeCache.get(normalizedDomain);
  if (neg && Date.now() - neg.fetchedAt < NEGATIVE_CACHE_TTL_MS && !isStale(neg.fetchedAt, refreshAfter)) {
    return new NextResponse(TRANSPARENT_PNG, { headers: MISSING_FAVICON_HEADERS });
  }

  // Check cache
  const cached = cache.get(normalizedDomain);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS && !isStale(cached.fetchedAt, refreshAfter)) {
    return new NextResponse(cached.data, {
      headers: faviconHeaders(cached.contentType),
    });
  }

  // Keyed by domain, so without a ceiling on concurrent upstream fetches,
  // and a budget and running count per caller, one caller could have this
  // instance open one connection per made-up domain name. Over any of them
  // the icon is simply missing for now; the browser asks again later.
  if (upstreamInFlight >= MAX_UPSTREAM_IN_FLIGHT) {
    return new NextResponse(TRANSPARENT_PNG, { headers: NOT_YET_HEADERS });
  }
  const lease = lookupLease(access.caller, 'favicon');
  if (!(await lease.take())) {
    return new NextResponse(TRANSPARENT_PNG, { headers: NOT_YET_HEADERS });
  }
  if (upstreamInFlight >= MAX_UPSTREAM_IN_FLIGHT) {
    await lease.release();
    return new NextResponse(TRANSPARENT_PNG, { headers: NOT_YET_HEADERS });
  }
  upstreamInFlight++;
  try {
    // The icon service answers directly; a redirect would send this server
    // somewhere the admin never approved.
    const upstream = await fetch(
      `https://icons.duckduckgo.com/ip3/${encodeURIComponent(normalizedDomain)}.ico`,
      { signal: AbortSignal.timeout(5000), redirect: 'error' }
    );

    if (!upstream.ok) {
      evictNegativeOldest();
      negativeCache.set(normalizedDomain, { fetchedAt: Date.now() });
      return new NextResponse(TRANSPARENT_PNG, { headers: MISSING_FAVICON_HEADERS });
    }

    // Served inline on the webmail origin, so only raster image types pass:
    // an image/svg+xml or text/html favicon opened on its own would run
    // script as the webmail.
    const contentType = rasterFaviconType(upstream.headers.get('content-type'));
    if (!contentType) {
      evictNegativeOldest();
      negativeCache.set(normalizedDomain, { fetchedAt: Date.now() });
      return new NextResponse(TRANSPARENT_PNG, { headers: MISSING_FAVICON_HEADERS });
    }
    const data = await readBodyCapped(upstream, MAX_ICON_BYTES);

    // Don't cache empty/tiny responses (likely no real favicon), nor one too
    // large to be an icon.
    if (!data || data.byteLength < 10) {
      evictNegativeOldest();
      negativeCache.set(normalizedDomain, { fetchedAt: Date.now() });
      return new NextResponse(TRANSPARENT_PNG, { headers: MISSING_FAVICON_HEADERS });
    }

    // Cache the result
    negativeCache.delete(normalizedDomain);
    evictOldest();
    cache.set(normalizedDomain, { data, contentType, fetchedAt: Date.now() });

    return new NextResponse(data, {
      headers: faviconHeaders(contentType),
    });
  } catch {
    // A refresh that can't reach upstream keeps showing the icon we have.
    if (cached) {
      return new NextResponse(cached.data, { headers: faviconHeaders(cached.contentType) });
    }
    return new NextResponse(null, {
      status: 502,
      headers: { 'Cache-Control': 'private, max-age=300' }, // 5 min
    });
  } finally {
    upstreamInFlight--;
    await lease.release();
  }
}

/**
 * The time from a ?v= refresh stamp, or null. Avatars send the moment the
 * user asked for fresh sender icons (#960); a stamp in the future is clamped
 * to now so it can't keep a domain permanently uncached.
 */
function parseRefreshAfter(value: string | null): number | null {
  if (!value || !/^\d{1,15}$/.test(value)) return null;
  return Math.min(Number(value), Date.now());
}

/** Whether a cache entry predates the refresh the client asked for. */
function isStale(fetchedAt: number, refreshAfter: number | null): boolean {
  if (refreshAfter === null || fetchedAt >= refreshAfter) return false;
  return Date.now() - fetchedAt >= MIN_REFRESH_INTERVAL_MS;
}

const RASTER_FAVICON_TYPES = new Set([
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/png',
  'image/gif',
  'image/jpeg',
  'image/webp',
  'image/bmp',
]);

/** The upstream type when it is a raster image, else null. */
function rasterFaviconType(header: string | null): string | null {
  const type = (header ?? 'image/x-icon').split(';')[0].trim().toLowerCase();
  return RASTER_FAVICON_TYPES.has(type) ? type : null;
}

function faviconHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'private, max-age=1209600', // 2 weeks
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };
}

function evictNegativeOldest() {
  if (negativeCache.size < NEGATIVE_CACHE_MAX_SIZE) return;
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, entry] of negativeCache) {
    if (entry.fetchedAt < oldestTime) {
      oldestTime = entry.fetchedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) negativeCache.delete(oldestKey);
}
