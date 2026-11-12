// Honest booking, travel, parcel and order mail in the shapes large senders use, each from its own
// domain. Names with an abbreviation glued to the next word ("St.Pölten Hbf", "Dr.Oetker",
// "E.Mustermann") end in no top-level domain, so the card shows them. A real domain of another site
// ("notebooksbilliger.de" on a DHL card, "Booking.com" in a hotel's name, "will.i.am") is still left
// out, as every text that names another domain is.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    if (key === 'route') return `${params!.from} to ${params!.to}`;
    return params ? `${key}${JSON.stringify(params)}` : key;
  },
  useLocale: () => 'en',
}));

import { loadAirportZones, readStructuredMail, resolveCards, type StructuredCard } from '@/lib/structured-mail';
import { useSettingsStore } from '@/stores/settings-store';
import { loadTopLevelDomains, namesOtherDomain } from '../card-parts';
import { StructuredMailCards } from '../structured-mail-cards';

const CTX = 'http://schema.org';
const page = (...items: unknown[]) => `<html><head>${items.map((item) => `<script type="application/ld+json">${JSON.stringify(item)}</script>`).join('')}</head><body><p>Hello</p></body></html>`;
async function cardsOf(...items: unknown[]): Promise<StructuredCard[]> {
  return resolveCards(readStructuredMail(page(...items), { mailDate: new Date('2026-11-01T09:00:00Z') }), await loadAirportZones());
}
function shown(cards: StructuredCard[], from: string): string {
  render(<StructuredMailCards cards={cards} email={{ id: 'm1', from: [{ email: from }] }} allowRemoteImages={false} />);
  return screen.getByTestId('structured-mail-cards').textContent ?? '';
}

const person = (name: string) => ({ '@type': 'Person', name });
const station = (name: string) => ({ '@type': 'TrainStation', name });

const initialSettings = useSettingsStore.getState();
beforeAll(() => loadTopLevelDomains());
beforeEach(() => { useSettingsStore.setState({ timeFormat: '24h', timeZone: 'Europe/Berlin' }); });
afterEach(() => { cleanup(); useSettingsStore.setState(initialSettings, true); });

interface Case { name: string; from: string; items: unknown[]; keep: string[]; leftOut?: string[] }

const CASES: Case[] = [
  {
    name: 'ÖBB train to St.Pölten (ÖBB writes station names without a space)',
    from: 'tickets@oebb.at',
    items: [{ '@context': CTX, '@type': 'TrainReservation', reservationNumber: '1234 5678 9012', underName: person('Erika Mustermann'),
      reservationFor: { '@type': 'TrainTrip', trainNumber: 'RJX 662', provider: { '@type': 'Organization', name: 'ÖBB-Personenverkehr AG' },
        departureStation: station('Wien Hbf'), departureTime: '2026-12-01T10:30:00+01:00', arrivalStation: station('St.Pölten Hbf'), arrivalTime: '2026-12-01T10:55:00+01:00' } }],
    keep: ['Wien Hbf', 'St.Pölten Hbf', 'RJX 662', 'Erika Mustermann'],
  },
  {
    name: 'DB train Saarbrücken to St.Ingbert, return from Bad Homburg v.d.Höhe',
    from: 'buchungsbestaetigung@bahn.de',
    items: [
      { '@context': CTX, '@type': 'TrainReservation', reservationNumber: 'Q7XK2M', underName: person('Erika Mustermann'),
        reservationFor: { '@type': 'TrainTrip', trainNumber: 'RB 71', provider: { '@type': 'Organization', name: 'DB Regio AG' },
          departureStation: station('Saarbrücken Hbf'), departureTime: '2026-12-02T08:04:00+01:00', arrivalStation: station('St.Ingbert'), arrivalTime: '2026-12-02T08:19:00+01:00' } },
      { '@context': CTX, '@type': 'TrainReservation', reservationNumber: 'Q7XK2N', underName: person('Erika Mustermann'),
        reservationFor: { '@type': 'TrainTrip', trainNumber: 'S 5', provider: { '@type': 'Organization', name: 'DB Regio AG' },
          departureStation: station('Bad Homburg v.d.Höhe'), departureTime: '2026-12-03T17:12:00+01:00', arrivalStation: station('Frankfurt (Main) Hbf'), arrivalTime: '2026-12-03T17:40:00+01:00' } },
    ],
    keep: ['St.Ingbert', 'Bad Homburg v.d.Höhe', 'Saarbrücken Hbf'],
  },
  {
    name: 'FlixBus to St.Gallen',
    from: 'noreply@flixbus.de',
    items: [{ '@context': CTX, '@type': 'BusReservation', reservationNumber: '3012345678', underName: person('Erika Mustermann'),
      reservationFor: { '@type': 'BusTrip', busNumber: 'N1234', provider: { '@type': 'Organization', name: 'FlixBus' },
        departureBusStop: { '@type': 'BusStation', name: 'München ZOB' }, departureTime: '2026-12-04T07:00:00+01:00',
        arrivalBusStop: { '@type': 'BusStation', name: 'St.Gallen' }, arrivalTime: '2026-12-04T10:40:00+01:00' } }],
    keep: ['München ZOB', 'St.Gallen'],
  },
  {
    name: 'Lufthansa flight, passengers written with initials',
    from: 'online@booking-lufthansa.com',
    items: [{ '@context': CTX, '@type': 'FlightReservation', reservationNumber: 'RD02XZ',
      underName: [person('J.R.R. Tolkien'), person('E.Mustermann'), person('Dr.Max Mustermann')],
      reservationFor: { '@type': 'Flight', flightNumber: 'LH400', airline: { '@type': 'Airline', name: 'Lufthansa', iataCode: 'LH' },
        departureAirport: { '@type': 'Airport', name: 'Frankfurt Airport', iataCode: 'FRA' }, departureTime: '2026-12-01T10:15:00+01:00',
        arrivalAirport: { '@type': 'Airport', name: 'John F. Kennedy International Airport', iataCode: 'JFK' }, arrivalTime: '2026-12-01T13:05:00-05:00' },
      checkinUrl: 'https://www.aircanada.com/checkin' }],
    keep: ['Lufthansa', 'J.R.R. Tolkien', 'E.Mustermann', 'Dr.Max Mustermann'],
  },
  {
    name: 'Hotel booked on Booking.com, mail from booking.com',
    from: 'noreply@booking.com',
    items: [{ '@context': CTX, '@type': 'LodgingReservation', reservationNumber: '4012345678', underName: person('Erika Mustermann'),
      provider: { '@type': 'Organization', name: 'Booking.com' },
      reservationFor: { '@type': 'LodgingBusiness', name: 'Hotel St.Georg', telephone: '+49 30 1234567',
        address: { '@type': 'PostalAddress', streetAddress: 'Str. des 17.Juni 106', addressLocality: 'Berlin', postalCode: '10623', addressCountry: 'DE' } },
      checkinTime: '2026-12-04T15:00:00+01:00', checkoutTime: '2026-12-06T11:00:00+01:00' }],
    keep: ['Hotel St.Georg', 'Str. des 17.Juni 106'],
  },
  {
    name: 'Hotel confirmation sent by the hotel, naming the booking site',
    from: 'reservierung@hotel-am-markt.de',
    items: [{ '@context': CTX, '@type': 'LodgingReservation', reservationNumber: 'HAM-2211', underName: person('Erika Mustermann'),
      reservationFor: { '@type': 'LodgingBusiness', name: 'Hotel Am Markt (über Booking.com)', telephone: '+49 40 123456',
        address: { '@type': 'PostalAddress', streetAddress: 'Marktplatz 1', addressLocality: 'Hamburg', postalCode: '20095' } },
      checkinTime: '2026-12-04T15:00:00+01:00', checkoutTime: '2026-12-06T11:00:00+01:00' }],
    keep: ['Marktplatz 1', 'Erika Mustermann'],
    leftOut: ['Booking.com'],
  },
  {
    name: 'DHL parcel from notebooksbilliger.de with typical item names',
    from: 'noreply@dhl.de',
    items: [{ '@context': CTX, '@type': 'ParcelDelivery', trackingNumber: '00340434161234567890', carrier: { '@type': 'Organization', name: 'DHL Paket' },
      expectedArrivalUntil: '2026-12-05',
      partOfOrder: { '@type': 'Order', orderNumber: '12345678', merchant: { '@type': 'Organization', name: 'notebooksbilliger.de' } },
      itemShipped: [{ '@type': 'Product', name: 'Vitamin B.Complex 100 Kapseln' }, { '@type': 'Product', name: 'Dr.Oetker Pizza Ristorante' }, { '@type': 'Product', name: 'T-Shirt Gr.XL' }, { '@type': 'Product', name: 'HDMI-Kabel v2.1, 9.99 EUR' }] }],
    // The card lists three items and counts all four.
    keep: ['Vitamin B.Complex', 'Dr.Oetker', 'Gr.XL', 'items_more{"count":1}', 'items_count{"count":4}', 'DHL Paket'],
    leftOut: ['notebooksbilliger'],
  },
  {
    name: 'Amazon order from amazon.de (own domain in the merchant name)',
    from: 'auto-confirm@amazon.de',
    items: [{ '@context': CTX, '@type': 'Order', orderNumber: '302-1234567-1234567', merchant: { '@type': 'Organization', name: 'Amazon.de' },
      price: '59.98', priceCurrency: 'EUR',
      acceptedOffer: [
        { '@type': 'Offer', itemOffered: { '@type': 'Product', name: 'Dr.Hauschka Rosen Tagescreme 30ml' } },
        { '@type': 'Offer', itemOffered: { '@type': 'Product', name: 'Echo Dot (5. Gen., 2022)' } },
        { '@type': 'Offer', itemOffered: { '@type': 'Product', name: 'e.l.f. Power Grip Primer' } },
      ] }],
    keep: ['Amazon.de', 'Dr.Hauschka', 'Echo Dot', 'e.l.f.'],
  },
  {
    name: 'Eventim concert tickets',
    from: 'noreply@eventim.de',
    items: [{ '@context': CTX, '@type': 'EventReservation', reservationNumber: '987654321', underName: person('Erika Mustermann'),
      reservationFor: { '@type': 'Event', name: 'will.i.am – Live in Hamburg', startDate: '2026-12-05T20:00:00+01:00',
        location: { '@type': 'Place', name: 'Barclays Arena', address: { '@type': 'PostalAddress', streetAddress: 'Sylvesterallee 10', addressLocality: 'Hamburg' } } },
      ticketNumber: 'EV-1234-5678' }],
    keep: ['Barclays Arena', 'EV-1234-5678'],
    leftOut: ['will.i.am'],
  },
  {
    name: 'OpenTable table, restaurant name with an abbreviation',
    from: 'no-reply@opentable.de',
    items: [{ '@context': CTX, '@type': 'FoodEstablishmentReservation', reservationNumber: 'OT-55', underName: person('Erika Mustermann'), partySize: 2,
      reservationFor: { '@type': 'FoodEstablishment', name: 'St.Pauli Fischerhaus', address: { '@type': 'PostalAddress', streetAddress: 'St.-Pauli-Fischmarkt 14', addressLocality: 'Hamburg' } },
      startTime: '2026-12-05T19:30:00+01:00' }],
    keep: ['St.Pauli Fischerhaus', 'St.-Pauli-Fischmarkt 14'],
  },
  {
    name: 'Sixt rental car',
    from: 'reservierung@sixt.de',
    items: [{ '@context': CTX, '@type': 'RentalCarReservation', reservationNumber: '9876543210', underName: person('Erika Mustermann'),
      reservationFor: { '@type': 'Car', name: 'VW Golf o.ä.', rentalCompany: { '@type': 'Organization', name: 'Sixt GmbH & Co. Autovermietung KG' } },
      pickupLocation: { '@type': 'Place', name: 'Sixt St.Gallen Bahnhof' }, pickupTime: '2026-12-04T09:00:00+01:00',
      dropoffLocation: { '@type': 'Place', name: 'Sixt Zürich Flughafen' }, dropoffTime: '2026-12-07T18:00:00+01:00' }],
    keep: ['VW Golf o.ä.', 'Sixt St.Gallen Bahnhof', 'Sixt Zürich Flughafen'],
  },
];

describe('honest mail keeps its text', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const cards = await cardsOf(...c.items);
    expect(cards.length).toBeGreaterThan(0);
    const text = shown(cards, c.from);
    expect(c.keep.filter((k) => !text.includes(k))).toEqual([]);
    expect((c.leftOut ?? []).filter((k) => text.includes(k))).toEqual([]);
  });

  it('shows the 14 names with an abbreviation glued to a word', () => {
    const names = ['St.Pölten Hbf', 'St.Ingbert', 'Bad Homburg v.d.Höhe', 'St.Gallen', 'E.Mustermann', 'Dr.Max Mustermann', 'Hotel St.Georg',
      'Str. des 17.Juni 106', 'Vitamin B.Complex 100 Kapseln', 'Dr.Oetker Pizza Ristorante', 'T-Shirt Gr.XL', 'Dr.Hauschka Rosen Tagescreme',
      'St.Pauli Fischerhaus', 'Sixt St.Gallen Bahnhof'];
    expect(names).toHaveLength(14);
    expect(names.filter((t) => namesOtherDomain(t, 'shop.example'))).toEqual([]);
  });

  it('shows ordinary dotted text that is no domain', () => {
    const texts = ['9.99 EUR', '10.30 Uhr', 'v2.1', 'J.R.R. Tolkien', 'z.B.', 'e.g.', 'Gr.42', 'Price 129.90', 'Hamburg Hbf.', 'Verein e.V.',
      'Frankfurt a.M.', 'Gr.L', 'No.5', 'Chanel No.5', 'Mr.Bean Live', 'Echo Dot (5. Gen., 2022)', 'e.l.f.'];
    expect(texts.filter((t) => namesOtherDomain(t, 'shop.example'))).toEqual([]);
  });
});
