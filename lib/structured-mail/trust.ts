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
} from '@/lib/email-headers';
import type { Email, EmailBodyPart } from '@/lib/jmap/types';
import { hasForwardPrefix } from '@/lib/subject-prefix';

export type UntrustedReason =
  | 'no_authentication_results'
  | 'not_written_on_receipt'
  | 'sender'
  | 'sender_not_verified'
  | 'personal_mailbox'
  | 'forwarded'
  | 'attached_message'
  | 'truncated';

export type StructuredMailTrust = { trusted: true } | { trusted: false; reason: UntrustedReason };

export type TrustInput = Pick<Email, 'from' | 'subject' | 'authenticationResults' | 'authenticationResultsOnReceipt' | 'headers' | 'htmlBody' | 'textBody' | 'bodyValues' | 'bodyStructure'>;

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

/** Separator lines mail clients put above a forwarded message. */
const FORWARD_SEPARATOR_RE = new RegExp([
  'forwarded message', 'begin forwarded message', 'original message', 'weitergeleitete nachricht',
  'ursprüngliche nachricht', 'message transféré', 'message d\'origine', 'mensaje reenviado', 'mensaje original',
  'messaggio inoltrato', 'messaggio originale', 'doorgestuurd bericht', 'oorspronkelijk bericht', 'mensagem encaminhada',
].map((s) => `-{2,}\\s*${s}\\s*-{2,}|^\\s*${s}:?\\s*$`).join('|'), 'im');

/** Outlook's forward header block: From / Sent / To ... Subject, in a few languages. */
const OUTLOOK_HEADER_RE = /^\s*(?:from|von|de|da|van|od):[^\n]*\n\s*(?:sent|gesendet|envoyé|inviato|enviado|verzonden|wysłano):[^\n]*\n(?:[^\n]*\n){0,3}\s*(?:subject|betreff|objet|oggetto|asunto|onderwerp|temat):/im;

function htmlToLines(html: string): string {
  return html
    .replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/gi, ' ')
    .replace(/<(?:br|\/p|\/div|\/tr|\/li|\/h\d|\/td)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t]+/g, ' ');
}

function looksForwarded(text: string): boolean {
  return FORWARD_SEPARATOR_RE.test(text) || OUTLOOK_HEADER_RE.test(text);
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
