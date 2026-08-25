/**
 * CSP `frame-src` support for user-configured Sidebar Apps ("Custom Apps").
 *
 * Plugins declare their embed origins in a manifest the server can read, so
 * the proxy merges them straight into the host CSP. Sidebar Apps are a *user*
 * setting living in the browser's settings store, which the proxy cannot read,
 * so the client mirrors the origins of its `inline` apps into a small cookie
 * and the proxy merges that into `frame-src` on the next document request.
 *
 * The cookie only ever widens `frame-src` for the browser that set it, and
 * every entry is re-validated here before it reaches the header - a malformed
 * or hostile value can never inject a CSP fragment, only be dropped.
 */

/** Cookie the client writes and the proxy reads. Not HttpOnly - the client owns it. */
export const APP_FRAME_ORIGINS_COOKIE = 'bulwark_app_frame_origins';

/** Hard cap so a large app list can never blow up the cookie or the header. */
export const MAX_APP_FRAME_ORIGINS = 20;

// `http(s)://host[:port]` where host is a DNS name, an IPv4 literal, or a
// bracketed IPv6 literal. Unlike the plugin validator this allows `http:` and
// single-label hosts (`localhost`, `nas`) because self-hosted apps on a LAN
// are a first-class use case here. No paths, queries, userinfo or wildcards,
// and no character that could terminate the directive.
const APP_FRAME_ORIGIN_RE =
  /^https?:\/\/(?:\[[0-9a-f:.]{2,45}\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::[0-9]{1,5})?$/i;

export function isValidAppFrameOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string') return false;
  if (origin.length === 0 || origin.length > 255) return false;
  if (!APP_FRAME_ORIGIN_RE.test(origin)) return false;
  // Final safeguard against anything that could break out of the directive.
  if (/[\s'"`;,()]/.test(origin)) return false;
  return true;
}

/**
 * Reduces a configured app URL to the bare origin CSP needs. Returns null for
 * anything that isn't an embeddable http(s) URL.
 *
 * `new URL` normalises for us: the host is lower-cased, default ports are
 * dropped, and IDN hosts become punycode - so `https://Example.COM:443/app`
 * and `https://example.com` collapse to the same entry.
 */
export function appUrlToFrameOrigin(url: unknown): string | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!parsed.host) return null;
  const origin = `${parsed.protocol}//${parsed.host}`;
  return isValidAppFrameOrigin(origin) ? origin : null;
}

/** Origins needed by the apps configured to open inline (embedded), deduped. */
export function inlineAppFrameOrigins(
  apps: ReadonlyArray<{ url: string; openMode: string }> | undefined | null
): string[] {
  if (!Array.isArray(apps)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const app of apps) {
    if (!app || app.openMode !== 'inline') continue;
    const origin = appUrlToFrameOrigin(app.url);
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
    if (out.length >= MAX_APP_FRAME_ORIGINS) break;
  }
  return out;
}

/** Encodes origins for the cookie value. */
export function serializeAppFrameOrigins(origins: ReadonlyArray<string>): string {
  return encodeURIComponent(origins.slice(0, MAX_APP_FRAME_ORIGINS).join(' '));
}

/**
 * Decodes and re-validates a cookie value. Invalid entries are dropped rather
 * than failing the whole list, so one bad app never disables the rest.
 */
export function parseAppFrameOrigins(raw: string | undefined | null): string[] {
  if (!raw) return [];
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    // Not percent-encoded (or malformed) - fall back to the raw value.
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of value.split(/[\s,]+/)) {
    if (!token) continue;
    const origin = token.toLowerCase();
    if (!isValidAppFrameOrigin(origin) || seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
    if (out.length >= MAX_APP_FRAME_ORIGINS) break;
  }
  return out;
}
