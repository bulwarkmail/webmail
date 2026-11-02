import type { SettingsPolicy } from './types';
import { parseJmapServers } from './jmap-servers';
import { isBuiltInHost } from '@/lib/outgoing-hosts';
import { DEFAULT_RELAY_BASE_URL } from '@/lib/push-relays';
import { allFeeds } from './company-feeds';
import { tracingEndpoint } from '@/lib/tracing/config';

/**
 * What stays reachable with "no third-party traffic" on: the hosts the
 * deployment configured itself, plus the addresses users type in themselves.
 * Shown on Organisation > Security so an admin can check the list against
 * what they expect, and turned into the page's CSP in the mode (#903).
 */

export interface ReachableHost {
  /** What the host is for, e.g. "JMAP server". */
  kind: string;
  /** The host (and port when it isn't the default), or "any address your users enter". */
  host: string;
  /** scheme://host[:port], for the CSP; absent for addresses users enter. */
  origin?: string;
  /** Where it was configured, e.g. "JMAP_SERVER_URL" or "User policy > Push relays". */
  setIn: string;
  /** Who connects: this server, the browser, or both. */
  side: 'server' | 'browser' | 'both';
  /** Something the admin should know about this line. */
  note?: string;
}

export const USER_ENTERED = 'any address your users enter';

function parse(url: unknown): URL | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : null;
  } catch {
    return null;
  }
}

export interface ReachableInput {
  get: (key: string) => unknown;
  policy: Pick<SettingsPolicy, 'pushRelays' | 'pushRelayUrl' | 'defaultSidebarApps'> & Partial<Pick<SettingsPolicy, 'organisation' | 'scopes'>> & { features?: Partial<SettingsPolicy['features']> };
  env: Record<string, string | undefined>;
  /** The relay the browser bundle was built with (NEXT_PUBLIC_PUSH_RELAY_URL inlined at build time). */
  buildRelayUrl?: string;
  /**
   * Plugins that run in the mode and the servers the admin entered on their
   * admin page (credentials with an originKey; lib/outgoing-hosts.ts).
   */
  plugins?: { name: string; origins: string[] }[];
}

const BRANDING_KEYS = [
  'faviconUrl', 'pwaIconUrl', 'pwaScreenshotMobileUrl', 'pwaScreenshotDesktopUrl',
  'appLogoLightUrl', 'appLogoDarkUrl', 'loginLogoLightUrl', 'loginLogoDarkUrl',
] as const;

export function listReachableHosts({ get, policy, env, buildRelayUrl = DEFAULT_RELAY_BASE_URL, plugins = [] }: ReachableInput): ReachableHost[] {
  const out: ReachableHost[] = [];
  const seen = new Set<string>();
  const add = (kind: string, url: unknown, setIn: string, side: ReachableHost['side'], note?: string) => {
    const parsed = parse(url);
    // A built-in host listed here would be off in the mode anyway; leaving
    // it out keeps the list to what really stays reachable.
    if (!parsed || isBuiltInHost(parsed.href)) return;
    const host = parsed.host.toLowerCase();
    const key = `${kind}|${host}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, host, origin: parsed.origin, setIn, side, ...(note ? { note } : {}) });
  };

  add('JMAP server', get('jmapServerUrl'), 'JMAP_SERVER_URL', 'both');
  for (const server of parseJmapServers(get('jmapServers'))) {
    add('JMAP server', server.url, `JMAP_SERVERS (${server.label})`, 'both');
    add('OAuth issuer', server.oauth?.issuerUrl, `JMAP_SERVERS (${server.label})`, 'both');
    add('OAuth issuer', server.oauth?.endSessionUrl, `JMAP_SERVERS (${server.label})`, 'browser');
  }
  if (get('oauthEnabled') === true) {
    add('OAuth issuer', get('oauthIssuerUrl'), 'OAUTH_ISSUER_URL', 'both');
    add('OAuth issuer', get('oauthAuthorizeUrl'), 'OAUTH_AUTHORIZE_URL', 'browser');
    add('OAuth issuer', get('oauthEndSessionUrl'), 'OAUTH_END_SESSION_URL', 'browser');
  }
  for (const relay of policy.pushRelays ?? []) add('Push relay', relay?.url, 'User policy > Push relays', 'browser');
  add('Push relay', policy.pushRelayUrl, 'User policy > Push relays', 'browser');
  // The relay browsers offer as the default is the one inlined when the
  // bundle was built. A different value in the running environment does
  // nothing for them, so it is listed with a warning.
  add('Push relay', buildRelayUrl, 'NEXT_PUBLIC_PUSH_RELAY_URL (build)', 'browser');
  const runtimeRelay = parse(env.NEXT_PUBLIC_PUSH_RELAY_URL);
  if (runtimeRelay && runtimeRelay.origin !== parse(buildRelayUrl)?.origin) {
    add('Push relay', runtimeRelay.href, 'NEXT_PUBLIC_PUSH_RELAY_URL (environment)', 'browser',
      'Set in the environment only: browsers use the relay this build was made with. Rebuild, or add it under User policy > Push relays.');
  }
  add('Extension directory', get('extensionDirectoryUrl'), 'EXTENSION_DIRECTORY_URL', 'server');
  // Company calendars of Everyone and of every scope: this server fetches
  // them (app/api/fetch-ical by feed id), whatever the switch says.
  for (const feed of allFeeds(policy)) add('Company calendar', feed.url, `Organisation > Calendars (${feed.name})`, 'server');
  // A plugin's server the admin entered (a company link check): this server
  // proxies its requests (app/api/plugin-proxy).
  for (const plugin of plugins) {
    for (const origin of plugin.origins) add(`Plugin ${plugin.name}`, origin, "The plugin's admin page", 'server');
  }
  for (const app of policy.defaultSidebarApps ?? []) add('Sidebar app', app?.url, `User policy > Sidebar apps (${app?.name ?? ''})`, 'browser');
  add('Document editor (WOPI)', get('wopiClientUrl'), 'WOPI_CLIENT_URL', 'both');
  add('Translation (LibreTranslate)', env.LIBRETRANSLATE_URL, 'LIBRETRANSLATE_URL', 'server');
  // Only when an admin set it; browsers and this server send error reports there.
  add('Error reporting', get('errorReportingDsn'), 'ERROR_REPORTING_DSN', 'both');
  // OpenTelemetry's OTLP endpoint, only when set in the standard OTEL_* variables.
  const otlp = tracingEndpoint(env);
  if (otlp) add('Tracing (OTLP)', otlp, env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ? 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT' : 'OTEL_EXPORTER_OTLP_ENDPOINT', 'server');
  for (const key of BRANDING_KEYS) add('Branding image', get(key), key, 'browser');

  // User-directed: what users type in themselves stays allowed.
  if (get('allowCustomJmapEndpoint') === true) {
    out.push({ kind: 'JMAP server', host: USER_ENTERED, setIn: 'ALLOW_CUSTOM_JMAP_ENDPOINT', side: 'both',
      note: 'Users can sign in to any server, so the browser may connect to any https host.' });
  }
  if (policy.features?.sidebarAppsEnabled !== false) {
    out.push({ kind: 'Sidebar apps users add', host: USER_ENTERED, setIn: 'Users, in Settings > Apps', side: 'browser' });
  }
  if (policy.features?.calendarEnabled !== false) {
    out.push({ kind: 'Calendar subscriptions', host: USER_ENTERED, setIn: 'Users, in Calendar', side: 'server' });
  }
  return out;
}

/**
 * The Content-Security-Policy sources of the page in the no-third-party mode:
 * 'self' and the origins above. With custom JMAP endpoints allowed, the
 * browser must reach whatever server a user signs in to, so connect-src
 * keeps https: (the other directives stay narrow).
 */
export function noThirdPartyCspSources(hosts: ReachableHost[], allowCustomJmapEndpoint: boolean): { connect: string[]; other: string[] } {
  const origins = [...new Set(hosts.flatMap((h) => (h.origin ? [h.origin] : [])))];
  return {
    connect: allowCustomJmapEndpoint ? [...origins, 'https:'] : origins,
    other: origins,
  };
}
