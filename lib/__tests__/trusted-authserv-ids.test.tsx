// Mail servers the admin trusts besides the receiving Stalwart (TRUSTED_AUTHSERV_IDS). Their
// Authentication-Results count when the header is the topmost one, its authserv-id is in the list,
// and every Received line above it was written after that server checked the message: by the
// receiving Stalwart, by a listed server, or as a handoff inside a server (no `from` clause).
// A header with a listed name below a server outside the list may be the sender's own. With no
// Received line above it (GMX writes its results above its own line), the line right below must be
// a listed server taking the message in.
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import {
  authenticationResultsOnReceipt,
  getSenderVerification,
  topAuthenticationResultsOnReceipt,
} from '@/lib/email-headers';
import { invalidTrustedAuthservIds, parseTrustedAuthservIds, setTrustedAuthservIds } from '@/lib/trusted-authserv';
import { useSenderWarning } from '@/hooks/use-sender-warning';
import type { Email } from '@/lib/jmap/types';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

type Header = { name: string; value: string };
type Call = [string, Record<string, unknown>, string];
const h = (name: string, value: string): Header => ({ name, value });
const values = (headers: Header[], name: string) => headers.filter((x) => x.name === name).map((x) => x.value);

const GMAIL = ['mx.google.com'];
const GATEWAY = ['gw.filter.example'];

/** A Gmail mailbox read through legacy-proxy: Gmail's own handoffs on top, then its MX. */
const gmailHeaders = (results: string, from = ' Anna <anna@client.example>'): Header[] => [
  h('Delivered-To', ' reader@gmail.com'),
  h('Received', ' by 2002:a05:7300:5b8a:b0:1a2:3b4c:5d6e with SMTP id x10csp1234567dyb;\r\n        Mon, 16 Nov 2026 01:00:01 -0800 (PST)'),
  h('X-Received', ' by 2002:a17:906:4fd1:b0:a9e:1234:5678 with SMTP id a1mr1234567ejb.12.1763283601234;\r\n        Mon, 16 Nov 2026 01:00:01 -0800 (PST)'),
  h('ARC-Authentication-Results', ' i=1; mx.google.com; dkim=pass header.i=@client.example'),
  h('Return-Path', ' <anna@client.example>'),
  h('Received', ' from mail.client.example (mail.client.example. [198.51.100.7])\r\n        by mx.google.com with ESMTPS id a1si123456ejb.123.2026.11.16.01.00.00\r\n        for <reader@gmail.com>\r\n        (version=TLS1_3 cipher=TLS_AES_256_GCM_SHA384 bits=256/256);\r\n        Mon, 16 Nov 2026 01:00:00 -0800 (PST)'),
  h('Received-SPF', ' pass (google.com: domain of anna@client.example designates 198.51.100.7 as permitted sender) client-ip=198.51.100.7;'),
  h('Authentication-Results', results),
  h('From', from),
];
const GMAIL_PASS = ' mx.google.com;\r\n       dkim=pass header.i=@client.example header.s=s1 header.b=abc;\r\n       spf=pass (google.com: domain of anna@client.example designates 198.51.100.7 as permitted sender) smtp.mailfrom=anna@client.example;\r\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=client.example';
const GMAIL_FAIL = ' mx.google.com;\r\n       spf=fail (google.com: domain of service@paypal.com does not designate 203.0.113.5 as permitted sender) smtp.mailfrom=service@paypal.com;\r\n       dmarc=fail (p=REJECT sp=REJECT dis=NONE) header.from=paypal.com';
const FORGED_GMAIL_PASS = ' mx.google.com; spf=pass smtp.mailfrom=paypal.com;\r\n dkim=pass header.d=paypal.com; dmarc=pass (p=REJECT) header.from=paypal.com';

/** Gmail took a forgery in: its own failing header on top, the sender's "pass" for mx.google.com below. */
const gmailForgery: Header[] = [
  ...gmailHeaders(GMAIL_FAIL, ' PayPal <service@paypal.com>').slice(0, -1),
  h('Received', ' from attacker.example by mx.google.com with ESMTP id 1; Mon, 16 Nov 2026 00:59:00 -0800'),
  h('Authentication-Results', FORGED_GMAIL_PASS),
  h('From', ' PayPal <service@paypal.com>'),
];

/** A host outside the list (a cPanel Exim) took a forgery in that claims mx.google.com, and imapsync copied it over. */
const forgedBelowUntrusted: Header[] = [
  h('Received', ' from attacker.example ([203.0.113.5]:12345)\r\n\tby server1.cpanel-host.example with esmtps (TLS1.2) (Exim 4.98)\r\n\tid 1abc-000; Mon, 16 Nov 2026 09:00:00 +0000'),
  h('Received', ' from mail.paypal.com (mail.paypal.com. [198.51.100.9])\r\n        by mx.google.com with ESMTPS id z9;\r\n        Mon, 16 Nov 2026 08:59:00 -0800 (PST)'),
  h('Authentication-Results', FORGED_GMAIL_PASS),
  h('From', ' PayPal <service@paypal.com>'),
];

/** The gateway took the mail in and relayed it to Stalwart, which wrote no results of its own. */
const STALWART_FROM_GATEWAY = ' from gw.filter.example (gw.filter.example [192.0.2.25])\r\n\t(using TLSv1.3 with cipher TLS13_AES_256_GCM_SHA384)\r\n\tby mail.example.org (Stalwart SMTP) with ESMTPS id 3F2A1B9C0E;\r\n\tMon, 16 Nov 2026 09:00:01 +0000';
const GATEWAY_RECEIVED = ' from mail.client.example (mail.client.example [198.51.100.7])\r\n\tby gw.filter.example (Postfix) with ESMTPS id 4XyZ12;\r\n\tMon, 16 Nov 2026 09:00:00 +0000 (UTC)';
const GATEWAY_PASS = ' gw.filter.example; spf=pass smtp.mailfrom=anna@client.example; dkim=none; dmarc=pass header.from=client.example';
const GATEWAY_FAIL = ' gw.filter.example; spf=fail smtp.mailfrom=paypal.com; dmarc=fail (p=REJECT) header.from=paypal.com';
const viaGateway = (results: string, from = ' Anna <anna@client.example>'): Header[] => [
  h('Received', STALWART_FROM_GATEWAY),
  h('Received-SPF', ' pass (mail.example.org: domain of srs.filter.example designates 192.0.2.25 as permitted sender)'),
  h('Received', GATEWAY_RECEIVED),
  h('Authentication-Results', results),
  h('From', from),
];
/** A sender writing the gateway's header below another relay outside the list. */
const forgedGatewayBelowRelay: Header[] = [
  h('Received', STALWART_FROM_GATEWAY.replace(/gw\.filter\.example/g, 'relay.other.example')),
  h('Received', ' from attacker.example (attacker.example [203.0.113.5])\r\n\tby relay.other.example (Postfix) with ESMTP id 77AA;\r\n\tMon, 16 Nov 2026 09:00:00 +0000'),
  h('Received', GATEWAY_RECEIVED),
  h('Authentication-Results', GATEWAY_PASS.replace('anna@client.example', 'service@paypal.com').replace('client.example', 'paypal.com')),
  h('From', ' PayPal <service@paypal.com>'),
];
/** Stalwart wrote its own results for what the gateway relayed: those come first. */
const gatewayWithStalwartResults: Header[] = [
  h('Received', STALWART_FROM_GATEWAY),
  h('Authentication-Results', ' mail.example.org; spf=pass smtp.mailfrom=srs0=ab=cd=client.example=anna@srs.filter.example; dmarc=fail header.from=paypal.com'),
  h('Received', GATEWAY_RECEIVED),
  h('Authentication-Results', GATEWAY_PASS),
  h('From', ' PayPal <service@paypal.com>'),
];

/** A GMX mailbox read through legacy-proxy: GMX writes its results above its own Received line. */
const GMX = ['gmx.net', 'mx-ha.gmx.net'];
const GMX_RECEIVED = ' from mail.client.example ([198.51.100.7]) by mx-ha.gmx.net (mxgmx007\r\n [212.227.15.9]) with ESMTPS (Nemesis) id 1MxYz2-1a2B3c4D5e-00AbCd for\r\n <reader@gmx.net>; Mon, 16 Nov 2026 10:00:00 +0100';
const GMX_PASS = ' gmx.net; dkim=pass header.i=@client.example header.s=s1 header.b=abc;\r\n spf=pass smtp.mailfrom=anna@client.example; dmarc=pass (p=REJECT) header.from=client.example';
const GMX_FAIL = ' gmx.net; spf=fail smtp.mailfrom=service@paypal.com; dmarc=fail (p=REJECT) header.from=paypal.com';
const gmxHeaders = (results: string, from = ' Anna <anna@client.example>'): Header[] => [
  h('Return-Path', ' <anna@client.example>'),
  h('Authentication-Results', results),
  h('Received', GMX_RECEIVED),
  h('From', from),
];

describe('the setting', () => {
  it('takes comma- or space-separated hostnames, in any case, and nothing else', () => {
    expect(parseTrustedAuthservIds(' MX.Google.com., gw.filter.example  mx.google.com,*.example.com,,mail_x.example')).toEqual(['mx.google.com', 'gw.filter.example']);
    expect(parseTrustedAuthservIds(['mx.google.com', 7])).toEqual(['mx.google.com']);
    expect(parseTrustedAuthservIds(undefined)).toEqual([]);
    expect(invalidTrustedAuthservIds('mx.google.com, *.example.com,')).toEqual(['*.example.com']);
  });
});

describe('a trusted server\'s results', () => {
  it('count for a Gmail mailbox behind legacy-proxy once mx.google.com is listed', () => {
    expect(authenticationResultsOnReceipt(gmailHeaders(GMAIL_PASS), [])).toBe(false);
    expect(authenticationResultsOnReceipt(gmailHeaders(GMAIL_PASS), GMAIL)).toBe(true);
    expect(authenticationResultsOnReceipt(gmailHeaders(GMAIL_PASS), ['MX.google.com'.toLowerCase(), 'other.example'])).toBe(true);
  });

  it('count for a gateway that relays to Stalwart, below Stalwart\'s own line', () => {
    expect(authenticationResultsOnReceipt(viaGateway(GATEWAY_PASS), [])).toBe(false);
    expect(authenticationResultsOnReceipt(viaGateway(GATEWAY_PASS), GATEWAY)).toBe(true);
    // A gateway whose milter writes its header above its own Received line.
    const milterOrder = [h('Received', STALWART_FROM_GATEWAY), h('Authentication-Results', GATEWAY_PASS), h('Received', GATEWAY_RECEIVED)];
    expect(authenticationResultsOnReceipt(milterOrder, GATEWAY)).toBe(true);
  });

  it('do not count with a listed name below a server outside the list', () => {
    expect(authenticationResultsOnReceipt(forgedBelowUntrusted, GMAIL)).toBe(false);
    expect(authenticationResultsOnReceipt(forgedGatewayBelowRelay, GATEWAY)).toBe(false);
    // Listing the relay as well vouches for it.
    expect(authenticationResultsOnReceipt(forgedGatewayBelowRelay, [...GATEWAY, 'relay.other.example'])).toBe(true);
  });

  it('do not count when a listed name only shows up in a comment of an outside server\'s line', () => {
    for (const line of [
      ' from attacker.example (by gw.filter.example) by relay.other.example with ESMTP id 1; Mon, 16 Nov 2026 09:00:00 +0000',
      ' from attacker.example (attacker.example [203.0.113.5] (AS64500 hosted by gw.filter.example GmbH, DE)) by relay.other.example with ESMTP id 1; Mon, 16 Nov 2026 09:00:00 +0000',
      ' from attacker.example by relay.other.example with ESMTP id 1; Mon, 16 Nov 2026 09:00:00 +0000 (by gw.filter.example)',
    ]) {
      expect(authenticationResultsOnReceipt([h('Received', line), h('Authentication-Results', GATEWAY_PASS)], GATEWAY)).toBe(false);
    }
  });

  it('do not count below an authenticated submission, or with no Received line above them', () => {
    const submitted = [h('Received', ' from [198.51.100.7] by mx.google.com with ESMTPSA id 1; Mon, 16 Nov 2026 09:00:00 +0000'), h('Authentication-Results', FORGED_GMAIL_PASS)];
    expect(authenticationResultsOnReceipt(submitted, GMAIL)).toBe(false);
    expect(authenticationResultsOnReceipt([h('Authentication-Results', GMAIL_PASS)], GMAIL)).toBe(false);
  });

  it('count above a listed server\'s own Received line, as GMX writes them', () => {
    expect(authenticationResultsOnReceipt(gmxHeaders(GMX_PASS), GMX)).toBe(true);
    // The results and the server that took the message in must both be listed.
    expect(authenticationResultsOnReceipt(gmxHeaders(GMX_PASS), [])).toBe(false);
    expect(authenticationResultsOnReceipt(gmxHeaders(GMX_PASS), ['gmx.net'])).toBe(false);
    expect(authenticationResultsOnReceipt(gmxHeaders(GMX_PASS), ['mx-ha.gmx.net'])).toBe(false);
  });

  it('do not count with nothing above them unless a listed server took the message in right below', () => {
    const top = (below: string) => [h('Authentication-Results', GMX_PASS), h('Received', below), h('From', ' Anna <anna@client.example>')];
    // A host outside the list, a listed name only in a comment, a submission, a handoff without `from`.
    expect(authenticationResultsOnReceipt(top(' from attacker.example by relay.other.example with ESMTP id 1; Mon, 16 Nov 2026 09:00:00 +0000'), GMX)).toBe(false);
    expect(authenticationResultsOnReceipt(top(' from attacker.example (by mx-ha.gmx.net) by relay.other.example with ESMTP id 1; Mon, 16 Nov 2026 09:00:00 +0000'), GMX)).toBe(false);
    expect(authenticationResultsOnReceipt(top(' from [198.51.100.7] by mx-ha.gmx.net with ESMTPSA id 1; Mon, 16 Nov 2026 09:00:00 +0000'), GMX)).toBe(false);
    expect(authenticationResultsOnReceipt(top(' by mx-ha.gmx.net with SMTP id 1; Mon, 16 Nov 2026 09:00:00 +0000'), GMX)).toBe(false);
    // Results of a server outside the list above a listed server's line.
    expect(authenticationResultsOnReceipt([h('Authentication-Results', ' relay.other.example; dmarc=pass header.from=paypal.com'), h('Received', GMX_RECEIVED)], [...GMX, 'other.example'])).toBe(false);
    // Only the line right below counts: a listed line further down is no receipt for these results.
    expect(authenticationResultsOnReceipt([h('Authentication-Results', GMX_PASS), h('Received', ' from attacker.example by relay.other.example with ESMTP id 1; Mon, 16 Nov 2026 09:00:00 +0000'), h('Received', GMX_RECEIVED)], GMX)).toBe(false);
  });

  it('only count as the topmost header', () => {
    // Stalwart's own results come first and decide; the gateway's below them don't count.
    expect(authenticationResultsOnReceipt(gatewayWithStalwartResults, GATEWAY)).toBe(true);
    // A listed name below a header from a server outside the list.
    const below = [h('Received', ' by 2002:a05::1 with SMTP id 1; Mon, 16 Nov 2026 09:00:01 +0000'), h('Authentication-Results', ' mx.other.example; spf=none'), h('Authentication-Results', GMAIL_PASS)];
    expect(authenticationResultsOnReceipt(below, GMAIL)).toBe(false);
  });

  it('do the same from a list row\'s lines', () => {
    const row = (headers: Header[], trusted: string[]) => topAuthenticationResultsOnReceipt(values(headers, 'Received'), values(headers, 'Authentication-Results'), trusted);
    expect(row(viaGateway(GATEWAY_PASS), GATEWAY)).toBe(true);
    expect(row(viaGateway(GATEWAY_PASS), [])).toBe(false);
    expect(row(gmailHeaders(GMAIL_PASS), GMAIL)).toBe(true);
    expect(row(forgedBelowUntrusted, GMAIL)).toBe(false);
    expect(row(gmxHeaders(GMX_PASS), GMX)).toBe(true);
    expect(row(gmxHeaders(GMX_PASS), ['gmx.net'])).toBe(false);
  });
});

/** A server holding these messages; Email/get hands out only the properties asked for. */
function client(messages: Record<string, { headers: Header[]; from: string; keywords?: Record<string, boolean> }>) {
  const records = Object.fromEntries(Object.entries(messages).map(([id, m]) => [id, {
    id, threadId: `t-${id}`, mailboxIds: { inbox: true }, keywords: m.keywords ?? {}, size: 100, blobId: `blob-${id}`,
    receivedAt: '2026-11-16T09:00:00Z', subject: 'Hello', preview: 'Hello', hasAttachment: false,
    from: [{ email: m.from }], to: [{ email: 'reader@example.org' }],
    headers: m.headers,
    'header:Authentication-Results:all': values(m.headers, 'Authentication-Results'),
    'header:Received:all': values(m.headers, 'Received'),
    htmlBody: [], textBody: [{ partId: '1', type: 'text/plain' }], bodyValues: { 1: { value: 'Hello', isTruncated: false } },
  }]));
  const c = new JMAPClient('https://jmap.example.com', 'reader@example.org', 'pass');
  Object.assign(c, { accountId: 'me', capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 50 } } });
  vi.spyOn(c as unknown as { request: (calls: Call[]) => Promise<unknown> }, 'request').mockImplementation(async (calls: Call[]) => ({
    methodResponses: calls.map(([method, args, id]) => {
      if (method !== 'Email/get') return [method, {}, id];
      const properties = args.properties as string[];
      const list = (args.ids as string[]).map((i) => Object.fromEntries(properties.filter((p) => p in records[i]).map((p) => [p, (records[i] as Record<string, unknown>)[p]])));
      return [method, { list }, id];
    }),
  }));
  return c;
}

const MESSAGES = {
  gmail: { headers: gmailHeaders(GMAIL_PASS), from: 'anna@client.example' },
  gmailForgery: { headers: gmailForgery, from: 'service@paypal.com' },
  forged: { headers: forgedBelowUntrusted, from: 'service@paypal.com' },
  gateway: { headers: viaGateway(GATEWAY_PASS), from: 'anna@client.example' },
  gatewayFail: { headers: viaGateway(GATEWAY_FAIL, ' PayPal <service@paypal.com>'), from: 'service@paypal.com' },
  imported: { headers: viaGateway(GATEWAY_FAIL, ' PayPal <service@paypal.com>'), from: 'service@paypal.com', keywords: { $imported: true } },
  gmx: { headers: gmxHeaders(GMX_PASS), from: 'anna@client.example' },
  gmxFail: { headers: gmxHeaders(GMX_FAIL, ' PayPal <service@paypal.com>'), from: 'service@paypal.com' },
};

const warning = (email: Email | undefined) => renderHook(() => useSenderWarning(email)).result.current;

afterEach(() => setTrustedAuthservIds([]));

describe('with trusted mail servers configured', () => {
  it('an opened message gets the listed server\'s verdict, and none without the list', async () => {
    const before = (await client(MESSAGES).getEmail('gatewayFail'))!;
    expect(before.authenticationResults).toBeUndefined();
    expect(warning(before)).toBeUndefined();

    setTrustedAuthservIds('gw.filter.example, mx.google.com');
    const c = client(MESSAGES);
    const failed = (await c.getEmail('gatewayFail'))!;
    expect(failed.authenticationResultsOnReceipt).toBe(true);
    expect(getSenderVerification(failed.authenticationResults, 'service@paypal.com')).toMatchObject({ status: 'failed' });
    expect(warning(failed)).toBe('failed_label');
    const gmail = (await c.getEmail('gmail'))!;
    expect(gmail.authenticationResults).toMatchObject({ dmarc: { result: 'pass' } });
    expect(warning(gmail)).toBeUndefined();
  });

  it('Gmail\'s own failing header decides over a forged pass below it', async () => {
    setTrustedAuthservIds(GMAIL);
    const email = (await client(MESSAGES).getEmail('gmailForgery'))!;
    expect(getSenderVerification(email.authenticationResults, 'service@paypal.com')).toMatchObject({ status: 'failed' });
  });

  it('a forged listed name below a server outside the list gives no verdict', async () => {
    setTrustedAuthservIds(GMAIL);
    const c = client(MESSAGES);
    const email = (await c.getEmail('forged'))!;
    expect(email.authenticationResults).toBeUndefined();
    expect(email.authenticationResultsIgnored).toBe(true);
    const [row] = await c.getSomeEmails(['forged']);
    expect(row.authenticationResults).toBeUndefined();
  });

  it('list rows get the listed server\'s verdict', async () => {
    setTrustedAuthservIds(GATEWAY);
    const rows = await client(MESSAGES).getSomeEmails(['gateway', 'gatewayFail']);
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(warning(byId.gateway)).toBeUndefined();
    expect(byId.gateway.authenticationResults).toMatchObject({ dmarc: { result: 'pass' } });
    expect(warning(byId.gatewayFail)).toBe('failed_label');
  });

  it('a GMX mailbox gets GMX\'s verdict when opened and in the list', async () => {
    setTrustedAuthservIds('gmx.net mx-ha.gmx.net');
    const c = client(MESSAGES);
    const failed = (await c.getEmail('gmxFail'))!;
    expect(failed.authenticationResultsOnReceipt).toBe(true);
    expect(warning(failed)).toBe('failed_label');
    const passed = (await c.getEmail('gmx'))!;
    expect(passed.authenticationResults).toMatchObject({ dmarc: { result: 'pass' } });
    const rows = await c.getSomeEmails(['gmxFail']);
    expect(warning(rows[0])).toBe('failed_label');
  });

  it('a message from an imported file still gets no verdict', async () => {
    setTrustedAuthservIds(GATEWAY);
    const c = client(MESSAGES);
    const email = (await c.getEmail('imported'))!;
    expect(email.authenticationResults).toBeUndefined();
    expect(warning(email)).toBeUndefined();
    const [row] = await c.getSomeEmails(['imported']);
    expect(row.authenticationResults).toBeUndefined();
    expect(warning(row)).toBeUndefined();
  });
});
