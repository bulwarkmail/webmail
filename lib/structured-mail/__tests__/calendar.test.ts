import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '@/lib/jmap/types';
import {
  bookingEndsAt,
  bookingEventPatch,
  bookingEventSlots,
  bookingEventUid,
  bookingToEvents,
  eventNeedsUpdate,
  fnv1a64,
  organizationalDomain,
} from '../calendar';
import { normalizeCalendarEventLike, sanitizeOutgoingCalendarEventData } from '@/lib/calendar-event-normalization';
import { loadAirportZones, readStructuredMail, resolveCards, type Booking, type StructuredCard, type TransportBooking } from '..';

const ctx = 'http://schema.org';

/** Cards as the reader gets them: parsed, validated, merged and zone-resolved. */
async function cards(items: unknown[], mailDate = '2026-10-30T10:00:00Z'): Promise<StructuredCard[]> {
  const html = `<html><head>${items.map((item) => `<script type="application/ld+json">${JSON.stringify(item)}</script>`).join('')}</head><body></body></html>`;
  return resolveCards(readStructuredMail(html, { mailDate: new Date(mailDate) }), await loadAirportZones());
}

async function booking(item: unknown, mailDate?: string): Promise<Booking> {
  const found = await cards([item], mailDate);
  expect(found).toHaveLength(1);
  return found[0] as Booking;
}

interface FlightSpec {
  ref?: string;
  airline?: { name?: string; iataCode?: string };
  number?: string;
  dep: [name: string, code: string, time: string];
  arr: [name: string, code: string, time: string];
  status?: string;
  passenger?: string;
  seat?: string;
}

function flight(spec: FlightSpec) {
  return {
    '@context': ctx, '@type': 'FlightReservation',
    ...(spec.ref !== undefined ? { reservationNumber: spec.ref } : { reservationNumber: 'KT4M9Z' }),
    underName: { '@type': 'Person', name: spec.passenger ?? 'Erika Mustermann' },
    ...(spec.seat ? { airplaneSeat: spec.seat } : {}),
    ...(spec.status ? { reservationStatus: `http://schema.org/${spec.status}` } : {}),
    checkinUrl: 'https://checkin.example-air.test/KT4M9Z',
    reservationFor: {
      '@type': 'Flight', flightNumber: spec.number ?? '110', airline: spec.airline ?? { name: 'United', iataCode: 'UA' },
      departureAirport: { '@type': 'Airport', name: spec.dep[0], iataCode: spec.dep[1] }, departureTime: spec.dep[2],
      arrivalAirport: { '@type': 'Airport', name: spec.arr[0], iataCode: spec.arr[1] }, arrivalTime: spec.arr[2],
    },
  };
}

const SENDER = { senderDomain: 'united.com' };
const SFO_JFK = flight({
  dep: ['San Francisco International Airport', 'SFO', '2026-12-04T20:15:00-08:00'],
  arr: ['John F. Kennedy International Airport', 'JFK', '2026-12-05T06:30:00-05:00'],
  seat: '9A',
});

describe('organizationalDomain', () => {
  it('keeps the last two labels, three under a listed two-label public suffix', () => {
    expect(organizationalDomain('booking.flixbus.com')).toBe('flixbus.com');
    expect(organizationalDomain('flixbus.com')).toBe('flixbus.com');
    expect(organizationalDomain('mail.Lufthansa.COM.')).toBe('lufthansa.com');
    expect(organizationalDomain('news.easyjet.co.uk')).toBe('easyjet.co.uk');
    expect(organizationalDomain('shop.example.co.uk')).toBe('example.co.uk');
    expect(organizationalDomain('mail.qantas.com.au')).toBe('qantas.com.au');
    expect(organizationalDomain('info.bahn.de')).toBe('bahn.de');
  });

  it('treats short brand names under country domains as brands, not suffixes', () => {
    expect(organizationalDomain('mail.klm.nl')).toBe('klm.nl');
    expect(organizationalDomain('info.klm.nl')).toBe('klm.nl');
    expect(organizationalDomain('news.dhl.de')).toBe('dhl.de');
    // Not listed, so both collapse; the reference still has to match (see the list's comment).
    expect(organizationalDomain('x.gouv.fr')).toBe(organizationalDomain('y.gouv.fr'));
  });
});

describe('fnv1a64', () => {
  it('matches the published FNV-1a 64-bit test vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });
});

describe('bookingToEvents: flights', () => {
  it('maps SFO 20:15 −08:00 → JFK 06:30 −05:00 to a Los Angeles start and an exact duration', async () => {
    const card = await booking(SFO_JFK);
    const [event] = bookingToEvents(card, SENDER);
    expect(event).toMatchObject({
      '@type': 'Event',
      title: 'UA 110 SFO → JFK',
      start: '2026-12-04T20:15:00',
      timeZone: 'America/Los_Angeles',
      duration: 'PT7H15M',
      showWithoutTime: false,
      locations: {
        dep: { '@type': 'Location', name: 'San Francisco International Airport (SFO)', timeZone: 'America/Los_Angeles', relativeTo: 'start' },
        arr: { '@type': 'Location', name: 'John F. Kennedy International Airport (JFK)', timeZone: 'America/New_York', relativeTo: 'end' },
      },
    });
    expect(event.uid).toMatch(/^bulwark-sm-flight-[0-9a-f]{16}@structured\.bulwark$/);
    expect(event.description).toBe([
      'Booking reference: KT4M9Z',
      'Passengers: Erika Mustermann (9A)',
      'Check in: https://checkin.example-air.test/KT4M9Z',
      'Added from a mail from united.com',
    ].join('\n'));
    expect(event).not.toHaveProperty('participants');
    expect(event).not.toHaveProperty('calendarIds');
  });

  it.each([
    // Westbound over the date line: the local arrival date is a day later.
    ['HNL → NRT', ['Honolulu', 'HNL', '2026-12-04T11:00:00-10:00'], ['Tokyo Narita', 'NRT', '2026-12-05T15:30:00+09:00'], '2026-12-04T11:00:00', 'Pacific/Honolulu', 'Asia/Tokyo', 'PT9H30M'],
    ['LAX → SYD', ['Los Angeles', 'LAX', '2026-12-04T22:30:00-08:00'], ['Sydney', 'SYD', '2026-12-06T08:45:00+11:00'], '2026-12-04T22:30:00', 'America/Los_Angeles', 'Australia/Sydney', 'PT15H15M'],
    // Eastbound: the local arrival time is earlier than the departure.
    ['NRT → HNL', ['Tokyo Narita', 'NRT', '2026-12-04T21:00:00+09:00'], ['Honolulu', 'HNL', '2026-12-04T09:15:00-10:00'], '2026-12-04T21:00:00', 'Asia/Tokyo', 'Pacific/Honolulu', 'PT7H15M'],
    ['SYD → LAX', ['Sydney', 'SYD', '2026-12-04T09:50:00+11:00'], ['Los Angeles', 'LAX', '2026-12-04T06:20:00-08:00'], '2026-12-04T09:50:00', 'Australia/Sydney', 'America/Los_Angeles', 'PT15H30M'],
  ] as const)('crosses the date line %s', async (_name, dep, arr, start, depZone, arrZone, duration) => {
    const card = await booking(flight({ dep: [...dep], arr: [...arr] }));
    const [event] = bookingToEvents(card, SENDER);
    expect(event).toMatchObject({
      start, timeZone: depZone, duration,
      locations: { dep: { timeZone: depZone, relativeTo: 'start' }, arr: { timeZone: arrZone, relativeTo: 'end' } },
    });
  });

  it('counts the real hours of a flight that lands after a DST change', async () => {
    // New York moves to EDT at 02:00 on 14 March 2027; 23:00 GMT → 03:30 EDT is 8 h 30.
    const card = await booking(flight({
      airline: { name: 'British Airways', iataCode: 'BA' }, number: '117',
      dep: ['London Heathrow', 'LHR', '2027-03-13T23:00:00+00:00'],
      arr: ['New York JFK', 'JFK', '2027-03-14T03:30:00-04:00'],
    }), '2027-03-01T10:00:00Z');
    const [event] = bookingToEvents(card, { senderDomain: 'ba.com' });
    expect(event).toMatchObject({ start: '2027-03-13T23:00:00', timeZone: 'Europe/London', duration: 'PT8H30M' });
  });

  it('adds no event for a cancelled leg but still names its uid for removal', async () => {
    const outbound = flight({ dep: ['Frankfurt', 'FRA', '2026-12-01T10:15:00+01:00'], arr: ['New York JFK', 'JFK', '2026-12-01T13:05:00-05:00'], airline: { name: 'Lufthansa', iataCode: 'LH' }, number: '400', ref: 'QX7K2M' });
    const back = { ...flight({ dep: ['New York JFK', 'JFK', '2026-12-08T17:30:00-05:00'], arr: ['Frankfurt', 'FRA', '2026-12-09T07:20:00+01:00'], airline: { name: 'Lufthansa', iataCode: 'LH' }, number: '401', ref: 'QX7K2M', status: 'ReservationCancelled' }) };
    const [card] = (await cards([outbound, back])) as TransportBooking[];
    expect(card.legs).toHaveLength(2);
    const events = bookingToEvents(card, { senderDomain: 'lufthansa.com' });
    expect(events.map((e) => e.title)).toEqual(['LH 400 FRA → JFK']);
    const slots = bookingEventSlots(card, { senderDomain: 'lufthansa.com' });
    expect(slots.map((s) => s.cancelled)).toEqual([false, true]);
    expect(slots[1].uid).toBe(bookingEventUid(card, 'lufthansa.com', card.legs[1]));
  });

  it('gives a pass leg without arrival a zero-length event', async () => {
    const pass: TransportBooking = {
      key: 'flight|ref:pq1', kind: 'flight', reference: 'PQ1RST', passengers: ['Erika Mustermann'], links: {}, source: 'pkpass',
      legs: [{
        carrierCode: 'LH', number: '400', seats: [{ passenger: 'Erika Mustermann', seat: '31C' }],
        departure: { place: { code: 'FRA', name: 'Frankfurt' }, at: { date: '2026-12-01', time: '10:15:00', offsetMinutes: 60, utc: '2026-12-01T09:15:00Z' } },
      }],
    };
    const [resolved] = resolveCards([pass], await loadAirportZones()) as TransportBooking[];
    const [event] = bookingToEvents(resolved, { senderDomain: 'lufthansa.com' });
    expect(event).toMatchObject({ start: '2026-12-01T10:15:00', timeZone: 'Europe/Berlin', duration: 'PT0S', title: 'LH 400 FRA' });
    expect(event.locations).not.toHaveProperty('arr');
  });
});

describe('bookingToEvents: fixed offsets', () => {
  const bus = (dep: string, arr: string) => ({
    '@context': ctx, '@type': 'BusReservation', reservationNumber: 'BX20471', underName: 'Erika Mustermann',
    reservationFor: {
      '@type': 'BusTrip', busNumber: 'N12', busCompany: { name: 'Coastline Coaches' },
      departureBusStop: { '@type': 'BusStation', name: 'Harbour Terminal' }, departureTime: dep,
      arrivalBusStop: { '@type': 'BusStation', name: 'Airport Stop 3' }, arrivalTime: arr,
    },
  });

  it('uses Etc/GMT+8 for a −08:00 time without a known zone, keeping the wall clock', async () => {
    const card = await booking(bus('2026-12-04T20:15:00-08:00', '2026-12-04T22:45:00-08:00'));
    const [event] = bookingToEvents(card, { senderDomain: 'coastline.test' });
    expect(event).toMatchObject({
      title: 'N12 Harbour Terminal → Airport Stop 3',
      start: '2026-12-04T20:15:00', timeZone: 'Etc/GMT+8', duration: 'PT2H30M',
      locations: { dep: { timeZone: 'Etc/GMT+8', relativeTo: 'start' }, arr: { timeZone: 'Etc/GMT+8', relativeTo: 'end' } },
    });
  });

  it('falls back to the UTC instant in Etc/UTC for a half-hour offset', async () => {
    const card = await booking(bus('2026-12-04T10:00:00+05:30', '2026-12-04T13:15:00+05:30'));
    const [event] = bookingToEvents(card, { senderDomain: 'coastline.test' });
    expect(event).toMatchObject({ start: '2026-12-04T04:30:00', timeZone: 'Etc/UTC', duration: 'PT3H15M' });
  });
});

describe('bookingToEvents: trains, stays, cars, events, tables', () => {
  it('names stations with their addresses and counts the extra hour of a DST change', async () => {
    // Berlin falls back from CEST to CET at 03:00 on 25 October 2026: 22:00 → 08:00 is 11 hours.
    const card = await booking({
      '@context': ctx, '@type': 'TrainReservation', reservationNumber: 'ZUG4711', underName: 'Erika Mustermann',
      reservationFor: {
        '@type': 'TrainTrip', trainNumber: 'NJ 40421', provider: { name: 'Nachtzug' },
        departureStation: { '@type': 'TrainStation', name: 'München Hbf', address: { streetAddress: 'Bayerstraße 10A', postalCode: '80335', addressLocality: 'München', addressCountry: 'DE' } },
        departureTime: '2026-10-24T22:00:00+02:00',
        arrivalStation: { '@type': 'TrainStation', name: 'Hamburg Hbf', address: { streetAddress: 'Hachmannplatz 16', postalCode: '20099', addressLocality: 'Hamburg', addressCountry: 'DE' } },
        arrivalTime: '2026-10-25T08:00:00+01:00',
      },
    }, '2026-10-20T10:00:00Z');
    const [event] = bookingToEvents(card, { senderDomain: 'nachtzug.test' });
    expect(event).toMatchObject({
      title: 'NJ 40421 München Hbf → Hamburg Hbf',
      start: '2026-10-24T22:00:00', timeZone: 'Europe/Berlin', duration: 'PT11H',
      locations: {
        dep: { name: 'München Hbf, Bayerstraße 10A, 80335 München', timeZone: 'Europe/Berlin', relativeTo: 'start' },
        arr: { name: 'Hamburg Hbf, Hachmannplatz 16, 20099 Hamburg', timeZone: 'Europe/Berlin', relativeTo: 'end' },
      },
    });
  });

  const hotel = (checkin: string, checkout: string) => ({
    '@context': ctx, '@type': 'LodgingReservation', reservationNumber: 'HB-88213', underName: 'Erika Mustermann',
    reservationFor: {
      '@type': 'Hotel', name: 'Hotel Adlon Kempinski', telephone: '+49 30 22610',
      address: { streetAddress: 'Unter den Linden 77', postalCode: '10117', addressLocality: 'Berlin', addressCountry: 'DE' },
    },
    checkinDate: checkin, checkoutDate: checkout,
  });

  it('makes a stay with dates only an all-day event that includes the check-out day', async () => {
    const card = await booking(hotel('2026-12-04', '2026-12-06'));
    const [event] = bookingToEvents(card, { senderDomain: 'kempinski.com' });
    expect(event).toMatchObject({
      title: 'Hotel Adlon Kempinski', start: '2026-12-04T00:00:00', showWithoutTime: true, timeZone: null,
      duration: 'P3D', freeBusyStatus: 'free',
      locations: { hotel: { name: 'Hotel Adlon Kempinski, Unter den Linden 77, 10117 Berlin' } },
    });
    expect(event.locations?.hotel).not.toHaveProperty('timeZone');
    expect(event.description).toContain('Phone: +49 30 22610');
  });

  it('makes a stay with times a timed, free event in the hotel zone', async () => {
    const card = await booking(hotel('2026-12-04T15:00:00+01:00', '2026-12-06T11:00:00+01:00'));
    const [event] = bookingToEvents(card, { senderDomain: 'kempinski.com' });
    expect(event).toMatchObject({
      start: '2026-12-04T15:00:00', timeZone: 'Europe/Berlin', duration: 'PT44H', showWithoutTime: false, freeBusyStatus: 'free',
      locations: { hotel: { timeZone: 'Europe/Berlin' } },
    });
  });

  it('maps a rental car from pickup to drop-off, marked free', async () => {
    const card = await booking({
      '@context': ctx, '@type': 'RentalCarReservation', reservationNumber: 'RC-55120', underName: 'Erika Mustermann',
      reservationFor: { '@type': 'RentalCar', name: 'Golf', brand: { name: 'VW' }, rentalCompany: { name: 'Sixt' } },
      pickupLocation: { '@type': 'Place', name: 'Sixt Berlin Hauptbahnhof', address: { addressLocality: 'Berlin', addressCountry: 'DE' } },
      pickupTime: '2026-12-04T09:00:00+01:00',
      dropoffLocation: { '@type': 'Place', name: 'Sixt Berlin Hauptbahnhof', address: { addressLocality: 'Berlin', addressCountry: 'DE' } },
      dropoffTime: '2026-12-07T18:00:00+01:00',
    });
    const [event] = bookingToEvents(card, { senderDomain: 'sixt.de' });
    expect(event).toMatchObject({
      title: 'Rental car: Sixt', start: '2026-12-04T09:00:00', timeZone: 'Europe/Berlin', duration: 'PT81H', freeBusyStatus: 'free',
      locations: { pickup: { relativeTo: 'start', timeZone: 'Europe/Berlin' }, dropoff: { relativeTo: 'end', timeZone: 'Europe/Berlin' } },
    });
    expect(event.description).toContain('Car: VW Golf');
  });

  const concert = (start: string, end?: string, address: Record<string, string> = { addressLocality: 'Berlin', addressCountry: 'DE' }) => ({
    '@context': ctx, '@type': 'EventReservation', reservationNumber: 'EV-30017', underName: 'Erika Mustermann',
    reservedTicket: { '@type': 'Ticket', ticketNumber: 'T-9001' },
    reservationFor: {
      '@type': 'Event', name: 'Grafikdesign: Illustrator-Workshop', startDate: start, ...(end ? { endDate: end } : {}),
      location: { '@type': 'Place', name: 'Werkstatt Mitte', address },
    },
  });

  it('gives an event without an end an explicit zero duration', async () => {
    const card = await booking(concert('2026-07-18T14:00:00+02:00'), '2026-06-01T10:00:00Z');
    const [event] = bookingToEvents(card, { senderDomain: 'workshops.test' });
    expect(event).toMatchObject({ start: '2026-07-18T14:00:00', timeZone: 'Europe/Berlin', duration: 'PT0S', locations: { venue: { name: 'Werkstatt Mitte, Berlin' } } });
    expect(event.description).toContain('Tickets: T-9001');
  });

  it('runs an event to its end, to the end of the day for a date-only end, and keeps floating times floating', async () => {
    const timed = await booking(concert('2026-07-18T14:00:00+02:00', '2026-07-18T19:00:00+02:00'), '2026-06-01T10:00:00Z');
    expect(bookingToEvents(timed, { senderDomain: 'workshops.test' })[0]).toMatchObject({ duration: 'PT5H', timeZone: 'Europe/Berlin' });
    const toDayEnd = await booking(concert('2026-07-18T14:00:00+02:00', '2026-07-18'), '2026-06-01T10:00:00Z');
    expect(bookingToEvents(toDayEnd, { senderDomain: 'workshops.test' })[0]).toMatchObject({ duration: 'PT9H59M59S' });
    const floating = await booking(concert('2026-07-18T14:00:00', '2026-07-18T16:30:00', { addressLocality: 'Somewhere' }), '2026-06-01T10:00:00Z');
    expect(bookingToEvents(floating, { senderDomain: 'workshops.test' })[0]).toMatchObject({ start: '2026-07-18T14:00:00', timeZone: null, duration: 'PT2H30M' });
  });

  it('makes a date-only event all-day over its days', async () => {
    const card = await booking(concert('2026-07-18', '2026-07-19'), '2026-06-01T10:00:00Z');
    expect(bookingToEvents(card, { senderDomain: 'workshops.test' })[0]).toMatchObject({
      start: '2026-07-18T00:00:00', showWithoutTime: true, timeZone: null, duration: 'P2D',
    });
  });

  it('books a table as a zero-length event with the party size', async () => {
    const card = await booking({
      '@context': ctx, '@type': 'FoodEstablishmentReservation', reservationNumber: 'TR-2207', underName: 'Erika Mustermann', partySize: 2,
      reservationFor: { '@type': 'Restaurant', name: 'Restaurant Tim Raue', address: { streetAddress: 'Rudi-Dutschke-Straße 26', postalCode: '10969', addressLocality: 'Berlin', addressCountry: 'DE' } },
      startTime: '2026-12-05T19:30:00+01:00',
    });
    const [event] = bookingToEvents(card, { senderDomain: 'tim-raue.de' });
    expect(event).toMatchObject({
      title: 'Restaurant Tim Raue', start: '2026-12-05T19:30:00', timeZone: 'Europe/Berlin', duration: 'PT0S',
      locations: { restaurant: { name: 'Restaurant Tim Raue, Rudi-Dutschke-Straße 26, 10969 Berlin', timeZone: 'Europe/Berlin' } },
    });
    expect(event.description).toBe('Booking reference: TR-2207\nParty size: 2\nAdded from a mail from tim-raue.de');
  });

  it('uses the labels it is given and names the mail subject', async () => {
    const card = await booking(SFO_JFK);
    const [event] = bookingToEvents(card, {
      senderDomain: 'mail.united.com',
      mailSubjectOrProvider: 'Your trip to New York',
      labels: { reference: (r) => `Buchungscode: ${r}` },
    });
    expect(event.description).toContain('Buchungscode: KT4M9Z');
    expect(event.description).toContain('Added from the mail "Your trip to New York" from united.com');
  });
});

describe('bookingEventUid', () => {
  const lh = (time: [string, string], extra: Partial<FlightSpec> = {}) => flight({
    airline: { name: 'Lufthansa', iataCode: 'LH' }, number: '400', ref: 'QX7K2M',
    dep: ['Frankfurt', 'FRA', time[0]], arr: ['New York JFK', 'JFK', time[1]], ...extra,
  });

  it('stays the same when the schedule changes, and the event then needs an update', async () => {
    const before = await booking(lh(['2026-12-01T10:15:00+01:00', '2026-12-01T13:05:00-05:00']));
    const after = await booking(lh(['2026-12-01T12:40:00+01:00', '2026-12-01T15:35:00-05:00']));
    const [old] = bookingToEvents(before, { senderDomain: 'lufthansa.com' });
    const [now] = bookingToEvents(after, { senderDomain: 'lufthansa.com' });
    expect(now.uid).toBe(old.uid);
    expect(eventNeedsUpdate(old as CalendarEvent, now)).toBe(true);
  });

  it('differs across sender domains and is shared by the subdomains of one', async () => {
    const card = await booking(lh(['2026-12-01T10:15:00+01:00', '2026-12-01T13:05:00-05:00']));
    expect(bookingEventUid(card, 'lufthansa.com')).not.toBe(bookingEventUid(card, 'lufthansa-deals.com'));
    expect(bookingEventUid(card, 'booking.flixbus.com')).toBe(bookingEventUid(card, 'flixbus.com'));
    expect(bookingEventUid(card, 'noreply@mail.lufthansa.com')).toBe(bookingEventUid(card, 'lufthansa.com'));
  });

  it('keys on the IATA code, and on the airline name only when there is no code', async () => {
    const times: [string, string] = ['2026-12-01T10:15:00+01:00', '2026-12-01T13:05:00-05:00'];
    const short = await booking(lh(times));
    const long = await booking(lh(times, { airline: { name: 'Deutsche Lufthansa AG', iataCode: 'LH' } }));
    expect(bookingEventUid(long, 'lufthansa.com')).toBe(bookingEventUid(short, 'lufthansa.com'));
    const nameOnly = await booking(lh(times, { airline: { name: 'Lufthansa' } }));
    const otherName = await booking(lh(times, { airline: { name: 'Lufthansa Group' } }));
    expect((nameOnly as TransportBooking).legs[0].carrierCode).toBeUndefined();
    expect(bookingEventUid(nameOnly, 'lufthansa.com')).not.toBe(bookingEventUid(otherName, 'lufthansa.com'));
    expect(bookingEventUid(nameOnly, 'lufthansa.com')).not.toBe(bookingEventUid(short, 'lufthansa.com'));
  });

  it('ignores leading zeros of the flight number, so a boarding pass finds the markup event', async () => {
    const times: [string, string] = ['2026-12-01T10:15:00+01:00', '2026-12-01T13:05:00-05:00'];
    const padded = (await booking(lh(times, { number: '0072' }))) as TransportBooking;
    const plain = (await booking(lh(times, { number: '72' }))) as TransportBooking;
    expect(padded.legs[0].number).toBe('0072');
    expect(bookingEventUid(padded, 'lufthansa.com')).toBe(bookingEventUid(plain, 'lufthansa.com'));
    const other = await booking(lh(times, { number: '720' }));
    expect(bookingEventUid(other, 'lufthansa.com')).not.toBe(bookingEventUid(plain, 'lufthansa.com'));
  });

  it('adds the departure date only when there is no reference', async () => {
    const noRef = (time: [string, string]) => ({ ...lh(time), reservationNumber: undefined });
    const day1 = await booking(noRef(['2026-12-01T10:15:00+01:00', '2026-12-01T13:05:00-05:00']));
    const day1Later = await booking(noRef(['2026-12-01T14:15:00+01:00', '2026-12-01T17:05:00-05:00']));
    const day2 = await booking(noRef(['2026-12-02T10:15:00+01:00', '2026-12-02T13:05:00-05:00']));
    expect(bookingEventUid(day1Later, 'lufthansa.com')).toBe(bookingEventUid(day1, 'lufthansa.com'));
    expect(bookingEventUid(day2, 'lufthansa.com')).not.toBe(bookingEventUid(day1, 'lufthansa.com'));
  });

  it('gives a leg the same uid whatever other legs the mail lists, and offers no event for legs that would share one', async () => {
    const day1 = lh(['2026-12-01T10:15:00+01:00', '2026-12-01T13:05:00-05:00']);
    const day8 = lh(['2026-12-08T10:15:00+01:00', '2026-12-08T13:05:00-05:00']);
    const back = flight({ airline: { name: 'Lufthansa', iataCode: 'LH' }, number: '401', ref: 'QX7K2M', dep: ['New York JFK', 'JFK', '2026-12-08T17:30:00-05:00'], arr: ['Frankfurt', 'FRA', '2026-12-09T07:20:00+01:00'] });
    const [both] = (await cards([day1, day8, back])) as TransportBooking[];
    const [one] = (await cards([day1, back])) as TransportBooking[];
    expect(both.legs).toHaveLength(3);
    expect(bookingEventUid(both, 'lufthansa.com', both.legs[0])).toBe(bookingEventUid(one, 'lufthansa.com', one.legs[0]));
    expect(bookingEventUid(both, 'lufthansa.com', both.legs[2])).toBe(bookingEventUid(one, 'lufthansa.com', one.legs[1]));
    // LH 400 FRA twice under one reference: one uid can't hold both, so neither is offered (nor removed); LH 401 still is.
    const slots = bookingEventSlots(both, { senderDomain: 'lufthansa.com' });
    expect(slots.map((slot) => [slot.event !== null, slot.cancelled])).toEqual([[false, false], [false, false], [true, false]]);
    expect(bookingToEvents(both, { senderDomain: 'lufthansa.com' }).map((e) => e.title)).toEqual(['LH 401 JFK → FRA']);
  });

  it('ignores spaces in train numbers', async () => {
    const train = (number: string) => ({
      '@context': ctx, '@type': 'TrainReservation', reservationNumber: 'ZUG577',
      reservationFor: {
        '@type': 'TrainTrip', trainNumber: number, provider: { name: 'DB' },
        departureStation: { name: 'Hannover Hbf', address: { addressCountry: 'DE' } }, departureTime: '2026-12-01T10:00:00+01:00',
        arrivalStation: { name: 'Berlin Hbf', address: { addressCountry: 'DE' } }, arrivalTime: '2026-12-01T11:40:00+01:00',
      },
    });
    const spaced = await booking(train('ICE 577'));
    expect(bookingEventUid(spaced, 'bahn.de')).toBe(bookingEventUid(await booking(train('ICE577')), 'bahn.de'));
    expect(bookingEventUid(spaced, 'bahn.de')).not.toBe(bookingEventUid(await booking(train('ICE 578')), 'bahn.de'));
  });

  it('keeps the uid of a rescheduled car, event or table that has a reference, and keys on the date without one', async () => {
    const table = (ref: string | undefined, start: string) => ({
      '@context': ctx, '@type': 'FoodEstablishmentReservation', ...(ref ? { reservationNumber: ref } : {}), partySize: 2,
      reservationFor: { '@type': 'Restaurant', name: 'Restaurant Tim Raue', address: { addressCountry: 'DE' } }, startTime: start,
    });
    const car = (ref: string | undefined, pickup: string, dropoff: string) => ({
      '@context': ctx, '@type': 'RentalCarReservation', ...(ref ? { reservationNumber: ref } : {}),
      reservationFor: { '@type': 'RentalCar', name: 'Golf', rentalCompany: { name: 'Sixt' } },
      pickupLocation: { name: 'Sixt Berlin', address: { addressCountry: 'DE' } }, pickupTime: pickup,
      dropoffLocation: { name: 'Sixt Berlin', address: { addressCountry: 'DE' } }, dropoffTime: dropoff,
    });
    const show = (ref: string | undefined, name: string, start: string) => ({
      '@context': ctx, '@type': 'EventReservation', ...(ref ? { reservationNumber: ref } : {}),
      reservationFor: { '@type': 'Event', name, startDate: start, location: { name: 'Werkstatt', address: { addressCountry: 'DE' } } },
    });
    const uid = async (item: unknown) => bookingEventUid(await booking(item), 'example-tickets.de');
    expect(await uid(table('TR-1', '2026-12-05T19:30:00+01:00'))).toBe(await uid(table('TR-1', '2026-12-06T20:00:00+01:00')));
    expect(await uid(table(undefined, '2026-12-05T19:30:00+01:00'))).not.toBe(await uid(table(undefined, '2026-12-06T19:30:00+01:00')));
    expect(await uid(car('RC-1', '2026-12-04T09:00:00+01:00', '2026-12-07T18:00:00+01:00'))).toBe(await uid(car('RC-1', '2026-12-05T09:00:00+01:00', '2026-12-08T18:00:00+01:00')));
    expect(await uid(car(undefined, '2026-12-04T09:00:00+01:00', '2026-12-07T18:00:00+01:00'))).not.toBe(await uid(car(undefined, '2026-12-05T09:00:00+01:00', '2026-12-08T18:00:00+01:00')));
    expect(await uid(show('EV-1', 'Workshop', '2026-12-05T14:00:00+01:00'))).toBe(await uid(show('EV-1', 'Workshop', '2026-12-12T14:00:00+01:00')));
    // One order, two events: the name keeps them apart.
    expect(await uid(show('EV-1', 'Workshop', '2026-12-05T14:00:00+01:00'))).not.toBe(await uid(show('EV-1', 'Concert', '2026-12-05T14:00:00+01:00')));
    expect(await uid(show(undefined, 'Workshop', '2026-12-05T14:00:00+01:00'))).not.toBe(await uid(show(undefined, 'Workshop', '2026-12-12T14:00:00+01:00')));
  });

  it('keys stays on reference and hotel, adding the check-in date only without reference', async () => {
    const stay = (ref: string | undefined, checkin: string) => ({
      '@context': ctx, '@type': 'LodgingReservation', ...(ref ? { reservationNumber: ref } : {}),
      reservationFor: { '@type': 'Hotel', name: 'Hotel Adlon Kempinski' }, checkinDate: checkin, checkoutDate: '2026-12-09',
    });
    const a = await booking(stay('HB-1', '2026-12-04'));
    const moved = await booking(stay('HB-1', '2026-12-05'));
    expect(bookingEventUid(moved, 'kempinski.com')).toBe(bookingEventUid(a, 'kempinski.com'));
    const b = await booking(stay(undefined, '2026-12-04'));
    const c = await booking(stay(undefined, '2026-12-05'));
    expect(bookingEventUid(b, 'kempinski.com')).not.toBe(bookingEventUid(c, 'kempinski.com'));
  });
});

describe('eventNeedsUpdate', () => {
  /** What CalendarEvent/get returns for an event created from `wanted`. */
  function serverShaped(wanted: Partial<CalendarEvent>): CalendarEvent {
    const locations = Object.fromEntries(Object.entries(wanted.locations ?? {}).map(([id, loc]) => [id, {
      ...loc, description: null, locationTypes: null, coordinates: null, links: null,
      timeZone: loc.timeZone ?? null, relativeTo: loc.relativeTo ?? null, iCalendar: { name: 'vlocation' },
    }]));
    return {
      id: 'b', calendarIds: { a: true }, isDraft: false, isOrigin: true, utcStart: '2026-12-05T04:15:00Z', utcEnd: '2026-12-05T11:30:00Z',
      sequence: 0, created: '2026-10-30T10:00:00Z', updated: '2026-10-30T10:00:00Z', status: 'confirmed', freeBusyStatus: 'busy',
      privacy: 'public', color: null, keywords: null, categories: null, locale: null, replyTo: null, organizerCalendarAddress: null,
      participants: null, recurrenceRules: null, recurrenceOverrides: null, alerts: null, useDefaultAlerts: false, virtualLocations: null, links: null,
      ...wanted,
      locations,
    } as unknown as CalendarEvent;
  }

  it('sees no change in the event the server gives back for the same booking', async () => {
    const [wanted] = bookingToEvents(await booking(SFO_JFK), SENDER);
    expect(eventNeedsUpdate(serverShaped(wanted), wanted)).toBe(false);
  });

  it('sees a changed start, duration, zone or location', async () => {
    const [wanted] = bookingToEvents(await booking(SFO_JFK), SENDER);
    const stored = serverShaped(wanted);
    expect(eventNeedsUpdate({ ...stored, start: '2026-12-04T21:15:00' }, wanted)).toBe(true);
    expect(eventNeedsUpdate({ ...stored, duration: 'PT7H' }, wanted)).toBe(true);
    expect(eventNeedsUpdate({ ...stored, timeZone: 'America/Denver' }, wanted)).toBe(true);
    expect(eventNeedsUpdate({ ...stored, locations: { ...stored.locations, arr: { ...stored.locations!.arr, timeZone: 'America/Chicago' } } }, wanted)).toBe(true);
    expect(eventNeedsUpdate({ ...stored, locations: { dep: stored.locations!.dep } }, wanted)).toBe(true);
  });

  it('does not compare titles or descriptions: the user may rename the event or write notes', async () => {
    const [wanted] = bookingToEvents(await booking(SFO_JFK), SENDER);
    expect(eventNeedsUpdate({ ...serverShaped(wanted), title: 'Flight to New York', description: 'my notes' }, wanted)).toBe(false);
  });

  it('ignores the zone of two all-day events', async () => {
    const stay = await booking({
      '@context': ctx, '@type': 'LodgingReservation', reservationNumber: 'HB-3', reservationFor: { '@type': 'Hotel', name: 'Hotel' },
      checkinDate: '2026-12-04', checkoutDate: '2026-12-06',
    });
    const [wanted] = bookingToEvents(stay, { senderDomain: 'hotel.test' });
    expect(eventNeedsUpdate({ ...serverShaped(wanted), timeZone: 'Europe/Berlin' }, wanted)).toBe(false);
    expect(eventNeedsUpdate({ ...serverShaped(wanted), duration: 'P2D' }, wanted)).toBe(true);
  });

  it('sees no change in a midnight-to-midnight span the store saved as all-day', async () => {
    const card = await booking({
      '@context': ctx, '@type': 'RentalCarReservation', reservationNumber: 'RC-0000',
      reservationFor: { '@type': 'RentalCar', name: 'Golf', rentalCompany: { name: 'Sixt' } },
      pickupLocation: { name: 'Sixt Berlin', address: { addressCountry: 'DE' } }, pickupTime: '2026-12-04T00:00:00+01:00',
      dropoffLocation: { name: 'Sixt Berlin', address: { addressCountry: 'DE' } }, dropoffTime: '2026-12-07T00:00:00+01:00',
    });
    const [wanted] = bookingToEvents(card, { senderDomain: 'sixt.de' });
    expect(wanted).toMatchObject({ start: '2026-12-04T00:00:00', duration: 'PT72H', timeZone: 'Europe/Berlin' });
    // What the store's createEvent sends, and what its lookup turns the server's answer into.
    const sent = sanitizeOutgoingCalendarEventData({ ...wanted });
    expect(sent).toMatchObject({ showWithoutTime: true, duration: 'P3D', timeZone: null });
    const readBack = normalizeCalendarEventLike(serverShaped(sent));
    expect(eventNeedsUpdate(readBack, wanted)).toBe(false);
    expect(bookingEventPatch(readBack, wanted, 'sixt.de')).toEqual({});
  });

  it('patches only what moved, and keeps the user\'s title, notes and own locations', async () => {
    const before = await booking(SFO_JFK);
    const after = await booking({ ...SFO_JFK, reservationFor: { ...SFO_JFK.reservationFor, departureTime: '2026-12-04T21:00:00-08:00', arrivalTime: '2026-12-05T07:15:00-05:00' } });
    const [old] = bookingToEvents(before, SENDER);
    const [now] = bookingToEvents(after, SENDER);
    const mine = { '@type': 'Location', name: 'Gate B12' } as CalendarEvent['locations'] extends Record<string, infer L> | null ? L : never;
    const edited = { ...serverShaped(old), title: 'Flight to New York', description: `${old.description}\nmy notes`, locations: { ...serverShaped(old).locations, mine } };
    const patch = bookingEventPatch(edited, now, 'united.com');
    expect(patch).toEqual({ start: '2026-12-04T21:00:00', duration: 'PT7H15M', timeZone: 'America/Los_Angeles', showWithoutTime: false });
    expect(patch).not.toHaveProperty('title');
    expect(patch).not.toHaveProperty('description');
    expect(patch).not.toHaveProperty('locations');

    const diverted = await booking({ ...SFO_JFK, reservationFor: { ...SFO_JFK.reservationFor, arrivalAirport: { '@type': 'Airport', name: 'Newark Liberty International Airport', iataCode: 'EWR' } } });
    const [toEwr] = bookingToEvents(diverted, SENDER);
    const locationPatch = bookingEventPatch(edited, toEwr, 'united.com');
    expect(locationPatch.locations).toMatchObject({ mine: { name: 'Gate B12' }, arr: { name: 'Newark Liberty International Airport (EWR)' } });
    expect(locationPatch).not.toHaveProperty('title');
    expect(locationPatch).not.toHaveProperty('start');
  });

  it('updates title and description while the description is still the generated one', async () => {
    const [old] = bookingToEvents(await booking(SFO_JFK), SENDER);
    const diverted = await booking({ ...SFO_JFK, reservationFor: { ...SFO_JFK.reservationFor, arrivalAirport: { '@type': 'Airport', name: 'Newark Liberty International Airport', iataCode: 'EWR' } } });
    const [toEwr] = bookingToEvents(diverted, { ...SENDER, mailSubjectOrProvider: 'Change to your flight' });
    const patch = bookingEventPatch(serverShaped(old), toEwr, 'united.com');
    expect(patch).toMatchObject({ title: 'UA 110 SFO → EWR', description: toEwr.description });
    expect(bookingEventPatch(serverShaped(old), toEwr)).not.toHaveProperty('title');
  });
});

describe('bookingEndsAt', () => {
  it('ends a trip at its last arrival and a stay at the end of the check-out day', async () => {
    expect(bookingEndsAt(await booking(SFO_JFK))).toBe(Date.parse('2026-12-05T11:30:00Z'));
    const stay = await booking({
      '@context': ctx, '@type': 'LodgingReservation', reservationNumber: 'HB-2', reservationFor: { '@type': 'Hotel', name: 'Hotel' },
      checkinDate: '2026-12-04', checkoutDate: '2026-12-06',
    });
    expect(bookingEndsAt(stay)).toBe(new Date(2026, 11, 7).getTime());
  });
});
