import { BlockList, isIP } from 'node:net';

// Never passed on as a client address (see normalizeIp).
const NOT_A_CLIENT = new BlockList();
NOT_A_CLIENT.addSubnet('127.0.0.0', 8, 'ipv4');
NOT_A_CLIENT.addAddress('0.0.0.0', 'ipv4');
NOT_A_CLIENT.addAddress('::1', 'ipv6');
NOT_A_CLIENT.addAddress('::', 'ipv6');

/**
 * Pick the client address out of an X-Forwarded-For value.
 *
 * Proxies *append* to X-Forwarded-For, so everything left of the entries our
 * own proxies added is whatever the client chose to send. With
 * TRUSTED_PROXY_DEPTH trusted proxies in front of the app (default 1), the
 * client is the entry that many places from the right.
 */
export function pickForwardedFor(value: string): string | undefined {
  const parts = value.split(',').map(s => s.trim()).filter(Boolean);
  const depth = Math.max(1, parseInt(process.env.TRUSTED_PROXY_DEPTH || '1', 10));
  return parts[Math.max(0, parts.length - depth)];
}

/**
 * Normalise one forwarded entry to a bare IP literal, or null.
 *
 * Accepts what proxies write: a bare address, `a.b.c.d:port` and
 * `[v6]:port` (some load balancers append the port), and IPv4-mapped IPv6
 * (`::ffff:a.b.c.d`, reported for IPv4 clients on a dual-stack socket), which
 * becomes plain IPv4. Rejects zone IDs, the unspecified address and loopback:
 * a real end user never arrives from loopback, and loopback is exactly what a
 * mail server tends to allow-list, so passing it on could only exempt someone
 * from rate limits.
 */
function normalizeIp(value: string): string | null {
  let ip = value.trim();
  const v4Port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(ip);
  const v6Port = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (v4Port) ip = v4Port[1];
  else if (v6Port) ip = v6Port[1];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const family = ip.includes('%') ? 0 : isIP(ip);
  if (family === 0) return null;
  if (NOT_A_CLIENT.check(ip, family === 4 ? 'ipv4' : 'ipv6')) return null;
  return ip;
}

/**
 * The end user's IP address for this request, or null when it is unknown or
 * not usable. Same derivation as the admin rate limiter (`getClientIP`), but
 * strict: a value that is not a routable address is never passed on.
 */
export function clientIpFromHeaders(requestHeaders: Pick<Headers, 'get'>): string | null {
  const forwarded = requestHeaders.get('x-forwarded-for');
  const candidate = forwarded ? pickForwardedFor(forwarded) : requestHeaders.get('x-real-ip');
  return candidate ? normalizeIp(candidate) : null;
}
