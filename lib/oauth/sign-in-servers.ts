import { configManager } from '@/lib/admin/config-manager';
import { parseJmapServers } from '@/lib/admin/jmap-servers';
import { IS_DESKTOP_BUILD } from '@/lib/desktop/flag';
import type { IssuerRule } from '@/lib/oauth/discovery';

/**
 * Strip a trailing JMAP session path so OAuth discovery hits the right base.
 *
 * `discoverOAuth` appends `/.well-known/...` to this base, so JMAP_SERVER_URL set to
 * the session URL (`.../jmap/session` or `.../.well-known/jmap`, common so the client
 * can skip the 307 redirect a preflighted CORS request cannot follow) makes discovery
 * fetch `<session-url>/.well-known/oauth-authorization-server`, get a 404, and refresh
 * fail with "OAuth token endpoint not found".
 *
 * Only the session suffix (and any query or fragment) is removed, not the whole path:
 * discovery also runs against OAUTH_ISSUER_URL, and a path-based issuer (for example a
 * Keycloak realm at `/realms/<name>`) must keep its path. So this is deliberately not
 * `new URL(url).origin`. (#971)
 */
export function discoveryBase(url: string): string {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/\/(?:jmap\/session|\.well-known\/jmap)\/*$/, '');
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return url;
  }
}

/** The configured server (no `jmapServers` entry) and its issuer URL, admin setting first, then the environment. */
export function configuredServer(): { serverUrl: string | undefined; issuerUrl: string | undefined } {
  return {
    serverUrl: configManager.get<string>('jmapServerUrl', '') || process.env.JMAP_SERVER_URL || process.env.NEXT_PUBLIC_JMAP_SERVER_URL,
    issuerUrl: configManager.get<string>('oauthIssuerUrl', '') || process.env.OAUTH_ISSUER_URL,
  };
}

/**
 * Whether this instance signs users in at exactly one provider, from the
 * settings the login page offers servers by: the `jmapServers` list, the
 * configured server, `allowCustomJmapEndpoint`, and the desktop build (whose
 * users sign in to servers they typed). Each listed entry and the configured
 * server count by the address discovery runs against (their issuer URL, or
 * their own URL); entries that share it are one provider. The configured
 * server counts even beside a list, since the sign-in routes still accept it
 * without a server id. Typed servers make any number possible.
 */
export function hasSingleSignInServer(): boolean {
  if (IS_DESKTOP_BUILD) return false;
  if (configManager.get<boolean>('allowCustomJmapEndpoint', false)) return false;
  const bases = new Set<string>();
  for (const entry of parseJmapServers(configManager.get<unknown>('jmapServers', []))) {
    bases.add(discoveryBase(entry.oauth?.issuerUrl?.trim() || entry.url));
  }
  const { serverUrl, issuerUrl } = configuredServer();
  if (serverUrl) bases.add(discoveryBase(issuerUrl?.trim() || serverUrl));
  return bases.size <= 1;
}

/**
 * How a sign-in checks the `issuer` of a provider's metadata
 * (lib/oauth/discovery.ts). With more than one sign-in server it must be the
 * address discovery ran against, so no server can pass for another and
 * collect the codes it issues. With one there is no other server to pass
 * for, so any issuer it names is taken: an install that reaches its mail
 * server by an internal address keeps signing in.
 */
export function signInIssuerRule(): IssuerRule {
  return hasSingleSignInServer() ? 'named' : 'own';
}
