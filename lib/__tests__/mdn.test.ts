import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildMdnMessage } from '@/lib/mdn';

// buildMdnMessage pulls in Date / Date.now / Math.random for the Date header,
// Message-ID and MIME boundary. Pin all three so the output is reproducible.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-28T14:23:00Z'));
  vi.spyOn(Math, 'random').mockReturnValue(0.5); // (0.5).toString(36).slice(2) === 'i'
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const base = {
  to: 'sender@other.com',
  fromEmail: 'me@example.com',
  originalSubject: 'Hello',
  originalMessageId: 'orig@other.com',
};

describe('buildMdnMessage — structure', () => {
  it('emits the expected headers and a manual disposition by default', () => {
    const msg = buildMdnMessage(base);
    expect(msg).toContain('Date: Thu, 28 May 2026 14:23:00 +0000'); // rfc5322 UTC
    expect(msg).toMatch(/^From: me@example\.com$/m);
    expect(msg).toMatch(/^To: sender@other\.com$/m);
    expect(msg).toMatch(/^Subject: Read: Hello$/m); // default subject
    expect(msg).toMatch(/^Message-ID: <mdn\.[0-9a-z]+\.i@example\.com>$/m); // random token = 'i'
    expect(msg).toMatch(/^In-Reply-To: <orig@other\.com>$/m);
    expect(msg).toContain('Original-Message-ID: <orig@other.com>');
    expect(msg).toContain('Disposition: manual-action/MDN-sent-manually; displayed');
    expect(msg).toContain('Final-Recipient: rfc822;me@example.com');
    expect(msg).not.toContain('Original-Recipient:');
    expect(msg).toContain('Reporting-UA: example.com; Bulwark Webmail');
  });

  it('uses CRLF line endings everywhere', () => {
    const msg = buildMdnMessage(base);
    expect(msg).toContain('\r\n');
    expect(msg).not.toMatch(/[^\r]\n/); // no bare LF
  });

  it('marks an automatic action when automatic:true', () => {
    expect(buildMdnMessage({ ...base, automatic: true })).toContain(
      'Disposition: automatic-action/MDN-sent-automatically; displayed',
    );
  });
});

describe('buildMdnMessage — header encoding & normalisation', () => {
  it('RFC2047-encodes non-ASCII From name and Subject', () => {
    const msg = buildMdnMessage({ ...base, fromName: 'Müller', subject: 'Übersicht' });
    expect(msg).toMatch(/^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <me@example\.com>$/m);
    expect(msg).toMatch(/^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m);
  });

  it('normalises Message-ID from a string[] and adds missing angle brackets', () => {
    expect(buildMdnMessage({ ...base, originalMessageId: ['arr@x.com'] })).toMatch(
      /^In-Reply-To: <arr@x\.com>$/m,
    );
    expect(buildMdnMessage({ ...base, originalMessageId: 'bare@x.com' })).toContain(
      'Original-Message-ID: <bare@x.com>',
    );
  });

  it('omits In-Reply-To / Original-Message-ID when no original id is given', () => {
    const msg = buildMdnMessage({ to: base.to, fromEmail: base.fromEmail });
    expect(msg).not.toContain('In-Reply-To:');
    expect(msg).not.toContain('Original-Message-ID:');
  });

  it('adds Original-Recipient and uses it as Final-Recipient when supplied', () => {
    const msg = buildMdnMessage({ ...base, originalRecipient: 'alias@example.com' });
    expect(msg).toContain('Original-Recipient: rfc822;alias@example.com');
    expect(msg).toContain('Final-Recipient: rfc822;alias@example.com');
  });

  it('falls back to the localhost domain when fromEmail has no @', () => {
    const msg = buildMdnMessage({ to: base.to, fromEmail: 'invalid' });
    expect(msg).toMatch(/^Message-ID: <mdn\.[0-9a-z]+\.i@localhost>$/m);
    expect(msg).toContain('Reporting-UA: localhost; Bulwark Webmail');
  });
});

describe('buildMdnMessage — body', () => {
  it('base64-encodes the human-readable part wrapped at 76 columns', () => {
    const msg = buildMdnMessage({ ...base, humanText: 'A'.repeat(100) });
    const lines = msg.split('\r\n');
    // A 100-char ASCII body → 136 base64 chars → a 76-char line + a 60-char line.
    expect(lines.some((l) => l.length === 76 && /^[A-Za-z0-9+/]+$/.test(l))).toBe(true);
    expect(lines.every((l) => !/^[A-Za-z0-9+/]+={0,2}$/.test(l) || l.length <= 76)).toBe(true);
  });
});
