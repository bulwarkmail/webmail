import { describe, expect, it, vi } from 'vitest';
import type { Email, Identity } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { buildArfParts, buildArfReportBlob, rawEncoding } from '../phishing-report-arf';
import { sendPhishingReport } from '../phishing-report';

// The ARF report (RFC 5965): multipart/report with report-type
// feedback-report, a text part, message/feedback-report with
// Feedback-Type: fraud, User-Agent and Version: 1, and the original whole
// as message/rfc822; submitted raw without a Sent copy.

const email = {
  id: 'e1', blobId: 'blob-1', size: 40, headers: { 'Delivered-To': 'alice@example.org' }, subject: 'Konto gesperrt – jetzt prüfen', receivedAt: '2026-10-01T10:00:00Z',
  from: [{ email: 'bad@phish.example' }], keywords: {}, mailboxIds: { inbox: true },
} as unknown as Email;
const reporter = { id: 'id-me', name: 'Alice', email: 'alice@example.org' } as Identity;
const ORIGINAL = 'From: bad@phish.example\r\nSubject: x\r\n\r\nclick here\r\n';

describe('buildArfParts', () => {
  it('has the three parts and the required feedback fields', () => {
    const { head, tail } = buildArfParts({ email, reporter, to: 'abuse@example.org', encoding: '7bit', recipient: 'alice@example.org', now: new Date('2026-11-01T08:00:00Z') });
    expect(head).toMatch(/^Date: Sun, 01 Nov 2026 08:00:00 \+0000\r\n/);
    expect(head).toContain('From: Alice <alice@example.org>\r\n');
    expect(head).toContain('To: abuse@example.org\r\n');
    // Non-ASCII subject as an encoded word, after "Phishing:".
    expect(head).toMatch(/\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/);
    const subject = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(head)![1];
    expect(new TextDecoder().decode(Uint8Array.from(atob(subject), (c) => c.charCodeAt(0)))).toBe('Phishing: Konto gesperrt – jetzt prüfen');
    expect(head).toContain('Content-Type: multipart/report; report-type=feedback-report;');
    const boundary = /boundary="([^"]+)"/.exec(head)![1];
    expect(head.split(`--${boundary}\r\n`)).toHaveLength(4);
    expect(head).toContain('Content-Type: message/feedback-report\r\n');
    expect(head).toContain('\r\nFeedback-Type: fraud\r\n');
    expect(head).toMatch(/\r\nUser-Agent: Bulwark\/\S+\r\n/);
    expect(head).toContain('\r\nVersion: 1\r\n');
    expect(head).toContain('\r\nArrival-Date: Thu, 01 Oct 2026 10:00:00 +0000\r\n');
    expect(head).toContain('\r\nOriginal-Rcpt-To: alice@example.org\r\n');
    expect(head).toContain('\r\nReported-Domain: phish.example\r\n');
    expect(head).toMatch(/Content-Type: message\/rfc822\r\n[\s\S]*Content-Transfer-Encoding: 7bit\r\n\r\n$/);
    expect(tail).toBe(`\r\n--${boundary}--\r\n`);
  });

  it('names the address the message was delivered to, and leaves the field out when unknown', () => {
    const { head } = buildArfParts({ email, reporter, to: 'abuse@example.org', encoding: '7bit' });
    expect(head).not.toContain('Original-Rcpt-To');
  });

  it('says binary for bare line breaks or long lines, 8bit for 8-bit bytes, never base64', () => {
    const enc = (text: string) => rawEncoding(new TextEncoder().encode(text));
    expect(enc('a\r\nb\r\n')).toBe('7bit');
    expect(enc('Grüße\r\n')).toBe('8bit');
    expect(enc('a\nb')).toBe('binary');
    expect(enc('a\rb')).toBe('binary');
    expect(enc(`${'x'.repeat(999)}\r\n`)).toBe('binary');
    expect(enc('a\u0000b')).toBe('binary');
  });

  it('marks an 8-bit original as 8bit, never base64', () => {
    const { head } = buildArfParts({ email, reporter, to: 'abuse@example.org', encoding: '8bit' });
    expect(head).toMatch(/Content-Transfer-Encoding: 8bit\r\n\r\n$/);
  });
});

describe('an ARF report', () => {
  it('carries the original byte for byte and is submitted raw, from the original account', async () => {
    const client = {
      getMaxSizeUpload: () => 50_000_000,
      getIdentities: vi.fn(async () => [reporter]),
      getUsername: () => 'alice@example.org',
      getAccountId: () => 'acc-own',
      fetchBlobArrayBuffer: vi.fn(async () => new TextEncoder().encode(ORIGINAL).buffer),
      submitRawEmail: vi.fn(async (..._args: unknown[]) => ({ scheduled: false })),
      sendEmail: vi.fn(),
    };
    await sendPhishingReport(email, {
      client: client as unknown as IJMAPClient,
      sourceAccountId: 'acc-group',
      setup: { address: 'abuse@example.org', format: 'arf' },
      buildArf: buildArfReportBlob,
    });
    expect(client.fetchBlobArrayBuffer).toHaveBeenCalledWith('blob-1', 'message.eml', 'message/rfc822', 'acc-group');
    expect(client.sendEmail).not.toHaveBeenCalled();
    const [blob, identityId, delayed, envelope] = client.submitRawEmail.mock.calls[0] as [Blob, string, unknown, string[]];
    expect(identityId).toBe('id-me');
    expect(delayed).toBeUndefined();
    expect(envelope).toEqual(['abuse@example.org']);
    const text = await blob.text();
    const boundary = /boundary="([^"]+)"/.exec(text)![1];
    expect(text).toContain(`message/rfc822\r\nContent-Disposition: attachment; filename="reported-message.eml"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${ORIGINAL}--${boundary}--\r\n`);
  });
});

describe('a message too big for an ARF report', () => {
  it('is refused before it is downloaded', async () => {
    const client = { getMaxSizeUpload: () => 1000, fetchBlobArrayBuffer: vi.fn() };
    await expect(buildArfReportBlob({
      client: client as unknown as IJMAPClient, email: { ...email, size: 5000 } as Email, sourceAccountId: 'a', reporter, to: 'abuse@example.org',
    })).rejects.toThrow(/too big/);
    expect(client.fetchBlobArrayBuffer).not.toHaveBeenCalled();
  });
});
