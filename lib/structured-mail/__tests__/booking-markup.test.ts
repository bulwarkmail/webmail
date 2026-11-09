import { describe, expect, it } from 'vitest';
import { readStructuredMail, readStructuredMailDetailed } from '..';

const CTX = { mailDate: new Date('2026-11-20T08:00:00Z') };
const page = (...blocks: unknown[]) => `<html><head>${blocks.map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`).join('')}</head><body><p>Hello</p></body></html>`;

function flight(departureTime: string, status = 'http://schema.org/ReservationConfirmed') {
  return {
    '@context': 'http://schema.org', '@type': 'FlightReservation', reservationNumber: 'PK7Q2Z', reservationStatus: status,
    underName: { '@type': 'Person', name: 'Jana Beispiel' },
    reservationFor: {
      '@type': 'Flight', flightNumber: '1072', airline: { '@type': 'Airline', name: 'Swiss', iataCode: 'LX' },
      departureAirport: { '@type': 'Airport', iataCode: 'ZRH' }, departureTime,
      arrivalAirport: { '@type': 'Airport', iataCode: 'BER' }, arrivalTime: '2026-12-03T09:05:00+01:00',
    },
  };
}
const ORDER = { '@context': 'http://schema.org', '@type': 'Order', orderNumber: 'SO-77', merchant: 'Shop' };

describe('readStructuredMailDetailed', () => {
  it('reports booking markup for a valid booking, with the same cards as readStructuredMail', () => {
    const html = page(flight('2026-12-03T07:40:00+01:00'));
    const detailed = readStructuredMailDetailed(html, CTX);
    expect(detailed.hadBookingMarkup).toBe(true);
    expect(detailed.cards).toEqual(readStructuredMail(html, CTX));
    expect(detailed.cards).toHaveLength(1);
  });

  it('reports booking markup for a cancelled booking', () => {
    const detailed = readStructuredMailDetailed(page(flight('2026-12-03T07:40:00+01:00', 'http://schema.org/ReservationCancelled')), CTX);
    expect(detailed).toMatchObject({ hadBookingMarkup: true, cards: [{ status: 'cancelled' }] });
  });

  it('reports booking markup that validation or merging rejected', () => {
    const conflicting = readStructuredMailDetailed(page(flight('2026-12-03T07:40:00+01:00'), flight('2026-12-03T08:10:00+01:00')), CTX);
    expect(conflicting).toEqual({ cards: [], hadBookingMarkup: true });
    const incomplete = readStructuredMailDetailed(page(flight('2026-12-03')), CTX);
    expect(incomplete).toEqual({ cards: [], hadBookingMarkup: true });
  });

  it('reports booking markup for reservation types it has no card for', () => {
    const boat = { '@context': 'https://schema.org', '@type': 'BoatReservation', reservationNumber: 'B-1' };
    expect(readStructuredMailDetailed(page(boat), CTX)).toEqual({ cards: [], hadBookingMarkup: true });
  });

  it('reports none for shipments only, foreign contexts and plain mail', () => {
    expect(readStructuredMailDetailed(page(ORDER), CTX)).toMatchObject({ hadBookingMarkup: false, cards: [{ kind: 'shipment' }] });
    expect(readStructuredMailDetailed(page({ ...flight('2026-12-03T07:40:00+01:00'), '@context': 'http://example.org' }), CTX).hadBookingMarkup).toBe(false);
    expect(readStructuredMailDetailed('<html><body>Your Reservation is attached.</body></html>', CTX)).toEqual({ cards: [], hadBookingMarkup: false });
  });
});
