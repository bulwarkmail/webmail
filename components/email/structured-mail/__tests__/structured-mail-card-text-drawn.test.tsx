// A booking card reads its text as the browser could draw it before it decides whether the text names
// another domain (namesOtherDomain). The card is for a message that passed the sender check for
// shop.example.
//
// 1. A space or word joiner with combining marks on it is one dot: some marks draw a dot just below
//    the baseline in the gap (THAI CHARACTER PHINTHU), and NFKC writes spacing diacritics (¸ ˛ ´) as a
//    space and a mark.
// 2. Spaces other than U+0020 (no-break, narrow, thin, hair, ideographic) count as nothing: some draw
//    as almost nothing.
// 3. Two or more dots in a row are one dot.
// 4. The end of a run is also read on its own through the table of letters that draw like Latin ones:
//    "Сбербанк.СОМ" with Cyrillic С О М ends in what draws as .COM.
// 5. The table holds izhitsa, IDEOGRAPHIC NUMBER ZERO, Armenian, a few Greek and Latin letters more.
// 6. SOFT HYPHEN, ZERO WIDTH NON-JOINER and ZERO WIDTH JOINER are read as nothing instead of leaving the
//    text out; the card keeps the two joiners (Persian, Sinhala) and drops the soft hyphen. Every other
//    format character still leaves the text out.
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

const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const SENDER = 'shop.example';
const OTHER = 'bigbank.example';
const named = (text: string) => namesOtherDomain(text, SENDER);

const SHY = cp(0xad);
const ZWNJ = cp(0x200c);
const ZWJ = cp(0x200d);
const RLO = cp(0x202e);
const PDF = cp(0x202c);
const PHINTHU = cp(0x0e3a);

const CTX = 'http://schema.org';
const page = (...items: unknown[]) => `<html><head>${items.map((item) => `<script type="application/ld+json">${JSON.stringify(item)}</script>`).join('')}</head><body><p>Hello</p></body></html>`;
async function cardsOf(...items: unknown[]): Promise<StructuredCard[]> {
  return resolveCards(readStructuredMail(page(...items), { mailDate: new Date('2026-11-01T09:00:00Z') }), await loadAirportZones());
}
const show = (cards: StructuredCard[], from = 'orders@shop.example') =>
  render(<StructuredMailCards cards={cards} email={{ id: 'm1', from: [{ email: from }] }} allowRemoteImages={false} />);
const cardText = () => screen.queryByTestId('structured-mail-cards')?.textContent ?? '';

const order = (merchant: string) => ({ '@context': CTX, '@type': 'Order', orderNumber: 'SO-1', merchant: { '@type': 'Organization', name: merchant } });
const flight = (airline: string, passengers: string[] = ['Erika Mustermann']) => ({
  '@context': CTX, '@type': 'FlightReservation', reservationNumber: 'RD02XZ', reservationStatus: 'http://schema.org/ReservationConfirmed',
  underName: passengers.map((name) => ({ '@type': 'Person', name })),
  reservationFor: {
    '@type': 'Flight', flightNumber: '400', airline: { '@type': 'Airline', name: airline, iataCode: 'LH' },
    departureAirport: { '@type': 'Airport', name: 'Frankfurt Airport', iataCode: 'FRA' }, departureTime: '2026-12-01T10:15:00+01:00',
    arrivalAirport: { '@type': 'Airport', name: 'John F. Kennedy International Airport', iataCode: 'JFK' }, arrivalTime: '2026-12-01T13:05:00-05:00',
  },
});
const hotel = (name: string, street: string, locality: string) => ({
  '@context': CTX, '@type': 'LodgingReservation', reservationNumber: 'HB-77', underName: { '@type': 'Person', name: 'Erika Mustermann' },
  reservationFor: { '@type': 'LodgingBusiness', name, address: { '@type': 'PostalAddress', streetAddress: street, addressLocality: locality } },
  checkinTime: '2026-12-04T15:00:00+01:00', checkoutTime: '2026-12-06T11:00:00+01:00',
});
const train = (from: string, to: string) => ({
  '@context': CTX, '@type': 'TrainReservation', reservationNumber: 'Q7XK2M', underName: { '@type': 'Person', name: 'Erika Mustermann' },
  reservationFor: { '@type': 'TrainTrip', trainNumber: 'ICE 577', provider: { '@type': 'Organization', name: 'DB Fernverkehr AG' },
    departureStation: { '@type': 'TrainStation', name: from }, departureTime: '2026-12-02T08:04:00+01:00',
    arrivalStation: { '@type': 'TrainStation', name: to }, arrivalTime: '2026-12-02T12:19:00+01:00' },
});

// Cyrillic Сбербанк and Москва, and С О М (Cyrillic capitals that draw as C O M).
const SBERBANK = cp(0x421, 0x431, 0x435, 0x440, 0x431, 0x430, 0x43d, 0x43a);
const MOSKVA = cp(0x41c, 0x43e, 0x441, 0x43a, 0x432, 0x430);
const CYRILLIC_COM = cp(0x421, 0x41e, 0x41c);

/** What the browser draws for the marks below, on a space: a dot just below the baseline. */
const DOT_MARKS = [0x0e3a, 0x0eb9, 0x1713];
const drawn = (text: string) => text.replace(new RegExp(` [${cp(...DOT_MARKS)}]`, 'gu'), '.').toLowerCase();

const initialSettings = useSettingsStore.getState();
beforeAll(() => loadTopLevelDomains());
beforeEach(() => { useSettingsStore.setState({ timeFormat: '24h', timeZone: 'Europe/Berlin' }); });
afterEach(() => { cleanup(); useSettingsStore.setState(initialSettings, true); });

describe('1. a space or joiner with combining marks on it reads as one dot', () => {
  const marked = DOT_MARKS.map((mark) => [`U+${mark.toString(16).toUpperCase().padStart(4, '0')}`, `bigbank ${cp(mark)}example`] as [string, string]);

  it('control: an honest name is shown, the plain domain is left out, an abbreviated name is shown', async () => {
    show(await cardsOf(order('Shop Outlet')));
    expect(cardText()).toContain('Shop Outlet');
    expect(named(OTHER)).toBe(true);
    expect(named('St.Gallen')).toBe(false);
  });

  it.each(marked)('reads a space with the mark %s on it, between two labels, as the dot', (_name, text) => {
    expect(drawn(text)).toBe(OTHER);
    expect(named(text)).toBe(true);
  });

  it.each(marked)('an order whose merchant has a space with the mark %s on it does not show the domain it draws', async (_name, text) => {
    show(await cardsOf(order(text)));
    expect(drawn(cardText())).not.toContain(OTHER);
  });

  it.each(marked)('a flight whose airline has a space with the mark %s on it shows the domain it draws nowhere', async (_name, text) => {
    show(await cardsOf(flight(`${text} Air`)));
    expect(drawn(cardText())).not.toContain(OTHER);
  });

  it.each<[string, string]>([
    ['another mark that sits below the line (LAO SEMIVOWEL SIGN LO)', `bigbank ${cp(0x0ebc)}com`],
    ['a mark of another script (MAHAJANI SIGN NUKTA)', `bigbank ${cp(0x11173)}com`],
    ['two marks', `bigbank ${PHINTHU}${cp(0x0323)}com`],
    ['two spaces and a mark', `bigbank  ${PHINTHU}com`],
    ['a no-break space with a mark', `bigbank${cp(0xa0)}${PHINTHU}com`],
    ['a hair space with a mark', `bigbank${cp(0x200a)}${PHINTHU}com`],
    ['a comma with a mark', `bigbank,${PHINTHU}com`],
    ['a spacing cedilla, which NFKC writes as a space and a mark', `bigbank${cp(0xb8)}com`],
    ['a spacing ogonek', `bigbank${cp(0x2db)}com`],
    ['a mark at the start of the label after a dot', `bigbank.${PHINTHU}com`],
  ])('reads %s as the dot', (_name, text) => {
    expect(named(text)).toBe(true);
  });

  it('shows honest text with an accent written as an apostrophe, and abbreviations with a normal space', () => {
    for (const text of [`McDonald${cp(0xb4)}s Berlin`, `L${cp(0xb4)}Or${cp(0xe9)}al Paris`, 'Art. Nr. 5', 'Café de Flore', 'z. B. Hamburg']) {
      expect(named(text), text).toBe(false);
    }
  });
});

describe('2. spaces other than U+0020 count as nothing', () => {
  it.each<[string, string]>([
    ['a hair space before the dot', `bigbank${cp(0x200a)}.example`],
    ['a hair space after the dot', `bigbank.${cp(0x200a)}example`],
    ['a narrow no-break space before the dot', `bigbank${cp(0x202f)}.example`],
    ['a six-per-em space before the dot', `bigbank${cp(0x2006)}.example`],
    ['a thin space before the dot', `bigbank${cp(0x2009)}.example`],
    ['a no-break space after the dot', `bigbank.${cp(0xa0)}example`],
    ['an ideographic space before the dot', `bigbank${cp(0x3000)}.example`],
    ['a hair space inside the last label', `bigbank.exa${cp(0x200a)}mple`],
  ])('reads a name with %s as the domain', (_name, text) => {
    expect(named(text)).toBe(true);
  });

  it('shows French text with narrow no-break spaces, and a name with a no-break space', () => {
    expect(named(`H${cp(0xf4)}tel du Parc${cp(0x202f)}: 1${cp(0x202f)}234,50${cp(0x202f)}${cp(0x20ac)}`)).toBe(false);
    expect(named(`Hotel${cp(0xa0)}Am Markt`)).toBe(false);
  });
});

describe('3. dots in a row read as one', () => {
  it.each<[string, string]>([
    ['two full stops', 'bigbank..example'],
    ['TWO DOT LEADER', `bigbank${cp(0x2025)}example`],
    ['an ellipsis', `bigbank${cp(0x2026)}example`],
    ['a full stop and a middle dot', `bigbank.${cp(0xb7)}example`],
    ['an ideographic and a plain full stop', `bigbank${cp(0x3002)}.example`],
    ['two Lisu tone letters', `bigbank${cp(0xa4f8, 0xa4f8)}example`],
  ])('reads %s between two labels as one dot', (_name, text) => {
    expect(named(text)).toBe(true);
  });

  it('shows honest text with dots in a row', () => {
    for (const text of ['Hamburg Hbf...', 'Verein e.V..', 'Ende...', 'z.B...']) {
      expect(named(text), text).toBe(false);
    }
  });
});

describe('4. the end of a run read through the table on its own', () => {
  it('control: the same name with a real Cyrillic top-level domain is left out, a Russian street is shown', () => {
    expect(named(`${SBERBANK}.${cp(0x440, 0x444)}`)).toBe(true);
    expect(named(`${cp(0x443, 0x43b)}.${cp(0x41b, 0x435, 0x43d, 0x438, 0x43d, 0x430)}`)).toBe(false);
  });

  it('reads a Cyrillic word followed by .COM in Cyrillic capitals as the domain it draws like', () => {
    expect(named(`${SBERBANK}.${CYRILLIC_COM}`)).toBe(true);
    expect(named(`${MOSKVA}.${CYRILLIC_COM}`)).toBe(true);
  });

  it('reads izhitsa and ka followed by .COM in Cyrillic, drawn as VK.COM, as that domain', () => {
    expect(named(`${cp(0x474, 0x41a)}.${CYRILLIC_COM}`)).toBe(true);
  });

  it('reads IDEOGRAPHIC NUMBER ZERO at the start of the last label as the O it draws like, also on a card', async () => {
    expect(named(`bigbank.${cp(0x3007)}rg`)).toBe(true);
    show(await cardsOf(order(`bigbank.${cp(0x3007)}rg`)));
    expect(cardText()).not.toContain(`bigbank.${cp(0x3007)}rg`);
  });

  it('an order whose merchant is that Cyrillic name with .COM does not show it', async () => {
    show(await cardsOf(order(`${SBERBANK}.${CYRILLIC_COM}`)));
    expect(cardText()).not.toContain(`${SBERBANK}.${CYRILLIC_COM}`);
  });

  it.each<[string, string]>([
    ['a Greek word with .NET in Greek capitals', `Ελλάδα.${cp(0x39d, 0x395, 0x3a4)}`],
    ['a Greek word with .COM, the C a lunate sigma (which NFKC makes a Σ)', `Αθήνα.${cp(0x3f9, 0x39f, 0x39c)}`],
    ['Armenian letters that draw as hugo.hu', `${cp(0x570, 0x57d, 0x581, 0x585)}.${cp(0x570, 0x57d)}`],
    ['Armenian letters that draw as gong.no', `${cp(0x581, 0x585, 0x578, 0x581)}.${cp(0x578, 0x585)}`],
  ])('reads %s as a domain', (_name, text) => {
    expect(named(text)).toBe(true);
  });

  it('shows Greek and Russian names with an abbreviation, whose end spells no top-level domain', () => {
    for (const text of ['г.Новосибирск', 'пр.Мира', 'ул.Ленина', 'ст.м.Арбатская', 'κ.Παπαδόπουλος', 'Αθ.Διάκου', 'Λεωφ.Συγγρού']) {
      expect(named(text), text).toBe(false);
    }
  });
});

describe('5. more letters that draw like Latin ones', () => {
  it.each<[string, string]>([
    ['a small izhitsa (банк.ѵс, drawn as .vc)', `${cp(0x431, 0x430, 0x43d, 0x43a)}.${cp(0x475, 0x441)}`],
    ['Greek san for M (.MA)', `Ελλάδα.${cp(0x3fa, 0x391)}`],
    ['HANGZHOU NUMERAL ONE for l (.lt)', `bigbank.${cp(0x3021)}t`],
    ['a Latin small capital O (.com)', `bigbank.c${cp(0x1d0f)}m`],
    ['a Latin script g (.org)', `bigbank.or${cp(0x261)}`],
    ['a dental click for l (.lt)', `bigbank.${cp(0x1c0)}t`],
  ])('reads %s as a domain', (_name, text) => {
    expect(named(text)).toBe(true);
  });
});

describe('6. soft hyphen, zero width non-joiner and zero width joiner are read as nothing', () => {
  it.each<[string, string]>([
    ['a soft hyphen inside the name', `big${SHY}bank.com`],
    ['a zero width non-joiner before the dot', `bigbank${ZWNJ}.com`],
    ['a zero width joiner after the dot', `bigbank.${ZWJ}com`],
  ])('still reads a domain with %s in it', (_name, text) => {
    expect(named(text)).toBe(true);
  });

  it('still leaves out a text with a direction control or another zero width character next to them', () => {
    expect(named(`Shop Air${ZWJ}${RLO}`)).toBe(true);
    expect(named(`bigbank${ZWNJ}${RLO}elpmaxe.${PDF}`)).toBe(true);
    expect(named(`Hotel${ZWNJ}${cp(0x200e)} Am Markt`)).toBe(true);
    expect(named(`Hotel Am${cp(0x200b)}${ZWJ} Markt`)).toBe(true);
    expect(named(`Hotel Am${cp(0x2060)} Markt`)).toBe(true);
  });

  it('shows a Persian hotel, street and passenger with their zero width non-joiners, and keeps them on the card', async () => {
    const name = `هتل${ZWNJ} پارسیان`;
    const street = `خیابان${ZWNJ} ولیعصر ۱۲`;
    show(await cardsOf(hotel(name, street, 'تهران')), 'reserve@hotel-parsian.example');
    expect(cardText()).toContain(name);
    expect(cardText()).toContain(street);
    cleanup();
    const passenger = `علی${ZWNJ}رضا احمدی`;
    show(await cardsOf(flight('Lufthansa', [passenger])), 'online@booking-lufthansa.com');
    expect(cardText()).toContain(passenger);
  });

  it('shows a Sinhala town with its zero width joiner, and keeps it on the card', async () => {
    const town = `ශ්${ZWJ}රී ජයවර්ධනපුර කෝට්ටේ`;
    show(await cardsOf(hotel('Hotel Kotte', 'Main Street 5', town)), 'booking@hotel-kotte.example');
    expect(cardText()).toContain(town);
  });

  it('draws a trip to a station whose name has a soft hyphen, without the soft hyphen', async () => {
    show(await cardsOf(train('Berlin Hbf', `Frankfurt (Main) Hauptbahn${SHY}hof`)), 'buchungsbestaetigung@bahn.de');
    expect(cardText()).toContain('Frankfurt (Main) Hauptbahnhof');
    expect(cardText()).not.toContain(SHY);
  });
});
