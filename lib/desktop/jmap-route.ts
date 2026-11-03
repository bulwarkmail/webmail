/**
 * Where the page reaches a plain http mail server in the desktop app.
 *
 * The app's page is https, so Chromium blocks a fetch to a plain http address as
 * mixed content, whatever the CSP says. The embedded server forwards
 * `/__jmap/<id>/...` to servers the user approved (src/server/jmap-proxy.ts in
 * the desktop repo), where the id is the base64url of the server's origin. The
 * real URL stays in the account registry and the cookies, since the server
 * routes reach the mail server directly: only the page's own requests move.
 */

import { IS_DESKTOP_BUILD } from './flag';

export function desktopJmapOriginId(origin: string): string {
  const bytes = new TextEncoder().encode(origin);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The base URL the page uses to talk to `serverUrl`: the same URL unless this
 * is the desktop build and the server speaks plain http.
 */
export function desktopJmapBase(serverUrl: string): string {
  if (!IS_DESKTOP_BUILD || typeof window === 'undefined') return serverUrl;
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== 'http:') return serverUrl;
    const path = url.pathname.replace(/\/+$/, '');
    return `${window.location.origin}/__jmap/${desktopJmapOriginId(url.origin)}${path}`;
  } catch {
    return serverUrl;
  }
}

/** True for a server the page reaches through the embedded server. */
export function isDesktopProxiedServer(serverUrl: string): boolean {
  return desktopJmapBase(serverUrl) !== serverUrl;
}

/**
 * The route answers everything but JSON as octet-stream, so that nothing can render
 * on the app's origin. A blob for the page gets back the type it asked for.
 */
export function withDesktopBlobType(blob: Blob, serverUrl: string, type: string | undefined): Blob {
  return type && isDesktopProxiedServer(serverUrl) ? new Blob([blob], { type }) : blob;
}

/** The origin part of {@link desktopJmapBase}, onto which session URLs are moved. */
export function desktopJmapOrigin(serverUrl: string): string {
  const { origin, protocol } = new URL(serverUrl);
  if (!IS_DESKTOP_BUILD || typeof window === 'undefined' || protocol !== 'http:') return origin;
  return `${window.location.origin}/__jmap/${desktopJmapOriginId(origin)}`;
}
