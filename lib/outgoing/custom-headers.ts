import { debug } from '@/lib/debug';

/**
 * Extra headers plugins add to an outgoing message (OutgoingEmail.headers),
 * such as a classification label, as JMAP Email/set create properties
 * (RFC 8621 §4.1.3, `header:Name:asText`, which the server encodes and folds).
 *
 * Only headers of their own get through. Names the client writes from other
 * properties are dropped, because JMAP refuses a create that sets the same
 * header twice, and so are names that say who sent the mail or how it
 * travelled: a plugin must not change the sender or forge trace and
 * authentication headers.
 */

const RESERVED = new Set([
  'from', 'sender', 'reply-to', 'to', 'cc', 'bcc', 'subject', 'date',
  'message-id', 'in-reply-to', 'references', 'mime-version',
  'return-path', 'received', 'received-spf', 'authentication-results',
  'dkim-signature', 'domainkey-signature',
  'disposition-notification-to', 'importance', 'x-priority', 'priority',
]);
const RESERVED_PREFIXES = ['content-', 'resent-', 'arc-'];

/** RFC 5322 §3.6.8 field-name: printable US-ASCII except the colon. */
const FIELD_NAME = /^[\x21-\x39\x3b-\x7e]{1,76}$/;
/** Line breaks or other control characters but tab (header injection). */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}
const MAX_HEADERS = 20;
// Room for an Autocrypt header with a whole key in it; the server folds it.
const MAX_VALUE_LENGTH = 8192;

function isReserved(lowerName: string): boolean {
  return RESERVED.has(lowerName) || RESERVED_PREFIXES.some((prefix) => lowerName.startsWith(prefix));
}

export function customHeaderProperties(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return out;
  const seen = new Set<string>();
  for (const [name, raw] of Object.entries(headers as Record<string, unknown>)) {
    const lower = name.toLowerCase();
    if (!FIELD_NAME.test(name) || isReserved(lower) || seen.has(lower)) {
      debug.warn(`Outgoing header "${name}" from a plugin was not sent`);
      continue;
    }
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value) continue;
    if (hasControlCharacter(value) || value.length > MAX_VALUE_LENGTH) {
      debug.warn(`Outgoing header "${name}" from a plugin was not sent: invalid value`);
      continue;
    }
    if (seen.size >= MAX_HEADERS) {
      debug.warn(`Outgoing header "${name}" from a plugin was not sent: more than ${MAX_HEADERS} headers`);
      continue;
    }
    seen.add(lower);
    out[`header:${name}:asText`] = value;
  }
  return out;
}

/**
 * The headers a classification label writes (lib/classification/labels.ts).
 * While the organisation uses labels, plugins can't set them: the label
 * stage drops them from the plugins' headers (withoutLabelHeaders), along
 * with the admin's extra header, and withLabelHeaders below lets the
 * label's own win over anything left.
 */
export const LABEL_HEADER_NAMES = ['sio-label', 'sio-label-history', 'sensitivity', 'x-bulwark-label'] as const;

/** `headers` (OutgoingEmail.headers) without the label headers and `extra` names. */
export function withoutLabelHeaders(
  headers: Record<string, string> | undefined,
  extra: readonly string[] = [],
): Record<string, string> | undefined {
  if (!headers) return headers;
  const reserved = new Set<string>([...LABEL_HEADER_NAMES, ...extra.map((name) => name.toLowerCase())]);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (reserved.has(name.toLowerCase())) {
      debug.warn(`Outgoing header "${name}" from a plugin was not sent: the classification label sets it`);
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** The name in a JMAP header property (`header:SIO-Label:asRaw` → `sio-label`). */
function propertyHeaderName(property: string): string {
  return property.split(':')[1]?.toLowerCase() ?? '';
}

/**
 * Plugin header properties with the label's added on top: a plugin header
 * of a name the label writes is dropped, since JMAP refuses a create that
 * sets one header twice and the label must win.
 */
export function withLabelHeaders(
  custom: Record<string, string>,
  label: Record<string, string> | undefined,
): Record<string, string> {
  if (!label || Object.keys(label).length === 0) return custom;
  const taken = new Set(Object.keys(label).map(propertyHeaderName));
  const out: Record<string, string> = {};
  for (const [property, value] of Object.entries(custom)) {
    if (!taken.has(propertyHeaderName(property))) out[property] = value;
  }
  return { ...out, ...label };
}
