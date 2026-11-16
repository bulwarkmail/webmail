// The sender check acts only on Authentication-Results the user's own receiving server wrote
// (RFC 8601 sections 5 and 7.1, #1740). Stalwart writes its Received line on top of a message it
// takes in, "by <hostname> (Stalwart SMTP)", and its Authentication-Results right below it with
// the same hostname. Any other header, from the sender's own servers, from a server that took the
// mail in before it was synced over IMAP, or written by the sender, gives no verdict: no warning,
// and no pass either. Neither does any header of a message from an imported file.
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import {
  authenticationResultsOnReceipt,
  authservId,
  brandIndicatorDomain,
  getSenderVerification,
  topAuthenticationResultsOnReceipt,
} from '@/lib/email-headers';
import { getInvitationTrustAssessment } from '@/lib/calendar-invitation';
import { getStructuredMailTrust } from '@/lib/structured-mail/trust';
import { useSenderWarning } from '@/hooks/use-sender-warning';
import type { CalendarEvent, Email } from '@/lib/jmap/types';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

type Header = { name: string; value: string };
type Call = [string, Record<string, unknown>, string];

/** Stalwart taking the message in from outside. */
const STALWART = ' from mail.shop.example (mail.shop.example [192.0.2.1])\r\n\t(using TLSv1.3 with cipher TLS13_AES_256_GCM_SHA384)\r\n\tby mail.example.org (Stalwart SMTP) with ESMTPS id 3F2A1B9C0D;\r\n\tMon, 16 Nov 2026 09:00:00 +0000';
/** A cPanel host (Exim, writes no Authentication-Results) that took the mail in before imapsync copied it over. */
const CPANEL = ' from mail-db8eur05on2070.outbound.protection.outlook.com ([40.107.20.70]:12345)\r\n\tby server1.cpanel-host.example with esmtps (TLS1.2) (Exim 4.98)\r\n\tid 1abc-000; Mon, 16 Nov 2026 09:00:00 +0000';
/** Microsoft 365's internal hops, below which it writes its own header before signing the mail. */
const MS_HOP = ' from AM0PR02MB1234.eurprd02.prod.outlook.com (2603:10a6:208::1) by AM0PR02MB5678.eurprd02.prod.outlook.com with Microsoft SMTP Server; Mon, 16 Nov 2026 08:59:59 +0000';
const MS_RESULTS = ' mx.microsoft.com 1; dkim=none (message not signed)\r\n header.d=none;dmarc=none action=none header.from=client.example;';
const MS_RESULTS_NO_ID = ' dkim=none (message not signed)\r\n header.d=none;dmarc=none action=none header.from=client.example;';

const OWN_PASS = ' mail.example.org;\r\n\tdkim=pass header.d=client.example header.s=s1;\r\n\tspf=pass smtp.mailfrom=anna@client.example;\r\n\tdmarc=pass header.from=client.example';
const OWN_FAIL = ' mail.example.org;\r\n\tdkim=none;\r\n\tspf=fail smtp.mailfrom=paypal.com;\r\n\tdmarc=fail (p=REJECT) header.from=paypal.com';
const OWN_UNVERIFIED = ' mail.example.org;\r\n\tspf=pass smtp.mailfrom=bounce@bulk-sender.example;\r\n\tdmarc=none header.from=paypal.com';
const FORGED_PASS = ' mx.example.net; spf=pass smtp.mailfrom=paypal.com;\r\n dkim=pass header.d=paypal.com; dmarc=pass (p=REJECT) header.from=paypal.com';

const h = (name: string, value: string): Header => ({ name, value });

/** Genuine mail from a Microsoft 365 tenant, received by cPanel and synced in (#1740). */
const syncedFromM365: Header[] = [
  h('Received', CPANEL),
  h('ARC-Authentication-Results', ' i=1; mx.microsoft.com 1; spf=pass smtp.mailfrom=client.example; dmarc=pass action=none header.from=client.example; dkim=pass header.d=client.example'),
  h('Received', MS_HOP),
  h('Authentication-Results', MS_RESULTS),
  h('From', ' Anna <anna@client.example>'),
];
const syncedFromM365NoId: Header[] = syncedFromM365.map((x) => (x.value === MS_RESULTS ? h(x.name, MS_RESULTS_NO_ID) : x));
/** A forged pass in mail the receiving server (not Stalwart) wrote no header for. */
const syncedForgery: Header[] = [
  h('Received', ' from attacker.example ([203.0.113.5]) by mx.receiver.example with esmtps'),
  h('Authentication-Results', FORGED_PASS),
  h('From', ' PayPal <service@paypal.com>'),
];
/** The same forgery naming the host that took it in: that host never wrote such a header. */
const syncedForgeryNamingReceiver: Header[] = [
  syncedForgery[0],
  h('Authentication-Results', FORGED_PASS.replace('mx.example.net', 'mx.receiver.example')),
  syncedForgery[2],
];
/** Stalwart received it directly: its own header on top, the sender's forgery below. */
const direct = (results: string, from = ' PayPal <service@paypal.com>'): Header[] => [
  h('Received', STALWART),
  h('Authentication-Results', results),
  h('Received-SPF', ' fail'),
  h('Received', ' from attacker.example by mx.example.net with ESMTP'),
  h('Authentication-Results', FORGED_PASS),
  h('From', from),
];

const values = (headers: Header[], name: string) => headers.filter((x) => x.name === name).map((x) => x.value);

describe('whose Authentication-Results these are', () => {
  it('takes the header Stalwart wrote right below its own Received line', () => {
    expect(authenticationResultsOnReceipt(direct(OWN_FAIL))).toBe(true);
    // A Sieve redirect on the same server adds a second line of its own on top.
    const redirected = [h('Received', ' from localhost (localhost [127.0.0.1])\r\n\tby MAIL.example.org. (Stalwart SMTP) with LMTP id 5;\r\n\tMon, 16 Nov 2026 09:00:01 +0000'), ...direct(OWN_PASS)];
    expect(authenticationResultsOnReceipt(redirected)).toBe(true);
  });

  it('refuses one another server wrote, with or without an authserv-id (#1740)', () => {
    expect(authenticationResultsOnReceipt(syncedFromM365)).toBe(false);
    expect(authenticationResultsOnReceipt(syncedFromM365NoId)).toBe(false);
  });

  it('refuses a forged pass in mail whose receiving server wrote none, whatever host it names', () => {
    expect(authenticationResultsOnReceipt(syncedForgery)).toBe(false);
    expect(authenticationResultsOnReceipt(syncedForgeryNamingReceiver)).toBe(false);
  });

  it('refuses a header for another host right below Stalwart\'s line, or one below another server\'s line', () => {
    expect(authenticationResultsOnReceipt([h('Received', STALWART), h('Authentication-Results', FORGED_PASS)])).toBe(false);
    expect(authenticationResultsOnReceipt([h('Received', STALWART), ...syncedForgery])).toBe(false);
    // Words the sender chose (a HELO name, an envelope address) can't pass for Stalwart's line
    // in another server's: Stalwart's clause ends the line.
    for (const line of [
      ' from evil.example (by mail.example.org (Stalwart SMTP) with ESMTPS id 1) by mx.receiver.example with esmtps id 2; Mon, 16 Nov 2026 09:00:00 +0000',
      ' from [203.0.113.5] by server1.cpanel-host.example with esmtps (Exim 4.98)\r\n\t(envelope-from <"by mail.example.org (Stalwart SMTP) with ESMTPS id 1"@evil.example>)\r\n\tid 1abc-000; Mon, 16 Nov 2026 09:00:00 +0000',
    ]) {
      expect(authenticationResultsOnReceipt([h('Received', line), h('Authentication-Results', OWN_PASS)])).toBe(false);
    }
    // Nor can they take Stalwart's own line from it.
    expect(authenticationResultsOnReceipt([
      h('Received', ' from x.example (by evil.example (Stalwart SMTP) with ESMTPS id 1) (x [203.0.113.5])\r\n\tby mail.example.org (Stalwart SMTP) with ESMTPS id 3F;\r\n\tMon, 16 Nov 2026 09:00:00 +0000'),
      h('Authentication-Results', OWN_FAIL),
    ])).toBe(true);
  });

  it('reads the authserv-id, not a result, from the first part', () => {
    expect(authservId(MS_RESULTS)).toBe('mx.microsoft.com');
    expect(authservId(MS_RESULTS_NO_ID)).toBeUndefined();
    expect(authservId(' Mail.Example.org.; none')).toBe('mail.example.org');
  });

  it('does the same from a list row\'s Received and Authentication-Results lines', () => {
    expect(topAuthenticationResultsOnReceipt(values(direct(OWN_FAIL), 'Received'), values(direct(OWN_FAIL), 'Authentication-Results'))).toBe(true);
    expect(topAuthenticationResultsOnReceipt(values(syncedFromM365, 'Received'), values(syncedFromM365, 'Authentication-Results'))).toBe(false);
    expect(topAuthenticationResultsOnReceipt(values(syncedForgery, 'Received'), values(syncedForgery, 'Authentication-Results'))).toBe(false);
    expect(topAuthenticationResultsOnReceipt([], [OWN_PASS])).toBe(false);
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
  const asked: string[][] = [];
  vi.spyOn(c as unknown as { request: (calls: Call[]) => Promise<unknown> }, 'request').mockImplementation(async (calls: Call[]) => ({
    methodResponses: calls.map(([method, args, id]) => {
      if (method !== 'Email/get') return [method, {}, id];
      const properties = args.properties as string[];
      asked.push(properties);
      const list = (args.ids as string[]).map((i) => Object.fromEntries(properties.filter((p) => p in records[i]).map((p) => [p, (records[i] as Record<string, unknown>)[p]])));
      return [method, { list }, id];
    }),
  }));
  return { c, asked };
}

const MESSAGES = {
  m365: { headers: syncedFromM365, from: 'anna@client.example' },
  m365NoId: { headers: syncedFromM365NoId, from: 'anna@client.example' },
  forgery: { headers: syncedForgery, from: 'service@paypal.com' },
  spoofed: { headers: direct(OWN_FAIL), from: 'service@paypal.com' },
  unverified: { headers: direct(OWN_UNVERIFIED), from: 'service@paypal.com' },
  genuine: { headers: direct(OWN_PASS, ' Anna <anna@client.example>'), from: 'anna@client.example' },
  imported: { headers: direct(OWN_FAIL), from: 'service@paypal.com', keywords: { $imported: true } },
};

const warning = (email: Email | undefined) => renderHook(() => useSenderWarning(email)).result.current;

describe('the list shield', () => {
  it('asks for the Received lines with the results', async () => {
    const { c, asked } = client(MESSAGES);
    await c.getSomeEmails(['m365']);
    expect(asked.some((p) => p.includes('header:Received:all') && p.includes('header:Authentication-Results:all'))).toBe(true);
  });

  it('shows no warning for mail whose only results another server wrote (#1740)', async () => {
    const rows = await client(MESSAGES).c.getSomeEmails(['m365', 'm365NoId', 'forgery']);
    for (const row of rows) {
      expect(row.authenticationResults).toBeUndefined();
      expect(row.authenticationResultsIgnored).toBe(true);
      expect(row).not.toHaveProperty('header:Received:all');
      expect(warning(row)).toBeUndefined();
    }
  });

  it('still warns on mail Stalwart received and found failing or unverified, and not on mail that passed', async () => {
    const rows = await client(MESSAGES).c.getSomeEmails(['spoofed', 'unverified', 'genuine']);
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    // Stalwart's own header on top decides; the forged pass below it changes nothing.
    expect(byId.spoofed.authenticationResults).toMatchObject({ dmarc: { result: 'fail' } });
    expect(warning(byId.spoofed)).toBe('failed_label');
    expect(warning(byId.unverified)).toBe('unverified_label');
    expect(warning(byId.genuine)).toBeUndefined();
  });

  it('shows no warning for a message from an imported file', async () => {
    const [row] = await client(MESSAGES).c.getSomeEmails(['imported']);
    expect(row.authenticationResults).toBeUndefined();
    expect(warning(row)).toBeUndefined();
    // Even with results in hand, from any other source.
    const parsed = (await client(MESSAGES).c.getSomeEmails(['spoofed']))[0];
    expect(warning({ ...parsed, keywords: { $imported: true } })).toBeUndefined();
  });

  it('judges a row without the Received lines (the offline store) by its results, as before', async () => {
    const { c } = client(MESSAGES);
    const request = (c as unknown as { request: (calls: Call[]) => Promise<{ methodResponses: unknown[][] }> }).request;
    vi.mocked(request).mockImplementationOnce(async (calls: Call[]) => ({
      methodResponses: calls.map(([method, , id]) => [method, { list: [{ id: 'm365', keywords: {}, from: [{ email: 'anna@client.example' }], 'header:Authentication-Results:all': values(syncedFromM365, 'Authentication-Results') }] }, id]),
    }));
    const [row] = await c.getSomeEmails(['m365']);
    expect(warning(row)).toBe('unverified_label');
  });
});

const invitation = (email: string) => ({
  participants: { org: { '@type': 'Participant', email, roles: { owner: true } } },
}) as unknown as Partial<CalendarEvent>;

describe('an opened message', () => {
  it('gives a forged pass no notice, no Pass in the details, no logo and no trust', async () => {
    const email = (await client(MESSAGES).c.getEmail('forgery'))!;
    // The viewer's notice and its "Authentication & security" details both read this.
    expect(email.authenticationResults).toBeUndefined();
    expect(getSenderVerification(email.authenticationResults, 'service@paypal.com')).toBeNull();
    expect(brandIndicatorDomain(email)).toBeUndefined();
    expect(getInvitationTrustAssessment(invitation('service@paypal.com'), email, 'request').level).not.toBe('trusted');
    expect(getStructuredMailTrust(email as never).trusted).toBe(false);
  });

  it('gives the sender\'s own header no warning either (#1740)', async () => {
    const email = (await client(MESSAGES).c.getEmail('m365'))!;
    expect(email.authenticationResults).toBeUndefined();
    expect(email.authenticationResultsIgnored).toBe(true);
    expect(warning(email)).toBeUndefined();
  });

  it('keeps the verdict of mail Stalwart received', async () => {
    const { c } = client(MESSAGES);
    const spoofed = (await c.getEmail('spoofed'))!;
    expect(getSenderVerification(spoofed.authenticationResults, 'service@paypal.com')).toMatchObject({ status: 'failed' });
    const genuine = (await c.getEmail('genuine'))!;
    expect(genuine.authenticationResultsOnReceipt).toBe(true);
    expect(genuine.authenticationResults).toMatchObject({ dmarc: { result: 'pass' } });
    expect(getSenderVerification(genuine.authenticationResults, 'anna@client.example')).toBeNull();
  });

  it('gives a message from an imported file no verdict, though Stalwart wrote its lines once', async () => {
    const email = (await client(MESSAGES).c.getEmail('imported'))!;
    expect(email.authenticationResults).toBeUndefined();
    expect(warning(email)).toBeUndefined();
  });

  it('does not take mail with another server\'s results for the organisation\'s own', async () => {
    const forgedColleague = { headers: syncedForgery.map((x) => (x.name === 'From' ? h('From', ' Boss <boss@example.org>') : x)), from: 'boss@example.org' };
    const email = (await client({ boss: forgedColleague }).c.getEmail('boss'))!;
    expect(brandIndicatorDomain(email, ['example.org'])).toBeUndefined();
    expect(getInvitationTrustAssessment(invitation('boss@example.org'), email, 'request', [], ['example.org']).level).not.toBe('trusted');
    // Control: mail handed in on the same server carries no header and still counts as the organisation's.
    expect(brandIndicatorDomain({ from: [{ email: 'boss@example.org' }], keywords: {} }, ['example.org'])).toBe('example.org');
  });
});
