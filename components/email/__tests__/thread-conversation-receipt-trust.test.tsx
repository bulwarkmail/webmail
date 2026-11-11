// Trust needs evidence. A pass in a message's Authentication-Results earns the sender logo, a
// trusted invitation or a booking card only when the message shows the results were written on
// receipt: the flag the full fetch sets, or the headers in message order. Every way a message is
// loaded is checked here through the real JMAPClient with a faked server that answers only the
// properties it is asked for:
// - the conversation view (getThreadEmails: headers in order, no flag), as the phone layout shows a thread
// - list rows and the Pro conversation list (getSomeEmails: the list properties, no headers)
// - search results (advancedSearchEmails: the list properties)
// - the reader, a prefetched message, one opened from a notification or in a pop-out (getEmail)
// - a message file opened in a window (parseEmailBlob): never received by this server
// - the demo, whose fixtures are the mail its server received
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import { brandIndicatorDomain } from '@/lib/email-headers';
import { getInvitationTrustAssessment } from '@/lib/calendar-invitation';
import { getStructuredMailTrust } from '@/lib/structured-mail/trust';
import { useBrandDomain } from '@/hooks/use-brand-domain';
import { DemoJMAPClient } from '@/lib/demo/demo-client';
import { getDemoData } from '@/lib/demo/demo-data';
import type { CalendarEvent, Email } from '@/lib/jmap/types';

type Call = [string, Record<string, unknown>, string];
type Header = { name: string; value: string };

const RESULTS = ' mail.example.org; dkim=pass header.d=airline.example header.s=s1; spf=pass smtp.mailfrom=bounce@airline.example; dmarc=pass header.from=airline.example';
const RECEIVED = ' from mx1.airline.example (mx1.airline.example [203.0.113.7]) by mail.example.org (Stalwart SMTP) with ESMTPS id 3F2A1B9C0D; Mon, 2 Nov 2026 09:00:00 +0000';

/** As a message handed in on the same server is stored: the server's two lines, then the sender's own text. */
const loneResults: Header[] = [
  { name: 'Delivered-To', value: ' reader@example.org' },
  { name: 'X-Spam-Status', value: ' No' },
  { name: 'Authentication-Results', value: RESULTS },
  { name: 'From', value: ' "Example Air" <bookings@airline.example>' },
];
const onReceipt: Header[] = [
  { name: 'Delivered-To', value: ' reader@example.org' },
  { name: 'X-Spam-Status', value: ' No' },
  { name: 'Received', value: RECEIVED },
  { name: 'Authentication-Results', value: RESULTS },
  { name: 'From', value: ' "Example Air" <bookings@airline.example>' },
];

/** A stored message as the server holds it; Email/get hands out only the properties asked for. */
function stored(id: string, headers: Header[]) {
  return {
    id, threadId: 't1', mailboxIds: { inbox: true }, keywords: {}, size: 100, receivedAt: `2026-11-02T09:0${id === 'm1' ? 0 : 1}:00Z`,
    subject: 'Your flight', from: [{ name: 'Example Air', email: 'bookings@airline.example' }], to: [{ email: 'reader@example.org' }],
    preview: 'Your flight', hasAttachment: false, blobId: `blob-${id}`,
    headers,
    'header:Authentication-Results:all': headers.filter((h) => h.name === 'Authentication-Results').map((h) => h.value),
    htmlBody: [{ partId: '1', type: 'text/html' }], textBody: [], bodyValues: { '1': { value: '<p>Your flight</p>', isTruncated: false } },
  };
}

function pick(record: Record<string, unknown>, properties: unknown): Record<string, unknown> {
  if (!Array.isArray(properties)) return record;
  return Object.fromEntries(properties.filter((p): p is string => typeof p === 'string' && p in record).map((p) => [p, record[p]]));
}

/** m1 carries the lone header, m2 the one written on receipt. */
function client() {
  const messages: Record<string, Record<string, unknown>> = { m1: stored('m1', loneResults), m2: stored('m2', onReceipt) };
  const c = new JMAPClient('https://jmap.example.com', 'reader@example.org', 'pass');
  Object.assign(c, { accountId: 'me', capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 50 } } });
  vi.spyOn(c as unknown as { request: (calls: Call[]) => Promise<unknown> }, 'request').mockImplementation(async (calls: Call[]) => ({
    methodResponses: calls.map(([method, args, id]) => {
      if (method === 'Thread/get') return [method, { list: [{ id: 't1', emailIds: ['m1', 'm2'] }] }, id];
      if (method === 'Email/query') return [method, { ids: ['m1', 'm2'], total: 2, position: 0 }, id];
      if (method === 'Email/get') {
        const ids = Array.isArray(args.ids) ? args.ids as string[] : Object.keys(messages);
        return [method, { list: ids.filter((i) => messages[i]).map((i) => pick(messages[i], args.properties)) }, id];
      }
      if (method === 'Email/parse') {
        const blobIds = args.blobIds as string[];
        return [method, { parsed: Object.fromEntries(blobIds.map((b) => [b, pick(messages[b === 'blob-m1' ? 'm1' : 'm2'], args.properties)])) }, id];
      }
      return [method, {}, id];
    }),
  }));
  return c;
}

const byId = (emails: Email[]) => ({ lone: emails.find((e) => e.id === 'm1')!, received: emails.find((e) => e.id === 'm2')! });

const invitation = {
  participants: {
    org: { '@type': 'Participant', name: 'Example Air', email: 'bookings@airline.example', roles: { owner: true } },
  },
} as unknown as Partial<CalendarEvent>;

const logo = (email: Email) => renderHook(() => useBrandDomain(email)).result.current;
const trusted = (email: Email) => getInvitationTrustAssessment(invitation, email, 'request').level === 'trusted';

describe('a message of a conversation, as getThreadEmails returns it', () => {
  it('carries its headers in order and the parsed results (the shape the cases below build on)', async () => {
    const { lone, received } = byId(await client().getThreadEmails('t1'));
    expect(Array.isArray(lone.headers)).toBe(true);
    expect(lone.authenticationResults).toMatchObject({ dmarc: { result: 'pass' } });
    expect(received.authenticationResults).toMatchObject({ dmarc: { result: 'pass' } });
    // The booking cards already refuse the lone header from this shape, and take the one on receipt.
    expect(getStructuredMailTrust(lone)).toEqual({ trusted: false, reason: 'not_written_on_receipt' });
    expect(getStructuredMailTrust(received)).toEqual({ trusted: true });
  });

  it('earns no sender logo for a results header with no receipt line above it', async () => {
    const { lone, received } = byId(await client().getThreadEmails('t1'));
    // Control: the message whose header was written on receipt keeps its logo.
    expect(logo(received)).toBe('airline.example');
    expect(brandIndicatorDomain(received)).toBe('airline.example');
    // The conversation view's sender logo (thread-conversation-view.tsx: useBrandDomain(email)).
    expect(logo(lone)).toBeUndefined();
    expect(brandIndicatorDomain(lone)).toBeUndefined();
  });

  it('is no trusted invitation with a results header with no receipt line above it', async () => {
    const { lone, received } = byId(await client().getThreadEmails('t1'));
    expect(trusted(received)).toBe(true);
    expect(trusted(lone)).toBe(false);
  });
});

describe('a message loaded without anything that shows its results were written on receipt', () => {
  it('earns nothing as a list row (getSomeEmails: rows, the Pro conversation list, new-mail notices)', async () => {
    const { lone, received } = byId(await client().getSomeEmails(['m1', 'm2']));
    for (const row of [lone, received]) {
      expect(row.headers).toBeUndefined();
      expect(row.authenticationResults).toMatchObject({ dmarc: { result: 'pass' } });
      expect(logo(row)).toBeUndefined();
      expect(trusted(row)).toBe(false);
      expect(getStructuredMailTrust(row).trusted).toBe(false);
    }
  });

  it('earns nothing as a search result (advancedSearchEmails)', async () => {
    const result = await client().advancedSearchEmails({ text: 'flight' });
    const { lone, received } = byId(result.emails);
    for (const hit of [lone, received]) {
      expect(hit.authenticationResults).toMatchObject({ dmarc: { result: 'pass' } });
      expect(logo(hit)).toBeUndefined();
      expect(trusted(hit)).toBe(false);
    }
  });

  it('earns nothing as a message file opened in a window (parseEmailBlob), whatever its own lines say', async () => {
    const opened = (await client().parseEmailBlob('blob-m2'))!;
    expect(opened.authenticationResults).toMatchObject({ dmarc: { result: 'pass' } });
    expect(logo(opened)).toBeUndefined();
    expect(trusted(opened)).toBe(false);
    expect(getStructuredMailTrust(opened).trusted).toBe(false);
  });
});

describe('a message opened in full', () => {
  it('keeps the answer the reader, a prefetch, a notification or a pop-out get from getEmail', async () => {
    const c = client();
    const lone = (await c.getEmail('m1'))!;
    const received = (await c.getEmail('m2'))!;
    expect(lone.authenticationResultsOnReceipt).toBe(false);
    expect(received.authenticationResultsOnReceipt).toBe(true);
    expect(logo(lone)).toBeUndefined();
    expect(trusted(lone)).toBe(false);
    expect(logo(received)).toBe('airline.example');
    expect(trusted(received)).toBe(true);
    expect(getStructuredMailTrust(received)).toEqual({ trusted: true });
  });

  it('keeps the logo of the demo mail the demo server received', async () => {
    const demo = new DemoJMAPClient('work');
    const fixture = getDemoData('work').emails.find((e) => {
      const header = (e.headers as Record<string, string> | undefined)?.['Authentication-Results'];
      return typeof header === 'string' && header.includes('dmarc=pass') && e.authenticationResultsOnReceipt === undefined;
    })!;
    expect(fixture).toBeDefined();
    const email = (await demo.getEmail(fixture.id))!;
    expect(logo(email)).toBe(fixture.from![0].email!.split('@')[1].toLowerCase());
  });
});
