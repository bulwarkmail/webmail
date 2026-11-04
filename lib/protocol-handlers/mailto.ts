import { splitRecipients as splitRecipientString } from "@/lib/email-composer-utils";

export interface ParsedMailto {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /**
   * Only from a plugin's api.compose.open, never from a mailto: URL: an HTML
   * body (sanitised by the host) the composer opens in HTML mode instead of
   * `body`.
   */
  htmlBody?: string;
  /** Only from api.compose.open: files the plugin uploaded, attached as they are. */
  attachments?: Array<{ blobId: string; name: string; type: string; size: number }>;
  /**
   * Started in the app itself (Contacts' "Send email"), not by the OS: it is
   * written from the account in use, without asking which one.
   */
  inApp?: boolean;
  /**
   * Handed over by the OS in the desktop app: a link clicked in another program. It
   * opens in a compose window of its own, and the main window stays where it was.
   */
  fromOs?: boolean;
}

const MAX_RECIPIENTS = 200;
const MAX_SUBJECT_LENGTH = 998;
const MAX_BODY_LENGTH = 64 * 1024;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_EXCEPT_LINE_BREAKS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS, "");
}

function stripBodyControlChars(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS_EXCEPT_LINE_BREAKS, "");
}

/** A subject from outside the app: no control characters, no longer than a mail header allows. */
export function cleanMailtoSubject(value: string): string {
  return stripControlChars(value).slice(0, MAX_SUBJECT_LENGTH);
}

/** A body from outside the app: line breaks kept, other control characters gone, limited in length. */
export function cleanMailtoBody(value: string): string {
  return stripBodyControlChars(value).slice(0, MAX_BODY_LENGTH);
}

function splitRecipients(value: string): string[] {
  // Quote/angle-aware split so a `"Doe, John" <john@doo.org>` display name with
  // an embedded comma stays a single recipient instead of being torn in two.
  return splitRecipientString(stripControlChars(value));
}

type QueryParam = {
  key: string;
  value: string;
};

function getQueryValue(searchParams: QueryParam[], key: string): string {
  const values: string[] = [];
  const lowerKey = key.toLowerCase();

  for (const { key: paramKey, value } of searchParams) {
    if (paramKey.toLowerCase() === lowerKey) {
      values.push(value);
    }
  }

  return values.join(",");
}

/**
 * Percent-decoding that never gives up on a link. Links written by hand or by older
 * programs carry a stray "%" ("50% off") or a cut-off UTF-8 sequence; Outlook and
 * Thunderbird open those, so each run of valid escapes is decoded and anything else
 * stays as it is. Bytes that aren't UTF-8 become U+FFFD. RFC 6068 uses
 * percent-encoding, not form encoding: a literal '+' stays a '+'.
 */
function decodeLenient(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        const bytes = Uint8Array.from(run.slice(1).split("%"), (hex) => parseInt(hex, 16));
        return new TextDecoder().decode(bytes);
      }
    });
  }
}

function parseQuery(query: string): QueryParam[] {
  if (!query) return [];

  const params: QueryParam[] = [];
  for (const part of query.split("&")) {
    if (!part) continue;
    const separatorIndex = part.indexOf("=");
    const rawKey = separatorIndex >= 0 ? part.slice(0, separatorIndex) : part;
    const rawValue = separatorIndex >= 0 ? part.slice(separatorIndex + 1) : "";
    params.push({ key: decodeLenient(rawKey), value: decodeLenient(rawValue) });
  }

  return params;
}

export function parseMailto(raw: string): ParsedMailto | null {
  if (!raw.toLowerCase().startsWith("mailto:")) return null;

  const addressAndQuery = raw.slice("mailto:".length);
  const queryIndex = addressAndQuery.indexOf("?");
  const rawPathname = queryIndex >= 0 ? addressAndQuery.slice(0, queryIndex) : addressAndQuery;
  const rawQuery = queryIndex >= 0 ? addressAndQuery.slice(queryIndex + 1) : "";

  const decodedPathname = decodeLenient(rawPathname);
  const searchParams = parseQuery(rawQuery);

  const to = [
    ...splitRecipients(decodedPathname),
    ...splitRecipients(getQueryValue(searchParams, "to")),
  ].slice(0, MAX_RECIPIENTS);
  const remainingAfterTo = Math.max(0, MAX_RECIPIENTS - to.length);
  const cc = splitRecipients(getQueryValue(searchParams, "cc")).slice(0, remainingAfterTo);
  const remainingAfterCc = Math.max(0, MAX_RECIPIENTS - to.length - cc.length);
  const bcc = splitRecipients(getQueryValue(searchParams, "bcc")).slice(0, remainingAfterCc);

  return {
    to,
    cc,
    bcc,
    subject: cleanMailtoSubject(getQueryValue(searchParams, "subject")),
    body: cleanMailtoBody(getQueryValue(searchParams, "body")),
  };
}

/**
 * A mailto: URL for parsed fields, for hooks that report the link when the
 * original URL is gone (a request that came through the OS handler).
 */
export function formatMailto(fields: Pick<ParsedMailto, "to"> & Partial<Omit<ParsedMailto, "to">>): string {
  const params: string[] = [];
  const add = (key: string, value: string | undefined) => {
    if (value) params.push(`${key}=${encodeURIComponent(value)}`);
  };
  add("cc", fields.cc?.join(","));
  add("bcc", fields.bcc?.join(","));
  add("subject", fields.subject);
  add("body", fields.body);
  const to = fields.to.map(encodeURIComponent).join(",");
  return `mailto:${to}${params.length ? `?${params.join("&")}` : ""}`;
}

/** Window event carrying a parsed in-app mailto request to the mail page. */
export const INTERNAL_MAILTO_EVENT = "bulwark:mailto";

/**
 * Ask the mail page to open its composer for an in-app `mailto:` click.
 * Loosely coupled through a window event (as `bulwark:rate-limit-blocked`
 * already is) because the composer state lives in the page component, several
 * levels above the address links in cards and sidebars.
 *
 * Returns whether the request was taken: false when the URL is unusable or no
 * listener is mounted, so callers can fall back to the browser's behaviour
 * rather than swallowing the click.
 */
export function requestInternalMailto(raw: string): boolean {
  if (typeof window === "undefined") return false;
  const parsed = parseMailto(raw);
  if (!parsed || parsed.to.length === 0) return false;
  return requestInternalCompose(parsed, raw);
}

/**
 * Ask the mail page to open its composer with this draft, the way an in-app
 * mailto: click does. Returns false when no mail page is mounted to take it.
 */
export function requestInternalCompose(draft: ParsedMailto, href?: string): boolean {
  if (typeof window === "undefined") return false;
  // The listener signals "handled" by cancelling the event, which makes
  // dispatchEvent report false - so an uncancelled dispatch means nobody took it.
  const uncancelled = window.dispatchEvent(
    new CustomEvent<ParsedMailto & { href: string }>(INTERNAL_MAILTO_EVENT, {
      detail: { ...draft, href: href ?? formatMailto(draft) },
      cancelable: true,
    }),
  );
  return !uncancelled;
}
