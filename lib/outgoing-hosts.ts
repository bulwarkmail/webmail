/**
 * The browser-side switches of the "no third-party traffic" mode (#903).
 *
 * Small on purpose: this module ships in every client chunk and in Lite. The
 * registry with the admin-facing descriptions is lib/admin/outgoing-hosts-registry.ts.
 * Every helper that opens an outside host asks noThirdPartyTraffic(), which is
 * true while the mode is on and while the config isn't known yet.
 */

import { noThirdPartyTraffic } from './third-party-mode';

/** Exact host names of the built-in outside hosts (the registry repeats them; a test keeps both equal). */
export const BUILT_IN_HOSTNAMES: readonly string[] = [
  'telemetry.bulwarkmail.org',
  'version.telemetry.bulwarkmail.org',
  'notifications.relay.bulwarkmail.org',
  'extensions.bulwarkmail.org',
  'connector.bulwarkmail.org',
  'icons.duckduckgo.com',
  'api.mymemory.translated.net',
  'www.google.com',
  'randomuser.me',
  'img.freepik.com',
];

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Whether a URL points at one of the built-in outside hosts. */
export function isBuiltInHost(url: string): boolean {
  const host = hostnameOf(url);
  return !!host && BUILT_IN_HOSTNAMES.includes(host);
}

/** A push relay may be used: always, except the built-in one in the mode. */
export function relayAllowed(url: string): boolean {
  return !(noThirdPartyTraffic() && isBuiltInHost(url));
}

/** Sender icons through /api/favicon. */
export function senderFaviconsAllowed(): boolean {
  return !noThirdPartyTraffic();
}

/** The Google Maps link on an event's address. */
export function mapsLinksAllowed(): boolean {
  return !noThirdPartyTraffic();
}

/** OpenPGP WKD lookups at the recipient's domain. */
export function wkdAllowed(): boolean {
  return !noThirdPartyTraffic();
}

/** Sample photos of the mock server. */
export function sampleAvatarsAllowed(): boolean {
  return !noThirdPartyTraffic();
}

/**
 * An avatar URL may be shown: a plugin's (Gravatar, Libravatar...) or a
 * contact card's photo link. In the mode only when it stays on this origin or
 * is inline data, so those avatars fall back to initials instead of reaching
 * out (or tripping the CSP).
 */
export function avatarUrlAllowed(url: string | null | undefined, origin?: string): boolean {
  if (!url) return false;
  if (!noThirdPartyTraffic()) return true;
  if (/^(data|blob):/i.test(url)) return true;
  const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  try {
    return !!base && new URL(url, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** The parts of a manifest credential (lib/plugin-secrets/credentials.ts) the mode looks at. */
export interface ModeCredential {
  scope?: string;
  origin?: string;
  originKey?: string;
}

export interface NetworkDeclaringPlugin {
  permissions?: readonly string[];
  httpOrigins?: readonly string[];
  frameOrigins?: readonly string[];
  credentials?: Readonly<Record<string, ModeCredential>>;
}

/**
 * A proxied credential stays usable in the no-third-party mode when the
 * admin entered its server on the plugin's admin page (`originKey`): a host
 * the deployment configured itself, like the JMAP server. A server fixed in
 * the manifest (Google Safe Browsing) and the accounts users connect are
 * outside hosts and stay off.
 */
export function credentialAllowedInMode(spec: ModeCredential | undefined): boolean {
  return !!spec && spec.scope === 'admin' && typeof spec.originKey === 'string' && !spec.origin;
}

/**
 * A plugin whose only network access is the credential proxy with admin
 * credentials, at least one of them on a server the admin entered. It runs
 * in the mode; the proxy refuses its other credentials there.
 */
export function pluginReachesOnlyAdminHosts(plugin: NetworkDeclaringPlugin): boolean {
  const permissions = plugin.permissions ?? [];
  if (permissions.includes('http:fetch') || (plugin.httpOrigins?.length ?? 0) > 0 || (plugin.frameOrigins?.length ?? 0) > 0) return false;
  const specs = Object.values(plugin.credentials ?? {});
  return specs.length > 0
    && specs.every((spec) => spec?.scope === 'admin')
    && specs.some(credentialAllowedInMode);
}

/**
 * A plugin declares network access when it may fetch outside hosts
 * (`http:fetch` with httpOrigins), use the credential proxy (`http:proxy`) or
 * embed outside frames (frameOrigins). Same-origin `http:post` doesn't count.
 */
export function pluginDeclaresNetwork(plugin: NetworkDeclaringPlugin): boolean {
  const permissions = plugin.permissions ?? [];
  return permissions.includes('http:fetch')
    || permissions.includes('http:proxy')
    || (plugin.httpOrigins?.length ?? 0) > 0
    || (plugin.frameOrigins?.length ?? 0) > 0;
}

/** Error code a refused plugin carries (shown translated in Settings > Plugins). */
export const PLUGIN_REFUSED_ERROR = 'third-party-off';

/** Whether a plugin may run while the mode is on (see pluginReachesOnlyAdminHosts). */
export function pluginAllowedInMode(plugin: NetworkDeclaringPlugin): boolean {
  return !pluginDeclaresNetwork(plugin) || pluginReachesOnlyAdminHosts(plugin);
}

/** Whether a plugin may run in this browser. */
export function pluginAllowed(plugin: NetworkDeclaringPlugin): boolean {
  return !noThirdPartyTraffic() || pluginAllowedInMode(plugin);
}
