/**
 * One card per booking. Senders write one FlightReservation per passenger
 * and leg, an Order next to its ParcelDelivery, or the same booking in both
 * JSON-LD and microdata; equal merge keys (normalize.ts cardKey) are folded
 * together here. If any part of a booking failed validation, or two parts
 * disagree about the same leg, the whole booking is dropped.
 */
import { legKey } from './normalize';
import type {
  Booking,
  BookingLinks,
  Candidate,
  Item,
  Moment,
  OrderStatus,
  Parcel,
  ReservationStatus,
  Seat,
  Shipment,
  StructuredCard,
  TransportBooking,
  TransportLeg,
} from './types';

const KIND_ORDER: StructuredCard['kind'][] = ['flight', 'train', 'bus', 'lodging', 'rentalcar', 'event', 'restaurant', 'shipment'];

function sameMoment(a: Moment | undefined, b: Moment | undefined): boolean {
  if (!a || !b) return true;
  if (a.utc && b.utc) return a.utc === b.utc;
  return a.date === b.date && (a.time ?? '') === (b.time ?? '');
}

function mergeLinks(all: BookingLinks[]): BookingLinks {
  const out: BookingLinks = {};
  for (const links of all) {
    out.checkin ??= links.checkin;
    out.manage ??= links.manage;
    out.ticket ??= links.ticket;
  }
  for (const key of Object.keys(out) as (keyof BookingLinks)[]) if (!out[key]) delete out[key];
  return out;
}

function unique<T>(values: (T | undefined)[]): T[] {
  return [...new Set(values.filter((v): v is T => v !== undefined))];
}

function latest(values: (string | undefined)[]): string | undefined {
  return unique(values).sort().pop();
}

/**
 * Status of a leg or booking several reservations contributed to: cancelled
 * only when every one of them says so. One cancelled passenger on a leg the
 * others still hold leaves the leg live.
 */
function combinedStatus(statuses: (ReservationStatus | undefined)[]): ReservationStatus | undefined {
  if (statuses.length > 0 && statuses.every((s) => s === 'cancelled')) return 'cancelled';
  return statuses.find((s) => s && s !== 'cancelled');
}

function mergeTransport(group: TransportBooking[]): TransportBooking | null {
  const legs = new Map<string, { legs: TransportLeg[] }>();
  for (const booking of group) {
    for (const leg of booking.legs) {
      const key = legKey(leg);
      const entry = legs.get(key) ?? { legs: [] };
      entry.legs.push(leg);
      legs.set(key, entry);
    }
  }
  const merged: TransportLeg[] = [];
  for (const { legs: parts } of legs.values()) {
    const [first] = parts;
    for (const other of parts.slice(1)) {
      if (!sameMoment(first.departure.at, other.departure.at) || !sameMoment(first.arrival?.at, other.arrival?.at)) return null;
    }
    const seats: Seat[] = [];
    const seen = new Set<string>();
    for (const seat of parts.flatMap((p) => p.seats)) {
      const id = `${seat.passenger ?? ''}|${seat.seat}`;
      if (!seen.has(id)) {
        seen.add(id);
        seats.push(seat);
      }
    }
    const status = combinedStatus(parts.map((p) => p.status));
    const withArrival = parts.find((p) => p.arrival?.at) ?? first;
    const { status: _ignored, ...rest } = first;
    merged.push({ ...rest, ...(withArrival.arrival ? { arrival: withArrival.arrival } : {}), seats, ...(status ? { status } : {}) });
  }
  merged.sort((a, b) => (a.departure.at.utc ?? `${a.departure.at.date}T${a.departure.at.time}`).localeCompare(b.departure.at.utc ?? `${b.departure.at.date}T${b.departure.at.time}`));
  const [head] = group;
  const allCancelled = merged.length > 0 && merged.every((leg) => leg.status === 'cancelled');
  const bookingStatus = allCancelled ? 'cancelled' : combinedStatus(group.map((b) => b.status).filter((s) => s !== 'cancelled'));
  const { status: _s, modified: _m, provider: _p, ...base } = head;
  const modified = latest(group.map((b) => b.modified));
  const provider = group.find((b) => b.provider)?.provider;
  return {
    ...base,
    ...(bookingStatus ? { status: bookingStatus } : {}),
    passengers: unique(group.flatMap((b) => b.passengers)),
    ...(provider ? { provider } : {}),
    links: mergeLinks(group.map((b) => b.links)),
    ...(modified ? { modified } : {}),
    legs: merged,
  } as TransportBooking;
}

function mergeOther(group: Booking[]): Booking {
  const [head] = group;
  const status = combinedStatus(group.map((b) => b.status));
  const modified = latest(group.map((b) => b.modified));
  const { status: _s, modified: _m, ...base } = head;
  const merged = {
    ...base,
    ...(status ? { status } : {}),
    passengers: unique(group.flatMap((b) => b.passengers)),
    links: mergeLinks(group.map((b) => b.links)),
    ...(modified ? { modified } : {}),
  } as Booking;
  if (merged.kind === 'event') merged.tickets = unique(group.flatMap((b) => (b.kind === 'event' ? b.tickets : [])));
  return merged;
}

/** Later shipping states win over earlier ones; a problem state over all. */
const ORDER_PROGRESS: OrderStatus[] = ['payment_due', 'processing', 'in_transit', 'pickup_available', 'delivered', 'returned', 'problem', 'cancelled'];

function mergeItems(lists: Item[][]): Item[] {
  const byName = new Map<string, Item>();
  for (const item of lists.flat()) {
    const key = item.name.toLowerCase();
    const known = byName.get(key);
    byName.set(key, known ? { ...item, ...known, image: known.image ?? item.image } : item);
  }
  return [...byName.values()].map((item) => {
    if (!item.image) delete item.image;
    return item;
  });
}

function mergeShipments(group: Shipment[]): Shipment {
  const parcels: Parcel[] = [];
  for (const parcel of group.flatMap((s) => s.parcels)) {
    const same = parcel.trackingNumber ? parcels.find((p) => p.trackingNumber === parcel.trackingNumber) : undefined;
    if (same) {
      same.carrier ??= parcel.carrier;
      same.trackingUrl ??= parcel.trackingUrl;
      same.expectedBy ??= parcel.expectedBy;
      same.items = mergeItems([same.items, parcel.items]);
    } else {
      parcels.push({ ...parcel, items: [...parcel.items] });
    }
  }
  const statuses = group.map((s) => s.status).filter((s): s is OrderStatus => !!s);
  const status = statuses.sort((a, b) => ORDER_PROGRESS.indexOf(a) - ORDER_PROGRESS.indexOf(b)).pop();
  const withOrder = group.find((s) => s.items.length > 0 || s.total) ?? group[0];
  const merged: Shipment = {
    kind: 'shipment',
    key: group[0].key,
    ...(group.find((s) => s.merchant) ? { merchant: group.find((s) => s.merchant)!.merchant } : {}),
    ...(group.find((s) => s.orderNumber) ? { orderNumber: group.find((s) => s.orderNumber)!.orderNumber } : {}),
    ...(status ? { status } : {}),
    items: mergeItems(group.map((s) => s.items)),
    ...(withOrder.total ? { total: withOrder.total } : {}),
    ...(group.find((s) => s.orderUrl) ? { orderUrl: group.find((s) => s.orderUrl)!.orderUrl } : {}),
    parcels,
    source: group[0].source,
  };
  return merged;
}

function startOf(card: StructuredCard): string {
  switch (card.kind) {
    case 'flight': case 'train': case 'bus': return card.legs[0]?.departure.at.utc ?? card.legs[0]?.departure.at.date ?? '';
    case 'lodging': return card.checkin.date;
    case 'rentalcar': return card.pickup.at.utc ?? card.pickup.at.date;
    case 'event': case 'restaurant': return card.start.utc ?? card.start.date;
    case 'shipment': return '';
  }
}

/** Fold candidates with equal keys into one card each; drop doubtful groups. */
export function mergeCandidates(candidates: Candidate[]): StructuredCard[] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.card.key) ?? [];
    group.push(candidate);
    groups.set(candidate.card.key, group);
  }
  const out: StructuredCard[] = [];
  for (const group of groups.values()) {
    if (group.some((c) => c.problems.length > 0)) continue;
    const cards = group.map((c) => c.card);
    const [head] = cards;
    if (head.kind === 'shipment') out.push(mergeShipments(cards as Shipment[]));
    else if (head.kind === 'flight' || head.kind === 'train' || head.kind === 'bus') {
      const merged = mergeTransport(cards as TransportBooking[]);
      if (merged) out.push(merged);
    } else out.push(mergeOther(cards as Booking[]));
  }
  return out.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || startOf(a).localeCompare(startOf(b)));
}
