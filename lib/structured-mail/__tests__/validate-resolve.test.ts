import { describe, expect, it } from 'vitest';
import { normalizeItems } from '../normalize';
import { needsAirportZones, resolveCards } from '../resolve';
import { loadAirportZones } from '../time-zones';
import type { StructuredCard, TransportBooking } from '../types';
import { validateCard } from '../validate';

const ctx = 'http://schema.org';
const MAIL = new Date('2026-10-30T10:00:00Z');
const one = (item: unknown) => normalizeItems([{ item, source: 'json-ld' }])[0];
const problems = (item: unknown, mailDate = MAIL) => validateCard(one(item), mailDate).problems;

function flight(dep: [string, string, string], arr: [string, string, string], extra: Record<string, unknown> = {}) {
  return {
    '@context': ctx, '@type': 'FlightReservation', reservationNumber: 'T1', underName: 'Erika Mustermann',
    reservationFor: {
      '@type': 'Flight', flightNumber: '100', airline: { name: 'Test Air', iataCode: 'TA' },
      departureAirport: { name: dep[0], iataCode: dep[1] }, departureTime: dep[2],
      arrivalAirport: { name: arr[0], iataCode: arr[1] }, arrivalTime: arr[2],
    },
    ...extra,
  };
}

const sfoJfk = flight(['San Francisco', 'SFO', '2026-12-04T20:15:00-08:00'], ['New York', 'JFK', '2026-12-05T06:30:00-05:00']);

describe('validateCard', () => {
  it('accepts a complete flight near the mail date', () => {
    expect(problems(sfoJfk)).toEqual([]);
  });

  it('rejects flights with missing times or places', () => {
    const noArrival = flight(['San Francisco', 'SFO', '2026-12-04T20:15:00-08:00'], ['New York', 'JFK', '']);
    const bareDate = flight(['San Francisco', 'SFO', '2026-12-04'], ['New York', 'JFK', '2026-12-05T06:30:00-05:00']);
    const noPlace = flight(['', '', '2026-12-04T20:15:00-08:00'], ['New York', 'JFK', '2026-12-05T06:30:00-05:00']);
    expect(problems(noArrival)).toContain('arrival time missing');
    expect(problems(bareDate)).toContain('departure time missing');
    expect(problems(noPlace)).toContain('departure place missing');
  });

  it('rejects bookings years away from the mail', () => {
    expect(problems(sfoJfk, new Date('2024-11-12T00:00:00Z'))).toContain('date too far from the mail');
    expect(problems(sfoJfk, new Date('2028-01-01T00:00:00Z'))).toContain('date too far from the mail');
  });

  it('rejects copies of Google documentation examples', () => {
    expect(problems({ ...sfoJfk, reservationNumber: 'RXJ34P' })).toContain('documentation example');
    expect(problems({ '@context': ctx, '@type': 'ParcelDelivery', trackingNumber: '3453291231', carrier: 'FedEx' })).toContain('documentation example');
  });

  it('rejects stays that end before they start', () => {
    const stay = (checkin: string, checkout: string) => ({
      '@context': ctx, '@type': 'LodgingReservation', reservationNumber: 'H', reservationFor: { '@type': 'Hotel', name: 'Hotel' },
      checkinDate: checkin, checkoutDate: checkout,
    });
    expect(problems(stay('2026-12-04', '2026-12-06'))).toEqual([]);
    expect(problems(stay('2026-12-06', '2026-12-04'))).toContain('check-out not after check-in');
    expect(problems(stay('2026-12-04', '2026-12-04'))).toContain('check-out not after check-in');
  });

  it('rejects orders with nothing to identify them, like Uber\'s empty Order', () => {
    expect(problems({ '@context': ctx, '@type': 'Order', merchant: { name: 'UberEATS' } })).toContain('neither order number nor tracking');
    expect(problems({ '@context': ctx, '@type': 'Order', merchant: 'K4G', orderNumber: 'A1' })).toEqual([]);
  });
});

describe('resolveCards', () => {
  const resolved = async (item: unknown): Promise<StructuredCard[]> => {
    const cards = [one(item)];
    return needsAirportZones(cards) ? resolveCards(cards, await loadAirportZones()) : resolveCards(cards);
  };

  it('gives flight ends their airport zones and keeps the instants', async () => {
    const [card] = (await resolved(sfoJfk)) as TransportBooking[];
    expect(card.legs[0].departure.at).toMatchObject({ zone: 'America/Los_Angeles', utc: '2026-12-05T04:15:00Z' });
    expect(card.legs[0].arrival?.at).toMatchObject({ zone: 'America/New_York', utc: '2026-12-05T11:30:00Z' });
  });

  it('accepts eastbound date-line flights that land earlier on the wall clock', async () => {
    const nrtHnl = flight(['Tokyo Narita', 'NRT', '2026-12-04T21:00:00+09:00'], ['Honolulu', 'HNL', '2026-12-04T09:15:00-10:00']);
    const sydLax = flight(['Sydney', 'SYD', '2026-12-04T09:50:00+11:00'], ['Los Angeles', 'LAX', '2026-12-04T06:20:00-08:00']);
    expect(await resolved(nrtHnl)).toHaveLength(1);
    expect(await resolved(sydLax)).toHaveLength(1);
  });

  it('rejects arrival before departure and flights over 20 hours', async () => {
    const backwards = flight(['Frankfurt', 'FRA', '2026-12-01T10:15:00+01:00'], ['New York', 'JFK', '2026-12-01T03:05:00-05:00']);
    const tooLong = flight(['Frankfurt', 'FRA', '2026-12-01T10:15:00+01:00'], ['Sydney', 'SYD', '2026-12-02T23:00:00+11:00']);
    expect(await resolved(backwards)).toEqual([]);
    expect(await resolved(tooLong)).toEqual([]);
  });

  it('drops a flight whose offset contradicts the airport zone', async () => {
    const wrongOffset = flight(['Frankfurt', 'FRA', '2026-12-01T10:15:00+00:00'], ['New York', 'JFK', '2026-12-01T13:05:00-05:00']);
    expect(await resolved(wrongOffset)).toEqual([]);
  });

  it('reads a flight time without offset in the airport zone, and drops it when the airport is unknown', async () => {
    const floating = flight(['Frankfurt', 'FRA', '2026-12-01T10:15:00'], ['New York', 'JFK', '2026-12-01T13:05:00']);
    const [card] = (await resolved(floating)) as TransportBooking[];
    expect(card.legs[0].departure.at).toMatchObject({ zone: 'Europe/Berlin', utc: '2026-12-01T09:15:00Z' });
    const unknown = flight(['Nowhere', 'QQQ', '2026-12-01T10:15:00'], ['New York', 'JFK', '2026-12-01T13:05:00']);
    expect(await resolved(unknown)).toEqual([]);
  });

  it('never shows a flight before the airport table is there', () => {
    expect(resolveCards([one(sfoJfk)])).toEqual([]);
  });

  it('uses a fixed-offset zone where no airport code is known', async () => {
    const noCode = flight(['San Francisco', '', '2026-12-04T20:15:00-08:00'], ['New York', 'JFK', '2026-12-05T06:30:00-05:00']);
    const [card] = (await resolved(noCode)) as TransportBooking[];
    expect(card.legs[0].departure.at.zone).toBe('Etc/GMT+8');
  });

  it('treats hotel times without offset or known country as dates only', async () => {
    const [card] = await resolved({
      '@context': ctx, '@type': 'LodgingReservation', reservationNumber: 'H', reservationFor: { '@type': 'Hotel', name: 'Hotel', address: { addressCountry: 'US' } },
      checkinDate: '2026-12-04T15:00:00', checkoutDate: '2026-12-06T11:00:00',
    });
    expect(card).toMatchObject({ checkin: { date: '2026-12-04' }, checkout: { date: '2026-12-06' } });
    expect((card as { checkin: { time?: string } }).checkin.time).toBeUndefined();
  });

  it('ends a date-only event end at midnight local time even across a DST change', async () => {
    const event = (country?: string) => ({
      '@context': ctx, '@type': 'EventReservation', reservationNumber: 'EV1',
      reservationFor: {
        '@type': 'Event', name: 'Herbstmesse', startDate: '2026-10-23T18:00:00+02:00', endDate: '2026-10-26',
        location: { '@type': 'Place', name: 'Messe', ...(country ? { address: { addressCountry: country } } : {}) },
      },
    });
    const [withVenue] = await resolved(event('DE'));
    expect(withVenue).toMatchObject({ end: { date: '2026-10-26', time: '23:59:59', zone: 'Europe/Berlin', utc: '2026-10-26T22:59:59Z' } });
    const [noVenueCountry] = await resolved(event());
    expect(noVenueCountry).toMatchObject({ end: { date: '2026-10-26', time: '23:59:59', zone: 'Etc/GMT-2', utc: '2026-10-26T21:59:59Z' } });
  });

  it('reads bus times in the single zone of the stop\'s country', async () => {
    const [card] = (await resolved({
      '@context': ctx, '@type': 'BusReservation', reservationNumber: 'B',
      reservationFor: {
        '@type': 'BusTrip', busNumber: 'FLX30',
        departureBusStop: { name: 'Hannover', address: { addressCountry: 'DE' } }, departureTime: '2026-06-04T11:44:00+0200',
        arrivalBusStop: { name: 'Berlin', address: { addressCountry: 'DE' } }, arrivalTime: '2026-06-04T13:44:00+0200',
      },
    })) as TransportBooking[];
    expect(card.legs[0].departure.at.zone).toBe('Europe/Berlin');
  });
});
