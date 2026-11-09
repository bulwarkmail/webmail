import { describe, expect, it } from 'vitest';
import { normalizeItems } from '../normalize';
import type { LodgingBooking, Shipment, TransportBooking } from '../types';
import { address, amount, lenientDate, link, moment, orderStatus, reservationStatus } from '../values';

const ctx = 'http://schema.org';
const norm = (...items: unknown[]) => normalizeItems(items.map((item) => ({ item, source: 'json-ld' as const })));

describe('value readers', () => {
  it('reads ISO times with every offset form and computes the instant', () => {
    expect(moment('2027-03-04T20:15:00-08:00')).toEqual({ date: '2027-03-04', time: '20:15:00', offsetMinutes: -480, utc: '2027-03-05T04:15:00Z' });
    expect(moment('2024-06-04T11:44:00+0200')).toEqual({ date: '2024-06-04', time: '11:44:00', offsetMinutes: 120, utc: '2024-06-04T09:44:00Z' });
    expect(moment('2026-01-01T10:00+05')).toMatchObject({ offsetMinutes: 300, utc: '2026-01-01T05:00:00Z' });
    expect(moment('2026-01-01T10:00:00.123Z')).toMatchObject({ time: '10:00:00', offsetMinutes: 0, utc: '2026-01-01T10:00:00Z' });
    expect(moment('2026-01-01T10:00:00')).toEqual({ date: '2026-01-01', time: '10:00:00' });
    expect(moment('2026-01-01')).toEqual({ date: '2026-01-01' });
  });

  it('refuses broken times instead of guessing', () => {
    expect(moment('2024-10-13CEST03:10:23')).toBeUndefined();
    expect(moment('2026-02-30T10:00:00Z')).toBeUndefined();
    expect(moment('2026-01-01T25:00:00Z')).toBeUndefined();
    expect(moment('2026-01-01T10:00:00+15:00')).toBeUndefined();
    expect(moment('next Friday')).toBeUndefined();
  });

  it('keeps only the date of a broken value where a date is enough', () => {
    expect(lenientDate('2024-10-13CEST03:10:23')).toEqual({ date: '2024-10-13' });
    expect(lenientDate('2026-03-12T12:00:00-08:00')).toEqual({ date: '2026-03-12' });
    expect(lenientDate('20241013')).toBeUndefined();
  });

  it('reads both forms of the status enums over http and https', () => {
    expect(reservationStatus('http://schema.org/ReservationConfirmed')).toBe('confirmed');
    expect(reservationStatus('https://schema.org/Confirmed')).toBe('confirmed');
    expect(reservationStatus('ReservationCancelled')).toBe('cancelled');
    expect(reservationStatus(['', 'http://schema.org/Cancelled'])).toBe('cancelled');
    expect(reservationStatus('http://schema.org/Bogus')).toBeUndefined();
    expect(orderStatus(['', 'http://schema.org/OrderProcessing'])).toBe('processing');
    expect(orderStatus('http://schema.org/OrderStatus/InTransit')).toBe('in_transit');
    expect(orderStatus('OrderDelivered')).toBe('delivered');
    expect(orderStatus('Processing')).toBe('processing');
  });

  it('reads prices in dot and German notation and refuses ambiguous ones', () => {
    expect(amount(25.99)).toBe('25.99');
    expect(amount('14.9700')).toBe('14.97');
    expect(amount('399,00 €')).toBe('399.00');
    expect(amount('1.299,00 EUR')).toBe('1299.00');
    expect(amount('$1,299.50')).toBe('1299.50');
    expect(amount('1,299')).toBeUndefined();
  });

  it('keeps only http(s) links with a real host', () => {
    expect(link('https://www.fedex.com/track/1')).toEqual({ url: 'https://www.fedex.com/track/1', host: 'fedex.com' });
    expect(link({ '@type': 'ViewAction', target: 'http://shop.example.com/o/1' })?.host).toBe('shop.example.com');
    expect(link('http://default/buchung/VK4XKD')).toBeUndefined();
    expect(link('javascript:alert(1)')).toBeUndefined();
    expect(link('https://user:pw@example.com/')).toBeUndefined();
    expect(link('http://192.168.1.1/x')).toBeUndefined();
    expect(link('http://localhost:3000/x')).toBeUndefined();
    expect(link('/relative')).toBeUndefined();
  });

  it('reads addresses given as objects, strings and country objects', () => {
    expect(address('Unter den Linden 77, Berlin')).toEqual({ street: 'Unter den Linden 77, Berlin' });
    expect(address({ streetAddress: 'Koppenstr. 3', addressLocality: 'Berlin', postalCode: '10243', addressCountry: 'de', addressRegion: '' }))
      .toEqual({ street: 'Koppenstr. 3', locality: 'Berlin', postalCode: '10243', country: 'DE' });
    expect(address({ addressLocality: 'Paris', addressCountry: { '@type': 'Country', name: 'France' } }))
      .toEqual({ locality: 'Paris', countryName: 'France' });
  });
});

describe('normalizeItems', () => {
  const flight = {
    '@context': ctx, '@type': 'FlightReservation', reservationNumber: 'QX7K2M',
    reservationStatus: 'http://schema.org/ReservationConfirmed',
    underName: { '@type': 'Person', name: 'Erika Mustermann' }, airplaneSeat: '12C',
    checkinUrl: 'https://www.lufthansa.example.com/checkin',
    reservationFor: {
      '@type': 'Flight', flightNumber: 'LH400',
      airline: { '@type': 'Airline', name: 'Lufthansa', iataCode: 'LH' },
      departureAirport: { '@type': 'Airport', name: 'Frankfurt', iataCode: 'fra' }, departureTime: '2026-12-01T10:15:00+01:00',
      arrivalAirport: { '@type': 'Airport', name: 'New York JFK', iataCode: 'JFK' }, arrivalTime: '2026-12-01T13:05:00-05:00',
    },
  };

  it('reads a flight reservation, splitting the airline code off the flight number', () => {
    const [card] = norm(flight) as TransportBooking[];
    expect(card).toEqual({
      key: 'flight|ref:qx7k2m', kind: 'flight', reference: 'QX7K2M', status: 'confirmed', passengers: ['Erika Mustermann'],
      provider: 'Lufthansa', links: { checkin: { url: 'https://www.lufthansa.example.com/checkin', host: 'lufthansa.example.com' } },
      source: 'json-ld',
      legs: [{
        carrier: 'Lufthansa', carrierCode: 'LH', number: '400',
        departure: { place: { name: 'Frankfurt', code: 'FRA' }, at: { date: '2026-12-01', time: '10:15:00', offsetMinutes: 60, utc: '2026-12-01T09:15:00Z' } },
        arrival: { place: { name: 'New York JFK', code: 'JFK' }, at: { date: '2026-12-01', time: '13:05:00', offsetMinutes: -300, utc: '2026-12-01T18:05:00Z' } },
        seats: [{ passenger: 'Erika Mustermann', seat: '12C' }], status: 'confirmed',
      }],
    });
  });

  it('flattens arrays, @graph and reservationFor arrays', () => {
    const two = { ...flight, reservationFor: [flight.reservationFor, { ...flight.reservationFor, flightNumber: '401' }] };
    expect(norm([flight, flight]).length).toBe(2);
    expect(norm({ '@context': ctx, '@graph': [flight, flight] }).length).toBe(2);
    const legs = norm(two) as TransportBooking[];
    expect(legs.map((c) => c.legs[0].number)).toEqual(['400', '401']);
  });

  it('accepts https contexts, @vocab and several @types, and drops foreign or missing contexts', () => {
    expect(norm({ ...flight, '@context': 'https://schema.org/' })).toHaveLength(1);
    expect(norm({ ...flight, '@context': { '@vocab': 'http://schema.org/' } })).toHaveLength(1);
    expect(norm({ ...flight, '@type': ['Thing', 'FlightReservation'] })).toHaveLength(1);
    expect(norm({ ...flight, '@context': 'http://example.com' })).toHaveLength(0);
    const { '@context': _dropped, ...noContext } = flight;
    expect(norm(noContext)).toHaveLength(0);
  });

  it('reads bus trips the way FlixBus writes them', () => {
    const [card] = norm({
      '@context': ctx, '@type': 'BusReservation', reservationNumber: 3165152579,
      underName: { '@type': 'Person', name: 'Max Mustermann' },
      reservationFor: {
        '@type': 'BusTrip', busNumber: 'FLX30', busName: 'Berlin Ostbahnhof', busCompany: { '@type': 'Organization', name: 'Flix' },
        departureBusStop: { '@type': 'BusStop', name: 'Hannover Hauptbahnhof', address: { '@type': 'PostalAddress', addressLocality: 'Hannover', addressCountry: 'DE' } },
        departureTime: '2024-06-04T11:44:00+0200',
        arrivalBusStop: { '@type': 'BusStop', name: 'Berlin Ostbahnhof' }, arrivalTime: '2024-06-04T13:44:00+0200',
      },
      reservedTicket: { '@type': 'Ticket', ticketedSeat: { '@type': 'Seat', seatingType: 'Coach', seatNumber: '6D' } },
    }) as TransportBooking[];
    expect(card.reference).toBe('3165152579');
    expect(card.legs[0]).toMatchObject({ carrier: 'Flix', number: 'FLX30', seats: [{ passenger: 'Max Mustermann', seat: '6D' }] });
    expect(card.legs[0].departure.place).toEqual({ name: 'Hannover Hauptbahnhof', address: { locality: 'Hannover', country: 'DE' } });
    expect(JSON.stringify(card)).not.toContain('busName');
  });

  it('reads hotels from Hotel subtypes with legacy names', () => {
    const [card] = norm({
      '@context': ctx, '@type': 'LodgingReservation', reservationId: 'h-1',
      reservationFor: { '@type': 'Hotel', name: 'Hotel Adlon', address: 'Unter den Linden 77, 10117 Berlin', telephone: '+49 30 1' },
      checkinTime: '2026-12-04T15:00:00+01:00', checkoutTime: '2026-12-06T12:00:00+01:00', Url: 'https://hotel.example.com/b/h-1',
    }) as LodgingBooking[];
    expect(card).toMatchObject({
      kind: 'lodging', reference: 'h-1', name: 'Hotel Adlon', phone: '+49 30 1', address: { street: 'Unter den Linden 77, 10117 Berlin' },
      checkin: { date: '2026-12-04', time: '15:00:00' }, checkout: { date: '2026-12-06', time: '12:00:00' },
      links: { manage: { host: 'hotel.example.com' } },
    });
  });

  it('reads restaurants, events with a date-only end, and rental cars', () => {
    const [restaurant, event, car] = norm(
      { '@context': ctx, '@type': 'FoodEstablishmentReservation', reservationNumber: 'R9', partySize: '2', startTime: '2026-12-05T19:30:00+01:00', reservationFor: { '@type': 'Restaurant', name: 'Tim Raue' } },
      { '@context': ctx, '@type': 'EventReservation', reservationNumber: 'E9', reservationFor: { '@type': 'MusicEvent', name: 'Konzert', startDate: '2026-12-05T20:00:00+01:00', endDate: '2026-12-05', location: { '@type': 'Place', name: 'Halle', address: { addressCountry: 'DE' } } } },
      { '@context': ctx, '@type': 'RentalCarReservation', reservationNumber: 'C9', reservationFor: { '@type': 'Car', brand: { name: 'VW' }, model: 'Golf', rentalCompany: { name: 'Sixt' } }, pickupTime: '2026-12-04T09:00:00+01:00', dropoffTime: '2026-12-07T18:00:00+01:00', pickupLocation: { name: 'BER' }, dropoffLocation: 'BER' },
    );
    expect(restaurant).toMatchObject({ kind: 'restaurant', name: 'Tim Raue', partySize: 2, start: { time: '19:30:00' } });
    expect(event).toMatchObject({ kind: 'event', name: 'Konzert', end: { date: '2026-12-05', time: '23:59:59' }, venue: { name: 'Halle' } });
    expect(car).toMatchObject({ kind: 'rentalcar', company: 'Sixt', car: 'VW Golf', pickup: { place: { name: 'BER' } }, dropoff: { place: { name: 'BER' } } });
  });

  it('reads orders with German prices and parcels with their order', () => {
    const [orderCard, parcelCard] = norm(
      {
        '@context': ctx, '@type': 'Order', merchant: { '@type': 'Organization', name: 'Kaufland.de' }, orderNumber: 'M1234AB',
        price: '399,00 €', priceCurrency: 'EUR', orderStatus: ['', 'http://schema.org/OrderProcessing'],
        acceptedOffer: { '@type': 'Offer', itemOffered: { '@type': 'Product', name: '3D-Drucker', image: 'https://media.example.com/p.jpg' }, eligibleQuantity: { value: '1' } },
        url: 'https://www.kaufland.de/account/orders',
      },
      {
        '@context': ctx, '@type': 'ParcelDelivery', carrier: 'DHL', trackingNumber: '0034', trackingUrl: 'https://www.dhl.de/t?id=0034',
        expectedArrivalUntil: '2024-10-13CEST03:10:23', itemShipped: [{ '@type': 'Product', name: 'A' }, 'B'],
        partOfOrder: { '@type': 'Order', orderNumber: 'M1234AB', merchant: 'Kaufland.de', orderStatus: 'http://schema.org/OrderInTransit' },
      },
    ) as Shipment[];
    expect(orderCard).toEqual({
      kind: 'shipment', key: 'shipment|order:m1234ab', merchant: 'Kaufland.de', orderNumber: 'M1234AB', status: 'processing',
      items: [{ name: '3D-Drucker', quantity: 1, image: { url: 'https://media.example.com/p.jpg', host: 'media.example.com' } }],
      total: { amount: '399.00', currency: 'EUR' }, orderUrl: { url: 'https://www.kaufland.de/account/orders', host: 'kaufland.de' },
      parcels: [], source: 'json-ld',
    });
    expect(parcelCard).toMatchObject({
      key: 'shipment|order:m1234ab', merchant: 'Kaufland.de', status: 'in_transit',
      parcels: [{ carrier: 'DHL', trackingNumber: '0034', trackingUrl: { host: 'dhl.de' }, expectedBy: { date: '2024-10-13' }, items: [{ name: 'A' }, { name: 'B' }] }],
    });
  });

  it('takes the expected arrival only from its latest bound', () => {
    const parcel = (extra: Record<string, unknown>) => norm({ '@context': ctx, '@type': 'ParcelDelivery', trackingNumber: '1', carrier: 'DHL', ...extra })[0] as Shipment;
    // The earliest possible delivery day is not an "arrives by" date.
    expect(parcel({ expectedArrivalFrom: '2026-11-03' }).parcels[0].expectedBy).toBeUndefined();
    expect(parcel({ expectedArrivalFrom: '2026-11-03', expectedArrivalUntil: '2026-11-05' }).parcels[0].expectedBy).toEqual({ date: '2026-11-05' });
  });

  it('drops types it does not read', () => {
    expect(norm(
      { '@context': ctx, '@type': 'PromotionCard', image: 'https://x.example.com/a.png' },
      { '@context': ctx, '@type': 'EmailMessage', potentialAction: { '@type': 'ViewAction' } },
      { '@context': ctx, '@type': 'Invoice', totalPaymentDue: 3 },
    )).toEqual([]);
  });
});
