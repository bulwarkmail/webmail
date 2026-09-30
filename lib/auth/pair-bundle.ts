import { encryptPayload, decryptPayload } from '@/lib/auth/crypto';
import type { PairingGrant } from '@/lib/auth/pairing-store';

// What a paired phone receives, and how it renews its access token.
//
// The phone refreshes with `client_id` only, against the `token_endpoint` it
// was given, and current app builds accept that endpoint only on the JMAP
// server's or the webmail's host (or a parent/child domain of either). So
// the phone talks to the provider directly only when both hold; otherwise it
// is pointed at the webmail's token proxy (/api/auth/pair/token), which adds
// the client secret server-side. The refresh token it carries then is sealed
// under SESSION_SECRET, so the proxy renews only tokens this webmail handed
// to a phone and knows where each one belongs, and never works as a
// secret-adding relay for arbitrary tokens.

export const PAIR_TOKEN_PROXY_PATH = '/api/auth/pair/token';

export interface SealedRefresh {
  refreshToken: string;
  serverId: string | null;
  clientId: string;
  /** The endpoint that minted the grant (the provider, never the proxy). */
  tokenEndpoint: string;
  /** False for a user-chosen server: renewals must use the rebinding-safe fetch. */
  trusted: boolean;
}

export function sealPhoneRefreshToken(value: SealedRefresh): string {
  return encryptPayload(
    { r: value.refreshToken, s: value.serverId, c: value.clientId, e: value.tokenEndpoint, t: value.trusted },
    'pair-refresh',
  );
}

export function openPhoneRefreshToken(sealed: string): SealedRefresh | null {
  let data: Record<string, unknown> | null;
  try {
    data = decryptPayload(sealed, 'pair-refresh');
  } catch {
    return null;
  }
  if (!data) return null;
  const { r, s, c, e, t } = data;
  if (typeof r !== 'string' || !r || typeof c !== 'string' || !c || typeof e !== 'string' || !e) return null;
  if (s !== null && typeof s !== 'string') return null;
  return { refreshToken: r, serverId: s, clientId: c, tokenEndpoint: e, trusted: t === true };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isLoopbackHttp(url: string): boolean {
  const host = hostOf(url);
  return url.toLowerCase().startsWith('http://') && (host === 'localhost' || host === '127.0.0.1' || host === '10.0.2.2');
}

/**
 * Whether the app will connect to this JMAP server at all: https, or loopback
 * http for development (the app's own rule for a paired `server_url`).
 */
export function appAcceptsServerUrl(serverUrl: string): boolean {
  return serverUrl.toLowerCase().startsWith('https://') || isLoopbackHttp(serverUrl);
}

/**
 * Mirrors the app's `isAcceptableTokenEndpoint` (src/lib/oauth.ts): https (or
 * loopback http for development), on the host family of the JMAP server or
 * the webmail.
 */
export function appAcceptsTokenEndpoint(tokenEndpoint: string, serverUrl: string, webmailBase: string | null): boolean {
  if (!tokenEndpoint.toLowerCase().startsWith('https://') && !isLoopbackHttp(tokenEndpoint)) return false;
  const host = hostOf(tokenEndpoint);
  if (!host) return false;
  const allowed = [hostOf(serverUrl), webmailBase ? hostOf(webmailBase) : ''].filter(Boolean);
  return allowed.some((h) => host === h || host.endsWith(`.${h}`) || h.endsWith(`.${host}`));
}

export type RedeemBundle =
  | {
      flow: 'oauth';
      server_url: string;
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_endpoint: string;
      client_id: string;
    }
  | { flow: 'password'; server_url: string; username: string; password: string };

/**
 * The redeem response for a grant. `webmailBase` is the public base the
 * desktop showed in the QR (origin plus mount path), used for the proxy URL.
 */
export function buildRedeemBundle(
  grant: PairingGrant,
  webmailBase: string | null,
  now = Date.now(),
): RedeemBundle {
  if (grant.flow === 'password') {
    return { flow: 'password', server_url: grant.serverUrl, username: grant.username, password: grant.password };
  }

  const expiresIn = typeof grant.expiresIn === 'number'
    ? Math.max(0, grant.expiresIn - Math.floor((now - grant.issuedAt) / 1000))
    : undefined;

  const direct = !grant.confidential && appAcceptsTokenEndpoint(grant.tokenEndpoint, grant.serverUrl, webmailBase);
  if (direct || !webmailBase) {
    return {
      flow: 'oauth',
      server_url: grant.serverUrl,
      access_token: grant.accessToken,
      ...(grant.refreshToken ? { refresh_token: grant.refreshToken } : {}),
      ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
      token_endpoint: grant.tokenEndpoint,
      client_id: grant.clientId,
    };
  }

  return {
    flow: 'oauth',
    server_url: grant.serverUrl,
    access_token: grant.accessToken,
    ...(grant.refreshToken
      ? {
          refresh_token: sealPhoneRefreshToken({
            refreshToken: grant.refreshToken,
            serverId: grant.serverId,
            clientId: grant.clientId,
            tokenEndpoint: grant.tokenEndpoint,
            trusted: grant.trusted,
          }),
        }
      : {}),
    ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
    token_endpoint: `${webmailBase.replace(/\/+$/, '')}${PAIR_TOKEN_PROXY_PATH}`,
    client_id: grant.clientId,
  };
}
