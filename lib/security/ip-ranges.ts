import { isIP } from 'node:net';

// The one definition of "not a public unicast address" for every server-side
// guard (url-guard for caller-supplied URLs, telemetry for the admin-set
// collector). Two copies drifted once: url-guard blocked only 127.0.0.1 while
// telemetry already rejected all of 127/8, CGNAT and the IPv6 transition
// prefixes.

const PRIVATE_V4: RegExp[] = [
  /^0\./,                                          // 0.0.0.0/8
  /^10\./,                                         // 10.0.0.0/8
  /^127\./,                                        // loopback
  /^169\.254\./,                                   // link-local + cloud metadata
  /^172\.(1[6-9]|2\d|3[0-1])\./,                   // 172.16.0.0/12
  /^192\.168\./,                                   // 192.168.0.0/16
  /^192\.0\.0\./,                                  // IETF reserved
  /^198\.(1[8-9])\./,                              // benchmarking 198.18.0.0/15
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,      // 100.64.0.0/10 CGNAT
  /^22[4-9]\./,                                    // 224.0.0.0/4 multicast
  /^23\d\./,
  /^2[4-5]\d\./,                                   // 240.0.0.0/4 reserved + broadcast
];

function isPrivateV4(ip: string): boolean {
  return PRIVATE_V4.some((re) => re.test(ip));
}

// Expand an IPv6 literal into its eight 16-bit groups. Accepts `::`
// compression, a trailing embedded dotted quad (`::ffff:127.0.0.1`) and a
// zone id suffix. Returns null when the string isn't a well-formed address.
//
// We parse structurally rather than regex-matching the textual form because
// the same address has several spellings: the WHATWG URL parser rewrites
// `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, while dns.lookup returns the
// dotted form. A textual check that only knew one spelling let the other
// straight through (GHSA-m7j8-f5q4-vj7x).
export function parseV6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);

  const v4 = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(2, 6).map(Number);
    if (o.some((n) => n > 255)) return null;
    s = `${v4[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  if (halves.length === 2 && missing === 0) return null;

  const groups = [...head, ...new Array<string>(missing).fill('0'), ...tail]
    .map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (groups.some(Number.isNaN)) return null;
  return groups;
}

function v4FromGroups(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isPrivateV6(ip: string): boolean {
  const g = parseV6Groups(ip);
  // Fail closed: isIP() said this is IPv6 but we can't make sense of it.
  if (!g) return true;

  const leadingZero = (n: number) => g.slice(0, n).every((x) => x === 0);

  if (leadingZero(7) && (g[7] === 0 || g[7] === 1)) return true;         // :: and ::1
  if ((g[0] & 0xff00) === 0xff00) return true;                            // ff00::/8 multicast
  if ((g[0] & 0xffc0) === 0xfe80) return true;                            // fe80::/10 link-local
  if ((g[0] & 0xfe00) === 0xfc00) return true;                            // fc00::/7 ULA
  if (g[0] === 0x2001 && g[1] === 0) return true;                         // 2001::/32 Teredo
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;        // 64:ff9b:1::/48 local NAT64

  // Forms that embed an IPv4 address: judge them by the embedded address so
  // an IPv6-only host behind DNS64 can still reach a public server.
  if (leadingZero(5) && g[5] === 0xffff) {                                // ::ffff:0:0/96 IPv4-mapped
    return isPrivateV4(v4FromGroups(g[6], g[7]));
  }
  if (leadingZero(6)) {                                                   // ::/96 IPv4-compatible (deprecated)
    return isPrivateV4(v4FromGroups(g[6], g[7]));
  }
  if (g[0] === 0x64 && g[1] === 0xff9b &&
      g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {             // 64:ff9b::/96 NAT64
    return isPrivateV4(v4FromGroups(g[6], g[7]));
  }
  if (g[0] === 0x2002) {                                                  // 2002::/16 6to4
    return isPrivateV4(v4FromGroups(g[1], g[2]));
  }
  return false;
}

/**
 * True for any address a server-side fetch must not reach: loopback,
 * RFC 1918, link-local, CGNAT, benchmarking, reserved, multicast, ULA, and
 * IPv6 transition forms whose embedded IPv4 address is one of those.
 * Returns false for anything that is not an IP literal.
 */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family === 6) return isPrivateV6(ip);
  return false;
}
