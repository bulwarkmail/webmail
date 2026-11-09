import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAuthenticationResults } from '@/lib/email-headers';
import type { Email, EmailBodyPart } from '@/lib/jmap/types';
import { usePolicyStore } from '@/stores/policy-store';
import { CARD_SOURCES } from '../sources';
import { useStructuredMail } from '../use-structured-mail';

const ld = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const ORDER = { '@context': 'http://schema.org', '@type': 'Order', orderNumber: 'SO-1', merchant: 'Shop' };
const FLIGHT = {
  '@context': 'http://schema.org', '@type': 'FlightReservation', reservationNumber: 'QX7K2M', underName: 'Erika Mustermann',
  reservationFor: {
    '@type': 'Flight', flightNumber: '400', airline: { name: 'Lufthansa', iataCode: 'LH' },
    departureAirport: { iataCode: 'FRA' }, departureTime: '2026-12-01T10:15:00+01:00',
    arrivalAirport: { iataCode: 'JFK' }, arrivalTime: '2026-12-01T13:05:00-05:00',
  },
};
const PASS = 'mx.example.org; dkim=pass header.d=shop.example; spf=pass smtp.mailfrom=bounce@shop.example; dmarc=pass header.from=shop.example';

function mail(id: string, body: string, ar: string | null = PASS): Email {
  return {
    id, threadId: 't', mailboxIds: {}, keywords: {}, size: 1, receivedAt: '2026-10-30T09:00:00Z', subject: 'Booking',
    from: [{ email: 'orders@shop.example' }],
    ...(ar ? { authenticationResults: parseAuthenticationResults([ar]), authenticationResultsOnReceipt: true } : {}),
    htmlBody: [{ partId: '1', type: 'text/html' } as EmailBodyPart],
    bodyValues: { '1': { value: `<html><head>${body}</head><body></body></html>`, isTruncated: false, isEncodingProblem: false } },
  } as unknown as Email;
}

const initial = usePolicyStore.getState();
function gate(on: boolean) {
  usePolicyStore.setState((state) => ({ policy: { ...state.policy, features: { ...state.policy.features, structuredMailEnabled: on } } }));
}

afterEach(() => {
  usePolicyStore.setState(initial, true);
  CARD_SOURCES.length = 0;
});

describe('useStructuredMail', () => {
  it('returns the cards of a trusted message', () => {
    gate(true);
    const { result } = renderHook(() => useStructuredMail(mail('a', ld(ORDER))));
    expect(result.current).toMatchObject([{ kind: 'shipment', orderNumber: 'SO-1' }]);
  });

  it('returns nothing for an untrusted message or with the admin gate off', () => {
    gate(true);
    expect(renderHook(() => useStructuredMail(mail('b', ld(ORDER), null))).result.current).toEqual([]);
    gate(false);
    expect(renderHook(() => useStructuredMail(mail('c', ld(ORDER)))).result.current).toEqual([]);
  });

  it('shows a flight only once the airport zones are resolved', async () => {
    gate(true);
    const { result } = renderHook(() => useStructuredMail(mail('d', ld(FLIGHT))));
    expect(result.current).toEqual([]);
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]).toMatchObject({ kind: 'flight', legs: [{ departure: { at: { zone: 'Europe/Berlin' } } }] });
  });

  it('merges cards from attachment sources, and never asks them about untrusted mail', async () => {
    gate(true);
    let asked = 0;
    CARD_SOURCES.push(async () => {
      asked++;
      return [{ kind: 'shipment', key: 'shipment|order:so-2', orderNumber: 'SO-2', merchant: 'Shop', items: [], parcels: [], source: 'pkpass' }];
    });
    const { result } = renderHook(() => useStructuredMail(mail('e', ld(ORDER))));
    await waitFor(() => expect(result.current).toHaveLength(2));
    renderHook(() => useStructuredMail(mail('f', ld(ORDER), null)));
    expect(asked).toBe(1);
  });
});
