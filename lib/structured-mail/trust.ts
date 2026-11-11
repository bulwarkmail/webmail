/**
 * Whether a message may show booking cards at all. A card looks official and
 * a calendar entry outlives the mail, so the bar is high: the receiving
 * server must have tied the mail to its From domain, the mail must not be a
 * forward, and the markup must come from the message itself. Plain
 * TypeScript on the Email shape; the admin gate is checked by the caller.
 */
import {
  authenticationResultsOnReceipt,
  getSenderVerification,
  hasAlignedAuthenticationPass,
  isImportedMessage,
} from '@/lib/email-headers';
import type { Email, EmailBodyPart } from '@/lib/jmap/types';
import { hasForwardPrefix } from '@/lib/subject-prefix';

export type UntrustedReason =
  | 'no_authentication_results'
  | 'not_written_on_receipt'
  | 'imported'
  | 'sender'
  | 'sender_not_verified'
  | 'personal_mailbox'
  | 'forwarded'
  | 'attached_message'
  | 'truncated';

export type StructuredMailTrust = { trusted: true } | { trusted: false; reason: UntrustedReason };

export type TrustInput = Pick<Email, 'from' | 'subject' | 'authenticationResults' | 'authenticationResultsOnReceipt' | 'headers' | 'htmlBody' | 'textBody' | 'bodyValues' | 'bodyStructure'>
  & Partial<Pick<Email, 'keywords'>>;

/**
 * Personal mailbox providers. A booking mail from one of these is someone
 * forwarding it (perhaps with the "Fwd:" removed); airlines and shops don't
 * send from them.
 */
const PERSONAL_MAILBOX_DOMAINS = [
  'gmail.com', 'googlemail.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'web.de', 't-online.de', 'freenet.de', 'posteo.de', 'posteo.net', 'mailbox.org', 'proton.me',
  'protonmail.com', 'protonmail.ch', 'pm.me', 'mail.ru', 'gmx.com', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch',
  'tutanota.com', 'tuta.io', 'zoho.com', 'fastmail.com', 'hey.com',
];
const PERSONAL_MAILBOX_FAMILIES = /^(?:outlook|hotmail|live|yahoo|ymail|yandex)\.[a-z.]+$/;

export function isPersonalMailboxDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return PERSONAL_MAILBOX_DOMAINS.includes(d) || PERSONAL_MAILBOX_FAMILIES.test(d);
}

/**
 * Separator lines mail clients put above a forwarded message, lower case,
 * with single spaces. Every pattern below reads one line at a time and
 * each pattern starts with fixed text, so the cost of the forward check
 * grows with the length of the body, never with its square.
 */
const FORWARD_MARKERS = [
  'forwarded message', 'begin forwarded message', 'original message', 'weitergeleitete nachricht',
  'ursprüngliche nachricht', 'message transféré', 'message d\'origine', 'mensaje reenviado', 'mensaje original',
  'messaggio inoltrato', 'messaggio originale', 'doorgestuurd bericht', 'oorspronkelijk bericht', 'mensagem encaminhada',
];
const MARKER_ALTERNATIVES = FORWARD_MARKERS.join('|');
/** "---------- Forwarded message ----------" anywhere in a line (runs of dashes are cut to two first). */
const DASHED_MARKER_RE = new RegExp(`-- ?(?:${MARKER_ALTERNATIVES}) ?--`);
/** "Begin forwarded message:" as a line of its own. */
const MARKER_LINE_RE = new RegExp(`^(?:${MARKER_ALTERNATIVES}):?$`);

/** Outlook's forward header block: From / Sent / To ... Subject, in a few languages. */
const OUTLOOK_FROM_RE = /^(?:from|von|de|da|van|od):/;
const OUTLOOK_SENT_RE = /^(?:sent|gesendet|envoyé|inviato|enviado|verzonden|wysłano):/;
const OUTLOOK_SUBJECT_RE = /^(?:subject|betreff|objet|oggetto|asunto|onderwerp|temat):/;
/** Lines the Outlook block may hold between Sent and Subject (To, Cc, ...). */
const OUTLOOK_LINES_BEFORE_SUBJECT = 3;

const LINE_BREAK_RE = /\r\n?|\n/;

/**
 * The text of an HTML part, a line per block. Script and style elements go
 * first, an unclosed one to the end of the part, so it is passed over once.
 * Tags are matched with `[^<>]`: a `<` without its `>` is given up at the
 * next `<` instead of after a scan to the end of the part.
 */
function htmlToLines(html: string): string {
  return html
    .replace(/<(script|style)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/tr|\/li|\/h\d|\/td)\b[^<>]*>/gi, '\n')
    .replace(/<[^<>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ');
}

/** A line as the markers are written: lower case, single spaces, runs of dashes cut to two. */
function normalizeLine(line: string): string {
  return line.toLowerCase().replace(/\s+/g, ' ').replace(/-{2,}/g, '--').trim();
}

function looksForwarded(text: string): boolean {
  const lines = text.split(LINE_BREAK_RE).map(normalizeLine).filter((line) => line !== '');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (DASHED_MARKER_RE.test(line) || MARKER_LINE_RE.test(line)) return true;
    if (!OUTLOOK_FROM_RE.test(line) || !OUTLOOK_SENT_RE.test(lines[i + 1] ?? '')) continue;
    const last = Math.min(lines.length - 1, i + 2 + OUTLOOK_LINES_BEFORE_SUBJECT);
    for (let j = i + 2; j <= last; j++) {
      if (OUTLOOK_SUBJECT_RE.test(lines[j])) return true;
    }
  }
  return false;
}

function partValue(email: TrustInput, part: EmailBodyPart | undefined): { value: string; truncated: boolean } | undefined {
  if (!part?.partId) return undefined;
  const value = email.bodyValues?.[part.partId];
  return value ? { value: value.value ?? '', truncated: !!value.isTruncated } : undefined;
}

/** The HTML part a card reads: the message's own first text/html part. */
export function structuredHtmlPart(email: Pick<Email, 'htmlBody' | 'bodyValues'>): { value: string; truncated: boolean } | undefined {
  const part = email.htmlBody?.find((p) => p.type === 'text/html');
  if (!part?.partId) return undefined;
  const value = email.bodyValues?.[part.partId];
  return value ? { value: value.value ?? '', truncated: !!value.isTruncated } : undefined;
}

/** Whether `partId` sits inside an attached message (message/rfc822) in the body tree. */
function insideAttachedMessage(root: EmailBodyPart | undefined, partId: string | undefined): boolean {
  if (!root || !partId) return false;
  const walk = (part: EmailBodyPart, inMessage: boolean): boolean | undefined => {
    const nested = inMessage || (part !== root && part.type?.toLowerCase() === 'message/rfc822');
    if (part.partId === partId) return nested;
    for (const child of part.subParts ?? []) {
      const found = walk(child, nested);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(root, false) ?? false;
}

function headerList(headers: TrustInput['headers']): { name: string; value: string }[] | undefined {
  return Array.isArray(headers) ? (headers as unknown as { name: string; value: string }[]) : undefined;
}

export function getStructuredMailTrust(email: TrustInput): StructuredMailTrust {
  const auth = email.authenticationResults;
  if (!auth) return { trusted: false, reason: 'no_authentication_results' };
  // A message from an imported file carries the lines some other server, or
  // the file's author, wrote; this server never checked it.
  if (isImportedMessage(email)) return { trusted: false, reason: 'imported' };

  const list = headerList(email.headers);
  const onReceipt = email.authenticationResultsOnReceipt ?? (list ? authenticationResultsOnReceipt(list) : false);
  if (!onReceipt) return { trusted: false, reason: 'not_written_on_receipt' };

  const senders = email.from ?? [];
  const from = senders[0]?.email ?? '';
  const domain = from.slice(from.lastIndexOf('@') + 1).toLowerCase();
  if (senders.length !== 1 || !from.includes('@') || !domain.includes('.')) return { trusted: false, reason: 'sender' };

  if (getSenderVerification(auth, from) !== null || !hasAlignedAuthenticationPass(auth, from)) {
    return { trusted: false, reason: 'sender_not_verified' };
  }
  if (isPersonalMailboxDomain(domain)) return { trusted: false, reason: 'personal_mailbox' };

  const html = structuredHtmlPart(email);
  const htmlPartId = email.htmlBody?.find((p) => p.type === 'text/html')?.partId;
  if (insideAttachedMessage(email.bodyStructure, htmlPartId)) return { trusted: false, reason: 'attached_message' };
  if (html?.truncated) return { trusted: false, reason: 'truncated' };

  if (hasForwardPrefix(email.subject)) return { trusted: false, reason: 'forwarded' };
  const text = partValue(email, email.textBody?.find((p) => p.type === 'text/plain'));
  if ((html && looksForwarded(htmlToLines(html.value))) || (text && looksForwarded(text.value))) {
    return { trusted: false, reason: 'forwarded' };
  }
  return { trusted: true };
}
