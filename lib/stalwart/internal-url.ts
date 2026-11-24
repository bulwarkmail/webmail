/**
 * The address Bulwark's own server uses for a JMAP server (#1294).
 *
 * Browsers reach the mail server under its public URL (`jmapServerUrl`, or a
 * `jmapServers` entry's `url`). Inside Docker or Kubernetes that name may not
 * work from the Bulwark container (NAT hairpin, a firewall or CDN in front),
 * so the admin can name an internal URL for server-side requests:
 * `JMAP_INTERNAL_SERVER_URL` for the main server, `internalUrl` on a list
 * entry. A request from Bulwark's server to the public URL, or below it, goes
 * to the internal one instead; that includes the apiUrl and downloadUrl in
 * the session object, which the server builds with its public name.
 *
 * The internal URL only comes from the admin's config, never from a request,
 * and only requests to a configured (trusted) server are rewritten. Nothing
 * here reaches the browser: the public URL stays the one users see.
 */

import { configManager } from '@/lib/admin/config-manager';
import { parseJmapServers } from '@/lib/admin/jmap-servers';

export interface InternalUrlMapping {
  /** The URL browsers use. */
  publicUrl: string;
  /** The URL Bulwark's server uses instead. */
  internalUrl: string;
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

const trimPath = (path: string) => path.replace(/\/+$/, '');

/**
 * `url` with the first mapping whose public URL it is at or below replaced
 * by that mapping's internal URL; `url` itself when none matches. Origins
 * compare as URL parses them (host in any case, default port dropped); a
 * public URL with a path only matches at a path segment boundary.
 */
export function rewriteToInternalUrl(url: string, mappings: readonly InternalUrlMapping[]): string {
  const target = parseHttpUrl(url);
  if (!target) return url;
  for (const mapping of mappings) {
    const from = parseHttpUrl(mapping.publicUrl);
    const to = parseHttpUrl(mapping.internalUrl);
    if (!from || !to || from.origin !== target.origin) continue;
    const base = trimPath(from.pathname);
    if (base && target.pathname !== base && !target.pathname.startsWith(`${base}/`)) continue;
    const rest = target.pathname.slice(base.length);
    return `${to.origin}${trimPath(to.pathname)}${rest}${target.search}${target.hash}`;
  }
  return url;
}

/** The admin's internal URLs, from the current config. */
export function internalUrlMappings(): InternalUrlMapping[] {
  const out: InternalUrlMapping[] = [];
  const internal = configManager.get<string>('jmapInternalServerUrl', '') || '';
  const publicUrl =
    configManager.get<string>('jmapServerUrl', '') ||
    process.env.JMAP_SERVER_URL ||
    process.env.NEXT_PUBLIC_JMAP_SERVER_URL ||
    '';
  if (internal.trim() && publicUrl.trim()) out.push({ publicUrl, internalUrl: internal });
  for (const server of parseJmapServers(configManager.get<unknown>('jmapServers', []))) {
    if (server.internalUrl) out.push({ publicUrl: server.url, internalUrl: server.internalUrl });
  }
  return out;
}

/**
 * Where Bulwark's server sends a request meant for `url` (see the file
 * comment). Reads the config already loaded: every caller loaded it to decide
 * whether the server is a configured one.
 */
export function serverSideJmapUrl(url: string): string {
  let mappings: InternalUrlMapping[];
  try {
    mappings = internalUrlMappings();
  } catch {
    // An unreadable config leaves the request as it was.
    return url;
  }
  return rewriteToInternalUrl(url, mappings);
}
