import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { loadAirportZones, mergeCandidates, readStructuredMail, resolveCards, type EventBooking, type TransportBooking } from '..';
import { isPkpassAttachment, passToCards, readPassJson, readPkpass } from '../pkpass';
import {
  AIR_SEMANTICS,
  BUS_SEMANTICS,
  EVENT_SEMANTICS,
  MAIL_DATE,
  TRAIN_SEMANTICS,
  boardingPass,
  eventTicket,
  otherPass,
  zipPass,
} from './pkpass-fixtures';

const CTX = { mailDate: MAIL_DATE };

/** The same flight as AIR_SEMANTICS, as the booking mail's JSON-LD would give it. */
const MARKUP = `<html><head><script type="application/ld+json">${JSON.stringify({
  '@context': 'http://schema.org', '@type': 'FlightReservation', reservationNumber: 'PK7Q2Z',
  underName: { '@type': 'Person', name: 'Jana Beispiel' },
  reservationFor: {
    '@type': 'Flight', flightNumber: 'LX1072', airline: { '@type': 'Airline', name: 'Swiss', iataCode: 'LX' },
    departureAirport: { '@type': 'Airport', name: 'Zurich Airport', iataCode: 'ZRH' }, departureTime: '2026-12-03T07:40:00+01:00',
    arrivalAirport: { '@type': 'Airport', name: 'Berlin Brandenburg', iataCode: 'BER' }, arrivalTime: '2026-12-03T09:05:00+01:00',
  },
})}</script></head><body></body></html>`;

async function cardsFrom(pass: unknown) {
  return readPkpass(await zipPass(pass), CTX);
}

describe('isPkpassAttachment', () => {
  it('goes by file name or type, up to 5 MB', () => {
    expect(isPkpassAttachment({ name: 'BoardingPass.PKPASS', type: 'application/octet-stream', size: 4000 })).toBe(true);
    expect(isPkpassAttachment({ name: 'ticket', type: 'application/vnd.apple.pkpass; name=x', size: 4000 })).toBe(true);
    expect(isPkpassAttachment({ name: 'ticket.pdf', type: 'application/pdf', size: 4000 })).toBe(false);
    expect(isPkpassAttachment({ name: 'big.pkpass', type: 'application/vnd.apple.pkpass', size: 5 * 1024 * 1024 + 1 })).toBe(false);
    expect(isPkpassAttachment({ name: 'empty.pkpass', type: 'application/vnd.apple.pkpass', size: 0 })).toBe(false);
  });
});

describe('passToCards', () => {
  it('turns an air boarding pass into the flight booking the markup describes, with the same key', async () => {
    const [card] = await cardsFrom(boardingPass()) as TransportBooking[];
    expect(card).toMatchObject({
      kind: 'flight', source: 'pkpass', reference: 'PK7Q2Z', passengers: ['Jana Beispiel'],
      provider: 'Swiss International Air Lines', links: {},
    });
    expect(card.legs).toEqual([{
      carrier: 'Swiss International Air Lines', carrierCode: 'LX', number: '1072',
      departure: { place: { code: 'ZRH', name: 'Zurich Airport' }, at: { date: '2026-12-03', time: '07:40:00', offsetMinutes: 60, utc: '2026-12-03T06:40:00Z' } },
      arrival: { place: { code: 'BER', name: 'Berlin Brandenburg' }, at: { date: '2026-12-03', time: '09:05:00', offsetMinutes: 60, utc: '2026-12-03T08:05:00Z' } },
      seats: [{ passenger: 'Jana Beispiel', seat: '14C' }],
    }]);
    const [markup] = readStructuredMail(MARKUP, CTX);
    expect(markup.key).toBe('flight|ref:pk7q2z');
    expect(card.key).toBe(markup.key);
  });

  it('merges with the markup booking into one card with one leg', async () => {
    const pass = await cardsFrom(boardingPass());
    const markup = readStructuredMail(MARKUP, CTX);
    const merged = mergeCandidates([...markup, ...pass].map((card) => ({ card, problems: [] }))) as TransportBooking[];
    expect(merged).toHaveLength(1);
    expect(merged[0].legs).toHaveLength(1);
    expect(merged[0].legs[0].seats).toEqual([{ passenger: 'Jana Beispiel', seat: '14C' }]);
    expect(merged[0].passengers).toEqual(['Jana Beispiel']);
  });

  it('merges with markup that pads the flight number with zeros (LX0072 and flightNumber 72)', async () => {
    const pass = await cardsFrom(boardingPass({ ...AIR_SEMANTICS, flightNumber: 72, flightCode: 'LX72' }));
    const markup = readStructuredMail(MARKUP.replace('"flightNumber":"LX1072"', '"flightNumber":"LX0072"'), CTX);
    const merged = mergeCandidates([...markup, ...pass].map((card) => ({ card, problems: [] }))) as TransportBooking[];
    expect(merged).toHaveLength(1);
    expect(merged[0].legs).toHaveLength(1);
    const { confirmationNumber: _ref, ...noRef } = AIR_SEMANTICS;
    const [unreferenced] = await cardsFrom(boardingPass({ ...noRef, flightNumber: 72, flightCode: 'LX72' }));
    const [markupLeg] = readStructuredMail(MARKUP.replace('"reservationNumber":"PK7Q2Z",', '').replace('"flightNumber":"LX1072"', '"flightNumber":"LX0072"'), CTX);
    expect(unreferenced.key).toBe(markupLeg.key);
  });

  it('keys a pass without confirmation number by its leg, like markup without one', async () => {
    const { confirmationNumber: _ref, ...semantics } = AIR_SEMANTICS;
    const [card] = await cardsFrom(boardingPass(semantics));
    expect(card.key).toBe('flight|leg:lx|1072|2026-12-03|zrh');
    const [markup] = readStructuredMail(MARKUP.replace('"reservationNumber":"PK7Q2Z",', ''), CTX);
    expect(card.key).toBe(markup.key);
  });

  it('gives nothing for a flight whose departure airport has a name but no code, as its leg could not be matched', async () => {
    const { departureAirportCode: _c, ...nameOnly } = AIR_SEMANTICS;
    expect(await cardsFrom(boardingPass(nameOnly))).toEqual([]);
    expect(await cardsFrom(boardingPass({ ...AIR_SEMANTICS, departureAirportCode: 'LSZH' }))).toEqual([]);
  });

  it('keeps a leg without arrival time and resolves its zone like any flight', async () => {
    const { originalArrivalDate: _a, ...semantics } = AIR_SEMANTICS;
    const cards = await cardsFrom(boardingPass(semantics));
    const [card] = resolveCards(cards, await loadAirportZones()) as TransportBooking[];
    expect(card.legs[0].arrival).toEqual({ place: { code: 'BER', name: 'Berlin Brandenburg' } });
    expect(card.legs[0].departure.at.zone).toBe('Europe/Zurich');
  });

  it('reads flightCode alone and refuses a flightCode that contradicts airlineCode and flightNumber', async () => {
    const { airlineCode: _c, flightNumber: _n, ...codeOnly } = AIR_SEMANTICS;
    const [card] = await cardsFrom(boardingPass(codeOnly)) as TransportBooking[];
    expect(card.legs[0]).toMatchObject({ carrierCode: 'LX', number: '1072' });
    expect(await cardsFrom(boardingPass({ ...AIR_SEMANTICS, flightCode: 'LX1073' }))).toEqual([]);
    expect(await cardsFrom(boardingPass({ ...AIR_SEMANTICS, airlineCode: 'SWR' }))).toEqual([]);
  });

  it('uses the updated departure, and only the updated arrival with it', async () => {
    const [card] = await cardsFrom(boardingPass({ ...AIR_SEMANTICS, currentDepartureDate: '2026-12-03T08:25+01:00' })) as TransportBooking[];
    expect(card.legs[0].departure.at.time).toBe('08:25:00');
    expect(card.legs[0].arrival?.at).toBeUndefined();
    expect(await cardsFrom(boardingPass({ ...AIR_SEMANTICS, currentDepartureDate: '2026-12-04T00:30+01:00' }))).toEqual([]);
  });

  it('pairs the scheduled arrival only with the scheduled departure', async () => {
    const { originalDepartureDate: _d, ...noOriginal } = AIR_SEMANTICS;
    const [delayed] = await cardsFrom(boardingPass({ ...noOriginal, currentDepartureDate: '2026-12-03T08:25+01:00' })) as TransportBooking[];
    expect(delayed.legs[0].departure.at.time).toBe('08:25:00');
    expect(delayed.legs[0].arrival).toEqual({ place: { code: 'BER', name: 'Berlin Brandenburg' } });
    const [updated] = await cardsFrom(boardingPass({ ...noOriginal, currentDepartureDate: '2026-12-03T08:25+01:00', currentArrivalDate: '2026-12-03T09:50+01:00' })) as TransportBooking[];
    expect(updated.legs[0].arrival?.at?.time).toBe('09:50:00');
    const [same] = await cardsFrom(boardingPass({ ...AIR_SEMANTICS, currentDepartureDate: '2026-12-03T07:40:00+01:00' })) as TransportBooking[];
    expect(same.legs[0].arrival?.at?.time).toBe('09:05:00');
  });

  it('places a UTC flight time in the airport zone once resolved, with or without a zone tag', async () => {
    const zones = await loadAirportZones();
    const { departureLocationTimeZone: _z, destinationLocationTimeZone: _y, ...noTags } = AIR_SEMANTICS;
    const utc = { ...noTags, originalDepartureDate: '2026-12-03T06:40:00Z', originalArrivalDate: '2026-12-03T08:05:00Z' };
    const raw = await cardsFrom(boardingPass(utc)) as TransportBooking[];
    expect(raw[0].legs[0].departure.at.instantOnly).toBe(true);
    const [card] = resolveCards(raw, zones) as TransportBooking[];
    expect(card.legs[0].departure.at).toEqual({ date: '2026-12-03', time: '07:40:00', offsetMinutes: 60, utc: '2026-12-03T06:40:00Z', zone: 'Europe/Zurich' });
    expect(card.legs[0].arrival?.at).toMatchObject({ time: '09:05:00', zone: 'Europe/Berlin' });
    expect(resolveCards(raw)).toEqual([]);

    const [tagged] = await cardsFrom(boardingPass({ ...AIR_SEMANTICS, originalDepartureDate: '2026-12-03T06:40:00+00:00' })) as TransportBooking[];
    expect(tagged.legs[0].departure.at).toEqual({ date: '2026-12-03', time: '07:40:00', offsetMinutes: 60, utc: '2026-12-03T06:40:00Z' });

    const london = { ...noTags, airlineCode: 'BA', flightNumber: 710, flightCode: 'BA710', departureAirportCode: 'LHR', departureAirportName: 'Heathrow', originalDepartureDate: '2026-12-03T06:40:00+00:00', originalArrivalDate: '2026-12-03T09:10:00+01:00' };
    const [lhr] = resolveCards(await cardsFrom(boardingPass(london)), zones) as TransportBooking[];
    expect(lhr.legs[0].departure.at).toMatchObject({ date: '2026-12-03', time: '06:40:00', offsetMinutes: 0, zone: 'Europe/London' });
  });

  it('places a UTC train time only with a zone tag, and never a UTC event time', async () => {
    const utcTrain = { ...TRAIN_SEMANTICS, originalDepartureDate: '2026-12-05T07:46:00Z', originalArrivalDate: '2026-12-05T11:50:00Z' };
    expect(await cardsFrom(boardingPass(utcTrain, 'PKTransitTypeTrain'))).toEqual([]);
    const tagged = { ...utcTrain, departureLocationTimeZone: 'Europe/Berlin', destinationLocationTimeZone: 'Europe/Berlin' };
    const [train] = await cardsFrom(boardingPass(tagged, 'PKTransitTypeTrain')) as TransportBooking[];
    expect(train.legs[0].departure.at).toEqual({ date: '2026-12-05', time: '08:46:00', offsetMinutes: 60, utc: '2026-12-05T07:46:00Z' });
    expect(train.legs[0].arrival?.at?.time).toBe('12:50:00');
    expect(await cardsFrom(boardingPass({ ...BUS_SEMANTICS, currentDepartureDate: '2026-12-06T09:15:00Z' }, 'PKTransitTypeBus'))).toEqual([]);
    expect(await cardsFrom(eventTicket({ ...EVENT_SEMANTICS, eventStartDate: '2026-12-12T18:30:00Z' }))).toEqual([]);
    expect(await cardsFrom(eventTicket({ ...EVENT_SEMANTICS, eventEndDate: '2026-12-12T20:45:00Z' }))).toEqual([]);
  });

  it('keeps the card only for a transit status that says the trip runs as planned', async () => {
    for (const status of ['On Time', 'pünktlich', 'Boarding', 'SCHEDULED', 'planmäßig', 'on-time']) {
      expect(await cardsFrom(boardingPass({ ...AIR_SEMANTICS, transitStatus: status })), status).toHaveLength(1);
    }
    for (const status of ['Delayed', 'Verspätet 40 Min.', 'Diverted', 'fällt aus', 'gestrichen', 'Gate closed', 'Cancelled']) {
      expect(await cardsFrom(boardingPass({ ...AIR_SEMANTICS, transitStatus: status })), status).toEqual([]);
    }
  });

  it('gives nothing when the pass zone disagrees with the time, or the status says cancelled', async () => {
    expect(await cardsFrom(boardingPass({ ...AIR_SEMANTICS, departureLocationTimeZone: 'America/New_York' }))).toEqual([]);
    expect(await cardsFrom(boardingPass({ ...AIR_SEMANTICS, departureLocationTimeZone: 'Not/AZone' }))).toEqual([]);
    expect(await cardsFrom(boardingPass({ ...AIR_SEMANTICS, transitStatus: 'Cancelled' }))).toEqual([]);
  });

  it('turns a train boarding pass into a train booking', async () => {
    const [card] = await cardsFrom(boardingPass(TRAIN_SEMANTICS, 'PKTransitTypeTrain')) as TransportBooking[];
    expect(card).toMatchObject({ kind: 'train', reference: 'ZUG4471', key: 'train|ref:zug4471', provider: 'Deutsche Bahn', passengers: ['Jana Beispiel'] });
    expect(card.legs).toEqual([{
      carrier: 'Deutsche Bahn', number: 'ICE 597',
      departure: { place: { name: 'Hamburg Hbf' }, at: { date: '2026-12-05', time: '08:46:00', offsetMinutes: 60, utc: '2026-12-05T07:46:00Z' } },
      arrival: { place: { name: 'Köln Hbf' }, at: { date: '2026-12-05', time: '12:50:00', offsetMinutes: 60, utc: '2026-12-05T11:50:00Z' } },
      seats: [{ passenger: 'Jana Beispiel', seat: '7/45' }],
    }]);
  });

  it('turns a bus boarding pass into a bus booking', async () => {
    const [card] = await cardsFrom(boardingPass(BUS_SEMANTICS, 'PKTransitTypeBus')) as TransportBooking[];
    expect(card).toMatchObject({ kind: 'bus', reference: 'BUS-80411', passengers: ['Ole Probe'] });
    expect(card.legs[0]).toMatchObject({ departure: { place: { name: 'Bremen ZOB' }, at: { time: '10:15:00' } }, arrival: { place: { name: 'Hannover ZOB' } } });
  });

  it('turns an event ticket into an event booking', async () => {
    const [card] = await cardsFrom(eventTicket()) as EventBooking[];
    expect(card).toEqual({
      key: 'event|tkt-30918|kammerkonzert im turmsaal|2026-12-12', kind: 'event', reference: 'TKT-30918',
      passengers: ['Jana Beispiel'], provider: 'Swiss', links: {}, source: 'pkpass', name: 'Kammerkonzert im Turmsaal',
      venue: { name: 'Turmsaal Hildesheim', address: { locality: 'Hildesheim' } },
      start: { date: '2026-12-12', time: '19:30:00', offsetMinutes: 60, utc: '2026-12-12T18:30:00Z' },
      end: { date: '2026-12-12', time: '21:45:00', offsetMinutes: 60, utc: '2026-12-12T20:45:00Z' },
      tickets: [],
    });
  });

  it('ignores store cards, coupons and generic passes', async () => {
    for (const style of ['storeCard', 'coupon', 'generic'] as const) expect(await cardsFrom(otherPass(style))).toEqual([]);
  });

  it('gives nothing for a pass without semantics, even with relevantDate and organizationName', async () => {
    expect(await cardsFrom(boardingPass(null))).toEqual([]);
    expect(await cardsFrom(eventTicket(null))).toEqual([]);
  });

  it('gives nothing for boat, generic or unknown transit types', async () => {
    for (const type of ['PKTransitTypeBoat', 'PKTransitTypeGeneric', 'PKTransitTypeRocket', '']) {
      expect(await cardsFrom(boardingPass(AIR_SEMANTICS, type))).toEqual([]);
    }
  });

  it('gives nothing when semantics lack what validation needs', async () => {
    const { originalDepartureDate: _d, ...noDeparture } = AIR_SEMANTICS;
    expect(await cardsFrom(boardingPass(noDeparture))).toEqual([]);
    const { destinationAirportCode: _c, destinationAirportName: _n, ...noArrival } = AIR_SEMANTICS;
    expect(await cardsFrom(boardingPass(noArrival))).toEqual([]);
    const { departureStationName: _s, ...noStation } = TRAIN_SEMANTICS;
    expect(await cardsFrom(boardingPass(noStation, 'PKTransitTypeTrain'))).toEqual([]);
    const { eventStartDate: _e, ...noStart } = EVENT_SEMANTICS;
    expect(await cardsFrom(eventTicket(noStart))).toEqual([]);
    expect(await cardsFrom(boardingPass({ ...AIR_SEMANTICS, originalDepartureDate: '3 Dec 2026 07:40' }))).toEqual([]);
  });

  it('gives nothing for a voided pass, a wrong formatVersion or two pass styles', async () => {
    expect(await cardsFrom(boardingPass(AIR_SEMANTICS, 'PKTransitTypeAir', { voided: true }))).toEqual([]);
    expect(await cardsFrom(boardingPass(AIR_SEMANTICS, 'PKTransitTypeAir', { formatVersion: 2 }))).toEqual([]);
    expect(await cardsFrom(boardingPass(AIR_SEMANTICS, 'PKTransitTypeAir', { eventTicket: {} }))).toEqual([]);
  });

  it('gives nothing for dates far from the mail date', async () => {
    const far = { ...AIR_SEMANTICS, originalDepartureDate: '2028-06-03T07:40+02:00', originalArrivalDate: '2028-06-03T09:05+02:00' };
    expect(passToCards(boardingPass(far), CTX)).toEqual([]);
    expect(passToCards(eventTicket({ ...EVENT_SEMANTICS, eventStartDate: '2024-01-12T19:30:00+01:00', eventEndDate: undefined }), CTX)).toEqual([]);
  });
});

describe('readPassJson', () => {
  it('reads pass.json, with or without a byte order mark', async () => {
    expect(await readPassJson(await zipPass(boardingPass()))).toMatchObject({ formatVersion: 1, semantics: { airlineCode: 'LX' } });
    expect(await readPassJson(await zipPass(null, { raw: String.fromCharCode(0xfeff) + JSON.stringify(eventTicket()) }))).toMatchObject({ eventTicket: {} });
  });

  it('gives undefined without throwing for anything doubtful', async () => {
    const valid = await zipPass(boardingPass());
    const corrupt = valid.slice(0, valid.length / 2);
    const noPass = await (() => { const zip = new JSZip(); zip.file('manifest.json', '{}'); return zip.generateAsync({ type: 'uint8array' }); })();
    const huge = await zipPass({ ...boardingPass(), padding: 'x'.repeat(300 * 1024) });
    const manyFiles = await zipPass(boardingPass(), { files: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`en.lproj/f${i}.txt`, 'x'])) });
    const notJson = await zipPass(null, { raw: '{"formatVersion": 1, "boardingPass": ' });
    const notObject = await zipPass(null, { raw: '[1, 2]' });
    for (const bytes of [new Uint8Array(), new Uint8Array([1, 2, 3, 4]), corrupt, noPass, huge, manyFiles, notJson, notObject]) {
      await expect(readPassJson(bytes)).resolves.toBeUndefined();
    }
    expect(await readPkpass(huge, CTX)).toEqual([]);
  });

  it('never inflates anything but pass.json', async () => {
    const zip = new JSZip();
    zip.file('pass.json', JSON.stringify(boardingPass()));
    zip.file('strip.png', 'y'.repeat(4 * 1024 * 1024));
    zip.file('en.lproj/pass.strings', '"a" = "b";');
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const real = await JSZip.loadAsync(bytes);
    // Every way to inflate an entry, on every entry, however it is reached
    // (zip.file(), zip.files[...], forEach): record which entries are read.
    const inflated: string[] = [];
    for (const entry of Object.values(real.files)) {
      const target = entry as unknown as Record<string, (...args: unknown[]) => unknown>;
      for (const method of ['async', 'internalStream', 'nodeStream']) {
        const original = target[method];
        if (typeof original !== 'function') continue;
        target[method] = function (this: unknown, ...args: unknown[]) {
          inflated.push(entry.name);
          return original.apply(this, args);
        };
      }
    }
    const loadZip = async () => ({ loadAsync: async () => real }) as unknown as typeof JSZip;
    expect(await readPkpass(bytes, CTX, { loadZip })).toHaveLength(1);
    expect(inflated).toEqual(['pass.json']);
  });
});
