/**
 * Finds the JMAP server of an email domain for the sign-in form, server side:
 * the documents rarely carry CORS headers, and the browser can't ask DNS.
 *
 * 1. `https://<domain>/.well-known/jmap` (RFC 8620 2.2), following up to three
 *    redirects. Stalwart answers 307 to /jmap/session, which answers 401.
 * 2. The SRV record `_jmap._tcp.<domain>` (RFC 8620 2.2), checked the same way
 *    on the host it names.
 *
 * Every request goes through fetchPublicUrl, so only public addresses are
 * asked, and each redirect target is checked again. The answer is the origin
 * that served the session resource; the form signs in there.
 */

import { resolveSrv } from 'node:dns/promises';
import { fetchPublicUrl } from '@/lib/security/url-guard';
import { emailDomain } from './mail-server-address';

const TIMEOUT_MS = 4000;
const MAX_REDIRECTS = 3;

export interface DiscoveryDeps {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;
  resolveSrv: (name: string) => Promise<{ name: string; port: number; priority: number; weight: number }[]>;
}

const defaultDeps: DiscoveryDeps = {
  fetch: (url, init) => fetchPublicUrl(url, init),
  resolveSrv: (name) => resolveSrv(name),
};

/** Does a JMAP session resource answer at this base? Returns the origin that answered, or null. */
async function probe(base: string, deps: DiscoveryDeps): Promise<string | null> {
  let url = `${base}/.well-known/jmap`;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response;
    try {
      response = await deps.fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return null;
      }
      // Never down to plain http: the password would follow it.
      if (next.protocol !== 'https:') return null;
      url = next.toString();
      continue;
    }
    // The session resource usually needs a sign-in: 401 with a challenge. Stalwart
    // answers 200 with an anonymous session, which names its capabilities.
    if (response.status === 401 && response.headers.get('www-authenticate') !== null) return new URL(url).origin;
    if (response.status === 200 && /json/i.test(response.headers.get('content-type') ?? '')) {
      const body = await response.text().catch(() => '');
      if (body.length > 256 * 1024) return null;
      try {
        const session = JSON.parse(body) as { capabilities?: unknown };
        if (session && typeof session.capabilities === 'object' && session.capabilities !== null) return new URL(url).origin;
      } catch {
        return null;
      }
    }
    return null;
  }
  return null;
}

/** The JMAP server for an email address, or null when nothing answered. */
export async function discoverMailServer(address: string, deps: DiscoveryDeps = defaultDeps): Promise<string | null> {
  const domain = emailDomain(address);
  if (!domain) return null;

  const direct = await probe(`https://${domain}`, deps);
  if (direct) return direct;

  let records: Awaited<ReturnType<DiscoveryDeps['resolveSrv']>> = [];
  try {
    records = await deps.resolveSrv(`_jmap._tcp.${domain}`);
  } catch {
    return null;
  }
  const ordered = [...records]
    // "." means the service is decidedly not offered (RFC 2782).
    .filter((r) => r.name && r.name !== '.')
    .sort((a, b) => a.priority - b.priority || b.weight - a.weight);
  for (const record of ordered.slice(0, 2)) {
    const host = record.name.replace(/\.$/, '').toLowerCase();
    const base = record.port && record.port !== 443 ? `https://${host}:${record.port}` : `https://${host}`;
    const found = await probe(base, deps);
    if (found) return found;
  }
  return null;
}
