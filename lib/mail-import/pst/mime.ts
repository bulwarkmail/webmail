/**
 * Builds an RFC 5322 message from what a PST stores about a message. Outlook
 * keeps the parts, not the MIME: received mail has its original header block
 * (PR_TRANSPORT_MESSAGE_HEADERS), sent mail and drafts have none. The header
 * block is kept without its MIME fields and a new multipart is built from the
 * bodies and attachments:
 *
 *   mixed (when there are attachments)
 *     related (when the HTML shows cid: images)
 *       alternative (plain text and HTML) | the one body there is
 *       inline images
 *     attachments
 *
 * An RTF-only body (no plain text or HTML Outlook could give) is attached as
 * message.rtf. Every part is UTF-8 and base64, so the result is 7-bit.
 */

export interface MailAddress {
  name?: string;
  email: string;
}

export interface PstAttachmentData {
  filename: string;
  mimeType: string;
  contentId?: string;
  data: Uint8Array;
}

export interface PstMailData {
  /** The original header block of received mail, if Outlook kept it. */
  headers?: string;
  subject: string;
  from?: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  date?: Date;
  messageId?: string;
  inReplyTo?: string;
  /** 0 low, 1 normal, 2 high. */
  importance?: number;
  text?: string;
  html?: string;
  rtf?: string;
  attachments: PstAttachmentData[];
}

const CRLF = "\r\n";
const encoder = new TextEncoder();

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** base64 in lines of 76 characters. */
export function base64Lines(bytes: Uint8Array): string {
  const all = base64(bytes);
  const lines: string[] = [];
  for (let i = 0; i < all.length; i += 76) lines.push(all.slice(i, i + 76));
  return lines.join(CRLF);
}

const PRINTABLE = /^[\x20-\x7e]*$/;

/** RFC 2047 encoded words for a header text that isn't plain ASCII. */
export function encodeHeaderText(text: string): string {
  const clean = text.replace(/[\r\n]+/g, " ");
  if (PRINTABLE.test(clean)) return clean;
  // Each word holds at most 45 bytes (60 base64 characters), split between characters.
  const words: string[] = [];
  let chunk = "";
  for (const ch of clean) {
    if (encoder.encode(chunk + ch).length > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${base64(encoder.encode(w))}?=`).join(`${CRLF} `);
}

function formatAddress(a: MailAddress): string {
  const name = (a.name ?? "").trim().replace(/^['"]+|['"]+$/g, "");
  if (!name || name.toLowerCase() === a.email.toLowerCase()) return `<${a.email}>`;
  if (PRINTABLE.test(name)) return `"${name.replace(/(["\\])/g, "\\$1")}" <${a.email}>`;
  return `${encodeHeaderText(name)} <${a.email}>`;
}

function addressList(list: MailAddress[]): string {
  return list.map(formatAddress).join(`,${CRLF} `);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RFC 5322 date in UTC. */
export function rfc5322Date(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

/** A filename parameter both old and new mail programs read. */
function fileParams(name: string): string {
  const safe = name.replace(/[\r\n"\\]/g, "_");
  if (PRINTABLE.test(safe)) return `; name="${safe}"`;
  const pct = Array.from(encoder.encode(safe), (b) =>
    /[A-Za-z0-9!#$&+.^_`|~-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
  return `; name="${encodeHeaderText(safe).replace(/\r\n /g, " ")}"; name*=UTF-8''${pct}`;
}

const MIME_FIELDS = /^(content-type|content-transfer-encoding|mime-version|content-disposition|content-length|content-md5)$/i;

/** The header block without its MIME fields, unfolded lines kept, CRLF. */
export function keptHeaders(block: string): { text: string; names: Set<string> } {
  const lines = block.replace(/\r?\n/g, "\n").replace(/\n+$/, "").split("\n");
  const fields: string[][] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && fields.length > 0) fields[fields.length - 1].push(line);
    else if (line.includes(":")) fields.push([line]);
    // A line without a colon outside a field isn't a header; drop it.
  }
  const names = new Set<string>();
  const kept = fields.filter((f) => {
    const name = f[0].slice(0, f[0].indexOf(":")).trim();
    if (MIME_FIELDS.test(name)) return false;
    names.add(name.toLowerCase());
    return true;
  });
  return { text: kept.map((f) => f.join(CRLF)).join(CRLF), names };
}

interface Part {
  headers: string[];
  body: string;
}

function leaf(contentType: string, data: Uint8Array, extra: string[] = []): Part {
  return { headers: [`Content-Type: ${contentType}`, "Content-Transfer-Encoding: base64", ...extra], body: base64Lines(data) };
}

function textPart(text: string, subtype: "plain" | "html"): Part {
  return leaf(`text/${subtype}; charset=utf-8`, encoder.encode(text.replace(/\r?\n/g, CRLF)));
}

/** A message id from the PST as `<id>`, or undefined: no line breaks or spaces can get into the header. */
function msgId(value: string | undefined): string | undefined {
  const id = (value ?? "").replace(/[\r\n]/g, "").trim().replace(/^<|>$/g, "");
  return /^[^<>\s]+$/.test(id) ? `<${id}>` : undefined;
}

/** A Content-ID without anything that could end the header or the angle brackets. */
function cid(value: string): string {
  return value.replace(/[<>\s]/g, "");
}

export interface MimeOptions {
  /** Makes boundaries reproducible (tests). */
  boundarySeed?: string;
}

export function buildMime(mail: PstMailData, options: MimeOptions = {}): Uint8Array {
  const seed = options.boundarySeed ?? Math.random().toString(36).slice(2, 12);
  let n = 0;
  const boundary = () => `=_bulwark_${seed}_${n++}`;
  const multipart = (subtype: string, parts: Part[]): Part => {
    const b = boundary();
    return {
      headers: [`Content-Type: multipart/${subtype};${CRLF} boundary="${b}"`],
      body: parts.map((p) => `--${b}${CRLF}${p.headers.join(CRLF)}${CRLF}${CRLF}${p.body}${CRLF}`).join("") + `--${b}--`,
    };
  };

  const html = mail.html?.trim() ? mail.html : undefined;
  const text = mail.text ?? "";
  const rtfOnly = !html && !text.trim() && !!mail.rtf;
  let body: Part = html && text.trim() ? multipart("alternative", [textPart(text, "plain"), textPart(html, "html")])
    : html ? textPart(html, "html")
    : textPart(text, "plain");

  const isInline = (a: PstAttachmentData) => !!a.contentId && !!html && html.includes(`cid:${a.contentId}`);
  const inline = mail.attachments.filter(isInline);
  const attached = mail.attachments.filter((a) => !isInline(a));
  if (inline.length > 0) {
    body = multipart("related", [body, ...inline.map((a) => leaf(
      `${a.mimeType}${fileParams(a.filename)}`,
      a.data,
      [`Content-ID: <${cid(a.contentId!)}>`, `Content-Disposition: inline${fileParams(a.filename).replace(/; name/g, "; filename")}`],
    ))]);
  }
  const extra: Part[] = attached.map((a) => leaf(
    `${a.mimeType}${fileParams(a.filename)}`,
    a.data,
    [`Content-Disposition: attachment${fileParams(a.filename).replace(/; name/g, "; filename")}`],
  ));
  if (rtfOnly) {
    extra.push(leaf('application/rtf; name="message.rtf"', encoder.encode(mail.rtf!), ['Content-Disposition: attachment; filename="message.rtf"']));
  }
  if (extra.length > 0) body = multipart("mixed", [body, ...extra]);

  const header: string[] = [];
  const kept = mail.headers ? keptHeaders(mail.headers) : { text: "", names: new Set<string>() };
  if (kept.text) header.push(kept.text);
  const has = (name: string) => kept.names.has(name);
  if (!has("date") && mail.date) header.push(`Date: ${rfc5322Date(mail.date)}`);
  if (!has("from") && mail.from) header.push(`From: ${formatAddress(mail.from)}`);
  if (!has("to") && mail.to.length > 0) header.push(`To: ${addressList(mail.to)}`);
  if (!has("cc") && mail.cc.length > 0) header.push(`Cc: ${addressList(mail.cc)}`);
  // Only sent mail and drafts have Bcc recipients; a received header block never names them.
  if (!mail.headers && mail.bcc.length > 0) header.push(`Bcc: ${addressList(mail.bcc)}`);
  if (!has("subject")) header.push(`Subject: ${encodeHeaderText(mail.subject)}`);
  const messageId = msgId(mail.messageId);
  const inReplyTo = msgId(mail.inReplyTo);
  if (!has("message-id") && messageId) header.push(`Message-ID: ${messageId}`);
  if (!has("in-reply-to") && inReplyTo) header.push(`In-Reply-To: ${inReplyTo}`);
  if (!has("importance") && mail.importance === 2) header.push("Importance: high");
  if (!has("importance") && mail.importance === 0) header.push("Importance: low");
  header.push("MIME-Version: 1.0");
  header.push(...body.headers);
  return encoder.encode(`${header.join(CRLF)}${CRLF}${CRLF}${body.body}${CRLF}`);
}
