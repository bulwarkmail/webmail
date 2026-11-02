// Builds an RFC 8098 Message Disposition Notification (MDN) as a raw RFC 5322
// message string. JMAP/Stalwart has no native MDN support, so the client
// constructs the multipart/report itself and sends it via
// blob-upload -> Email/import -> EmailSubmission/set (see client.sendReadReceipt).
//
// The message has two parts:
//   1. text/plain  — human-readable explanation (English, ASCII; rarely shown)
//   2. message/disposition-notification — the machine-readable fields
// The optional third part (original message/headers) is omitted; RFC 8098 §3.1
// permits a two-part report.

export interface MdnOptions {
  /** Address that requested the receipt (Disposition-Notification-To) — the MDN recipient. */
  to: string;
  /** Our identity address (sender of the MDN). */
  fromEmail: string;
  /** Optional display name for the From header. */
  fromName?: string;
  /** Original Message-ID. JMAP may hand this back as a string[]
   *  (header:Message-ID:asMessageIds), so accept both. */
  originalMessageId?: string | string[];
  /** Original Subject (used to build the MDN subject). */
  originalSubject?: string;
  /**
   * The address the original message was delivered to (our address/alias).
   * Used for Final-Recipient/Original-Recipient. Falls back to fromEmail.
   */
  originalRecipient?: string;
  /** true => automatic-action (setting "always"); false => manual-action (user clicked send). */
  automatic?: boolean;
  /** Reporting-UA value, e.g. "mail.dornig.de; Bulwark Webmail". */
  reportingUa?: string;
  /** Localized full Subject line. Defaults to "Read: <originalSubject>". */
  subject?: string;
  /** Localized human-readable explanation (first report part). Defaults to English. */
  humanText?: string;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RFC 5322 date in UTC, e.g. "Thu, 28 May 2026 14:23:00 +0000". */
export function rfc5322Date(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

/** UTF-8 string -> base64, without the deprecated unescape(). */
function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** UTF-8 base64 body, wrapped at 76 chars per RFC 2045. */
export function base64Body(text: string): string {
  return (utf8ToBase64(text).match(/.{1,76}/g) || []).join("\r\n");
}

/**
 * Remove the characters that must never reach a header we assemble as text:
 * CR, LF, the remaining C0 controls and DEL. Runs collapse to one space.
 *
 * Every value that lands in a header here ultimately comes from the message
 * we are answering (its Subject, Message-ID, Disposition-Notification-To),
 * and Stalwart hands those back already RFC 2047-decoded. A sender can
 * therefore smuggle a bare CRLF past SMTP inside an encoded-word; if it were
 * interpolated verbatim it would terminate the header and let the sender
 * append headers and a body of their choosing to a message the victim's own
 * account submits (GHSA-w38p-hpqv-g89c).
 */
export function stripHeaderControls(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1F\x7F]+/g, " ").trim();
}

/** Address-like atoms (mailboxes, message-ids) may contain no whitespace at all. */
export function headerAtom(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x20\x7F]+/g, "");
}

/**
 * Header value safe to place after "Name: ". Control characters are stripped
 * first; the result is RFC 2047-encoded when it contains non-ASCII.
 */
export function encodeHeaderWord(value: string): string {
  const clean = stripHeaderControls(value);
  if (!/[^\x20-\x7E]/.test(clean)) return clean;
  return `=?UTF-8?B?${utf8ToBase64(clean)}?=`;
}

/** Display-name for a mailbox: encoded-word if non-ASCII, quoted if it uses specials. */
export function displayName(value: string): string {
  const encoded = encodeHeaderWord(value);
  if (encoded.startsWith("=?") || !/[()<>[\]:;@\\,."]/.test(encoded)) return encoded;
  return `"${encoded.replace(/["\\]/g, "\\$&")}"`;
}

function ensureAngles(messageId: string | string[] | undefined): string {
  // JMAP often returns Message-ID as a string[] (header:...:asMessageIds), so
  // normalize string | string[] | undefined down to a single bracketed id.
  const raw = Array.isArray(messageId) ? messageId[0] : messageId;
  if (typeof raw !== "string") return "";
  const trimmed = headerAtom(raw);
  if (!trimmed) return "";
  return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
}

export function randomToken(): string {
  const rnd = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}.${rnd}`;
}

/**
 * Build the raw RFC 5322 MDN message. Lines are CRLF-terminated as required
 * by the MIME standard so the bytes import/transmit verbatim.
 */
export function buildMdnMessage(opts: MdnOptions): string {
  // Everything interpolated into a header line goes through headerAtom /
  // encodeHeaderWord so that no CR/LF (or other control) can split a line.
  const to = headerAtom(opts.to);
  const fromEmail = headerAtom(opts.fromEmail);
  const originalRecipient = opts.originalRecipient ? headerAtom(opts.originalRecipient) : "";
  const finalRecipient = originalRecipient || fromEmail;
  const domain = fromEmail.split("@")[1] || "localhost";
  const messageId = `<mdn.${randomToken()}@${domain}>`;
  const boundary = `----=_MDN_${randomToken()}`;
  const origMsgId = ensureAngles(opts.originalMessageId); // normalized "<...>" or ""

  const fromName = opts.fromName ? displayName(opts.fromName) : "";
  const fromHeader = fromName ? `${fromName} <${fromEmail}>` : fromEmail;

  const subject = encodeHeaderWord(
    opts.subject ?? `Read: ${opts.originalSubject || ""}`.trim()
  );

  const disposition = opts.automatic
    ? "automatic-action/MDN-sent-automatically; displayed"
    : "manual-action/MDN-sent-manually; displayed";

  const reportingUa = stripHeaderControls(opts.reportingUa || "") || `${domain}; Bulwark Webmail`;

  // Human-readable part. Caller passes a localized humanText; fall back to
  // English. Encoded as UTF-8/base64 below so any language survives.
  const humanText = opts.humanText ?? [
    `This is a return receipt for the message you sent to ${finalRecipient}.`,
    ``,
    `Note: This receipt only acknowledges that the message was displayed on the`,
    `recipient's computer. There is no guarantee that the recipient has read or`,
    `understood the message contents.`,
  ].join("\r\n");

  // Machine-readable disposition-notification part (pure ASCII tokens).
  const mdnFields = [
    `Reporting-UA: ${reportingUa}`,
    `Final-Recipient: rfc822;${finalRecipient}`,
    ...(originalRecipient ? [`Original-Recipient: rfc822;${originalRecipient}`] : []),
    ...(origMsgId ? [`Original-Message-ID: ${origMsgId}`] : []),
    `Disposition: ${disposition}`,
  ].join("\r\n");

  return [
    `Date: ${rfc5322Date()}`,
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    ...(origMsgId ? [`In-Reply-To: ${origMsgId}`] : []),
    `MIME-Version: 1.0`,
    `Content-Type: multipart/report; report-type=disposition-notification;`,
    `\tboundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    base64Body(humanText),
    ``,
    `--${boundary}`,
    `Content-Type: message/disposition-notification`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    mdnFields,
    ``,
    `--${boundary}--`,
    ``,
  ].join("\r\n");
}
