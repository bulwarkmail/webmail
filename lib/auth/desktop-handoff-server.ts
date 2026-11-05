import { configManager } from '@/lib/admin/config-manager';
import { findServerById, findServerByUrl, parseJmapServers, resolveTrustedJmapUrl, type JmapServerEntry } from '@/lib/admin/jmap-servers';
import { IS_DESKTOP_BUILD } from '@/lib/desktop/flag';
import { isPublicHttpUrl } from '@/lib/security/url-guard';

/**
 * What the desktop app's sign-in routes share (app/api/auth/desktop-handoff). The same
 * pinning as the other sign-in routes, and the instance admin's switch: on a terminal
 * server another local user can bind a loopback port, so the admin can turn the hand-off
 * off there. A device's own `BrowserSignIn` doesn't reach this: it's about the app, and
 * the other user's link opens in a browser.
 */
export interface DesktopHandoffRefusal {
  error: string;
  status: number;
}

export function desktopHandoffEnabled(): boolean {
  return !IS_DESKTOP_BUILD && configManager.get<boolean>('desktopBrowserSignIn', true);
}

export type DesktopHandoffServer =
  | { refusal: DesktopHandoffRefusal }
  | {
      entry: JmapServerEntry | undefined;
      /** What's checked and parked, whatever the body said. */
      resolved: string;
      upstream: string;
      trusted: boolean;
      /** The user's own server, by `allowCustomJmapEndpoint`. A device's policy may refuse it. */
      custom: boolean;
    };

export async function resolveDesktopHandoffServer(serverUrl: string, serverId: unknown): Promise<DesktopHandoffServer> {
  await configManager.ensureLoaded();
  if (!desktopHandoffEnabled()) return { refusal: { error: 'disabled', status: 403 } };
  // Same gate as the session and verify routes: an admin who turned on the
  // password fallback lets passwords through here too.
  if (
    configManager.get<boolean>('oauthEnabled', false)
    && configManager.get<boolean>('oauthOnly', false)
    && !configManager.get<boolean>('oauthPasswordFallbackEnabled', false)
  ) {
    return { refusal: { error: 'oauth_only', status: 403 } };
  }
  const configured =
    configManager.get<string>('jmapServerUrl', '') || process.env.JMAP_SERVER_URL || process.env.NEXT_PUBLIC_JMAP_SERVER_URL || '';
  const list = parseJmapServers(configManager.get<unknown>('jmapServers', []));
  const requested = typeof serverId === 'string' && serverId ? serverId : null;
  const entry = findServerById(list, requested) || findServerByUrl(list, serverUrl) || undefined;
  let resolved: string;
  let trusted = true;
  let custom = false;
  if (entry) {
    resolved = entry.url;
  } else {
    const pinned = resolveTrustedJmapUrl(serverUrl, configured, list);
    if (pinned) {
      resolved = pinned;
    } else if (configManager.get<boolean>('allowCustomJmapEndpoint', false) && (await isPublicHttpUrl(serverUrl))) {
      resolved = serverUrl;
      trusted = false;
      custom = true;
    } else {
      return { refusal: { error: 'invalid_server_url', status: 400 } };
    }
  }
  return { entry, resolved, upstream: resolved.replace(/\/+$/, ''), trusted, custom };
}
