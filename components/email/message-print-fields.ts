import type { Email } from "@/lib/jmap/types";
import { sanitizeEmailHtml } from "@/lib/email-sanitization";
import { emailDisplayDate } from "@/lib/email-date";
import { getAttachmentDisplayName } from "@/lib/attachment-name";
import { formatDateTime, formatFileSize } from "@/lib/utils";
import type { InvitationPrint } from "@/lib/print/invitation-print";
import type { MessagePrintFields } from "./message-print";

export interface MessagePrintSource {
  email: Email;
  /** The body as the reader shows it: sanitized HTML, or escaped plain text with its quote toggle. */
  html: string;
  isHtml: boolean;
  /** The attachments the reader lists (inline images in the body left out). */
  attachments: ReadonlyArray<{ name?: string | null; type?: string | null; size?: number | null }>;
  invitation?: InvitationPrint | null;
  timeFormat: '12h' | '24h';
  /** The reader's words for a message without a subject or a sender. */
  noSubject: string;
  unknownSender: string;
}

/**
 * What a printout of one message shows: the same for the reader's own
 * message and for any message of a conversation. Text fields are unescaped.
 */
export function buildMessagePrintFields(source: MessagePrintSource): MessagePrintFields {
  const { email } = source;
  const sender = email.from?.[0];
  const formatRecipient = (r: { name?: string | null; email: string }) =>
    r.name ? `${r.name} <${r.email}>` : r.email;
  // The body was sanitized with a config that permits <style>. A printout
  // has no iframe isolation, so re-sanitize with the stricter config that
  // forbids <style> before injecting into the DOM. A plain-text body is
  // escaped text with its own newlines: it prints its trailing quote opened
  // instead of behind the collapsed toggle.
  const plain = !source.isHtml;
  return {
    subject: email.subject || source.noSubject,
    sender: sender?.name ? `${sender.name} <${sender.email}>` : sender?.email || source.unknownSender,
    to: email.to?.map(formatRecipient).join(', ') || '',
    cc: email.cc?.map(formatRecipient).join(', ') || '',
    date: formatDateTime(emailDisplayDate(email), source.timeFormat, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }),
    // The reader's list: inline images stay in the body, not here.
    attachments: source.attachments
      .map((a) => `${getAttachmentDisplayName(a.name ?? undefined, a.type ?? undefined)} (${formatFileSize(a.size ?? 0)})`)
      .join(', '),
    bodyHtml: plain ? source.html.replace(/<details>/g, '<details open>') : sanitizeEmailHtml(source.html),
    plain,
    invitation: source.invitation ?? null,
  };
}
