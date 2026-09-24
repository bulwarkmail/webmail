import { headers } from 'next/headers';
import { configManager } from '@/lib/admin/config-manager';
import { clientIpFromHeaders } from '@/lib/security/client-ip';

/**
 * Headers that tell the admin-configured JMAP server which end user a
 * server-side request is made for.
 *
 * Bulwark checks credentials from its own server (login pre-check, session and
 * Stalwart-context cookies, TOTP login, account passthrough, WebDAV/CalDAV).
 * Without this, the JMAP server attributes every one of those requests to
 * Bulwark's own address: a server that rate-limits or bans failed logins per
 * IP (Stalwart's auth ban, fail2ban) then counts every user's typo - and every
 * anonymous request with a wrong password - against that single address, and
 * eventually locks Bulwark's server side out for everyone.
 *
 * Opt-in (JMAP_FORWARD_CLIENT_IP) because the value is only as good as the
 * X-Forwarded-For Bulwark receives: Bulwark must be reachable only through
 * reverse proxies that append to (or replace) that header, with
 * TRUSTED_PROXY_DEPTH matching. Reached directly, a client would choose the
 * address the JMAP server then bans or exempts. It also only helps when the
 * JMAP server honours the header from Bulwark alone.
 *
 * Only ever sent to admin-configured servers, never to a user-supplied custom
 * endpoint. Empty outside a request or when the client address is unknown.
 */
export async function forwardedClientIpHeaders(): Promise<Record<string, string>> {
  // No ensureLoaded(): it sits in front of every JMAP fetch, so it must never
  // throw or do I/O. Every caller has loaded the config already.
  if (!configManager.get<boolean>('jmapForwardClientIp', false)) return {};
  let requestHeaders: Pick<Headers, 'get'>;
  try {
    requestHeaders = await headers();
  } catch {
    // Outside a request (timers, background work) there is no end user to
    // name. Every caller runs inside a dynamic route, never a prerender.
    return {};
  }
  const ip = clientIpFromHeaders(requestHeaders);
  return ip ? { 'X-Forwarded-For': ip } : {};
}
