import { describe, expect, it } from 'vitest';
import { readStructuredMail } from '..';
import type { Shipment, TransportBooking } from '../types';

const MAIL = { mailDate: new Date('2026-10-30T09:00:00Z') };
const C = 'http://schema.org';
const page = (...blocks: unknown[]) => `<html><head>${blocks.map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`).join('')}</head><body></body></html>`;

function leg(name: string, number: string, dep: string, arr: string, status = 'ReservationConfirmed', seat?: string) {
  return {
    '@context': C, '@type': 'FlightReservation', reservationNumber: 'QX7K2M', underName: { name }, reservationStatus: status,
    ...(seat ? { airplaneSeat: seat } : {}),
    reservationFor: {
      '@type': 'Flight', flightNumber: number, airline: { name: 'Lufthansa', iataCode: 'LH' },
      departureAirport: { iataCode: number === '400' ? 'FRA' : 'JFK' }, departureTime: dep,
      arrivalAirport: { iataCode: number === '400' ? 'JFK' : 'FRA' }, arrivalTime: arr,
    },
  };
}
const OUT: [string, string] = ['2026-12-01T10:15:00+01:00', '2026-12-01T13:05:00-05:00'];
const BACK: [string, string] = ['2026-12-08T17:30:00-05:00', '2026-12-09T07:20:00+01:00'];

describe('merging', () => {
  it('folds two passengers on two legs into one booking with two legs and two names', () => {
    const cards = readStructuredMail(page([
      leg('Erika Mustermann', '400', ...OUT, undefined, '12A'), leg('Max Mustermann', '400', ...OUT, undefined, '12B'),
      leg('Erika Mustermann', '401', ...BACK), leg('Max Mustermann', '401', ...BACK),
    ]), MAIL) as TransportBooking[];
    expect(cards).toHaveLength(1);
    expect(cards[0].passengers).toEqual(['Erika Mustermann', 'Max Mustermann']);
    expect(cards[0].legs.map((l) => l.number)).toEqual(['400', '401']);
    expect(cards[0].legs[0].seats).toEqual([{ passenger: 'Erika Mustermann', seat: '12A' }, { passenger: 'Max Mustermann', seat: '12B' }]);
  });

  it('sorts legs by departure even when the mail lists them backwards', () => {
    const [card] = readStructuredMail(page([leg('Erika Mustermann', '401', ...BACK), leg('Erika Mustermann', '400', ...OUT)]), MAIL) as TransportBooking[];
    expect(card.legs.map((l) => l.number)).toEqual(['400', '401']);
  });

  it('keeps a leg live when only one of its passengers is cancelled', () => {
    const [card] = readStructuredMail(page([
      leg('Erika Mustermann', '400', ...OUT), leg('Max Mustermann', '400', ...OUT, 'ReservationCancelled'),
    ]), MAIL) as TransportBooking[];
    expect(card.legs[0].status).toBe('confirmed');
    expect(card.status).toBe('confirmed');
  });

  it('cancels a leg, and the booking, only when every part is cancelled', () => {
    const [partly] = readStructuredMail(page([
      leg('Erika Mustermann', '400', ...OUT, 'ReservationCancelled'), leg('Erika Mustermann', '401', ...BACK),
    ]), MAIL) as TransportBooking[];
    expect(partly.legs.map((l) => l.status)).toEqual(['cancelled', 'confirmed']);
    expect(partly.status).toBe('confirmed');
    const [all] = readStructuredMail(page([
      leg('Erika Mustermann', '400', ...OUT, 'ReservationCancelled'), leg('Erika Mustermann', '401', ...BACK, 'Cancelled'),
    ]), MAIL) as TransportBooking[];
    expect(all.status).toBe('cancelled');
  });

  it('drops the booking when two parts disagree about one leg, or one part is invalid', () => {
    expect(readStructuredMail(page([leg('Erika Mustermann', '400', ...OUT), leg('Max Mustermann', '400', OUT[0], '2026-12-01T14:05:00-05:00')]), MAIL)).toEqual([]);
    expect(readStructuredMail(page([leg('Erika Mustermann', '400', ...OUT), leg('Erika Mustermann', '401', BACK[0], '')]), MAIL)).toEqual([]);
  });

  it('collapses the same booking given as JSON-LD and as microdata', () => {
    const microdata = `<div itemscope itemtype="http://schema.org/Order"><meta itemprop="orderNumber" content="SO-1"><div itemprop="merchant" itemscope itemtype="http://schema.org/Organization"><meta itemprop="name" content="Shop"></div></div>`;
    const html = page({ '@context': C, '@type': 'Order', orderNumber: 'SO-1', merchant: 'Shop', price: 10, priceCurrency: 'EUR' }).replace('<body></body>', `<body>${microdata}</body>`);
    const cards = readStructuredMail(html, MAIL) as Shipment[];
    expect(cards).toHaveLength(1);
    expect(cards[0].total).toEqual({ amount: '10.00', currency: 'EUR' });
  });

  it('makes one card of an Order and a ParcelDelivery for the same order number', () => {
    const cards = readStructuredMail(page(
      { '@context': C, '@type': 'Order', orderNumber: 'SO-1', merchant: 'Shop', orderStatus: 'OrderProcessing', acceptedOffer: { itemOffered: { name: 'Schuhe' } } },
      { '@context': C, '@type': 'ParcelDelivery', trackingNumber: 'T1', carrier: 'DHL', partOfOrder: { '@type': 'Order', orderNumber: 'SO-1', orderStatus: 'OrderInTransit' } },
      { '@context': C, '@type': 'ParcelDelivery', trackingNumber: 'T2', carrier: 'DHL', partOfOrder: { '@type': 'Order', orderNumber: 'SO-1' } },
    ), MAIL) as Shipment[];
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ orderNumber: 'SO-1', merchant: 'Shop', status: 'in_transit', items: [{ name: 'Schuhe' }] });
    expect(cards[0].parcels.map((p) => p.trackingNumber)).toEqual(['T1', 'T2']);
  });

  it('keeps orders with different numbers apart', () => {
    const cards = readStructuredMail(page(
      { '@context': C, '@type': 'Order', orderNumber: 'SO-1', merchant: 'Shop' },
      { '@context': C, '@type': 'Order', orderNumber: 'SO-2', merchant: 'Shop' },
    ), MAIL);
    expect(cards).toHaveLength(2);
  });
});
