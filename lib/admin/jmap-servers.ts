/**
 * Multi-server JMAP support: schema, parsing, lookup, and redaction helpers.
 */
import { isDesktopTrustedServer } from '@/lib/desktop/trusted-servers';


export interface JmapServerOAuthConfig {
  clientId?: string;
  issuerUrl?: string;
  clientSecret?: string;
  /** Text of this server's sign-in button, e.g. "Sign in with Google"; the generic SSO label otherwise. */
  buttonLabel?: string;
  /** The provider's logout URL, used instead of a discovered end_session_endpoint (#1279). Never sent to the browser. */
  endSessionUrl?: string;
}

export interface JmapServerEntry {
  id: string;
  label: string;
  url: string;
  domains?: string[];
  oauth?: JmapServerOAuthConfig & {
    /**
     * Set on the admin dashboard's view of an entry instead of the secret
     * itself: an admin session may change the secret but never read it
     * back. Never persisted.
     */
    hasClientSecret?: boolean;
  };
}

export interface PublicJmapServerEntry {
  id: string;
  label: string;
  url: string;
  domains: string[];
  oauth?: {
    clientId?: string;
    issuerUrl?: string;
    buttonLabel?: string;
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
      const buttonLabel = typeof o.buttonLabel === 'string' ? o.buttonLabel.trim().slice(0, 64) : '';
      // Kept as written: some providers' logout path ends in a slash.
      const endSessionUrl = typeof o.endSessionUrl === 'string' ? o.endSessionUrl.trim() : '';
      if (clientId || issuerUrl || clientSecret || endSessionUrl) {
        oauth = {};
        if (clientId) oauth.clientId = clientId;
        if (issuerUrl && isHttpUrl(issuerUrl)) oauth.issuerUrl = issuerUrl;
        if (clientSecret) oauth.clientSecret = clientSecret;
        if (buttonLabel) oauth.buttonLabel = buttonLabel;
        if (endSessionUrl && isHttpUrl(endSessionUrl)) oauth.endSessionUrl = endSessionUrl;
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

/**
 * An entry with its own OAuth client and a button label gets a sign-in button
 * of its own on the login page, even while OAuth is off globally. A client id
 * alone keeps its older meaning: the registered client that password and TOTP
 * logins use, which must not start offering OAuth on its own.
 */
export function offersOwnOAuth(server: PublicJmapServerEntry | undefined): boolean {
  return !!(server?.oauth?.clientId && server.oauth.buttonLabel);
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
            ...(s.oauth.buttonLabel ? { buttonLabel: s.oauth.buttonLabel } : {}),
          },
        }
      : {}),
  }));
}

/**
 * The admin dashboard's view: every field except the per-server OAuth client
 * secret, which is replaced by `hasClientSecret`. The dashboard shows the
 * global client secret and the session secret the same way (`hasValue`), so
 * that a stolen admin session cannot lift the secrets in one request.
 */
export function redactJmapServersForAdmin(servers: JmapServerEntry[]): JmapServerEntry[] {
  return servers.map((s) => {
    if (!s.oauth) return s;
    const { clientSecret, hasClientSecret: _ignored, ...rest } = s.oauth;
    void _ignored;
    return { ...s, oauth: { ...rest, ...(clientSecret ? { hasClientSecret: true } : {}) } };
  });
}

/**
 * Complete a dashboard-submitted server list with the client secrets already
 * stored. The dashboard never holds the secret, so an entry that still has an
 * OAuth block but names no `clientSecret` keeps the stored one; an explicit
 * empty string clears it, and dropping the OAuth block drops the secret with
 * it. Operates on the raw request value so the caller can still validate it.
 */
export function withStoredClientSecrets(incoming: unknown, stored: JmapServerEntry[]): unknown {
  if (!Array.isArray(incoming)) return incoming;
  const secrets = new Map<string, string>();
  for (const entry of stored) {
    if (entry.oauth?.clientSecret) secrets.set(entry.id, entry.oauth.clientSecret);
  }
  return incoming.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.oauth || typeof e.oauth !== 'object') return item;
    const o = e.oauth as Record<string, unknown>;
    const { hasClientSecret: _flag, ...oauth } = o;
    void _flag;
    const storedSecret = secrets.get(e.id.trim());
    if (oauth.clientSecret === undefined && storedSecret) oauth.clientSecret = storedSecret;
    return { ...e, oauth };
  });
}

export function findServerById(servers: JmapServerEntry[], id: string | null | undefined): JmapServerEntry | undefined {
  if (!id) return undefined;
  return servers.find((s) => s.id === id);
}

/** The form two server URLs are compared in: host lower-cased, no trailing slash. */
export function normalizeUrl(url: string): string {
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
  // A server the user approved in the desktop app. Spelled out, not IS_DESKTOP_BUILD:
  // only this form lets the bundler drop the branch and the module behind it, so
  // that no other build holds this path at all (scripts/standalone-guard.mjs checks).
  if (process.env.NEXT_PUBLIC_BULWARK_DESKTOP === '1' && isDesktopTrustedServer(requestedUrl)) return trimUrl(requestedUrl);
  // No match - caller decides whether to honor the request anyway (e.g. when
  // allowCustomJmapEndpoint is enabled).
  return null;
}
