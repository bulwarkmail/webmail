// A receiving server writes "Received" and then "Authentication-Results" above a message it takes
// from outside. A results header with no receipt line above it was not written on receipt, and the
// booking cards already refuse to build on it (lib/structured-mail/trust.ts). The invitation banner
// and the sender logo must not be less careful: with the message's
// `authenticationResultsOnReceipt` flag false, a pass in that header counts for nothing.
//
// Trust needs evidence: where neither the flag nor the headers in message order show the results
// were written on receipt (a list row, a search result), a pass counts for nothing either.
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { authenticationResultsOnReceipt, brandIndicatorDomain, parseAuthenticationResults } from '@/lib/email-headers';
import { getInvitationTrustAssessment } from '@/lib/calendar-invitation';
import { useBrandDomain } from '@/hooks/use-brand-domain';
import type { CalendarEvent, Email } from '@/lib/jmap/types';

const RESULTS = 'mail.example.org; dkim=pass header.d=airline.example header.s=s1; spf=pass smtp.mailfrom=bounce@airline.example; dmarc=pass header.from=airline.example';
const RECEIVED = 'from mx1.airline.example (mx1.airline.example [203.0.113.7]) by mail.example.org (Stalwart SMTP) with ESMTPS id 3F2A1B9C0D; Mon, 2 Nov 2026 09:00:00 +0000';

type Header = { name: string; value: string };

/** As Email/get returns them, top first. */
const loneResults: Header[] = [
  { name: 'Delivered-To', value: ' reader@example.org' },
  { name: 'X-Spam-Status', value: ' No' },
  { name: 'Authentication-Results', value: ` ${RESULTS}` },
  { name: 'From', value: ' "Example Air" <bookings@airline.example>' },
];
const onReceipt: Header[] = [
  { name: 'Received', value: ` ${RECEIVED}` },
  { name: 'Authentication-Results', value: ` ${RESULTS}` },
  { name: 'From', value: ' "Example Air" <bookings@airline.example>' },
];
/** Below a hop that records an authenticated submission: the client's own text. */
const belowSubmission = (protocol: string): Header[] => [
  { name: 'Received', value: ` from client.example (client.example [198.51.100.4]) by mail.example.org (Stalwart SMTP) with ${protocol} id 1A; Mon, 2 Nov 2026 09:00:00 +0000` },
  { name: 'Authentication-Results', value: ` ${RESULTS}` },
  { name: 'From', value: ' "Example Air" <bookings@airline.example>' },
];
/** Two results headers: only the lower one has a receipt line above it. */
const receiptBelowTopmost: Header[] = [
  { name: 'Authentication-Results', value: ` ${RESULTS}` },
  { name: 'Received', value: ` ${RECEIVED}` },
  { name: 'Authentication-Results', value: ` ${RESULTS}` },
  { name: 'From', value: ' "Example Air" <bookings@airline.example>' },
];

function message(headers: Header[], from = 'bookings@airline.example', results = RESULTS) {
  return {
    from: [{ name: 'Sender', email: from }],
    authenticationResults: parseAuthenticationResults(results),
    authenticationResultsOnReceipt: authenticationResultsOnReceipt(headers),
  } as unknown as Email;
}

const invitation = {
  participants: {
    org: { '@type': 'Participant', name: 'Example Air', email: 'bookings@airline.example', roles: { owner: true } },
  },
} as unknown as Partial<CalendarEvent>;

describe('a results header that was not written on receipt', () => {
  it('is recognised as such', () => {
    expect(authenticationResultsOnReceipt(loneResults)).toBe(false);
    expect(authenticationResultsOnReceipt(onReceipt)).toBe(true);
  });

  it('does not make an invitation trusted', () => {
    const assessment = getInvitationTrustAssessment(invitation, message(loneResults), 'request');
    expect(assessment.level).not.toBe('trusted');
  });

  it('does not earn the sender logo', () => {
    expect(brandIndicatorDomain(message(loneResults))).toBeUndefined();
  });

  it.each(['ESMTPA', 'ESMTPSA'])('counts for nothing below a %s submission hop', (protocol) => {
    const email = message(belowSubmission(protocol));
    expect(email.authenticationResultsOnReceipt).toBe(false);
    expect(getInvitationTrustAssessment(invitation, email, 'request').level).not.toBe('trusted');
    expect(brandIndicatorDomain(email)).toBeUndefined();
  });

  it('counts for nothing when only a lower results header has a receipt line above it', () => {
    const email = message(receiptBelowTopmost);
    expect(email.authenticationResultsOnReceipt).toBe(false);
    expect(getInvitationTrustAssessment(invitation, email, 'request').level).not.toBe('trusted');
    expect(brandIndicatorDomain(email)).toBeUndefined();
  });

  it("does not make an attendee's reply or counter trusted", () => {
    const meeting = {
      participants: {
        me: { '@type': 'Participant', email: 'reader@example.org', roles: { owner: true }, participationStatus: 'accepted' },
        guest: { '@type': 'Participant', email: 'bookings@airline.example', roles: { attendee: true }, participationStatus: 'accepted' },
      },
    } as unknown as Partial<CalendarEvent>;
    for (const method of ['reply', 'counter'] as const) {
      expect(getInvitationTrustAssessment(meeting, message(loneResults), method).level).not.toBe('trusted');
      // Control: the same answer that arrived from outside.
      expect(getInvitationTrustAssessment(meeting, message(onReceipt), method).level).toBe('trusted');
    }
  });

  it("does not make mail of the user's own domain count as handed in on the same server", () => {
    const own = message(loneResults, 'colleague@example.org', 'mail.example.org; dkim=pass header.d=example.org; spf=pass smtp.mailfrom=example.org; dmarc=pass header.from=example.org');
    const meeting = {
      participants: { org: { '@type': 'Participant', email: 'colleague@example.org', roles: { owner: true } } },
    } as unknown as Partial<CalendarEvent>;
    expect(getInvitationTrustAssessment(meeting, own, 'request', ['reader@example.org'], ['example.org']).level).not.toBe('trusted');
    expect(brandIndicatorDomain(own, ['example.org'])).toBeUndefined();
    // Control: without any results header it is still internal mail.
    const internal = { from: own.from } as Email;
    expect(getInvitationTrustAssessment(meeting, internal, 'request', ['reader@example.org'], ['example.org']).level).toBe('trusted');
    expect(brandIndicatorDomain(internal, ['example.org'])).toBe('example.org');
  });

  it('reaches the logo of an open message through useBrandDomain', () => {
    const { result } = renderHook(() => useBrandDomain(message(loneResults)));
    expect(result.current).toBeUndefined();
    const { result: control } = renderHook(() => useBrandDomain(message(onReceipt)));
    expect(control.current).toBe('airline.example');
  });
});

// Controls: mail that did arrive from outside keeps both.
describe('a results header written on receipt', () => {
  it("still makes the organizer's invitation trusted", () => {
    expect(getInvitationTrustAssessment(invitation, message(onReceipt), 'request').level).toBe('trusted');
  });

  it('still earns the sender logo', () => {
    expect(brandIndicatorDomain(message(onReceipt))).toBe('airline.example');
  });

  it('earns nothing where nothing shows it was written on receipt (a list row)', () => {
    const row = { from: [{ email: 'bookings@airline.example' }], authenticationResults: parseAuthenticationResults(RESULTS) } as unknown as Email;
    expect(getInvitationTrustAssessment(invitation, row, 'request').level).not.toBe('trusted');
    expect(brandIndicatorDomain(row)).toBeUndefined();
  });
});
