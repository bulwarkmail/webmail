import { splitRecipients as splitRecipientString } from "@/lib/email-composer-utils";

export interface ParsedMailto {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
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

function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname || "");
  } catch {
    return null;
  }
}

function decodeQueryPart(value: string): string | null {
  try {
    // RFC 6068 uses percent-encoding for mailto query fields; unlike form
    // encoding, a literal '+' is part of the value and must not become space.
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseQuery(query: string): QueryParam[] | null {
  if (!query) return [];

  const params: QueryParam[] = [];
  for (const part of query.split("&")) {
    if (!part) continue;
    const separatorIndex = part.indexOf("=");
    const rawKey = separatorIndex >= 0 ? part.slice(0, separatorIndex) : part;
    const rawValue = separatorIndex >= 0 ? part.slice(separatorIndex + 1) : "";
    const key = decodeQueryPart(rawKey);
    const value = decodeQueryPart(rawValue);
    if (key === null || value === null) return null;
    params.push({ key, value });
  }

  return params;
}

export function parseMailto(raw: string): ParsedMailto | null {
  if (!raw.toLowerCase().startsWith("mailto:")) return null;

  const addressAndQuery = raw.slice("mailto:".length);
  const queryIndex = addressAndQuery.indexOf("?");
  const rawPathname = queryIndex >= 0 ? addressAndQuery.slice(0, queryIndex) : addressAndQuery;
  const rawQuery = queryIndex >= 0 ? addressAndQuery.slice(queryIndex + 1) : "";

  const decodedPathname = decodePathname(rawPathname);
  if (decodedPathname === null) return null;
  const searchParams = parseQuery(rawQuery);
  if (searchParams === null) return null;

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
    subject: stripControlChars(getQueryValue(searchParams, "subject")).slice(0, MAX_SUBJECT_LENGTH),
    body: stripBodyControlChars(getQueryValue(searchParams, "body")).slice(0, MAX_BODY_LENGTH),
  };
}
