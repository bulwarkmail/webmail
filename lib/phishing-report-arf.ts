/**
 * The ARF format of a phishing report (RFC 5965, an admin option of
 * Organisation > Security > Phishing reports): a multipart/report with
 * report-type=feedback-report and three parts, a short text for people, the
 * machine-readable message/feedback-report (Feedback-Type: fraud, which
 * RFC 5965 §7.3 defines as "fraud or phishing"), and the original whole and
 * unchanged as message/rfc822.
 *
 * JMAP can't set the report-type parameter through Email/set, so this is
 * raw MIME: the original's bytes are downloaded, wrapped and uploaded, then
 * submitted with submitRawEmail (no Sent copy). The upload counts against
 * the server's upload quota and is limited by maxSizeUpload.
 */

import type { Email } from '@/lib/jmap/types';
import { base64Body, displayName, encodeHeaderWord, headerAtom, randomToken, rfc5322Date } from '@/lib/mdn';
import { deliveryAddresses } from '@/lib/reply-identity';
import { reportSubject, type ArfInput } from './phishing-report';

export interface ArfParts {
  /** Everything before the original's bytes. */
  head: string;
  /** Everything after them. */
  tail: string;
}

function appVersion(): string {
  return (process.env.NEXT_PUBLIC_APP_VERSION || '').trim() || 'unknown';
}

/** "Reported-Domain": the domain of the original's From, when it has one. */
function senderDomain(email: Pick<Email, 'from'>): string | null {
  const address = email.from?.[0]?.email ?? '';
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return address.includes('@') && /^[A-Za-z0-9.-]+$/.test(domain) ? domain.toLowerCase() : null;
}

/** How the original goes in: message/rfc822 may not be base64-encoded (RFC 2046 §5.2.1). */
export type RawEncoding = '7bit' | '8bit' | 'binary';

/**
 * The report around the original. `encoding`: what the original's bytes
 * are (rawEncoding). `recipient`: the address the original was delivered
 * to, for Original-Rcpt-To; left out when unknown.
 */
export function buildArfParts(input: {
  email: Pick<Email, 'subject' | 'receivedAt' | 'from' | 'messageId'>;
  reporter: { name?: string; email: string };
  to: string;
  encoding: RawEncoding;
  recipient?: string;
  now?: Date;
}): ArfParts {
  const { email, reporter } = input;
  const fromEmail = headerAtom(reporter.email);
  const domain = fromEmail.split('@')[1] || 'localhost';
  const boundary = `----=_ARF_${randomToken()}`;
  const fromName = reporter.name?.trim() ? displayName(reporter.name.trim()) : '';
  const arrival = email.receivedAt ? new Date(email.receivedAt) : null;
  const reportedDomain = senderDomain(email);
  const human = [
    `This is a phishing report (RFC 5965) sent by ${fromEmail} with Bulwark.`,
    '',
    'The reported message is attached unchanged.',
  ].join('\r\n');
  const report = [
    'Feedback-Type: fraud',
    `User-Agent: Bulwark/${appVersion()}`,
    'Version: 1',
    ...(arrival && !Number.isNaN(arrival.getTime()) ? [`Arrival-Date: ${rfc5322Date(arrival)}`] : []),
    ...(input.recipient ? [`Original-Rcpt-To: ${headerAtom(input.recipient)}`] : []),
    ...(reportedDomain ? [`Reported-Domain: ${reportedDomain}`] : []),
  ].join('\r\n');

  const head = [
    `Date: ${rfc5322Date(input.now ?? new Date())}`,
    `From: ${fromName ? `${fromName} <${fromEmail}>` : fromEmail}`,
    `To: ${headerAtom(input.to)}`,
    `Subject: ${encodeHeaderWord(reportSubject(email.subject))}`,
    `Message-ID: <arf.${randomToken()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/report; report-type=feedback-report;',
    `\tboundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(human),
    '',
    `--${boundary}`,
    'Content-Type: message/feedback-report',
    'Content-Transfer-Encoding: 7bit',
    '',
    report,
    '',
    `--${boundary}`,
    'Content-Type: message/rfc822',
    'Content-Disposition: attachment; filename="reported-message.eml"',
    `Content-Transfer-Encoding: ${input.encoding}`,
    '',
    '',
  ].join('\r\n');
  const tail = `\r\n--${boundary}--\r\n`;
  return { head, tail };
}

/**
 * 7bit or 8bit lines of at most 998 octets ending in CRLF (RFC 2045 §2.7,
 * §2.8); anything else (a NUL, a bare CR or LF, a longer line) is binary.
 */
export function rawEncoding(bytes: Uint8Array): RawEncoding {
  let eightBit = false;
  let line = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x00) return 'binary';
    if (b === 0x0d) {
      if (bytes[i + 1] !== 0x0a) return 'binary';
      i++;
      line = 0;
      continue;
    }
    if (b === 0x0a) return 'binary';
    if (b > 0x7f) eightBit = true;
    if (++line > 998) return 'binary';
  }
  return eightBit ? '8bit' : '7bit';
}

/** The whole report as a Blob, the original downloaded from its own account. */
export async function buildArfReportBlob(input: ArfInput): Promise<Blob> {
  const { client, email, sourceAccountId } = input;
  if (!email.blobId) throw new Error('The message has no content to report');
  // The report is uploaded: one bigger than the server takes fails anyway,
  // so it isn't downloaded either.
  const maxUpload = client.getMaxSizeUpload?.() ?? 0;
  if (maxUpload > 0 && email.size + 8192 > maxUpload) {
    throw new Error('The message is too big for an ARF report on this server');
  }
  const original = new Uint8Array(await client.fetchBlobArrayBuffer(email.blobId, 'message.eml', 'message/rfc822', sourceAccountId));
  const parts = buildArfParts({
    email,
    reporter: input.reporter,
    to: input.to,
    encoding: rawEncoding(original),
    recipient: deliveryAddresses(email.headers)[0]
      ?? email.to?.find((addr) => addr.email?.toLowerCase() === input.reporter.email.toLowerCase())?.email,
  });
  // The original goes in byte for byte; the closing boundary needs a line break before it.
  const endsWithBreak = original.length >= 2 && original[original.length - 2] === 0x0d && original[original.length - 1] === 0x0a;
  const report = new Blob([parts.head, original, endsWithBreak ? parts.tail.slice(2) : parts.tail], { type: 'message/rfc822' });
  if (maxUpload > 0 && report.size > maxUpload) throw new Error('The message is too big for an ARF report on this server');
  return report;
}
