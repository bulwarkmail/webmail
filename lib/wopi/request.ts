import type { NextRequest } from 'next/server';
import { isTrustedJmapServerUrl } from '@/lib/stalwart/server-fetch';
import type { WopiJmapContext } from '@/lib/wopi/files';
import { verifyWopiToken, type WopiTokenPayload } from '@/lib/wopi/token';
import { isWopiTokenRevoked } from '@/lib/wopi/revocation';

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
