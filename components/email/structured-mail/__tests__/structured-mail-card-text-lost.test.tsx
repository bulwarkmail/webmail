// A text a booking card leaves out (it names another domain) takes the leg, seat or item it belongs
// to with it: no "Wien Hbf → ?", no list entry that is empty or starts with ", ", no count that
// includes a left-out item. A trip with no leg left, and an order with nothing left that says which
// one it is, are not drawn, and the message shows as it would without a card. A hotel, rental car,
// event or restaurant keeps its kind as the title when its name is left out.
import { render, screen } from '@testing-library/react';
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
import { loadTopLevelDomains } from '../card-parts';
import { StructuredMailCards } from '../structured-mail-cards';

const CTX = 'http://schema.org';
const OTHER = 'bigbank.example';
const page = (...items: unknown[]) => `<html><head>${items.map((item) => `<script type="application/ld+json">${JSON.stringify(item)}</script>`).join('')}</head><body><p>Hello</p></body></html>`;
async function cardsOf(...items: unknown[]): Promise<StructuredCard[]> {
  return resolveCards(readStructuredMail(page(...items), { mailDate: new Date('2026-11-01T09:00:00Z') }), await loadAirportZones());
}
const show = (cards: StructuredCard[]) => render(<StructuredMailCards cards={cards} email={{ id: 'm1', from: [{ email: 'tickets@shop.example' }] }} allowRemoteImages={false} />);
const cardText = () => screen.getByTestId('structured-mail-cards').textContent ?? '';

const train = (reservationNumber: string, from: string, to: string, day: string) => ({
  '@context': CTX, '@type': 'TrainReservation', reservationNumber, underName: { '@type': 'Person', name: 'Erika Mustermann' },
  reservationFor: { '@type': 'TrainTrip', trainNumber: 'RJX 662', provider: { '@type': 'Organization', name: 'Shop Rail' },
    departureStation: { '@type': 'TrainStation', name: from }, departureTime: `${day}T10:30:00+01:00`,
    arrivalStation: { '@type': 'TrainStation', name: to }, arrivalTime: `${day}T12:55:00+01:00` },
});
const flightSeat = (passenger: string, seat: string) => ({
  '@context': CTX, '@type': 'FlightReservation', reservationNumber: 'RD02XZ', underName: { '@type': 'Person', name: passenger }, airplaneSeat: seat,
  reservationFor: { '@type': 'Flight', flightNumber: '400', airline: { '@type': 'Airline', name: 'Shop Air', iataCode: 'LH' },
    departureAirport: { '@type': 'Airport', name: 'Frankfurt Airport', iataCode: 'FRA' }, departureTime: '2026-12-01T10:15:00+01:00',
    arrivalAirport: { '@type': 'Airport', name: 'John F. Kennedy International Airport', iataCode: 'JFK' }, arrivalTime: '2026-12-01T13:05:00-05:00' },
});
const offer = (name: string, quantity?: number) => ({ '@type': 'Offer', itemOffered: { '@type': 'Product', name }, ...(quantity ? { eligibleQuantity: quantity } : {}) });

const initialSettings = useSettingsStore.getState();
beforeAll(() => loadTopLevelDomains());
beforeEach(() => { useSettingsStore.setState({ timeFormat: '24h', timeZone: 'Europe/Berlin' }); });
afterEach(() => { useSettingsStore.setState(initialSettings, true); });

describe('a trip that lost a station', () => {
  it('is not drawn when its only leg has no destination left', async () => {
    const cards = await cardsOf(train('Q1', 'Wien Hbf', `Tickets at ${OTHER}`, '2026-12-01'));
    expect(cards).toHaveLength(1);
    const { container } = show(cards);
    expect(screen.queryByTestId('structured-mail-cards')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('is not drawn when its only leg has no departure left', async () => {
    show(await cardsOf(train('Q2', `Tickets at ${OTHER}`, 'Graz Hbf', '2026-12-01')));
    expect(screen.queryByTestId('structured-mail-cards')).toBeNull();
  });

  it('shows the legs that kept their stations and says nothing about the one that did not', async () => {
    const cards = await cardsOf(
      train('Q3', 'Wien Hbf', 'Graz Hbf', '2026-12-01'),
      train('Q3', `${OTHER} Hbf`, 'Wien Hbf', '2026-12-03'),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].kind === 'train' && cards[0].legs).toHaveLength(2);
    show(cards);
    expect(screen.getAllByTestId('structured-mail-leg')).toHaveLength(1);
    expect(screen.getByTestId('structured-mail-title-visual').textContent).toBe('Wien HbfGraz Hbf');
    expect(cardText()).not.toContain('?');
    expect(cardText().toLowerCase()).not.toContain(OTHER);
  });
});

describe('a seat whose passenger was left out', () => {
  it('is left out with the passenger, and the seat row has no empty entry', async () => {
    const cards = await cardsOf(flightSeat('Erika Mustermann', '12A'), flightSeat(`Support ${OTHER}`, '12B'));
    expect(cards).toHaveLength(1);
    show(cards);
    const seats = screen.getAllByTestId('structured-mail-seat').map((el) => el.textContent);
    expect(seats).toEqual(['12A']);
    expect(cardText()).toContain('seats: Erika Mustermann 12A');
    expect(cardText()).not.toMatch(/: ,|, ,|,\s*$/);
  });
});

describe('an item whose name was left out', () => {
  it('is left out of the list and of the count', async () => {
    const cards = await cardsOf({
      '@context': CTX, '@type': 'Order', orderNumber: 'SO-1', merchant: { '@type': 'Organization', name: 'Shop' },
      acceptedOffer: [offer(`Gift card for ${OTHER}`, 2), offer('Wanderschuhe'), offer('Socken', 3), offer('Rucksack')],
    });
    show(cards);
    const text = cardText();
    // The item row holds the three names and nothing in front of them.
    expect(screen.getByText('Wanderschuhe').parentElement!.textContent).toBe('Wanderschuhe, Socken, Rucksack');
    expect(text).not.toContain('items_more');
    expect(text).toContain('items_count{"count":5}');
  });

  it('is left out of a parcel\'s items, and the parcel counts the rest', async () => {
    show(await cardsOf({
      '@context': CTX, '@type': 'ParcelDelivery', trackingNumber: '00340434161234567890', carrier: { '@type': 'Organization', name: 'Shop Paket' },
      itemShipped: [{ '@type': 'Product', name: `Security token for ${OTHER}` }, { '@type': 'Product', name: 'Dr.Oetker Pizza Ristorante' }, { '@type': 'Product', name: 'T-Shirt Gr.XL' }, { '@type': 'Product', name: 'HDMI-Kabel v2.1' }],
    }));
    const text = cardText();
    expect(text).toContain('Dr.Oetker Pizza Ristorante, T-Shirt Gr.XL, HDMI-Kabel v2.1');
    expect(text).toContain('items_count{"count":3}');
    expect(text.toLowerCase()).not.toContain(OTHER);
  });

  it('takes the order with it when nothing is left that says which order it is', async () => {
    const cards = await cardsOf({
      '@context': CTX, '@type': 'Order', orderNumber: `${OTHER}-1`, merchant: { '@type': 'Organization', name: OTHER },
      acceptedOffer: [offer(`Login at ${OTHER}`)],
    });
    expect(cards).toHaveLength(1);
    show(cards);
    expect(screen.queryByTestId('structured-mail-cards')).toBeNull();
  });
});

describe('a card that lost its name', () => {
  it('keeps a hotel with its kind as the title, its address and its dates', async () => {
    show(await cardsOf({
      '@context': CTX, '@type': 'LodgingReservation', reservationNumber: 'H1', underName: { '@type': 'Person', name: 'Erika Mustermann' },
      reservationFor: { '@type': 'LodgingBusiness', name: `Hotel Am Markt (über ${OTHER})`,
        address: { '@type': 'PostalAddress', streetAddress: 'Marktplatz 1', addressLocality: 'Hamburg', postalCode: '20095' } },
      checkinTime: '2026-12-04T15:00:00+01:00', checkoutTime: '2026-12-06T11:00:00+01:00',
    }));
    expect(screen.getByRole('heading').textContent).toBe('kind_lodging');
    expect(cardText()).toContain('Marktplatz 1, 20095 Hamburg');
    expect(cardText()).toContain('check_in_label');
  });
});
