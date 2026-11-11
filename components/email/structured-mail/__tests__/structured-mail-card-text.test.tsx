// A booking card shows no text that names a domain other than the verified sender's, in any field
// and in any spelling that reads the same on screen. The cards here are read from markup as the
// reader reads it (readStructuredMail), not from edited fixtures:
//
// 1. The airline, train or bus company of a booking is the card's `provider` and also each leg's
//    `carrier` (lib/structured-mail/normalize.ts); the leg row prints the carrier.
// 2. A domain can be spelled with characters a reader does not see next to the dot, with a dot
//    look-alike, with a hyphen after the name, or after a long text.
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    if (key === 'route') return `${params!.from} to ${params!.to}`;
    return params ? `${key}${JSON.stringify(params)}` : key;
  },
  useLocale: () => 'en',
}));

import { loadAirportZones, readStructuredMail, resolveCards, type StructuredCard } from '@/lib/structured-mail';
import { useSettingsStore } from '@/stores/settings-store';
import { brandText, namesOtherDomain } from '../card-parts';
import { StructuredMailCards } from '../structured-mail-cards';

const char = (code: number) => String.fromCharCode(code);
const OTHER = 'bigbank.example';
const page = (...items: unknown[]) => `<html><head>${items.map((item) => `<script type="application/ld+json">${JSON.stringify(item)}</script>`).join('')}</head><body><p>Hello</p></body></html>`;

async function cardsOf(...items: unknown[]): Promise<StructuredCard[]> {
  return resolveCards(readStructuredMail(page(...items), { mailDate: new Date('2026-11-01T09:00:00Z') }), await loadAirportZones());
}
const show = (cards: StructuredCard[]) => render(<StructuredMailCards cards={cards} email={{ id: 'm1', from: [{ email: 'orders@shop.example' }] }} allowRemoteImages={false} />);
const shownText = () => screen.getByTestId('structured-mail-cards').textContent ?? '';
/** The text as a reader sees it: without the characters that have no width. */
const INVISIBLE = new RegExp('[' + char(0x200b) + char(0x200c) + char(0x200d) + char(0x2060) + char(0xfeff) + char(0xad) + ']', 'g');
const visible = (text: string) => text.replace(INVISIBLE, '').toLowerCase();

const flight = (airline: string) => ({
  '@context': 'http://schema.org', '@type': 'FlightReservation', reservationNumber: 'RD02XZ',
  reservationStatus: 'http://schema.org/ReservationConfirmed', underName: { '@type': 'Person', name: 'Erika Mustermann' },
  reservationFor: {
    '@type': 'Flight', flightNumber: '400', airline: { '@type': 'Airline', name: airline, iataCode: 'LH' },
    departureAirport: { '@type': 'Airport', name: 'Frankfurt Airport', iataCode: 'FRA' }, departureTime: '2026-12-01T10:15:00+01:00',
    arrivalAirport: { '@type': 'Airport', name: 'John F. Kennedy International Airport', iataCode: 'JFK' }, arrivalTime: '2026-12-01T13:05:00-05:00',
  },
});
const train = (company: string) => ({
  '@context': 'http://schema.org', '@type': 'TrainReservation', reservationNumber: 'TR77', reservationStatus: 'http://schema.org/ReservationConfirmed',
  underName: { '@type': 'Person', name: 'Erika Mustermann' },
  reservationFor: {
    '@type': 'TrainTrip', trainNumber: 'ICE 123', provider: { '@type': 'Organization', name: company },
    departureStation: { '@type': 'TrainStation', name: 'Hamburg Hbf' }, departureTime: '2026-12-01T10:15:00+01:00',
    arrivalStation: { '@type': 'TrainStation', name: 'Berlin Hbf' }, arrivalTime: '2026-12-01T12:05:00+01:00',
  },
});

const initialSettings = useSettingsStore.getState();
beforeEach(() => { useSettingsStore.setState({ timeFormat: '24h', timeZone: 'Europe/Berlin' }); });
afterEach(() => { useSettingsStore.setState(initialSettings, true); });

describe('brand text of another domain in a card from orders@shop.example', () => {
  it('control: the sender\'s own airline is named in the heading and in the leg row', async () => {
    const cards = await cardsOf(flight('Shop Air'));
    expect(cards).toHaveLength(1);
    show(cards);
    expect(shownText()).toContain('kind_flight · Shop Air · card_sender{"domain":"shop.example"}');
    expect(screen.getByTestId('structured-mail-leg').textContent).toContain('Shop Air');
  });

  it('a flight whose airline name is another domain shows that domain nowhere, the leg row included', async () => {
    const cards = await cardsOf(flight(`${OTHER} Air`));
    expect(cards).toHaveLength(1);
    show(cards);
    // The heading already leaves it out.
    expect(shownText()).toContain('kind_flight · card_sender{"domain":"shop.example"}');
    expect(screen.getByTestId('structured-mail-leg').textContent?.toLowerCase()).not.toContain(OTHER);
    expect(shownText().toLowerCase()).not.toContain(OTHER);
  });

  it('a train whose company name is another domain shows that domain nowhere', async () => {
    const cards = await cardsOf(train(`Tickets by ${OTHER}`));
    expect(cards).toHaveLength(1);
    show(cards);
    expect(shownText().toLowerCase()).not.toContain(OTHER);
  });
});

describe('spellings of another domain in brand text', () => {
  it('control: the plain spellings are left out, the sender\'s own stay', () => {
    for (const text of [OTHER, 'BIGBANK.EXAMPLE', `www.${OTHER}`, `https://${OTHER}/login`, `service@${OTHER}`, `Travel by ${OTHER}`]) {
      expect(brandText(text, 'shop.example'), text).toBeUndefined();
    }
    expect(brandText('Shop Air', 'shop.example')).toBe('Shop Air');
    expect(brandText('pay.shop.example', 'shop.example')).toBe('pay.shop.example');
  });

  // Each of these is read on screen as "bigbank.example", or as a host of that name.
  it.each<[string, string]>([
    ['a zero width space after the dot', `bigbank.${char(0x200b)}example`],
    ['a zero width space before the dot', `bigbank${char(0x200b)}.example`],
    ['a soft hyphen after the dot', `bigbank.${char(0xad)}example`],
    ['a word joiner after the dot', `bigbank.${char(0x2060)}example`],
    ['a one dot leader for the dot', `bigbank${char(0x2024)}example`],
    ['a fullwidth full stop for the dot', `bigbank${char(0xff0e)}example`],
    ['an ideographic full stop for the dot', `bigbank${char(0x3002)}example`],
    ['a halfwidth ideographic full stop for the dot', `bigbank${char(0xff61)}example`],
    ['a variation selector next to the dot', `bigbank.${char(0xfe0f)}example`],
    ['a direction mark inside the name', `big${char(0x200e)}bank.example`],
    ['fullwidth letters', 'ｂｉｇｂａｎｋ．ｅｘａｍｐｌｅ'],
    ['a hyphen right after the name', 'bigbank.example-secure'],
    ['a punycode top-level domain', 'bigbank.xn--p1ai'],
    ['the domain after 200 characters of other text', `${'Reisen '.repeat(30)}${OTHER}`],
  ])('leaves out %s', (_name, text) => {
    expect(brandText(text, 'shop.example')).toBeUndefined();
  });

  it('keeps ordinary names with dots in them that are no host names', () => {
    for (const text of ['J.R.R. Tolkien', 'St.-Georg-Str. 5', 'Gr. 42', 'Price 129.90', 'Hamburg Hbf.', 'Verein e.V.']) {
      expect(namesOtherDomain(text, 'shop.example'), text).toBe(false);
    }
  });

  it('a merchant name with a zero width space after the dot does not read as that domain, from markup to card', async () => {
    const cards = await cardsOf({ '@context': 'http://schema.org', '@type': 'Order', orderNumber: 'SO-1', merchant: { '@type': 'Organization', name: `bigbank.${char(0x200b)}example` } });
    expect(cards).toHaveLength(1);
    show(cards);
    expect(visible(shownText())).not.toContain(OTHER);
  });
});

// Every text a card writes goes through the same check: places, addresses, passengers, seats,
// tickets, item names, numbers. Only the host shown on a button stays as it is, with its mark.
describe('every text a card shows', () => {
  const OTHER_ZW = `bigbank.${char(0x200b)}example`;

  it('leaves out each field that names another domain, and keeps the others', async () => {
    const cards = await cardsOf(
      {
        '@context': 'http://schema.org', '@type': 'EventReservation', reservationNumber: `EV-${OTHER}`,
        underName: [{ '@type': 'Person', name: `Support ${OTHER_ZW}` }, { '@type': 'Person', name: 'Erika Mustermann' }],
        reservationFor: {
          '@type': 'Event', name: 'Jazz Night', startDate: '2026-12-05T20:00:00+01:00',
          location: { '@type': 'Place', name: `Hall at ${OTHER}`, address: { '@type': 'PostalAddress', streetAddress: `${OTHER} street 1`, addressLocality: 'Hamburg' } },
        },
        ticketNumber: `T-${OTHER}`,
      },
      {
        '@context': 'http://schema.org', '@type': 'LodgingReservation', reservationNumber: 'HB-1',
        underName: { '@type': 'Person', name: 'Erika Mustermann' },
        reservationFor: {
          '@type': 'LodgingBusiness', name: 'Hotel Am Markt', telephone: '+49 30 1234567',
          address: { '@type': 'PostalAddress', streetAddress: 'Marktplatz 1', addressLocality: `Login at ${OTHER_ZW}`, postalCode: '10178' },
        },
        checkinTime: '2026-12-04T15:00:00+01:00', checkoutTime: '2026-12-06T11:00:00+01:00',
      },
      {
        '@context': 'http://schema.org', '@type': 'RentalCarReservation', reservationNumber: 'RC-1',
        underName: { '@type': 'Person', name: 'Erika Mustermann' },
        reservationFor: { '@type': 'Car', name: `VW Golf from ${OTHER}`, rentalCompany: { '@type': 'Organization', name: 'Shop Cars' } },
        pickupLocation: { '@type': 'Place', name: `Desk ${OTHER}` }, pickupTime: '2026-12-04T09:00:00+01:00',
        dropoffLocation: { '@type': 'Place', name: 'Flughafen BER' }, dropoffTime: '2026-12-07T18:00:00+01:00',
      },
      {
        '@context': 'http://schema.org', '@type': 'Order', orderNumber: `SO-${OTHER}`, merchant: { '@type': 'Organization', name: 'Shop' },
        acceptedOffer: [
          { '@type': 'Offer', itemOffered: { '@type': 'Product', name: `Security token for ${OTHER}` } },
          { '@type': 'Offer', itemOffered: { '@type': 'Product', name: 'Wanderschuhe' } },
        ],
      },
    );
    expect(cards.length).toBeGreaterThanOrEqual(3);
    show(cards);
    const text = visible(shownText());
    expect(text).not.toContain(OTHER);
    // What names no other domain is still there.
    for (const kept of ['erika mustermann', 'jazz night', 'hotel am markt', 'marktplatz 1', 'flughafen ber', 'wanderschuhe']) {
      expect(text).toContain(kept);
    }
  });

  it('keeps the host of a button that leads to another domain, with its mark', async () => {
    const cards = await cardsOf({
      ...flight('Shop Air'),
      checkinUrl: `https://checkin.${OTHER}/x`,
    });
    show(cards);
    const button = screen.getByRole('link', { name: /link_check_in/ });
    expect(button).toHaveTextContent(`checkin.${OTHER}`);
    expect(within(button).getByTestId('structured-mail-outside-link')).toBeInTheDocument();
  });
});
