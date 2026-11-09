import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatAddress,
  formatMoment,
  formatMomentDate,
  formatMomentTime,
  formatMoney,
  isOtherZone,
  isWebLink,
  legPlaceLabel,
  legService,
  momentOffsetMinutes,
  nightsBetween,
  routeTitle,
  shipmentItems,
  summarizeItems,
} from '../format';
import type { Moment, Shipment, TransportBooking, TransportLeg } from '../types';

const NOW = new Date('2026-10-30T12:00:00Z');
const en = { locale: 'en-US', hour12: false, now: NOW } as const;

// SFO 20:15 −08:00 = 04:15Z the next day; JFK 06:30 −05:00.
const SFO_DEP: Moment = { date: '2026-12-03', time: '20:15:00', offsetMinutes: -480, utc: '2026-12-04T04:15:00Z', zone: 'America/Los_Angeles' };
const BERLIN: Moment = { date: '2026-12-01', time: '10:15:00', offsetMinutes: 60, utc: '2026-12-01T09:15:00Z', zone: 'Europe/Berlin' };
// A floating time the airport table resolved: no offset in the mail, utc from the zone.
const NRT_RESOLVED: Moment = { date: '2026-12-02', time: '17:40:00', utc: '2026-12-02T08:40:00Z', zone: 'Asia/Tokyo' };

const originalTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalTz;
});

describe('wall-clock formatting', () => {
  for (const tz of ['UTC', 'America/Los_Angeles', 'Europe/Berlin', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
    it(`keeps 20:15 −08:00 at 20:15 on 3 Dec with TZ=${tz}`, () => {
      process.env.TZ = tz;
      expect(formatMomentTime(SFO_DEP, en)).toBe('20:15');
      expect(formatMomentDate(SFO_DEP, en)).toBe('Thu, Dec 3');
      expect(formatMoment(SFO_DEP, en)).toBe('Thu, Dec 3, 20:15');
    });
  }

  it('shows the clock the mail gave whatever the offset', () => {
    const tokyo: Moment = { date: '2026-12-02', time: '07:05:00', offsetMinutes: 540, utc: '2026-12-01T22:05:00Z' };
    const kolkata: Moment = { date: '2026-12-02', time: '23:50:00', offsetMinutes: 330, utc: '2026-12-02T18:20:00Z' };
    expect(formatMoment(tokyo, en)).toBe('Wed, Dec 2, 07:05');
    expect(formatMoment(kolkata, en)).toBe('Wed, Dec 2, 23:50');
  });

  it('formats a date-only moment without a time', () => {
    const d: Moment = { date: '2027-06-01' };
    expect(formatMomentTime(d, en)).toBeUndefined();
    // Another year than "now": the year is shown.
    expect(formatMoment(d, en)).toBe('Tue, Jun 1, 2027');
    expect(formatMomentDate({ date: '2026-11-03' }, en)).toBe('Tue, Nov 3');
  });

  it('follows the UI locale and the 12-hour setting', () => {
    expect(formatMoment(BERLIN, { locale: 'de', hour12: false, now: NOW })).toBe('Di., 1. Dez., 10:15');
    expect(formatMomentTime(SFO_DEP, { locale: 'en-US', hour12: true, now: NOW })).toBe('8:15 PM');
  });

  it('accepts HH:mm and falls back to the raw value for a malformed moment', () => {
    expect(formatMomentTime({ date: '2026-12-01', time: '09:05' }, en)).toBe('09:05');
    expect(formatMomentDate({ date: 'soon' }, en)).toBe('soon');
  });
});

describe('local-time hint', () => {
  it('knows the offset of a moment from the mail or from its resolved zone', () => {
    expect(momentOffsetMinutes(SFO_DEP)).toBe(-480);
    expect(momentOffsetMinutes(NRT_RESOLVED)).toBe(540);
    expect(momentOffsetMinutes({ date: '2026-12-01', time: '10:00:00' })).toBeUndefined();
    expect(momentOffsetMinutes({ date: '2026-12-01' })).toBeUndefined();
  });

  it('marks a time whose place keeps another clock than the reader', () => {
    expect(isOtherZone(SFO_DEP, 'Europe/Berlin')).toBe(true);
    expect(isOtherZone(SFO_DEP, 'America/Los_Angeles')).toBe(false);
    expect(isOtherZone(NRT_RESOLVED, 'Asia/Tokyo')).toBe(false);
    expect(isOtherZone(NRT_RESOLVED, 'Europe/Berlin')).toBe(true);
  });

  it('compares at the instant, so DST on the reader side counts', () => {
    // 10:15 +01:00 in December: Berlin is +01:00 then, London +00:00.
    expect(isOtherZone(BERLIN, 'Europe/Berlin')).toBe(false);
    expect(isOtherZone(BERLIN, 'Europe/London')).toBe(true);
    // A +02:00 time in July matches Berlin's summer time.
    expect(isOtherZone({ date: '2026-07-18', time: '14:00:00', offsetMinutes: 120, utc: '2026-07-18T12:00:00Z' }, 'Europe/Berlin')).toBe(false);
    expect(isOtherZone(BERLIN, 'x', () => 60)).toBe(false);
    expect(isOtherZone(BERLIN, 'x', () => 0)).toBe(true);
  });

  it('never marks a floating or date-only moment', () => {
    expect(isOtherZone({ date: '2026-12-01', time: '10:00:00', zone: null }, 'Asia/Tokyo')).toBe(false);
    expect(isOtherZone({ date: '2026-12-01' }, 'Asia/Tokyo')).toBe(false);
  });
});

describe('card text helpers', () => {
  const leg = (from: string, to: string, extra: Partial<TransportLeg> = {}): TransportLeg => ({
    carrier: 'Lufthansa', carrierCode: 'LH', number: '400',
    departure: { place: { code: from, name: `${from} Airport` }, at: BERLIN },
    arrival: { place: { code: to }, at: SFO_DEP },
    seats: [], ...extra,
  });
  const flight = (legs: TransportLeg[]): TransportBooking => ({ key: 'k', kind: 'flight', passengers: [], links: {}, source: 'json-ld', legs });

  it('titles a flight with airport codes, chaining connecting legs', () => {
    expect(routeTitle(flight([leg('FRA', 'JFK')]))).toBe('FRA → JFK');
    expect(routeTitle(flight([leg('FRA', 'JFK'), leg('JFK', 'FRA')]))).toBe('FRA → JFK → FRA');
    expect(routeTitle(flight([leg('FRA', 'JFK'), leg('BOS', 'FRA')]))).toBe('FRA → JFK, BOS → FRA');
  });

  it('titles a train with towns when every stop has one, else station names', () => {
    const station = (name: string, locality?: string) => ({ name, ...(locality ? { address: { locality } } : {}) });
    const train = (a: ReturnType<typeof station>, b: ReturnType<typeof station>): TransportBooking => ({
      key: 'k', kind: 'train', passengers: [], links: {}, source: 'json-ld',
      legs: [{ departure: { place: a, at: BERLIN }, arrival: { place: b, at: BERLIN }, seats: [] }],
    });
    expect(routeTitle(train(station('Hamburg Hbf', 'Hamburg'), station('München Hbf', 'München')))).toBe('Hamburg → München');
    expect(routeTitle(train(station('Hamburg Hbf', 'Hamburg'), station('München Hbf')))).toBe('Hamburg Hbf → München Hbf');
    expect(routeTitle(train(station('Berlin Hbf', 'Berlin'), station('Berlin Südkreuz', 'Berlin')))).toBe('Berlin Hbf → Berlin Südkreuz');
  });

  it('labels airports and services', () => {
    expect(legPlaceLabel({ code: 'FRA', name: 'Frankfurt Airport' }, 'flight')).toBe('Frankfurt Airport (FRA)');
    expect(legPlaceLabel({ code: 'FRA' }, 'flight')).toBe('FRA');
    expect(legPlaceLabel({ code: 'JFK', name: 'New York JFK' }, 'flight')).toBe('New York JFK');
    expect(legPlaceLabel({ name: 'Hamburg Hbf', code: 'X' }, 'train')).toBe('Hamburg Hbf');
    expect(legService(leg('FRA', 'JFK'))).toBe('Lufthansa LH 400');
    expect(legService({ ...leg('FRA', 'JFK'), carrierCode: undefined, carrier: 'Flix', number: 'FLX30' })).toBe('Flix FLX30');
  });

  it('counts nights by date', () => {
    expect(nightsBetween({ date: '2026-12-04', time: '15:00:00' }, { date: '2026-12-06', time: '11:00:00' })).toBe(2);
    expect(nightsBetween({ date: '2027-03-27' }, { date: '2027-03-29' })).toBe(2);
    expect(nightsBetween({ date: '2027-03-29' }, { date: '2027-03-29' })).toBeUndefined();
  });

  it('formats money in the UI locale with the card currency', () => {
    expect(formatMoney({ amount: '129.90', currency: 'EUR' }, 'en-US')).toBe('€129.90');
    expect(formatMoney({ amount: '1299.00', currency: 'EUR' }, 'de').replace(/\s/g, ' ')).toBe('1.299,00 €');
    expect(formatMoney({ amount: '25.99', currency: 'USD' }, 'en-US')).toBe('$25.99');
    expect(formatMoney({ amount: '5.00', currency: 'XX1' }, 'en-US')).toBe('5.00 XX1');
  });

  it('writes an address on one line without repeating a combined street', () => {
    expect(formatAddress({ street: 'Marktplatz 1', postalCode: '10178', locality: 'Berlin', country: 'DE' }, 'en')).toBe('Marktplatz 1, 10178 Berlin, Germany');
    expect(formatAddress({ street: 'Kurfürstendamm 18, 10719 Berlin' }, 'en')).toBe('Kurfürstendamm 18, 10719 Berlin');
    expect(formatAddress({}, 'en')).toBeUndefined();
  });

  it('lists the first three items and counts pieces', () => {
    const items = [{ name: 'A', quantity: 2 }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E', quantity: 3 }];
    const s = summarizeItems(items);
    expect(s.shown.map((i) => i.name)).toEqual(['A', 'B', 'C']);
    expect(s.more).toBe(2);
    expect(s.count).toBe(8);
  });

  it('takes item images from the parcel when the order has none', () => {
    const shipment: Shipment = {
      kind: 'shipment', key: 'k', items: [{ name: 'Shoes', quantity: 1 }], source: 'json-ld',
      parcels: [{ items: [{ name: 'Shoes', image: { url: 'https://img.example.com/1.jpg', host: 'img.example.com' } }] }],
    };
    expect(shipmentItems(shipment)[0].image?.host).toBe('img.example.com');
    expect(shipmentItems({ ...shipment, items: [] }).map((i) => i.name)).toEqual(['Shoes']);
  });

  it('accepts only http(s) links', () => {
    expect(isWebLink({ url: 'https://dhl.de/x' })).toBe(true);
    expect(isWebLink({ url: 'http://dhl.de/x' })).toBe(true);
    expect(isWebLink({ url: 'javascript:alert(1)' })).toBe(false);
    expect(isWebLink({ url: 'data:text/html,x' })).toBe(false);
    expect(isWebLink({ url: 'not a url' })).toBe(false);
  });
});

describe('formatting does not depend on the process zone', () => {
  beforeEach(() => {
    process.env.TZ = 'Pacific/Honolulu';
  });
  it('keeps a Berlin morning a Berlin morning in Honolulu', () => {
    expect(formatMoment(BERLIN, en)).toBe('Tue, Dec 1, 10:15');
  });
});
