/**
 * Where a mail server may send the desktop app's own server with a redirect.
 *
 * An approved server gets past the SSRF guard, and the guard only knows about the
 * address the user approved. Following its redirects anywhere would let it aim the
 * app at the LAN or at loopback, with the user's credentials on the request. So a
 * hop stays on its origin, goes to another approved server, or moves the same host
 * from http to https on the standard ports. Nothing else counts as the same server.
 *
 * A public server's hops go through the rebinding-safe fetch, which checks each of
 * them. AllowedJmapServers holds for every hop, wherever it comes from.
 *
 * Every other build keeps its rules: a server an admin configured is the admin's.
 */

import { mailServerRefusedByDevicePolicy } from './server-policy';
import { isDesktopTrustedServer } from './trusted-servers';

function movesUpToHttps(from: URL, to: URL): boolean {
  return from.protocol === 'http:' && to.protocol === 'https:' && from.hostname === to.hostname && from.port === '' && to.port === '';
}

/** `approved`: the request was let past the guard as an approved server. */
export function desktopRedirectRefused(from: string | URL, to: string | URL, approved: boolean): boolean {
  if (process.env.NEXT_PUBLIC_BULWARK_DESKTOP !== '1') return false;
  const source = new URL(from);
  const target = new URL(to);
  if (mailServerRefusedByDevicePolicy(target.href)) return true;
  if (!approved || source.origin === target.origin) return false;
  return !isDesktopTrustedServer(target.href) && !movesUpToHttps(source, target);
}
