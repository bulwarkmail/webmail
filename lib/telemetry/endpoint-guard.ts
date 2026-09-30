import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isPrivateAddress } from '@/lib/security/ip-ranges';
import { fetchPublicUrl } from '@/lib/security/url-guard';

export { isPrivateAddress, parseV6Groups } from '@/lib/security/ip-ranges';

// Block telemetry endpoints from pointing at internal/loopback addresses.
// Required because the admin UI lets an authenticated admin set an arbitrary
// URL; without this an attacker with a session (or a hostile admin in a
// multi-tenant deploy) could redirect heartbeats at internal hosts.
//
// Set BULWARK_TELEMETRY_ALLOW_PRIVATE=1 to bypass - useful only for local
// dev where the collector is on the loopback.

const BAD_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

function bypassEnabled(): boolean {
  return process.env.BULWARK_TELEMETRY_ALLOW_PRIVATE === '1';
}

export type EndpointCheck = { ok: true } | { ok: false; reason: string };

// Sync URL/host shape check. Catches the obvious cases without DNS.
export function validateEndpointUrl(raw: string): EndpointCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'must be http(s)://' };
  }
  if (bypassEnabled()) return { ok: true };

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: 'host required' };
  if (BAD_HOSTS.has(host)) {
    return { ok: false, reason: 'localhost endpoints are not allowed' };
  }
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    return { ok: false, reason: 'private TLDs are not allowed' };
  }
  if (isIP(host) && isPrivateAddress(host)) {
    return { ok: false, reason: 'private/loopback IP is not allowed' };
  }
  return { ok: true };
}

// Async check that additionally resolves DNS hostnames. Use this on
// set-endpoint AND immediately before fetch to defeat DNS-rebinding tricks
// where a hostname resolves to a public IP at validation time and a private
// one at fetch time.
export async function resolveEndpointAllowed(raw: string): Promise<EndpointCheck> {
  const initial = validateEndpointUrl(raw);
  if (!initial.ok) return initial;
  if (bypassEnabled()) return { ok: true };

  const host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(host)) return { ok: true };

  try {
    const addrs = await lookup(host, { all: true });
    for (const a of addrs) {
      if (isPrivateAddress(a.address)) {
        return { ok: false, reason: `host ${host} resolves to private address ${a.address}` };
      }
    }
    return { ok: true };
  } catch {
    // Don't block on transient DNS failures - fetch will fail loudly anyway,
    // and we don't want to lock admins out of their config when the resolver
    // is flaky. The literal-IP check above already covers the direct-attack
    // case, and fetchTelemetryTarget re-checks at connect time, failing
    // closed.
    return { ok: true };
  }
}

export interface TelemetryFetchInit {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * Fetch a telemetry target (the collector, the JMAP server's version
 * probe). resolveEndpointAllowed runs its own DNS lookup, so on its own it
 * is check-then-fetch: the socket resolves again and a rebinding answer, or
 * a lookup that failed at check time, lands wherever it points. Unless the
 * dev bypass is on, the address is checked inside the socket's own lookup
 * instead, and a lookup failure fails the request. Redirects are never
 * followed.
 */
export async function fetchTelemetryTarget(url: string, init: TelemetryFetchInit): Promise<Response> {
  if (bypassEnabled()) {
    return fetch(url, { ...init, redirect: 'manual' });
  }
  return (await fetchPublicUrl(url, init)) as unknown as Response;
}
