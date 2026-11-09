/**
 * Second validation pass, once zones can be looked up: give every time its
 * zone and instant, then check order and durations on UTC instants (an
 * eastbound flight over the date line lands "earlier" on the wall clock).
 * A booking whose times don't hold together is dropped.
 */
import { countryZone, resolveZone, wallClockAt, zoneOffsetAt, zonedTimeToUtc, type ResolvedZone } from './time-zones';
import type { Moment, Place, StructuredCard, TransportBooking, TransportLeg } from './types';

type ZoneOf = (code: string | undefined) => string | undefined;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LIMITS = {
  flight: { min: 10 * MINUTE, max: 20 * HOUR },
  train: { min: MINUTE, max: 48 * HOUR },
  bus: { min: MINUTE, max: 48 * HOUR },
} as const;

/** Whether resolving these cards needs the airport table. */
export function needsAirportZones(cards: StructuredCard[]): boolean {
  return cards.some((card) => card.kind === 'flight');
}

interface Named { zone: string; source: 'airport' | 'country' }

function namedZone(place: Place | undefined, kind: StructuredCard['kind'], zoneOf: ZoneOf | undefined, floating: boolean): Named | undefined {
  if (kind === 'flight') {
    const zone = zoneOf?.(place?.code);
    return zone ? { zone, source: 'airport' } : undefined;
  }
  const zone = countryZone(place?.address?.country, { floating });
  return zone ? { zone, source: 'country' } : undefined;
}

/**
 * Attach zone and instant to a timed moment. 'drop' when table and mail
 * disagree, or when a floating local time falls into a DST gap or overlap.
 * An instant without a known wall clock (a pass's UTC time, `instantOnly`)
 * takes date, time and offset from the place's zone, or is dropped without one.
 */
function resolveMoment(m: Moment, named: Named | undefined): Moment | 'drop' {
  if (m.instantOnly) {
    if (!named || !m.utc) return 'drop';
    const ms = Date.parse(m.utc);
    const local = wallClockAt(ms, named.zone);
    return { date: local.date, time: local.time, offsetMinutes: zoneOffsetAt(named.zone, ms), utc: m.utc, zone: named.zone };
  }
  if (!m.time) return m;
  const utcMs = m.utc ? Date.parse(m.utc) : undefined;
  const resolved: ResolvedZone | 'mismatch' = resolveZone({ named, offsetMinutes: m.offsetMinutes, utcMs });
  if (resolved === 'mismatch') return 'drop';
  if (m.utc || resolved.zone === null) return { ...m, zone: resolved.zone };
  const utc = zonedTimeToUtc(m.date, m.time, resolved.zone);
  if (utc === null) return 'drop';
  return { ...m, zone: resolved.zone, utc: new Date(utc).toISOString().replace('.000Z', 'Z') };
}

function resolveLeg(kind: TransportBooking['kind'], leg: TransportLeg, zoneOf: ZoneOf | undefined): TransportLeg | null {
  const dep = resolveMoment(leg.departure.at, namedZone(leg.departure.place, kind, zoneOf, leg.departure.at.offsetMinutes === undefined));
  if (dep === 'drop' || !dep.utc) return null;
  let arrivalAt: Moment | undefined;
  if (leg.arrival?.at) {
    const arr = resolveMoment(leg.arrival.at, namedZone(leg.arrival.place, kind, zoneOf, leg.arrival.at.offsetMinutes === undefined));
    if (arr === 'drop' || !arr.utc) return null;
    const duration = Date.parse(arr.utc) - Date.parse(dep.utc);
    if (duration < LIMITS[kind].min || duration > LIMITS[kind].max) return null;
    arrivalAt = arr;
  }
  return {
    ...leg,
    departure: { ...leg.departure, at: dep },
    ...(leg.arrival ? { arrival: { ...leg.arrival, ...(arrivalAt ? { at: arrivalAt } : {}) } } : {}),
  };
}

/** Order two resolved moments: by instant when both have one, else by wall clock. */
function notBefore(later: Moment, earlier: Moment): boolean {
  if (later.utc && earlier.utc) return Date.parse(later.utc) >= Date.parse(earlier.utc);
  return `${later.date}T${later.time ?? '00:00:00'}` >= `${earlier.date}T${earlier.time ?? '00:00:00'}`;
}

function resolveCard(card: StructuredCard, zoneOf: ZoneOf | undefined): StructuredCard | null {
  switch (card.kind) {
    case 'flight': case 'train': case 'bus': {
      const legs: TransportLeg[] = [];
      for (const leg of card.legs) {
        const resolved = resolveLeg(card.kind, leg, zoneOf);
        if (!resolved) return null;
        legs.push(resolved);
      }
      return { ...card, legs };
    }
    case 'lodging': {
      const place: Place = { address: card.address };
      const resolveEnd = (m: Moment): Moment | 'drop' => {
        const named = namedZone(place, card.kind, zoneOf, m.offsetMinutes === undefined);
        // A time with neither offset nor a known zone says nothing reliable:
        // keep the date only.
        if (m.time && m.offsetMinutes === undefined && !named) return { date: m.date };
        return resolveMoment(m, named);
      };
      const checkin = resolveEnd(card.checkin);
      const checkout = resolveEnd(card.checkout);
      if (checkin === 'drop' || checkout === 'drop') return null;
      if (checkin.time && checkout.time && !notBefore(checkout, checkin)) return null;
      return { ...card, checkin, checkout };
    }
    case 'rentalcar': {
      const pickupAt = resolveMoment(card.pickup.at, namedZone(card.pickup.place, card.kind, zoneOf, card.pickup.at.offsetMinutes === undefined));
      const dropoffAt = resolveMoment(card.dropoff.at, namedZone(card.dropoff.place, card.kind, zoneOf, card.dropoff.at.offsetMinutes === undefined));
      if (pickupAt === 'drop' || dropoffAt === 'drop') return null;
      if (!notBefore(dropoffAt, pickupAt) || notBefore(pickupAt, dropoffAt)) return null;
      return { ...card, pickup: { ...card.pickup, at: pickupAt }, dropoff: { ...card.dropoff, at: dropoffAt } };
    }
    case 'event': {
      const named = (m: Moment) => namedZone(card.venue, card.kind, zoneOf, m.offsetMinutes === undefined);
      const start = resolveMoment(card.start, named(card.start));
      if (start === 'drop') return null;
      // An end without its own offset (a date-only end turned into the end of
      // that day) belongs to the start's zone when the venue names none.
      const endNamed = card.end && card.end.offsetMinutes === undefined && !named(card.end) && start.zone
        ? { zone: start.zone, source: 'country' as const }
        : card.end ? named(card.end) : undefined;
      const end = card.end ? resolveMoment(card.end, endNamed) : undefined;
      if (end === 'drop') return null;
      if (end && !notBefore(end, start)) return null;
      return { ...card, start, ...(end ? { end } : {}) };
    }
    case 'restaurant': {
      const start = resolveMoment(card.start, namedZone({ address: card.address }, card.kind, zoneOf, card.start.offsetMinutes === undefined));
      if (start === 'drop') return null;
      return { ...card, start };
    }
    case 'shipment':
      return card;
  }
}

/**
 * Resolve zones and drop cards whose times don't hold together. `zoneOf` is
 * the airport lookup from loadAirportZones(); without it, flight cards are
 * dropped (the card must not show before its zones are known).
 */
export function resolveCards(cards: StructuredCard[], zoneOf?: ZoneOf): StructuredCard[] {
  const out: StructuredCard[] = [];
  for (const card of cards) {
    if (card.kind === 'flight' && !zoneOf) continue;
    const resolved = resolveCard(card, zoneOf);
    if (resolved) out.push(resolved);
  }
  return out;
}
