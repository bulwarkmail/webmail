/**
 * Multi-server JMAP support: schema, parsing, lookup, and redaction helpers.
 */

import { toAsciiDomain } from '@/lib/idn';

export interface JmapServerOAuthConfig {
  clientId?: string;
  issuerUrl?: string;
  clientSecret?: string;
}

export interface JmapServerEntry {
  id: string;
  label: string;
  url: string;
  domains?: string[];
  oauth?: JmapServerOAuthConfig;
}

export interface PublicJmapServerEntry {
  id: string;
  label: string;
  url: string;
  domains: string[];
  oauth?: {
    clientId?: string;
    issuerUrl?: string;
  };
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function trimUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Parse the raw config value (may be array, string JSON, or null). */
export function parseJmapServers(raw: unknown): JmapServerEntry[] {
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
  const out: JmapServerEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    const label = typeof e.label === 'string' ? e.label.trim() : '';
    const url = typeof e.url === 'string' ? trimUrl(e.url) : '';
    if (!id || !ID_RE.test(id) || seen.has(id)) continue;
    if (!url || !isHttpUrl(url)) continue;
    seen.add(id);
    const domains = Array.isArray(e.domains)
      ? e.domains
          .filter((d): d is string => typeof d === 'string')
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean)
      : [];
    let oauth: JmapServerOAuthConfig | undefined;
    if (e.oauth && typeof e.oauth === 'object') {
      const o = e.oauth as Record<string, unknown>;
      const clientId = typeof o.clientId === 'string' ? o.clientId.trim() : '';
      const issuerUrl = typeof o.issuerUrl === 'string' ? trimUrl(o.issuerUrl) : '';
      const clientSecret = typeof o.clientSecret === 'string' ? o.clientSecret : '';
      if (clientId || issuerUrl || clientSecret) {
        oauth = {};
        if (clientId) oauth.clientId = clientId;
        if (issuerUrl && isHttpUrl(issuerUrl)) oauth.issuerUrl = issuerUrl;
        if (clientSecret) oauth.clientSecret = clientSecret;
      }
    }
    out.push({
      id,
      label: label || id,
      url,
      ...(domains.length > 0 ? { domains } : {}),
      ...(oauth ? { oauth } : {}),
    });
  }
  return out;
}

/** Strip secrets for client-side exposure. */
export function redactJmapServers(servers: JmapServerEntry[]): PublicJmapServerEntry[] {
  return servers.map((s) => ({
    id: s.id,
    label: s.label,
    url: s.url,
    domains: s.domains ?? [],
    ...(s.oauth && (s.oauth.clientId || s.oauth.issuerUrl)
      ? {
          oauth: {
            ...(s.oauth.clientId ? { clientId: s.oauth.clientId } : {}),
            ...(s.oauth.issuerUrl ? { issuerUrl: s.oauth.issuerUrl } : {}),
          },
        }
      : {}),
  }));
}

export function findServerById(servers: JmapServerEntry[], id: string | null | undefined): JmapServerEntry | undefined {
  if (!id) return undefined;
  return servers.find((s) => s.id === id);
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(trimUrl(url));
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return trimUrl(url).toLowerCase();
  }
}

export function findServerByUrl(servers: JmapServerEntry[], url: string | null | undefined): JmapServerEntry | undefined {
  if (!url) return undefined;
  const target = normalizeUrl(url);
  return servers.find((s) => normalizeUrl(s.url) === target);
}

function domainKey(domain: string): string {
  return toAsciiDomain(domain) ?? domain.trim().toLowerCase();
}

/**
 * Find the server whose `domains` array matches the given email's domain
 * (case-insensitive, IDN domains compared in their ASCII form).
 */
export function findServerByEmailDomain(servers: JmapServerEntry[], email: string | null | undefined): JmapServerEntry | undefined {
  if (!email || !email.includes('@')) return undefined;
  const domain = email.split('@')[1]?.trim();
  if (!domain) return undefined;
  const key = domainKey(domain);
  return servers.find((s) => (s.domains ?? []).some((d) => domainKey(d) === key));
}

/**
 * Resolve a client-supplied JMAP URL to a trusted upstream URL by checking it
 * against the configured server list and the global `jmapServerUrl`. Returns
 * null when no match is found. Used by API routes that need to forward auth
 * requests upstream without being tricked into hitting internal hosts.
 */
export function resolveTrustedJmapUrl(
  requestedUrl: string | null | undefined,
  globalServerUrl: string | null | undefined,
  servers: JmapServerEntry[],
): string | null {
  if (!requestedUrl) {
    return globalServerUrl ? trimUrl(globalServerUrl) : null;
  }
  const target = normalizeUrl(requestedUrl);
  if (globalServerUrl && normalizeUrl(globalServerUrl) === target) {
    return trimUrl(globalServerUrl);
  }
  const matched = servers.find((s) => normalizeUrl(s.url) === target);
  if (matched) return matched.url;
  // No match - caller decides whether to honor the request anyway (e.g. when
  // allowCustomJmapEndpoint is enabled).
  return null;
}
