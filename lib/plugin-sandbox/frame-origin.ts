/**
 * An origin of their own for privileged plugin frames (PLUGIN_FRAME_SUBDOMAIN).
 *
 * A privileged frame is `allow-same-origin`, so it runs with the origin of the
 * document it loads. Loaded from the webmail's own origin, the frame and the
 * webmail can reach into each other: a script on the webmail's origin (an XSS,
 * another privileged plugin) reads what the plugin keeps in memory and in
 * IndexedDB, such as the private keys of an encryption plugin.
 *
 * With the setting on, privileged frames load from a subdomain of the host
 * the webmail is served on: `<label>.<webmail host>`. The same server answers
 * there, with the sandbox document and its assets only (proxy.ts). The frame
 * keeps a real origin (WebCrypto, IndexedDB), and the browser keeps the
 * webmail's scripts out of it.
 *
 * The setting is one DNS label, not an origin, on purpose. The server then
 * finds the webmail a plugin host belongs to from the host name alone
 * (`plugins.mail.example.org` -> `mail.example.org`), with no second setting
 * to keep in step, and on every host name the webmail is served on. A host
 * name the operator does not own gives an origin of its own: it can never
 * stand for the real plugin origin, whose storage it does not share.
 */

/** One DNS label: letters, digits and hyphens, not at either end. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The setting as a valid label in lower case, or '' (off) for anything else. */
export function parsePluginFrameLabel(value: unknown): string {
  if (typeof value !== 'string') return '';
  const label = value.trim().toLowerCase();
  return LABEL.test(label) ? label : '';
}

/** An IPv4 or bracketed IPv6 host: it has no subdomains. */
function isIpHost(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[');
}

/**
 * The origin privileged frames load from, for a webmail served at
 * `webmailOrigin`. Null while the setting is off, and for a webmail reached
 * by IP address, where no subdomain exists.
 */
export function pluginFrameOriginFor(webmailOrigin: string, label: string): string | null {
  if (!label) return null;
  let url: URL;
  try {
    url = new URL(webmailOrigin);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || isIpHost(url.hostname)) return null;
  return `${url.protocol}//${label}.${url.host}`;
}

/**
 * The reverse, on the server: the origin of the webmail that a request to
 * `requestOrigin` serves plugin frames for. Null when the request is not to
 * a plugin host.
 */
export function webmailOriginOfPluginHost(requestOrigin: string, label: string): string | null {
  if (!label) return null;
  let url: URL;
  try {
    url = new URL(requestOrigin);
  } catch {
    return null;
  }
  const prefix = `${label}.`;
  if (!url.host.toLowerCase().startsWith(prefix)) return null;
  const host = url.host.slice(prefix.length);
  // "plugins.com" is not a plugin host of "com".
  const hasDomain = host.includes('.') || /^localhost(?::\d+)?$/i.test(host);
  if (!host || !hasDomain) return null;
  return `${url.protocol}//${host}`;
}

// ─── Browser side ────────────────────────────────────────────

/**
 * The label as the browser knows it from /api/config. Until the config has
 * been read it is unknown: the loader reads the config before it starts a
 * privileged plugin (loader.ts), and the server refuses the privileged
 * document on the webmail's own origin while the setting is on (proxy.ts), so
 * a frame created too early loads nothing. Lite has no server to answer on a
 * second host name and never sets a label.
 */
let label: string | null = null;

/** Called once the runtime config is known; null goes back to the start state. */
export function setPluginFrameLabel(value: string | null): void {
  label = value === null ? null : parsePluginFrameLabel(value);
}

export type PrivilegedFramePlace =
  /** The setting is off (or not read yet): the webmail's own origin, as before. */
  | { kind: 'webmail' }
  | { kind: 'separate'; origin: string }
  /** The setting is on, but this page was opened by IP address: no subdomain exists. */
  | { kind: 'none' };

/** Where a privileged frame of this page loads from. */
export function privilegedFramePlace(): PrivilegedFramePlace {
  if (!label || typeof window === 'undefined') return { kind: 'webmail' };
  const origin = pluginFrameOriginFor(window.location.origin, label);
  return origin ? { kind: 'separate', origin } : { kind: 'none' };
}
