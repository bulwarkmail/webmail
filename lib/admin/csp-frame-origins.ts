/**
 * Computes the union of CSP `frame-src` origins declared by installed and
 * enabled plugins. The proxy reads this on each request so that plugins can
 * embed external content (YouTube, Vimeo, Jitsi, …) without us hard-coding
 * domains in the host CSP.
 *
 * Origins are validated at install time and re-validated here as defense in
 * depth - any malformed value is dropped so a corrupted registry can never
 * inject arbitrary CSP fragments.
 */

import { getPluginRegistry } from './plugin-registry';

// `https://host`, `https://host:port`, or `https://*.host[:port]`
//
// Each label is alphanumeric with optional inner dashes; the final TLD label
// MUST start with a letter so we reject raw IPv4 literals.
//
// Disallowed by the regex (intentionally):
//   - any scheme other than https
//   - paths, queries, fragments
//   - userinfo, IPv4 literals, IPv6 literals (`[::1]`)
//   - bare wildcards (`https://*`)
const FRAME_ORIGIN_RE =
  /^https:\/\/(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?))*\.(?:[a-z](?:[a-z0-9-]*[a-z0-9])?)(?::[0-9]{1,5})?$/i;

export function isValidFrameOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string') return false;
  if (origin.length > 200) return false;
  if (!FRAME_ORIGIN_RE.test(origin)) return false;
  // Reject control characters / whitespace as a final safeguard against
  // anything that would let an attacker break out of the directive.
  if (/[\s'"`;,()]/.test(origin)) return false;
  return true;
}

/**
 * Sanitises a list of candidate origins from a manifest. Drops invalid
 * entries silently and dedupes (case-insensitive on the host).
 */
export function sanitizeFrameOrigins(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of input) {
    if (!isValidFrameOrigin(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

// In-memory cache. The proxy fires on every page navigation; reading the
// registry JSON every time is fine but cheap to skip when nothing has
// changed. Five seconds is short enough to make plugin install/uninstall
// feel snappy without measurable overhead.
let cachedAt = 0;
let cachedOrigins: string[] = [];
const CACHE_TTL_MS = 5_000;

/**
 * Returns the union of frame origins declared by every enabled plugin in
 * the server-side registry, deduped and validated.
 *
 * Returns an empty array on any failure (missing file, parse error, …) so
 * a broken registry only ever shrinks the CSP - never widens it.
 */
export async function getEnabledPluginFrameOrigins(): Promise<string[]> {
  const now = Date.now();
  if (now - cachedAt < CACHE_TTL_MS) return cachedOrigins;

  try {
    const registry = await getPluginRegistry();
    const seen = new Set<string>();
    const out: string[] = [];
    for (const plugin of registry.plugins) {
      if (!plugin.enabled) continue;
      const origins = sanitizeFrameOrigins(plugin.frameOrigins);
      for (const o of origins) {
        const key = o.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(o);
      }
    }
    cachedOrigins = out;
    cachedAt = now;
    return out;
  } catch {
    cachedOrigins = [];
    cachedAt = now;
    return [];
  }
}

/** Force the next call to re-read the registry. Used by install/uninstall. */
export function invalidateFrameOriginsCache(): void {
  cachedAt = 0;
  cachedOrigins = [];
}
