/**
 * Per-domain branding overrides: schema, parsing, host extraction, and match.
 *
 * The webmail can be served on multiple hostnames (e.g. mail1.example.com,
 * mail2.other.com). Each hostname can override a subset of branding fields;
 * unset fields fall back to the global admin/env/default value.
 */

import type { NextRequest } from 'next/server';

/** Config keys that can be overridden per domain. */
export const BRANDING_OVERRIDE_KEYS = [
  'appName',
  'appShortName',
  'appDescription',
  'faviconUrl',
  'pwaIconUrl',
  'pwaScreenshotMobileUrl',
  'pwaScreenshotDesktopUrl',
  'pwaThemeColor',
  'pwaBackgroundColor',
  'appLogoLightUrl',
  'appLogoDarkUrl',
  'loginLogoLightUrl',
  'loginLogoDarkUrl',
  'loginCompanyName',
  'loginImprintUrl',
  'loginPrivacyPolicyUrl',
  'loginWebsiteUrl',
] as const;

export type BrandingOverrideKey = (typeof BRANDING_OVERRIDE_KEYS)[number];

export interface DomainBrandingEntry {
  /**
   * Hostname this entry applies to. Either an exact host like
   * "mail.example.com" or a wildcard like "*.example.com" (matches any
   * direct or deeper subdomain). Case-insensitive; trailing dots are
   * stripped on parse.
   */
  host: string;
  appName?: string;
  appShortName?: string;
  appDescription?: string;
  faviconUrl?: string;
  pwaIconUrl?: string;
  pwaScreenshotMobileUrl?: string;
  pwaScreenshotDesktopUrl?: string;
  pwaThemeColor?: string;
  pwaBackgroundColor?: string;
  appLogoLightUrl?: string;
  appLogoDarkUrl?: string;
  loginLogoLightUrl?: string;
  loginLogoDarkUrl?: string;
  loginCompanyName?: string;
  loginImprintUrl?: string;
  loginPrivacyPolicyUrl?: string;
  loginWebsiteUrl?: string;
}

// Accepts plain hostnames (foo, foo.bar, foo.bar.baz) and one-level wildcards
// at the leftmost label (*.example.com). Rejects IPs, scheme/path/userinfo,
// and embedded wildcards.
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '');
}

/** Parse the raw config value (array of entries, or string-JSON). Invalid entries are dropped. */
export function parseDomainBranding(raw: unknown): DomainBrandingEntry[] {
  if (!raw) return [];
  let value = raw;
  if (typeof value === 'string') {
    if (!value.trim()) return [];
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const out: DomainBrandingEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const rawHost = typeof rec.host === 'string' ? rec.host : '';
    const host = normalizeHost(rawHost);
    if (!host || !HOST_RE.test(host)) continue;
    if (seen.has(host)) continue;
    seen.add(host);

    const entry: DomainBrandingEntry = { host };
    const writable = entry as unknown as Record<string, string>;
    for (const key of BRANDING_OVERRIDE_KEYS) {
      const v = rec[key];
      if (typeof v === 'string' && v.length > 0) {
        writable[key] = v;
      }
    }
    out.push(entry);
  }
  return out;
}

type HeadersLike = Headers | { get(name: string): string | null };

/**
 * Pick the request's host, preferring X-Forwarded-Host (first entry if
 * comma-separated) over Host. Strips the port. Returns null when no usable
 * host header is set.
 */
export function pickRequestHost(headersOrReq: NextRequest | HeadersLike): string | null {
  // A Headers / ReadonlyHeaders exposes `.get` directly; a NextRequest carries
  // its headers under `.headers`. Discriminate on the callable `.get` rather
  // than the presence of a `headers` property, since ReadonlyHeaders (returned
  // by `await headers()`) also has an internal `headers` field (#585).
  const candidate = headersOrReq as { get?: unknown };
  const headers: HeadersLike =
    typeof candidate.get === 'function'
      ? (headersOrReq as HeadersLike)
      : (headersOrReq as NextRequest).headers;
  const raw = headers.get('x-forwarded-host') || headers.get('host');
  if (!raw) return null;
  const first = raw.split(',')[0]?.trim();
  if (!first) return null;
  return normalizeHost(first.split(':')[0]);
}

/**
 * Find the entry whose host matches `host`. Exact match always wins; among
 * wildcards the longest (most-specific) suffix wins. Returns {} when no
 * entry matches.
 */
export function matchDomainBranding(
  host: string | null,
  entries: DomainBrandingEntry[],
): Partial<DomainBrandingEntry> {
  if (!host || entries.length === 0) return {};
  const lower = normalizeHost(host);
  let wildcardMatch: DomainBrandingEntry | undefined;
  for (const entry of entries) {
    if (entry.host === lower) return entry;
    if (entry.host.startsWith('*.')) {
      const suffix = entry.host.slice(1); // ".example.com"
      if (lower.endsWith(suffix) && lower.length > suffix.length) {
        if (!wildcardMatch || entry.host.length > wildcardMatch.host.length) {
          wildcardMatch = entry;
        }
      }
    }
  }
  return wildcardMatch ?? {};
}
