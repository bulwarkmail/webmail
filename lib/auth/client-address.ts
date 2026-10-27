import { BlockList, isIP } from 'node:net';
import { getClientIP } from '@/lib/admin/session';

/** Addresses that name no client: loopback and unspecified. */
const NOT_A_CLIENT = new BlockList();
NOT_A_CLIENT.addSubnet('127.0.0.0', 8, 'ipv4');
NOT_A_CLIENT.addAddress('0.0.0.0', 'ipv4');
NOT_A_CLIENT.addAddress('::1', 'ipv6');
NOT_A_CLIENT.addAddress('::', 'ipv6');
NOT_A_CLIENT.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

/**
 * Every credential the sign-in routes check reaches the mail server from this
 * host's address. Stalwart counts failed logins per address (fail2ban) and
 * bans the address once the allowance is spent, so wrong passwords typed by
 * or fired at the webmail would eventually lock the webmail itself out for
 * everyone. Handing Stalwart the real client address lets it attribute the
 * failure to that client instead, once the admin tells it to read the header:
 * on 0.16 `Http.useXForwarded` (it then prefers a `Forwarded` header and
 * otherwise takes the first `X-Forwarded-For` entry), on 1.0
 * `Http.clientIpSource` = `xForwardedFor` with `forwardedHops` = 1 (the last
 * entry; more when proxies between the webmail and Stalwart append their
 * own). Neither checks where the connection comes from, so only enable it
 * when every HTTP client of Stalwart goes through the webmail or a proxy
 * that sets the header. Left at its default, Stalwart ignores the header.
 *
 * Only a syntactically valid address is forwarded: the client-facing value
 * comes from the request's own `X-Forwarded-For` when no reverse proxy
 * rewrites it, and anything else would be a stranger's text in an upstream
 * header.
 *
 * Nor is a loopback or unspecified address: it says nothing about the client,
 * and Stalwart 1.0 set to read `X-Forwarded-For` (what stalwart-migrate makes
 * of a 0.16 server behind a proxy) answers 400 to a request naming one.
 */
export function forwardedClientHeaders(clientIp: string | undefined): Record<string, string> {
  const family = clientIp ? isIP(clientIp) : 0;
  if (!clientIp || family === 0 || NOT_A_CLIENT.check(clientIp, family === 4 ? 'ipv4' : 'ipv6')) return {};
  return { 'X-Forwarded-For': clientIp };
}

/** The client address of `request` as the sign-in routes forward and budget it. */
export function loginClientAddress(request: Request): string {
  return getClientIP(request);
}
