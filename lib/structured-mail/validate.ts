/**
 * Plausibility checks that don't need time zones. A card with any problem is
 * dropped, together with every other part of the same booking (merge.ts):
 * a wrong card is worse than no card. Time order and durations are checked
 * once the zones are known (resolve.ts).
 */
import type { Candidate, Moment, StructuredCard, TransportLeg } from './types';

const DAY = 86_400_000;
const PAST_WINDOW_DAYS = 366;
const TRANSPORT_FUTURE_DAYS = 400;
const OTHER_FUTURE_DAYS = 760;

/**
 * Values from Google's markup documentation examples. Senders paste those
 * examples into newsletters (zave.it sent the "Eva Green" flight in a
 * cashback mail, with a passing DKIM signature); they are never real.
 */
const DOCUMENTATION_VALUES = new Set([
  'rxj34p', 'abc456', 'e123456789', 'ot12345', '546323', '3453291231', '176057', '123-4567890-1234567',
]);

function dayNumber(date: string): number | undefined {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / DAY) : undefined;
}

function hasDate(m: Moment | undefined): m is Moment {
  return !!m && /^\d{4}-\d{2}-\d{2}$/.test(m.date);
}

function hasTime(m: Moment | undefined): boolean {
  return hasDate(m) && !!m.time;
}

function firstDate(card: StructuredCard): string | undefined {
  switch (card.kind) {
    case 'flight': case 'train': case 'bus': return card.legs[0]?.departure.at.date;
    case 'lodging': return card.checkin.date;
    case 'rentalcar': return card.pickup.at.date;
    case 'event': case 'restaurant': return card.start.date;
    case 'shipment': return undefined;
  }
}

function legProblems(kind: 'flight' | 'train' | 'bus', leg: TransportLeg, fromPass: boolean): string[] {
  const problems: string[] = [];
  if (!hasTime(leg.departure.at)) problems.push('departure time missing');
  if (!fromPass && !hasTime(leg.arrival?.at)) problems.push('arrival time missing');
  const named = (p: { code?: string; name?: string } | undefined) => !!(p && (kind === 'flight' ? p.code || p.name : p.name));
  if (!named(leg.departure.place)) problems.push('departure place missing');
  if (!named(leg.arrival?.place)) problems.push('arrival place missing');
  if (kind === 'flight' && !(leg.carrierCode || leg.carrier)) problems.push('airline missing');
  if (kind === 'flight' && !leg.number) problems.push('flight number missing');
  return problems;
}

function cardProblems(card: StructuredCard): string[] {
  switch (card.kind) {
    case 'flight': case 'train': case 'bus':
      if (card.legs.length === 0) return ['no legs'];
      return card.legs.flatMap((leg) => legProblems(card.kind as 'flight' | 'train' | 'bus', leg, card.source === 'pkpass'));
    case 'lodging': {
      const problems: string[] = [];
      if (!card.name) problems.push('hotel name missing');
      if (!hasDate(card.checkin) || !hasDate(card.checkout)) problems.push('stay dates missing');
      else {
        const nights = dayNumber(card.checkout.date)! - dayNumber(card.checkin.date)!;
        if (nights < 1) problems.push('check-out not after check-in');
        if (nights > 365) problems.push('stay longer than a year');
      }
      return problems;
    }
    case 'rentalcar': {
      const problems: string[] = [];
      if (!hasTime(card.pickup.at) || !hasTime(card.dropoff.at)) problems.push('rental times missing');
      else {
        const days = dayNumber(card.dropoff.at.date)! - dayNumber(card.pickup.at.date)!;
        if (days < 0) problems.push('dropoff before pickup');
        if (days > 365) problems.push('rental longer than a year');
      }
      return problems;
    }
    case 'event': {
      const problems: string[] = [];
      if (!card.name) problems.push('event name missing');
      if (!hasDate(card.start)) problems.push('event start missing');
      else if (card.end && hasDate(card.end)) {
        const days = dayNumber(card.end.date)! - dayNumber(card.start.date)!;
        if (days < 0) problems.push('event ends before it starts');
        if (days > 31) problems.push('event longer than a month');
      }
      return problems;
    }
    case 'restaurant': {
      const problems: string[] = [];
      if (!card.name) problems.push('restaurant name missing');
      if (!hasTime(card.start)) problems.push('reservation time missing');
      return problems;
    }
    case 'shipment': {
      const problems: string[] = [];
      const tracked = card.parcels.some((p) => p.trackingNumber || p.trackingUrl);
      if (!card.orderNumber && !tracked) problems.push('neither order number nor tracking');
      const showable = card.merchant || card.items.length > 0 || card.parcels.some((p) => p.carrier || p.items.length > 0 || p.expectedBy);
      if (!showable) problems.push('nothing to show');
      return problems;
    }
  }
}

function identifiers(card: StructuredCard): string[] {
  if (card.kind === 'shipment') {
    return [card.orderNumber, ...card.parcels.map((p) => p.trackingNumber)].filter((v): v is string => !!v);
  }
  return card.reference ? [card.reference] : [];
}

/** Check one card against the mail's date. */
export function validateCard(card: StructuredCard, mailDate: Date): Candidate {
  const problems = cardProblems(card);
  if (identifiers(card).some((id) => DOCUMENTATION_VALUES.has(id.toLowerCase()))) {
    problems.push('documentation example');
  }
  const date = firstDate(card);
  const mailDay = Math.floor(mailDate.getTime() / DAY);
  const day = date ? dayNumber(date) : undefined;
  if (date !== undefined && day !== undefined && Number.isFinite(mailDay)) {
    const future = card.kind === 'flight' || card.kind === 'train' || card.kind === 'bus' ? TRANSPORT_FUTURE_DAYS : OTHER_FUTURE_DAYS;
    if (day < mailDay - PAST_WINDOW_DAYS || day > mailDay + future) problems.push('date too far from the mail');
  }
  return { card, problems };
}
