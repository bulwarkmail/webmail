// Right-to-left text on a booking card (Hebrew, Arabic: letters, so the card shows them) cannot
// change the order of the text around it. Every text from the mail is drawn in its own <bdi>: the
// browser lays out an isolate as one neutral character in the surrounding line, so the verified
// sender line ("from shop.example") and the fields next to it keep their order, whatever the
// isolate holds.
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
const page = (...items: unknown[]) => `<html><head>${items.map((item) => `<script type="application/ld+json">${JSON.stringify(item)}</script>`).join('')}</head><body><p>Hello</p></body></html>`;
async function cardsOf(...items: unknown[]): Promise<StructuredCard[]> {
  return resolveCards(readStructuredMail(page(...items), { mailDate: new Date('2026-11-01T09:00:00Z') }), await loadAirportZones());
}
const show = (cards: StructuredCard[]) => render(<StructuredMailCards cards={cards} email={{ id: 'm1', from: [{ email: 'orders@shop.example' }] }} allowRemoteImages={false} />);

const HEBREW = /\p{Script=Hebrew}/u;
/** An element's text as the line around its isolates sees it: each <bdi> stands for one placeholder. */
function outsideIsolates(el: Element): string {
  return Array.from(el.childNodes).map((n) => {
    if (n.nodeType === 3) return n.textContent ?? '';
    if (n instanceof Element) return n.tagName === 'BDI' ? '[]' : outsideIsolates(n);
    return '';
  }).join('');
}

const flight = (airline: string, passengers: string[] = ['Erika Mustermann']) => ({
  '@context': CTX, '@type': 'FlightReservation', reservationNumber: 'RD02XZ', reservationStatus: 'http://schema.org/ReservationConfirmed',
  underName: passengers.map((name) => ({ '@type': 'Person', name })),
  reservationFor: {
    '@type': 'Flight', flightNumber: '315', airline: { '@type': 'Airline', name: airline, iataCode: 'LY' },
    departureAirport: { '@type': 'Airport', name: 'Frankfurt Airport', iataCode: 'FRA' }, departureTime: '2026-12-01T10:15:00+01:00',
    arrivalAirport: { '@type': 'Airport', name: 'Ben Gurion', iataCode: 'TLV' }, arrivalTime: '2026-12-01T15:05:00+02:00',
  },
});

const initialSettings = useSettingsStore.getState();
beforeAll(() => loadTopLevelDomains());
beforeEach(() => { useSettingsStore.setState({ timeFormat: '24h', timeZone: 'Europe/Berlin' }); });
afterEach(() => { useSettingsStore.setState(initialSettings, true); });

describe('right-to-left text on a card', () => {
  it('leaves the verified sender line and its order as they are, next to a Hebrew airline', async () => {
    show(await cardsOf(flight('Shop Air')));
    const latinLine = screen.getByTestId('structured-mail-sender-domain').parentElement!;
    const latin = outsideIsolates(latinLine);
    document.body.innerHTML = '';

    show(await cardsOf(flight('אל על')));
    const line = screen.getByTestId('structured-mail-sender-domain').parentElement!;
    expect(line.textContent).toBe('kind_flight · אל על · card_sender{"domain":"shop.example"}');
    // Outside its isolate, the Hebrew name leaves the same text in the same order as a Latin one.
    expect(outsideIsolates(line)).toBe(latin);
    expect(outsideIsolates(line)).toBe('kind_flight · [] · card_sender{"domain":"shop.example"}');
    expect(screen.getByTestId('structured-mail-sender-domain').closest('bdi')).toBeNull();
  });

  it('draws every Hebrew text of every kind of card in a <bdi> of its own', async () => {
    const H = {
      airline: 'אל על', passengerA: 'ישראל ישראלי', passengerB: 'שרה כהן', hotel: 'מלון דן', hotelStreet: 'רחוב הירקון 99',
      company: 'השכרת רכב', car: 'טויוטה קורולה', pickup: 'סניף נמל התעופה', dropoff: 'סניף העיר', event: 'הופעת חנוכה', venue: 'היכל התרבות',
      restaurant: 'מסעדת הים', restaurantStreet: 'רחוב דיזנגוף 1', merchant: 'חנות הספרים', itemA: 'ספר בישול', itemB: 'כוס קפה', carrier: 'דואר ישראל',
      station: 'תחנת מרכז', train: 'רכבת ישראל',
    };
    const cards = await cardsOf(
      flight(H.airline, [H.passengerA, H.passengerB]),
      { '@context': CTX, '@type': 'TrainReservation', reservationNumber: 'TR1', underName: { '@type': 'Person', name: 'Erika Mustermann' },
        reservationFor: { '@type': 'TrainTrip', trainNumber: '12', provider: { '@type': 'Organization', name: H.train },
          departureStation: { '@type': 'TrainStation', name: H.station }, departureTime: '2026-12-02T08:00:00+02:00',
          arrivalStation: { '@type': 'TrainStation', name: 'Haifa Hof HaCarmel' }, arrivalTime: '2026-12-02T09:00:00+02:00' } },
      { '@context': CTX, '@type': 'LodgingReservation', reservationNumber: 'H1', underName: { '@type': 'Person', name: 'Erika Mustermann' },
        reservationFor: { '@type': 'LodgingBusiness', name: H.hotel, telephone: '+972 3 1234567',
          address: { '@type': 'PostalAddress', streetAddress: H.hotelStreet, addressLocality: 'Tel Aviv' } },
        checkinTime: '2026-12-04T15:00:00+02:00', checkoutTime: '2026-12-06T11:00:00+02:00' },
      { '@context': CTX, '@type': 'RentalCarReservation', reservationNumber: 'R1', underName: { '@type': 'Person', name: 'Erika Mustermann' },
        reservationFor: { '@type': 'Car', name: H.car, rentalCompany: { '@type': 'Organization', name: H.company } },
        pickupLocation: { '@type': 'Place', name: H.pickup }, pickupTime: '2026-12-04T09:00:00+02:00',
        dropoffLocation: { '@type': 'Place', name: H.dropoff }, dropoffTime: '2026-12-07T18:00:00+02:00' },
      { '@context': CTX, '@type': 'EventReservation', reservationNumber: 'E1', underName: { '@type': 'Person', name: 'Erika Mustermann' },
        reservationFor: { '@type': 'Event', name: H.event, startDate: '2026-12-05T20:00:00+02:00', location: { '@type': 'Place', name: H.venue } } },
      { '@context': CTX, '@type': 'FoodEstablishmentReservation', reservationNumber: 'F1', underName: { '@type': 'Person', name: 'Erika Mustermann' }, partySize: 2,
        reservationFor: { '@type': 'FoodEstablishment', name: H.restaurant, address: { '@type': 'PostalAddress', streetAddress: H.restaurantStreet, addressLocality: 'Tel Aviv' } },
        startTime: '2026-12-05T19:30:00+02:00' },
      { '@context': CTX, '@type': 'Order', orderNumber: 'SO-1', merchant: { '@type': 'Organization', name: H.merchant },
        acceptedOffer: [{ '@type': 'Offer', itemOffered: { '@type': 'Product', name: H.itemA } }, { '@type': 'Offer', itemOffered: { '@type': 'Product', name: H.itemB } }] },
      { '@context': CTX, '@type': 'ParcelDelivery', trackingNumber: '123456', carrier: { '@type': 'Organization', name: H.carrier },
        partOfOrder: { '@type': 'Order', orderNumber: 'SO-2', merchant: { '@type': 'Organization', name: 'Shop' } } },
    );
    expect(cards.length).toBeGreaterThanOrEqual(8);
    show(cards);
    const root = screen.getByTestId('structured-mail-cards');
    const markers = Object.values(H);

    // Every field is on the card.
    for (const marker of markers) expect(root.textContent, marker).toContain(marker);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const unisolated: string[] = [];
    const shared: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!HEBREW.test(node.textContent ?? '')) continue;
      // The route's text for screen readers is clipped (sr-only) and drawn in no line.
      if (node.parentElement?.closest('.sr-only')) continue;
      const isolate = node.parentElement?.closest('bdi');
      if (!isolate || !root.contains(isolate)) {
        unisolated.push(node.textContent ?? '');
        continue;
      }
      // One field per isolate, and never the sender line.
      const inside = markers.filter((m) => isolate.textContent!.includes(m));
      if (inside.length !== 1 || isolate.querySelector('[data-testid="structured-mail-sender-domain"]')) shared.push(isolate.textContent ?? '');
    }
    expect(unisolated).toEqual([]);
    expect(shared).toEqual([]);
  });
});
