/**
 * Which server minted a slot's refresh token, for the desktop build.
 *
 * The token routes know a server only through `jmap_rts`, the id of an entry in
 * `jmapServers`, and otherwise fall back to the configured server. A standalone
 * desktop app has neither: every account is a server the user typed. So refresh,
 * revocation and sign-out would throw "OAuth misconfigured", and the account
 * would first look unreachable and then be signed out.
 *
 * The record is sealed so only this server can have written it. Whether the
 * address may be reached isn't stored: it is checked again on every read, by
 * the same rule as the sign-in routes.
 */

import type { cookies } from 'next/headers';
import { configManager } from '@/lib/admin/config-manager';
import { parseJmapServers, resolveTrustedJmapUrl } from '@/lib/admin/jmap-servers';
import { decryptPayload, encryptPayload } from '@/lib/auth/crypto';
import { getSignInCookieOptions } from '@/lib/oauth/cookie-config';
import { isPublicHttpUrl } from '@/lib/security/url-guard';
import { mailServerRefusedByDevicePolicy } from '@/lib/desktop/server-policy';

type CookieStore = Awaited<ReturnType<typeof cookies>>;

const COOKIE = 'jmap_rtu';

export interface CustomUpstream {
  serverUrl: string;
  clientId: string;
  /** The user approved this server, so it may be on a private address. */
  trusted: boolean;
}

export function customUpstreamCookieName(slot: number): string {
  return slot === 0 ? COOKIE : `${COOKIE}_${slot}`;
}

/** Null when the address isn't one the sign-in routes would accept right now. */
export async function resolveCustomUpstream(serverUrl: unknown, clientId: unknown): Promise<CustomUpstream | null> {
  if (mailServerRefusedByDevicePolicy(serverUrl)) return null;
  return checkedUpstream(serverUrl, clientId);
}

async function checkedUpstream(serverUrl: unknown, clientId: unknown): Promise<CustomUpstream | null> {
  if (typeof serverUrl !== 'string' || !serverUrl || typeof clientId !== 'string' || !clientId) return null;
  await configManager.ensureLoaded();
  const servers = parseJmapServers(configManager.get<unknown>('jmapServers', []));
  const trusted = resolveTrustedJmapUrl(serverUrl, configManager.get<string>('jmapServerUrl', ''), servers) !== null;
  if (!trusted && !(await isPublicHttpUrl(serverUrl))) return null;
  return { serverUrl: serverUrl.replace(/\/+$/, ''), clientId, trusted };
}

export function writeCustomUpstream(
  cookieStore: CookieStore,
  slot: number,
  upstream: Pick<CustomUpstream, 'serverUrl' | 'clientId'>,
  remember: boolean,
): void {
  const value = encryptPayload({ s: upstream.serverUrl, c: upstream.clientId }, 'custom-upstream');
  cookieStore.set(customUpstreamCookieName(slot), value, getSignInCookieOptions(remember));
}

export async function readCustomUpstream(cookieStore: CookieStore, slot: number): Promise<CustomUpstream | null> {
  const value = cookieStore.get(customUpstreamCookieName(slot))?.value;
  if (!value) return null;
  let payload: Record<string, unknown> | null;
  try {
    payload = decryptPayload(value, 'custom-upstream');
  } catch {
    return null;
  }
  // Without the device's policy: a sign-out still has to revoke its token at a server
  // that came off the list. A refresh checks the policy itself.
  return payload ? checkedUpstream(payload.s, payload.c) : null;
}

export function clearCustomUpstream(cookieStore: CookieStore, slot: number): void {
  const name = customUpstreamCookieName(slot);
  if (cookieStore.get(name)) cookieStore.delete(name);
}
