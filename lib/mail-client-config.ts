/**
 * Server settings for other mail apps (Thunderbird, Apple Mail, Outlook,
 * phone apps), read from the mail server's Mozilla autoconfig document.
 *
 * Stalwart 0.16 and 1.0 both serve
 * `/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=<address>`
 * without sign-in and with `Access-Control-Allow-Origin: *`, so the page reads
 * it directly from the server it is signed in to. No other host is asked.
 */

import { desktopJmapBase } from '@/lib/desktop/jmap-route';

export type MailSocketSecurity = 'ssl' | 'starttls' | 'none';

export interface MailServerEndpoint {
  hostname: string;
  port: number;
  security: MailSocketSecurity;
}

export interface MailClientConfig {
  username?: string;
  imap?: MailServerEndpoint;
  smtp?: MailServerEndpoint;
  caldav?: string;
  carddav?: string;
}

function text(el: Element | null | undefined, tag: string): string | undefined {
  const value = el?.getElementsByTagName(tag)[0]?.textContent?.trim();
  return value ? value : undefined;
}

function security(raw: string | undefined): MailSocketSecurity {
  const value = (raw ?? '').toUpperCase();
  if (value === 'SSL' || value === 'TLS') return 'ssl';
  if (value === 'STARTTLS') return 'starttls';
  return 'none';
}

function endpoint(el: Element | undefined): MailServerEndpoint | undefined {
  if (!el) return undefined;
  const hostname = text(el, 'hostname');
  const port = Number(text(el, 'port'));
  if (!hostname || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return { hostname, port, security: security(text(el, 'socketType')) };
}

function davUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fills the Mozilla autoconfig placeholders from the address the document
 * was asked for. Stalwart writes `%EMAILADDRESS%` as the username whatever
 * address it was asked for. A username with a placeholder left over is
 * dropped, so the caller shows its own.
 */
function fillPlaceholders(value: string | undefined, emailAddress: string | undefined): string | undefined {
  if (!value) return undefined;
  const at = emailAddress ? emailAddress.lastIndexOf('@') : -1;
  const filled = emailAddress && at > 0
    ? value.replace(/%EMAILADDRESS%|%EMAILLOCALPART%|%EMAILDOMAIN%/g, (placeholder) =>
      placeholder === '%EMAILADDRESS%' ? emailAddress
        : placeholder === '%EMAILLOCALPART%' ? emailAddress.slice(0, at) : emailAddress.slice(at + 1))
    : value;
  return /%[A-Z]+%/.test(filled) ? undefined : filled;
}

/**
 * The parts of an autoconfig document a person needs to set up another app.
 * Returns null for anything that isn't a clientConfig with at least one server.
 * `emailAddress` is the address the document was asked for; it fills the
 * username placeholders.
 */
export function parseMailClientConfig(xml: string, emailAddress?: string): MailClientConfig | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch {
    return null;
  }
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const root = doc.documentElement;
  if (!root || root.nodeName !== 'clientConfig') return null;

  const incoming = Array.from(root.getElementsByTagName('incomingServer'));
  const outgoing = Array.from(root.getElementsByTagName('outgoingServer'));
  const imapEl = incoming.find((el) => el.getAttribute('type') === 'imap');
  const smtpEl = outgoing.find((el) => el.getAttribute('type') === 'smtp');
  const calendarEl = Array.from(root.getElementsByTagName('calendar')).find((el) => el.getAttribute('type') === 'caldav');
  const contactsEl = Array.from(root.getElementsByTagName('addressBook')).find((el) => el.getAttribute('type') === 'carddav');

  const config: MailClientConfig = {
    username: fillPlaceholders(text(imapEl, 'username') ?? text(smtpEl, 'username'), emailAddress),
    imap: endpoint(imapEl),
    smtp: endpoint(smtpEl),
    caldav: davUrl(text(calendarEl, 'serverURL')),
    carddav: davUrl(text(contactsEl, 'serverURL')),
  };
  if (!config.imap && !config.smtp && !config.caldav && !config.carddav) return null;
  return config;
}

/** The autoconfig address on the server the page is signed in to. */
export function mailClientConfigUrl(serverUrl: string, emailAddress: string): string {
  const base = desktopJmapBase(serverUrl.replace(/\/+$/, ''));
  return `${base}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(emailAddress)}`;
}

/** Reads and parses the server's autoconfig; null when it has none or can't be reached. */
export async function fetchMailClientConfig(
  serverUrl: string,
  emailAddress: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<MailClientConfig | null> {
  if (!serverUrl || !emailAddress.includes('@')) return null;
  try {
    const response = await fetchImpl(mailClientConfigUrl(serverUrl, emailAddress), {
      credentials: 'omit',
      cache: 'no-store',
      signal,
    });
    if (!response.ok) return null;
    return parseMailClientConfig(await response.text(), emailAddress);
  } catch {
    return null;
  }
}
