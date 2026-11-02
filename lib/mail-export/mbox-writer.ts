/**
 * Writes messages as mboxrd: an envelope line, the message with every
 * `^>*From ` line quoted with one more `>`, and an empty line. The message's
 * own line endings are kept; the lines added use the same ones.
 *
 * State goes into `Status:` (R read, O old), `X-Status:` (A answered,
 * F flagged, T draft) and `X-Keywords:` (other keywords), the headers the
 * import reads back. Those headers, and Thunderbird's X-Mozilla-* ones, are
 * dropped from the message first so an old value can't contradict the new.
 */

const LF = 0x0a;
const CR = 0x0d;
const GT = 0x3e;
const FROM = [0x46, 0x72, 0x6f, 0x6d, 0x20];

const STATE_HEADERS = /^(status|x-status|x-keywords|x-mozilla-status|x-mozilla-status2|x-mozilla-keys)$/i;
/** Keywords the server works out itself, or that have their own header. */
const NOT_IN_X_KEYWORDS = new Set(["$seen", "$flagged", "$answered", "$draft", "$recent", "$hasattachment", "$hasnoattachment"]);

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The sender Bulwark writes on its envelope lines. The import trusts the
 * date of a line with this sender (it is receivedAt), unlike the date on
 * other programs' lines, which may be when the message was copied.
 */
export const EXPORT_ENVELOPE_SENDER = "bulwark-export";

/** `From bulwark-export Tue May  5 10:11:12 2020` for a JMAP UTCDate (UTC asctime). */
export function envelopeLine(receivedAt: string | undefined, eol: string): string {
  const parsed = receivedAt ? new Date(receivedAt) : new Date(0);
  const d = Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, " ");
  return `From ${EXPORT_ENVELOPE_SENDER} ${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}${eol}`;
}

export function stateHeaders(keywords: Record<string, boolean> | undefined, eol: string): string {
  const k = keywords ?? {};
  const xStatus = `${k.$answered ? "A" : ""}${k.$flagged ? "F" : ""}${k.$draft ? "T" : ""}`;
  const others = Object.keys(k).filter((key) => k[key] && !NOT_IN_X_KEYWORDS.has(key.toLowerCase()));
  let out = `Status: ${k.$seen ? "RO" : "O"}${eol}`;
  if (xStatus) out += `X-Status: ${xStatus}${eol}`;
  if (others.length > 0) out += `X-Keywords: ${others.join(" ")}${eol}`;
  return out;
}

function startsWithFrom(data: Uint8Array, at: number, end: number): boolean {
  if (end - at < FROM.length) return false;
  for (let i = 0; i < FROM.length; i++) if (data[at + i] !== FROM[i]) return false;
  return true;
}

const encoder = new TextEncoder();
// Header names are ASCII; decoding (not spreading the bytes into fromCharCode) copes with a 100 KB line.
const latin1 = new TextDecoder("latin1");
const GT_BYTE = new Uint8Array([GT]);

/**
 * The bytes for one message, as a list of parts (mostly subarrays of `raw`).
 * `raw` is the message as the server stores it.
 */
export function mboxEntry(raw: Uint8Array, keywords: Record<string, boolean> | undefined, receivedAt: string | undefined): Uint8Array[] {
  // The first line ending decides which ones added lines use.
  const firstLf = raw.indexOf(LF);
  const eol = firstLf > 0 && raw[firstLf - 1] === CR ? "\r\n" : "\n";
  const parts: Uint8Array[] = [encoder.encode(envelopeLine(receivedAt, eol) + stateHeaders(keywords, eol))];

  let inHeaders = true;
  let runStart = 0;
  let lineStart = 0;
  let skipping = false;
  const flush = (end: number) => {
    if (end > runStart) parts.push(raw.subarray(runStart, end));
  };
  while (lineStart < raw.length) {
    let lineEnd = raw.indexOf(LF, lineStart);
    lineEnd = lineEnd === -1 ? raw.length : lineEnd + 1;
    if (inHeaders) {
      const isEmpty = lineEnd - lineStart === 1 || (lineEnd - lineStart === 2 && raw[lineStart] === CR);
      if (isEmpty) {
        inHeaders = false;
        skipping = false;
      } else if (raw[lineStart] === 0x20 || raw[lineStart] === 0x09) {
        // A folded line continues the field before it.
        if (skipping) { flush(lineStart); runStart = lineEnd; }
      } else {
        const colon = raw.indexOf(0x3a, lineStart);
        const name = colon > lineStart && colon < lineEnd
          ? latin1.decode(raw.subarray(lineStart, colon)).trim()
          : "";
        skipping = STATE_HEADERS.test(name);
        if (skipping) { flush(lineStart); runStart = lineEnd; }
      }
    }
    let at = lineStart;
    while (at < lineEnd && raw[at] === GT) at++;
    if (startsWithFrom(raw, at, lineEnd)) {
      flush(lineStart);
      parts.push(GT_BYTE);
      runStart = lineStart;
    }
    lineStart = lineEnd;
  }
  flush(raw.length);
  // The empty line that separates messages. A message without a final line
  // ending gets one first, so its last line isn't joined to the next envelope
  // line; the import then sees one line ending more than the server stored.
  const endsWithLf = raw.length > 0 && raw[raw.length - 1] === LF;
  parts.push(encoder.encode(endsWithLf ? eol : eol + eol));
  return parts;
}
