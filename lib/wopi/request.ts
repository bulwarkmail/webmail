import type { NextRequest } from 'next/server';
import { isPastMaxAge, maxSessionHoursFor } from '@/lib/auth/session-age';
import { isTrustedJmapServerUrl } from '@/lib/stalwart/server-fetch';
import type { WopiJmapContext } from '@/lib/wopi/files';
import { verifyWopiToken, type WopiTokenPayload } from '@/lib/wopi/token';
import { isWopiTokenRevoked } from '@/lib/wopi/revocation';

/**
 * Whether the session that opened the editor is past the organisation's
 * maximum length now. Every token minted here names its session's sign-in
 * time and carries the `timed` mark; a marked token without the time counts
 * as ended. A token with neither was minted by a version that recorded no
 * sign-in time, so an editor opened before the upgrade keeps saving: it can't
 * be checked against the maximum or revoked with its sign-in, but it ends
 * with its own expiry (six hours after it was minted at most), and signing
 * out in its browser still revokes it (lib/wopi/revocation.ts).
 */
async function sessionPastMaxAge(payload: WopiTokenPayload): Promise<boolean> {
  if (payload.signedInAt === undefined) return payload.timed === true;
  // An impersonation login is `target%master`; the policy is the target's.
  return isPastMaxAge(payload.signedInAt, await maxSessionHoursFor(payload.username.split('%', 1)[0]));
}

/**
 * Authenticate an incoming WOPI request (called by the editor
 * server-to-server, no session cookie) from its `access_token` query
 * parameter, scoped to the document id in the URL (see wopiDocumentId).
 */
export async function wopiContext(
  request: NextRequest,
  documentId: string,
): Promise<{ payload: WopiTokenPayload; ctx: WopiJmapContext } | null> {
  const payload = verifyWopiToken(request.nextUrl.searchParams.get('access_token'), documentId);
  if (!payload) return null;
  // Signed out since the editor was opened.
  if (await isWopiTokenRevoked(payload)) return null;
  // The session that opened it has outlived the maximum session length.
  if (await sessionPastMaxAge(payload)) return null;
  // Trust is re-derived from the current config, not persisted in the token
  // (mirrors lib/stalwart/server-fetch.ts): removing a server from the config
  // immediately drops its tokens to the rebinding-safe fetch path. A server on
  // the webmail's own origin (the dev mock) is this process itself - the
  // public-URL guard would refuse localhost, so it counts as trusted.
  const sameOrigin = (() => {
    try {
      return new URL(payload.serverUrl).origin === payload.origin;
    } catch {
      return false;
    }
  })();
  const trusted = sameOrigin || await isTrustedJmapServerUrl(payload.serverUrl);
  return {
    payload,
    ctx: { serverUrl: payload.serverUrl, authHeader: payload.authHeader, trusted },
  };
}
