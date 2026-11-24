import { NextRequest, NextResponse } from 'next/server';
import { configManager } from '@/lib/admin/config-manager';
import { hasSessionSecret } from '@/lib/auth/session-secret';
import { isNoThirdPartyTrafficOn, thirdPartyRefusal } from '@/lib/admin/third-party-mode';
import { decodeRemoteUrl } from '@/lib/remote-content-proxy';
import { readBodyCapped } from '@/lib/security/capped-body';
import { fetchPublicUrl, type PublicFetchResponse } from '@/lib/security/url-guard';
import { lookupLease, NO_STORE, senderIconAccess } from '@/lib/sender-icon-access';

/**
 * GET /api/remote-content/<token> - one remote picture of a message, fetched
 * by this server (#1021).
 *
 * The admin policy's `remoteContentProxyEnabled` gate turns it on. The
 * message renderer then points every remote picture of a message whose
 * remote content the user allowed at this route (lib/email-sanitization.ts),
 * so the sender sees this server instead of the reader's address and browser.
 *
 * - Signed-in webmail pages only, counted per mailbox (lib/sender-icon-access.ts);
 *   off without SESSION_SECRET, where sessions can't be told apart.
 * - The address is fetched with the rebinding-safe public fetch: no private,
 *   loopback or metadata addresses, every redirect checked again.
 * - Nothing of the reader goes along: no cookies, no Referer, a fixed User-Agent.
 * - Only raster pictures come back, recognised by their bytes, whatever the
 *   remote server says they are; SVG, pages and anything else are refused.
 *   The answer can't run as a document here (CSP sandbox, nosniff) and no
 *   other site can embed it.
 * - Size and time are capped. On any failure a transparent pixel comes back,
 *   so the message's layout holds.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
/** Remote fetches running at once across all callers. */
const MAX_IN_FLIGHT = 128;
let inFlight = 0;

const USER_AGENT = 'Mozilla/5.0 (compatible; Bulwark Webmail image proxy)';
const ACCEPT = 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8';

/** The sanitizer's placeholder pixel (TRANSPARENT_BLOCKED_PIXEL). */
const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const SAFETY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
} as const;

/** A picture is kept by the reader's browser for a day, never by a shared cache. */
const PICTURE_CACHE = 'private, max-age=86400';
/** A failed one is asked for again a little later. */
const FAILURE_CACHE = 'private, max-age=300';

function refusal(status: number): NextResponse {
  return new NextResponse(null, { status, headers: { ...SAFETY_HEADERS, ...NO_STORE } });
}

function placeholder(cacheControl: string): NextResponse {
  return new NextResponse(new Uint8Array(TRANSPARENT_GIF), {
    headers: { ...SAFETY_HEADERS, 'Content-Type': 'image/gif', 'Cache-Control': cacheControl },
  });
}

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

/** The raster type the bytes are, or null. SVG is not one. */
function sniffImageType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(bytes, ascii('BM')) && bytes.length > 26) return 'image/bmp';
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && bytes.length > 22) return 'image/x-icon';
  if (startsWith(bytes, ascii('ftyp'), 4)) {
    const brands = String.fromCharCode(...bytes.subarray(8, Math.min(bytes.length, 64)));
    if (/avi[fs]/.test(brands)) return 'image/avif';
  }
  return null;
}

async function fetchPicture(url: string, signal: AbortSignal): Promise<PublicFetchResponse | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchPublicUrl(current, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: ACCEPT },
      signal,
    });
    if (res.status < 300 || res.status >= 400) {
      if (res.ok) return res;
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const location = res.headers.get('location');
    await res.body?.cancel().catch(() => {});
    if (!location) return null;
    current = new URL(location, current).toString();
  }
  return null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  await configManager.ensureLoaded();
  if (configManager.getPolicy().features.remoteContentProxyEnabled !== true) return refusal(404);
  // Without a session secret no reader can be told from anyone else, and the
  // route would fetch for whoever asks.
  if (!hasSessionSecret()) return refusal(404);
  // The mode stops remote content in mail altogether (#903).
  if (await isNoThirdPartyTrafficOn()) return thirdPartyRefusal('Remote content');

  const access = await senderIconAccess(request, 'remote-content');
  if ('refusal' in access) return refusal(access.refusal.status);
  if (access.caller.sessionless) return refusal(401);

  const { token } = await params;
  const url = decodeRemoteUrl(token);
  if (!url) return refusal(400);

  if (inFlight >= MAX_IN_FLIGHT) return placeholder(NO_STORE['Cache-Control']);
  const lease = lookupLease(access.caller, 'remote-content');
  if (!(await lease.take())) return placeholder(NO_STORE['Cache-Control']);

  inFlight++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchPicture(url, controller.signal);
    if (!res) return placeholder(FAILURE_CACHE);
    const body = await readBodyCapped(res, MAX_BYTES, controller);
    if (!body) return placeholder(FAILURE_CACHE);
    const bytes = new Uint8Array(body);
    const type = sniffImageType(bytes);
    if (!type) return placeholder(FAILURE_CACHE);
    return new NextResponse(bytes, {
      headers: { ...SAFETY_HEADERS, 'Content-Type': type, 'Cache-Control': PICTURE_CACHE },
    });
  } catch {
    return placeholder(FAILURE_CACHE);
  } finally {
    clearTimeout(timer);
    inFlight--;
    await lease.release();
  }
}
