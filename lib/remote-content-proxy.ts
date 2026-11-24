/**
 * Remote content through this server (#1021).
 *
 * With the admin policy's `remoteContentProxyEnabled` gate on, a message's
 * remote pictures load from /api/remote-content/<token> on the webmail's own
 * origin instead of from the sender's servers, so the sender sees this
 * server, not the reader's address, browser or the moment each reader opens
 * the mail. Whether remote content loads at all is still the user's choice
 * (Settings > Privacy, the "load" button, trusted senders); the gate only
 * changes where it is fetched from.
 *
 * Shared by the sanitizer (lib/email-sanitization.ts), the viewers and the
 * route (app/api/remote-content/[token]/route.ts), so it has no imports.
 */

/** The route's path below the base path, with the trailing slash the token follows. */
export const REMOTE_CONTENT_PATH = '/api/remote-content/';

/** Longest remote address the route takes. Longer ones stay unloaded. */
export const MAX_REMOTE_URL_LENGTH = 4096;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(token: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const binary = atob(token.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * The absolute http(s) address a resource reference in a message stands for,
 * the way a browser reads it: C0 controls and spaces dropped, `\` as `/`,
 * `//host` as https. Null for anything else (data:, cid:, relative paths) or
 * an address too long to carry.
 */
export function normalizeRemoteUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  // eslint-disable-next-line no-control-regex
  let raw = value.replace(/[\u0000-\u0020]+/g, '').replace(/\\/g, '/');
  if (raw.startsWith('//')) raw = `https:${raw}`;
  if (!/^https?:/i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  url.hash = '';
  const href = url.href;
  return href.length <= MAX_REMOTE_URL_LENGTH ? href : null;
}

/** The route token for a remote address: its UTF-8 bytes, URL-safe base64 without padding. */
export function encodeRemoteUrl(url: string): string {
  return toBase64Url(new TextEncoder().encode(url));
}

/** The remote address a token carries, or null when it isn't one the route fetches. */
export function decodeRemoteUrl(token: string): string | null {
  if (!token || token.length > Math.ceil((MAX_REMOTE_URL_LENGTH * 4) / 3) + 4) return null;
  const bytes = fromBase64Url(token);
  if (!bytes) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const url = normalizeRemoteUrl(text);
  // Only the exact form encodeRemoteUrl writes, so one picture has one address.
  return url === text ? url : null;
}

/**
 * The proxied address of a resource reference, or null when it isn't a
 * remote http(s) address. `proxyBase` is {@link remoteContentProxyBase}'s.
 */
export function proxiedResourceUrl(value: string | null | undefined, proxyBase: string): string | null {
  const url = normalizeRemoteUrl(value);
  return url ? `${proxyBase}${encodeRemoteUrl(url)}` : null;
}

/**
 * The absolute prefix proxied addresses start with: origin, base path and
 * the route's folder, e.g. `https://mail.example.com/webmail/api/remote-content/`.
 * Absolute because the message renders in a srcdoc frame and the frame's CSP
 * names exactly this folder. Null when the origin can't be named.
 */
export function remoteContentProxyBase(origin: string, basePath = ''): string | null {
  if (!/^https?:\/\/[^\s/;,'"]+$/.test(origin)) return null;
  const base = basePath.replace(/\/+$/, '');
  if (base && !/^\/[A-Za-z0-9._~\-/]*$/.test(base)) return null;
  return `${origin}${base}${REMOTE_CONTENT_PATH}`;
}
