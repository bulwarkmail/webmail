import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAuthenticationResults } from '@/lib/email-headers';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Email, EmailBodyPart } from '@/lib/jmap/types';
import type { TransportBooking } from '@/lib/structured-mail';
import { AIR_SEMANTICS, MAIL_DATE, TRAIN_SEMANTICS, boardingPass, zipPass } from '@/lib/structured-mail/__tests__/pkpass-fixtures';
import { usePolicyStore } from '@/stores/policy-store';
import { useStructuredMail } from '../use-structured-mail';

const PASS = 'mx.example.org; dkim=pass header.d=swiss.example; spf=pass smtp.mailfrom=bounce@swiss.example; dmarc=pass header.from=swiss.example';
const PLAIN = '<html><body><p>Your boarding pass is attached.</p></body></html>';
const ld = (...blocks: unknown[]) => `<html><head>${blocks.map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`).join('')}</head><body><p>Your boarding pass is attached.</p></body></html>`;

/** The flight of AIR_SEMANTICS as the booking mail's markup. */
function flightMarkup(fields: { departureTime?: string; status?: string } = {}) {
  const { departureTime = '2026-12-03T07:40:00+01:00', status = 'http://schema.org/ReservationConfirmed' } = fields;
  return {
    '@context': 'http://schema.org', '@type': 'FlightReservation', reservationNumber: 'PK7Q2Z',
    reservationStatus: status, underName: { '@type': 'Person', name: 'Jana Beispiel' },
    reservationFor: {
      '@type': 'Flight', flightNumber: 'LX1072', airline: { '@type': 'Airline', name: 'Swiss', iataCode: 'LX' },
      departureAirport: { '@type': 'Airport', name: 'Zurich Airport', iataCode: 'ZRH' }, departureTime,
      arrivalAirport: { '@type': 'Airport', name: 'Berlin Brandenburg', iataCode: 'BER' }, arrivalTime: '2026-12-03T09:05:00+01:00',
    },
  };
}

/** The train of TRAIN_SEMANTICS, as the markup writes it ("ICE597", full station names). */
const TRAIN_MARKUP = {
  '@context': 'http://schema.org', '@type': 'TrainReservation', reservationNumber: 'ZUG4471', underName: { '@type': 'Person', name: 'Jana Beispiel' },
  reservationFor: {
    '@type': 'TrainTrip', trainNumber: 'ICE597', provider: { '@type': 'Organization', name: 'DB Fernverkehr' },
    departureStation: { '@type': 'TrainStation', name: 'Hamburg Hauptbahnhof' }, departureTime: '2026-12-05T08:46:00+01:00',
    arrivalStation: { '@type': 'TrainStation', name: 'Köln Hauptbahnhof' }, arrivalTime: '2026-12-05T12:50:00+01:00',
  },
};

function mail(id: string, options: { ar?: string | null; html?: string | null; htmlLoaded?: boolean } = {}): Email {
  const { ar = PASS, html = PLAIN, htmlLoaded = true } = options;
  return {
    id, threadId: 't', mailboxIds: {}, keywords: {}, size: 1, receivedAt: MAIL_DATE.toISOString(), subject: 'Your boarding pass',
    from: [{ email: 'boarding@swiss.example' }],
    ...(ar ? { authenticationResults: parseAuthenticationResults([ar]), authenticationResultsOnReceipt: true } : {}),
    htmlBody: [{ partId: '1', type: html === null ? 'text/plain' : 'text/html' } as EmailBodyPart],
    bodyValues: htmlLoaded ? { '1': { value: html ?? 'Your boarding pass is attached.', isTruncated: false, isEncodingProblem: false } } : {},
    attachments: [{ partId: '2', blobId: 'blob-pass', size: 3000, name: 'BoardingPass.pkpass', type: 'application/vnd.apple.pkpass' }],
  } as unknown as Email;
}

async function passClient(semantics: Record<string, unknown> = AIR_SEMANTICS, transitType = 'PKTransitTypeAir') {
  const bytes = await zipPass(boardingPass(semantics, transitType));
  const fetchBlobArrayBuffer = vi.fn(async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return { blob: { client: { fetchBlobArrayBuffer } as unknown as IJMAPClient, accountId: 'acc-1' }, fetchBlobArrayBuffer };
}

function gate(on: boolean) {
  usePolicyStore.setState((state) => ({ policy: { ...state.policy, features: { ...state.policy.features, structuredMailEnabled: on } } }));
}

/** Let effects and the airport-table import settle when nothing is expected to show. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

const initial = usePolicyStore.getState();

afterEach(() => {
  usePolicyStore.setState(initial, true);
});

describe('useStructuredMail with a Wallet pass attached', () => {
  it('shows the resolved flight card of a trusted mail without booking markup, and downloads nothing for an untrusted one', async () => {
    gate(true);
    const { blob, fetchBlobArrayBuffer } = await passClient();
    const untrusted = renderHook(() => useStructuredMail(mail('u', { ar: null }), blob));
    const { result } = renderHook(() => useStructuredMail(mail('t'), blob));
    await waitFor(() => expect(result.current).toHaveLength(1));
    const [card] = result.current as TransportBooking[];
    expect(card).toMatchObject({ kind: 'flight', reference: 'PK7Q2Z', source: 'pkpass' });
    expect(card.legs[0].departure.at).toMatchObject({ time: '07:40:00', zone: 'Europe/Zurich' });
    expect(card.legs[0].arrival?.at).toMatchObject({ time: '09:05:00', zone: 'Europe/Berlin' });
    expect(fetchBlobArrayBuffer).toHaveBeenCalledTimes(1);
    expect(fetchBlobArrayBuffer).toHaveBeenCalledWith('blob-pass', 'BoardingPass.pkpass', 'application/vnd.apple.pkpass', 'acc-1', 5 * 1024 * 1024 + 1);
    expect(untrusted.result.current).toEqual([]);
  });

  it('reads the pass of a plain-text mail too', async () => {
    gate(true);
    const { blob } = await passClient();
    const { result } = renderHook(() => useStructuredMail(mail('p', { html: null }), blob));
    await waitFor(() => expect(result.current).toMatchObject([{ kind: 'flight', source: 'pkpass' }]));
  });

  it('downloads nothing and shows nothing with the admin gate off', async () => {
    gate(false);
    const { blob, fetchBlobArrayBuffer } = await passClient();
    const { result } = renderHook(() => useStructuredMail(mail('g'), blob));
    await settle();
    expect(result.current).toEqual([]);
    expect(fetchBlobArrayBuffer).not.toHaveBeenCalled();
  });

  it('waits for the HTML before asking for passes, as it may hold booking markup', async () => {
    gate(true);
    const { blob, fetchBlobArrayBuffer } = await passClient();
    const { result } = renderHook(() => useStructuredMail(mail('w', { htmlLoaded: false }), blob));
    await settle();
    expect(result.current).toEqual([]);
    expect(fetchBlobArrayBuffer).not.toHaveBeenCalled();
  });

  describe('when the HTML has booking markup, the markup alone counts and nothing is downloaded', () => {
    it('keeps a cancelled markup booking cancelled', async () => {
      gate(true);
      const { blob, fetchBlobArrayBuffer } = await passClient();
      const { result } = renderHook(() => useStructuredMail(mail('c', { html: ld(flightMarkup({ status: 'http://schema.org/ReservationCancelled' })) }), blob));
      await waitFor(() => expect(result.current).toHaveLength(1));
      await settle();
      expect(result.current).toMatchObject([{ kind: 'flight', status: 'cancelled', source: 'json-ld' }]);
      expect(fetchBlobArrayBuffer).not.toHaveBeenCalled();
    });

    it('shows nothing when the markup booking was rejected', async () => {
      gate(true);
      const { blob, fetchBlobArrayBuffer } = await passClient();
      const html = ld(flightMarkup(), flightMarkup({ departureTime: '2026-12-03T08:10:00+01:00' }));
      const { result } = renderHook(() => useStructuredMail(mail('r', { html }), blob));
      await settle();
      expect(result.current).toEqual([]);
      expect(fetchBlobArrayBuffer).not.toHaveBeenCalled();
    });

    it('shows one train card with the markup leg when the pass writes number and station differently', async () => {
      gate(true);
      const { blob, fetchBlobArrayBuffer } = await passClient(TRAIN_SEMANTICS, 'PKTransitTypeTrain');
      const { result } = renderHook(() => useStructuredMail(mail('i', { html: ld(TRAIN_MARKUP) }), blob));
      await waitFor(() => expect(result.current).toHaveLength(1));
      await settle();
      const cards = result.current as TransportBooking[];
      expect(cards).toHaveLength(1);
      expect(cards[0].legs).toHaveLength(1);
      expect(cards[0].legs[0]).toMatchObject({ number: 'ICE597', departure: { place: { name: 'Hamburg Hauptbahnhof' } } });
      expect(fetchBlobArrayBuffer).not.toHaveBeenCalled();
    });

    it('shows one flight card when the pass has no confirmation number', async () => {
      gate(true);
      const { confirmationNumber: _ref, ...noRef } = AIR_SEMANTICS;
      const { blob, fetchBlobArrayBuffer } = await passClient(noRef);
      const { result } = renderHook(() => useStructuredMail(mail('f', { html: ld(flightMarkup()) }), blob));
      await waitFor(() => expect(result.current).toHaveLength(1));
      await settle();
      expect(result.current).toMatchObject([{ kind: 'flight', source: 'json-ld', reference: 'PK7Q2Z' }]);
      expect(fetchBlobArrayBuffer).not.toHaveBeenCalled();
    });
  });
});
