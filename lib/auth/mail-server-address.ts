/**
 * What the sign-in form makes of what people type: the domain of an email
 * address, the big mail providers that don't speak JMAP, and a server address
 * typed without a scheme. No network here: the browser and the server both use it.
 */

import { toAsciiDomain } from '@/lib/idn';

/** A host name as it can appear after the @: letters, digits, hyphens, at least one dot. */
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** The domain of a complete email address, lower case, or "" while it isn't one yet. */
export function emailDomain(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return '';
  const domain = toAsciiDomain(trimmed.slice(at + 1).replace(/\.$/, '')) ?? '';
  return DOMAIN.test(domain) ? domain : '';
}

/** Providers people try first. None of them offers JMAP. */
const UNSUPPORTED: Record<string, string> = {
  'gmail.com': 'Gmail',
  'googlemail.com': 'Gmail',
  'outlook.com': 'Outlook.com',
  'hotmail.com': 'Outlook.com',
  'live.com': 'Outlook.com',
  'msn.com': 'Outlook.com',
  'icloud.com': 'iCloud Mail',
  'me.com': 'iCloud Mail',
  'mac.com': 'iCloud Mail',
};

/** The provider's name when this domain belongs to one that Bulwark can't reach, else null. */
export function unsupportedProvider(domain: string): string | null {
  const d = domain.toLowerCase();
  if (UNSUPPORTED[d]) return UNSUPPORTED[d];
  // Country variants: hotmail.de, outlook.fr, live.co.uk, googlemail.co.uk.
  const label = d.split('.')[0];
  if (label === 'hotmail' || label === 'outlook' || label === 'live') return 'Outlook.com';
  if (label === 'googlemail') return 'Gmail';
  return null;
}

/**
 * A server address as people type it, as a URL: "mail.example.org",
 * "mail.example.org:8443" and "https://mail.example.org/" all work. http:// stays
 * http:// when typed (the desktop app asks before it uses one). Null when it
 * isn't a server address at all.
 */
export function normalizeServerInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname || url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** The host to show for a server URL: no scheme, no default port. */
export function serverHostLabel(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol === 'http:' ? 'http://' : ''}${url.host}${path}`;
  } catch {
    return serverUrl;
  }
}
