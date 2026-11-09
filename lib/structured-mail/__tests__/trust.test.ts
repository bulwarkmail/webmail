import { describe, expect, it } from 'vitest';
import { authenticationResultsOnReceipt, parseAuthenticationResults } from '@/lib/email-headers';
import type { Email, EmailBodyPart } from '@/lib/jmap/types';
import { hasForwardPrefix } from '@/lib/subject-prefix';
import { readStructuredMail } from '..';
import { getStructuredMailTrust, isPersonalMailboxDomain } from '../trust';

const HTML = `<html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'http://schema.org', '@type': 'Order', orderNumber: 'SO-1', merchant: 'Shop', orderStatus: 'OrderProcessing',
})}</script></head><body><p>Thanks for your order.</p></body></html>`;

const AR = {
  pass: 'mx.example.org; dkim=pass header.d=shop.example header.s=s1; spf=pass smtp.mailfrom=bounce@shop.example; dmarc=pass header.from=shop.example',
  fail: 'mx.example.org; dkim=fail header.d=shop.example; spf=fail smtp.mailfrom=shop.example; dmarc=fail header.from=shop.example',
  unverified: 'mx.example.org; dkim=pass header.d=bulk-sender.example; spf=pass smtp.mailfrom=bounce@bulk-sender.example; dmarc=none',
};

type Headers = { name: string; value: string }[];

function mail(o: {
  from?: string; ar?: string; headers?: Headers; subject?: string; html?: string; text?: string;
  truncated?: boolean; bodyStructure?: EmailBodyPart; onReceipt?: boolean;
} = {}): Email {
  const from = o.from ?? 'orders@shop.example';
  const headers: Headers = o.headers ?? [
    { name: 'Received', value: 'from mail.shop.example (mail.shop.example [192.0.2.1]) by mx.example.org (Stalwart SMTP) with ESMTPS id 1' },
    ...(o.ar ? [{ name: 'Authentication-Results', value: o.ar }] : []),
    { name: 'From', value: `<${from}>` },
  ];
  const arValues = headers.filter((h) => h.name.toLowerCase() === 'authentication-results').map((h) => h.value);
  return {
    id: 'm1', threadId: 't1', mailboxIds: {}, keywords: {}, size: 1, receivedAt: '2026-10-30T09:00:00Z',
    from: [{ email: from }], subject: o.subject ?? 'Your order SO-1',
    headers: headers as unknown as Email['headers'],
    ...(arValues.length > 0 ? { authenticationResults: parseAuthenticationResults(arValues) } : {}),
    ...(o.onReceipt !== undefined ? { authenticationResultsOnReceipt: o.onReceipt } : {}),
    htmlBody: [{ partId: '2', type: 'text/html' } as EmailBodyPart],
    textBody: o.text !== undefined ? [{ partId: '1', type: 'text/plain' } as EmailBodyPart] : [],
    bodyValues: {
      '2': { value: o.html ?? HTML, isTruncated: !!o.truncated, isEncodingProblem: false },
      ...(o.text !== undefined ? { '1': { value: o.text, isTruncated: false, isEncodingProblem: false } } : {}),
    },
    ...(o.bodyStructure ? { bodyStructure: o.bodyStructure } : {}),
  } as unknown as Email;
}

/** What the reader does: the trust gate, then the parser. */
function cardsFor(email: Email) {
  if (!getStructuredMailTrust(email).trusted) return [];
  const html = email.bodyValues!['2'].value;
  return readStructuredMail(html, { mailDate: new Date(email.receivedAt) });
}

const reason = (email: Email) => {
  const trust = getStructuredMailTrust(email);
  return trust.trusted ? 'trusted' : trust.reason;
};

describe('the same markup under each Authentication-Results verdict', () => {
  it('gives a card only when SPF or DKIM passes for the From domain', () => {
    expect(cardsFor(mail({ ar: AR.pass }))).toHaveLength(1);
    expect(cardsFor(mail({ ar: AR.fail }))).toEqual([]);
    expect(cardsFor(mail({ ar: AR.unverified }))).toEqual([]);
    expect(cardsFor(mail({}))).toEqual([]);
    // Internal: a colleague on the reader's own domain, handed in without any header.
    expect(cardsFor(mail({ from: 'travel@example.org' }))).toEqual([]);
  });

  it('names the reason', () => {
    expect(reason(mail({ ar: AR.pass }))).toBe('trusted');
    expect(reason(mail({ ar: AR.fail }))).toBe('sender_not_verified');
    expect(reason(mail({ ar: AR.unverified }))).toBe('sender_not_verified');
    expect(reason(mail({}))).toBe('no_authentication_results');
  });

  it('accepts a DKIM pass from a subdomain of the From domain (Uber signs as ibt.uber.com)', () => {
    const ar = 'mx.google.com; dkim=pass header.i=@ibt.shop.example header.s=smtp3; spf=pass smtp.mailfrom=bounces@ibt.shop.example; dmarc=pass header.from=shop.example';
    expect(reason(mail({ ar }))).toBe('trusted');
  });
});

describe('Authentication-Results written by the sender', () => {
  it('refuses a passing header with no Received above it (submitted over JMAP)', () => {
    const headers = [{ name: 'Authentication-Results', value: AR.pass }, { name: 'From', value: '<orders@shop.example>' }];
    expect(reason(mail({ headers }))).toBe('not_written_on_receipt');
  });

  it('refuses a passing header right below an authenticated submission hop', () => {
    const headers = [
      { name: 'Received', value: 'from [10.0.0.5] (user@example.org) by mx.example.org with ESMTPSA id 7' },
      { name: 'Authentication-Results', value: AR.pass },
    ];
    expect(reason(mail({ headers }))).toBe('not_written_on_receipt');
  });

  it('trusts the flag the full message fetch recorded', () => {
    expect(reason(mail({ ar: AR.pass, onReceipt: false }))).toBe('not_written_on_receipt');
    expect(reason(mail({ ar: AR.pass, headers: [{ name: 'Authentication-Results', value: AR.pass }], onReceipt: true }))).toBe('trusted');
  });
});

describe('authenticationResultsOnReceipt', () => {
  it('accepts the header order Stalwart writes on delivery', () => {
    expect(authenticationResultsOnReceipt([
      { name: 'Delivered-To', value: 'info@example.org' },
      { name: 'X-Spam-Status', value: 'No' },
      { name: 'Received', value: 'from smh-01.example.net (smh-01.example.net [178.254.0.201]) (using TLSv1.3 with cipher TLS13_AES_256_GCM_SHA384) by mail.example.org (Stalwart SMTP) with ESMTPS id 1' },
      { name: 'Authentication-Results', value: 'mail.example.org; dkim=pass header.d=shop.example' },
      { name: 'Received-SPF', value: 'pass' },
    ])).toBe(true);
  });

  it('accepts the header order Gmail writes', () => {
    expect(authenticationResultsOnReceipt([
      { name: 'Delivered-To', value: 'someone@gmail.com' },
      { name: 'Received', value: 'by 2002:a05:6a10:1b4a:b0:5b1:2::1 with SMTP id 10csp1;' },
      { name: 'X-Received', value: 'by 2002:a17:906 with SMTP id 1' },
      { name: 'ARC-Authentication-Results', value: 'i=1; mx.google.com; dkim=pass' },
      { name: 'Return-Path', value: '<bounce@shop.example>' },
      { name: 'Received', value: 'from mail.shop.example (mail.shop.example. [192.0.2.1]) by mx.google.com with ESMTPS id 2' },
      { name: 'Received-SPF', value: 'pass' },
      { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@shop.example' },
    ])).toBe(true);
  });

  it('refuses headers above every Received, after a submission hop, or with no Received at all', () => {
    expect(authenticationResultsOnReceipt([{ name: 'Authentication-Results', value: 'x' }, { name: 'Received', value: 'from a by b with ESMTPS' }])).toBe(false);
    expect(authenticationResultsOnReceipt([{ name: 'Received', value: 'from a by b with LMTPSA' }, { name: 'Authentication-Results', value: 'x' }])).toBe(false);
    expect(authenticationResultsOnReceipt([{ name: 'Received', value: 'from a by b with utf8esmtpa' }, { name: 'Authentication-Results', value: 'x' }])).toBe(false);
    expect(authenticationResultsOnReceipt([{ name: 'From', value: 'x' }, { name: 'Authentication-Results', value: 'x' }])).toBe(false);
    expect(authenticationResultsOnReceipt([{ name: 'Received', value: 'from a by b with ESMTPS' }])).toBe(false);
  });
});

describe('forwarded and personal mail', () => {
  it('gives no card for a forward prefix anywhere in the prefix chain', () => {
    expect(reason(mail({ ar: AR.pass, subject: 'Fwd: Your order SO-1' }))).toBe('forwarded');
    expect(reason(mail({ ar: AR.pass, subject: 'Re: WG: Ihre Bestellung' }))).toBe('forwarded');
    expect(reason(mail({ ar: AR.pass, subject: 'Re: Your order SO-1' }))).toBe('trusted');
  });

  it('gives no card when the body carries a forward separator or Outlook header block', () => {
    const separator = HTML.replace('<p>Thanks', '<p>---------- Forwarded message ----------</p><p>Thanks');
    expect(reason(mail({ ar: AR.pass, html: separator }))).toBe('forwarded');
    const outlook = 'FYI\n\nVon: Shop <orders@shop.example>\nGesendet: Freitag, 30. Oktober 2026 10:00\nAn: Erika\nBetreff: Ihre Bestellung\n';
    expect(reason(mail({ ar: AR.pass, text: outlook }))).toBe('forwarded');
    expect(reason(mail({ ar: AR.pass, text: 'From: Frankfurt\nTo: New York\nDate: 1 Dec' }))).toBe('trusted');
  });

  it('gives no card for mail from a personal mailbox, even when it passes', () => {
    const ar = 'mx.example.org; dkim=pass header.d=gmail.com; spf=pass smtp.mailfrom=friend@gmail.com; dmarc=pass header.from=gmail.com';
    expect(reason(mail({ from: 'friend@gmail.com', ar }))).toBe('personal_mailbox');
    expect(isPersonalMailboxDomain('outlook.de')).toBe(true);
    expect(isPersonalMailboxDomain('yahoo.co.uk')).toBe(true);
    expect(isPersonalMailboxDomain('lufthansa.com')).toBe(false);
  });

  it('detects forward prefixes on their own', () => {
    expect(hasForwardPrefix('FW: x')).toBe(true);
    expect(hasForwardPrefix('AW: Antw: Fwd: x')).toBe(true);
    expect(hasForwardPrefix('Forwarding your booking')).toBe(false);
    expect(hasForwardPrefix(undefined)).toBe(false);
  });
});

describe('attached and truncated mail', () => {
  it('gives no card when the HTML part sits inside an attached message', () => {
    const bodyStructure = {
      type: 'multipart/mixed', subParts: [
        { partId: '1', type: 'text/plain' },
        { type: 'message/rfc822', partId: '3', subParts: [{ partId: '2', type: 'text/html' }] },
      ],
    } as unknown as EmailBodyPart;
    expect(reason(mail({ ar: AR.pass, bodyStructure }))).toBe('attached_message');
  });

  it('gives no card when the HTML body value was cut off', () => {
    expect(reason(mail({ ar: AR.pass, truncated: true }))).toBe('truncated');
  });
});
