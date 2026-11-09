/**
 * Message state from the headers mail programs write into mbox files.
 *
 * - `Status:` R = read (O = not recent, ignored).
 * - `X-Status:` A = answered, F = flagged, T = draft.
 * - `X-Mozilla-Status:` Thunderbird's flags in four hex digits: 0x1 read,
 *   0x2 replied, 0x4 flagged, 0x8 expunged (deleted, the folder wasn't
 *   compacted yet: such a message is skipped, or the import brings back
 *   deleted mail), 0x1000 forwarded.
 * - `X-Keywords:` and `X-Mozilla-Keys:` keywords, separated by spaces or commas.
 * - `X-Gmail-Labels:` (Google Takeout) "Unread" and "Starred".
 *
 * A message with none of these is imported as read, as Bulwark always did.
 */

export interface MboxState {
  keywords: Record<string, true>;
  /** Thunderbird marked it deleted (expunged): don't import it. */
  expunged: boolean;
}

/** Unfolded header fields by lowercased name (first occurrence wins). */
export function headerFields(headerBlock: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!fields.has(name)) fields.set(name, line.slice(colon + 1).trim());
  }
  return fields;
}

/** RFC 8621 keyword characters: printable ASCII except ( ) { ] % * " \ and space. */
const KEYWORD = /^[\x21-\x7e]{1,255}$/;
const BAD_KEYWORD_CHARS = /[(){\]%*"\\]/;
/** Keywords the server sets itself or that mean something else in an mbox header. */
const IGNORED_KEYWORDS = new Set(["$recent", "\\recent", "$hasattachment", "$hasnoattachment"]);

function addKeywords(into: Record<string, true>, value: string | undefined): void {
  if (!value) return;
  for (const raw of value.split(/[\s,]+/)) {
    let keyword = raw.trim();
    if (!keyword) continue;
    // IMAP system flags written as keywords.
    const system: Record<string, string> = { "\\seen": "$seen", "\\flagged": "$flagged", "\\answered": "$answered", "\\draft": "$draft" };
    keyword = system[keyword.toLowerCase()] ?? keyword;
    if (!KEYWORD.test(keyword) || BAD_KEYWORD_CHARS.test(keyword)) continue;
    if (IGNORED_KEYWORDS.has(keyword.toLowerCase())) continue;
    into[keyword.toLowerCase()] = true;
  }
}

export function mboxState(headerBlock: string): MboxState {
  const fields = headerFields(headerBlock);
  const status = fields.get("status");
  const xStatus = fields.get("x-status");
  const mozilla = fields.get("x-mozilla-status");
  const gmail = fields.get("x-gmail-labels");
  const keywords: Record<string, true> = {};
  let expunged = false;

  const known = status !== undefined || xStatus !== undefined || mozilla !== undefined || gmail !== undefined;
  if (!known) keywords.$seen = true;

  if (status && /R/i.test(status)) keywords.$seen = true;
  if (xStatus) {
    if (/A/i.test(xStatus)) keywords.$answered = true;
    if (/F/i.test(xStatus)) keywords.$flagged = true;
    if (/T/i.test(xStatus)) keywords.$draft = true;
  }
  if (mozilla && /^[0-9a-f]{1,8}$/i.test(mozilla)) {
    const flags = parseInt(mozilla, 16);
    if (flags & 0x1) keywords.$seen = true;
    if (flags & 0x2) keywords.$answered = true;
    if (flags & 0x4) keywords.$flagged = true;
    if (flags & 0x8) expunged = true;
    if (flags & 0x1000) keywords.$forwarded = true;
  }
  if (gmail !== undefined) {
    const labels = gmail.split(",").map((l) => l.trim().toLowerCase());
    if (!labels.includes("unread")) keywords.$seen = true;
    if (labels.includes("starred")) keywords.$flagged = true;
  }
  addKeywords(keywords, fields.get("x-keywords"));
  addKeywords(keywords, fields.get("x-mozilla-keys"));
  return { keywords, expunged };
}

const STATE_HEADER = /^(status|x-status|x-keywords|x-mozilla-status|x-mozilla-status2|x-mozilla-keys)$/i;
/** How far into a message the header block is looked for. */
const HEADER_LIMIT = 256 * 1024;

/**
 * The message without the mbox state headers read above: their state is now
 * in JMAP keywords, and a stale copy in the stored message would only
 * contradict it (and differ from what was exported). Everything else,
 * the body included, stays byte for byte.
 */
export function withoutStateHeaders(parts: Uint8Array[]): Uint8Array[] {
  // Find the end of the header block (the empty line) within the first parts.
  let end = -1;
  let offset = 0;
  let lineHasText = false;
  outer: for (const p of parts) {
    for (let i = 0; i < p.length; i++) {
      const b = p[i];
      if (b === 0x0a) {
        if (!lineHasText) { end = offset + i + 1; break outer; }
        lineHasText = false;
      } else if (b !== 0x0d) {
        lineHasText = true;
      }
    }
    offset += p.length;
    if (offset > HEADER_LIMIT) break;
  }
  const headerEnd = end === -1 ? Math.min(offset, parts.reduce((n, p) => n + p.length, 0)) : end;
  // The header bytes, copied, and the rest as it is.
  const head = new Uint8Array(headerEnd);
  const rest: Uint8Array[] = [];
  let at = 0;
  for (const p of parts) {
    if (at >= headerEnd) { rest.push(p); continue; }
    const take = Math.min(p.length, headerEnd - at);
    head.set(p.subarray(0, take), at);
    if (take < p.length) rest.push(p.subarray(take));
    at += take;
  }
  const kept: Uint8Array[] = [];
  let skipping = false;
  let found = false;
  let start = 0;
  for (let i = 0; i <= head.length; i++) {
    if (i < head.length && head[i] !== 0x0a) continue;
    const line = head.subarray(start, Math.min(head.length, i + 1));
    start = i + 1;
    if (line.length === 0) continue;
    const folded = line[0] === 0x20 || line[0] === 0x09;
    if (!folded) {
      const colon = line.indexOf(0x3a);
      const name = colon > 0 ? new TextDecoder("latin1").decode(line.subarray(0, colon)).trim() : "";
      skipping = STATE_HEADER.test(name);
      if (skipping) found = true;
    }
    if (!skipping) kept.push(line);
  }
  return found ? [...kept, ...rest] : parts;
}
