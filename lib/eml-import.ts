import { MAX_FUTURE_SENT_AT_MS } from "./email-date";

/** Only the header block is needed; don't decode a whole large message. */
const HEADER_SCAN_BYTES = 64 * 1024;

/**
 * Read the `Date` header of a raw RFC 5322 message and return it as a JMAP
 * UTCDate (no fractional seconds). Returns undefined when the header is
 * missing, unparsable, or more than a day in the future.
 */
export async function readMessageDate(blob: Blob, now: number = Date.now()): Promise<string | undefined> {
  const head = await blob.slice(0, HEADER_SCAN_BYTES).text();
  return dateFromHeaderBlock(head, now);
}

/** `readMessageDate` for header text already read (anything after the header block is ignored). */
export function dateFromHeaderBlock(head: string, now: number = Date.now()): string | undefined {
  const end = head.search(/\r?\n\r?\n/);
  const headers = (end === -1 ? head : head.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const match = /^Date:[ \t]*(.+)$/im.exec(headers);
  if (!match) return undefined;
  // Drop RFC 5322 comments such as "(CEST)" before parsing.
  const value = match[1].replace(/\([^)]*\)/g, " ").trim();
  const time = Date.parse(value);
  if (Number.isNaN(time) || time - now > MAX_FUTURE_SENT_AT_MS) return undefined;
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
}
