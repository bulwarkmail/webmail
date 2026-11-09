/**
 * Turn extracted schema.org objects into the card model. Unknown types and
 * properties are dropped; validation (validate.ts) decides afterwards which
 * cards are believable.
 */
import type { ExtractedItem } from './extract';
import type {
  BookingKind,
  BookingLinks,
  CardSource,
  Item,
  Moment,
  Parcel,
  Place,
  Seat,
  Shipment,
  StructuredCard,
  TransportBooking,
  TransportKind,
  TransportLeg,
} from './types';
import {
  address,
  all,
  amount,
  currency,
  hasType,
  isObj,
  isSchemaContext,
  link,
  moment,
  lenientDate,
  nameOf,
  obj,
  orderStatus,
  people,
  positiveInt,
  reservationStatus,
  str,
  typesOf,
  type Obj,
} from './values';

const RESERVATION_KINDS: Record<string, BookingKind> = {
  FlightReservation: 'flight',
  TrainReservation: 'train',
  BusReservation: 'bus',
  LodgingReservation: 'lodging',
  RentalCarReservation: 'rentalcar',
  EventReservation: 'event',
  FoodEstablishmentReservation: 'restaurant',
};

const MAX_OBJECTS = 200;

interface Found {
  object: Obj;
  source: CardSource;
}

/**
 * Flatten what the extractor found into typed top-level objects: arrays,
 * `@graph`, ReservationPackage `subReservation`, and `reservationFor` arrays
 * (one reservation per element). Only objects under a schema.org context
 * count; nested objects inherit it.
 */
function flatten(extracted: ExtractedItem[]): Found[] {
  const out: Found[] = [];
  const visit = (value: unknown, source: CardSource, inherited: boolean, depth: number) => {
    if (out.length >= MAX_OBJECTS || depth > 6) return;
    if (Array.isArray(value)) {
      for (const v of value) visit(v, source, inherited, depth + 1);
      return;
    }
    if (!isObj(value)) return;
    const inContext = inherited || isSchemaContext(value['@context']);
    if (Array.isArray(value['@graph'])) {
      visit(value['@graph'], source, inContext, depth + 1);
      return;
    }
    if (!inContext) return;
    if (hasType(value, ['ReservationPackage'])) {
      visit(value.subReservation, source, true, depth + 1);
      return;
    }
    const reservationFor = value.reservationFor;
    if (Array.isArray(reservationFor) && reservationFor.length > 1) {
      for (const one of reservationFor) out.push({ object: { ...value, reservationFor: one }, source });
      return;
    }
    out.push({ object: value, source });
  };
  for (const { item, source } of extracted) visit(item, source, false, 0);
  return out;
}

const lower = (s: string | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

function place(value: unknown): Place {
  const v = obj(value);
  if (!v) {
    const name = str(value);
    return name ? { name } : {};
  }
  const result: Place = {};
  const name = str(v.name);
  if (name) result.name = name;
  const code = str(v.iataCode)?.toUpperCase();
  if (code && /^[A-Z]{3}$/.test(code)) result.code = code;
  const addr = address(v.address);
  if (addr) result.address = addr;
  return result;
}

function bookingLinks(res: Obj, extra: Obj | undefined): BookingLinks {
  const links: BookingLinks = {};
  const checkin = link(res.checkinUrl);
  const manage = link(res.modifyReservationUrl) ?? link(res.url) ?? link(res.Url);
  const ticket = link(res.ticketDownloadUrl) ?? link(res.ticketPrintUrl) ?? link(extra?.ticketDownloadUrl);
  if (checkin) links.checkin = checkin;
  if (manage) links.manage = manage;
  if (ticket) links.ticket = ticket;
  return links;
}

function reference(res: Obj): string | undefined {
  return str(res.reservationNumber) ?? str(res.reservationId) ?? str(res.confirmationNumber);
}

function tickets(res: Obj): Obj[] {
  return all(res.reservedTicket).filter(isObj);
}

function seatOf(res: Obj): string | undefined {
  const direct = str(res.airplaneSeat);
  if (direct) return direct;
  for (const ticket of tickets(res)) {
    const seat = obj(ticket.ticketedSeat);
    const number = str(seat?.seatNumber) ?? str(ticket.ticketedSeat);
    if (number) {
      const section = str(seat?.seatSection);
      return section ? `${section}/${number}` : number;
    }
  }
  return undefined;
}

function splitFlightNumber(raw: string | undefined, airlineCode: string | undefined): { code?: string; number?: string } {
  if (!raw) return { code: airlineCode };
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  if (airlineCode && compact.startsWith(airlineCode) && /^\d{1,4}[A-Z]?$/.test(compact.slice(airlineCode.length))) {
    return { code: airlineCode, number: compact.slice(airlineCode.length) };
  }
  const match = /^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/.exec(compact);
  if (match && /[A-Z]/.test(match[1]) && (!airlineCode || airlineCode === match[1])) return { code: match[1], number: match[2] };
  return { code: airlineCode, number: compact };
}

function transport(kind: TransportKind, res: Obj, source: CardSource): TransportBooking {
  const trip = obj(res.reservationFor) ?? {};
  const passengers = people(res.underName);
  let carrier: string | undefined;
  let carrierCode: string | undefined;
  let number: string | undefined;
  let departure: Place;
  let arrival: Place;
  if (kind === 'flight') {
    const airline = obj(trip.airline);
    const airlineCode = str(airline?.iataCode)?.toUpperCase();
    carrier = nameOf(trip.airline) ?? nameOf(trip.provider) ?? nameOf(res.provider);
    const split = splitFlightNumber(str(trip.flightNumber), airlineCode && /^[A-Z0-9]{2}$/.test(airlineCode) ? airlineCode : undefined);
    carrierCode = split.code;
    number = split.number;
    departure = place(trip.departureAirport);
    arrival = place(trip.arrivalAirport);
  } else if (kind === 'train') {
    carrier = nameOf(trip.provider) ?? nameOf(trip.trainCompany) ?? nameOf(res.provider);
    number = str(trip.trainNumber) ?? str(trip.trainName);
    departure = place(trip.departureStation);
    arrival = place(trip.arrivalStation);
  } else {
    carrier = nameOf(trip.busCompany) ?? nameOf(trip.provider) ?? nameOf(res.provider);
    // busName is ignored: FlixBus puts the destination there.
    number = str(trip.busNumber);
    departure = place(trip.departureBusStop ?? trip.departureStation);
    arrival = place(trip.arrivalBusStop ?? trip.arrivalStation);
  }
  const depAt = moment(trip.departureTime);
  const arrAt = moment(trip.arrivalTime);
  const seat = seatOf(res);
  const status = reservationStatus(res.reservationStatus);
  const seats: Seat[] = seat ? [{ ...(passengers[0] ? { passenger: passengers[0] } : {}), seat }] : [];
  const leg: TransportLeg = {
    ...(carrier ? { carrier } : {}),
    ...(carrierCode ? { carrierCode } : {}),
    ...(number ? { number } : {}),
    departure: { place: departure, at: depAt ?? { date: '' } },
    arrival: { place: arrival, ...(arrAt ? { at: arrAt } : {}) },
    seats,
    ...(status ? { status } : {}),
  };
  const ref = reference(res);
  return {
    key: '',
    kind,
    ...(ref ? { reference: ref } : {}),
    ...(status ? { status } : {}),
    passengers,
    ...(carrier ? { provider: carrier } : {}),
    links: bookingLinks(res, tickets(res)[0]),
    ...(str(res.modifiedTime) ? { modified: str(res.modifiedTime) } : {}),
    source,
    legs: [leg],
  };
}

function base(kind: BookingKind, res: Obj, source: CardSource) {
  const ref = reference(res);
  const status = reservationStatus(res.reservationStatus);
  return {
    key: '',
    kind,
    ...(ref ? { reference: ref } : {}),
    ...(status ? { status } : {}),
    passengers: people(res.underName),
    links: bookingLinks(res, tickets(res)[0]),
    ...(str(res.modifiedTime) ? { modified: str(res.modifiedTime) } : {}),
    source,
  };
}

const MISSING: Moment = { date: '' };

function reservation(kind: BookingKind, res: Obj, source: CardSource): StructuredCard | undefined {
  if (kind === 'flight' || kind === 'train' || kind === 'bus') return transport(kind, res, source);
  const target = obj(res.reservationFor) ?? {};
  const name = str(target.name) ?? (typeof res.reservationFor === 'string' ? str(res.reservationFor) : undefined);
  switch (kind) {
    case 'lodging': {
      const addr = address(target.address);
      const phone = str(target.telephone);
      return {
        ...base(kind, res, source),
        kind,
        name: name ?? '',
        ...(name ? { provider: name } : {}),
        ...(addr ? { address: addr } : {}),
        ...(phone ? { phone } : {}),
        checkin: moment(res.checkinDate) ?? moment(res.checkinTime) ?? MISSING,
        checkout: moment(res.checkoutDate) ?? moment(res.checkoutTime) ?? MISSING,
      };
    }
    case 'rentalcar': {
      const company = nameOf(target.rentalCompany) ?? nameOf(res.provider) ?? nameOf(target.brand);
      const car = [nameOf(target.brand), str(target.model) ?? str(target.name)].filter(Boolean).join(' ') || undefined;
      return {
        ...base(kind, res, source),
        kind,
        ...(company ? { company, provider: company } : {}),
        ...(car ? { car } : {}),
        pickup: { place: place(res.pickupLocation), at: moment(res.pickupTime) ?? MISSING },
        dropoff: { place: place(res.dropoffLocation), at: moment(res.dropoffTime) ?? MISSING },
      };
    }
    case 'event': {
      const venue = place(target.location);
      const ticketNumbers = [...new Set([str(res.ticketNumber), ...tickets(res).map((t) => str(t.ticketNumber))].filter((t): t is string => !!t))];
      const start = moment(target.startDate);
      let end = moment(target.endDate);
      // An end date without a time means the end of that day, when the
      // event starts at a time; with a date-only start it's an all-day span.
      // The end carries no offset: the day may end on the other side of a
      // DST change, so resolve.ts reads it in the zone the start resolves to.
      if (end && !end.time && start?.time) end = { ...end, time: '23:59:59' };
      return {
        ...base(kind, res, source),
        kind,
        name: name ?? '',
        ...(venue.name || venue.address ? { venue } : {}),
        start: start ?? MISSING,
        ...(end ? { end } : {}),
        tickets: ticketNumbers,
        ...(nameOf(res.provider) ? { provider: nameOf(res.provider) } : {}),
      };
    }
    case 'restaurant': {
      const addr = address(target.address);
      const partySize = positiveInt(res.partySize);
      return {
        ...base(kind, res, source),
        kind,
        name: name ?? '',
        ...(name ? { provider: name } : {}),
        ...(addr ? { address: addr } : {}),
        start: moment(res.startTime) ?? moment(res.startDate) ?? MISSING,
        ...(partySize ? { partySize } : {}),
      };
    }
  }
}

function items(products: unknown, quantityOf?: (o: Obj) => number | undefined): Item[] {
  const result: Item[] = [];
  for (const p of all(products)) {
    const name = nameOf(p);
    if (!name) continue;
    const product = isObj(p) ? p : undefined;
    const image = product ? link(isObj(product.image) ? product.image.url ?? product.image.contentUrl : product.image) : undefined;
    const quantity = product && quantityOf ? quantityOf(product) : undefined;
    result.push({ name, ...(quantity ? { quantity } : {}), ...(image ? { image } : {}) });
  }
  return result;
}

function orderItems(order: Obj): Item[] {
  const result: Item[] = [];
  for (const offer of all(order.acceptedOffer).filter(isObj)) {
    const quantity = positiveInt(offer.eligibleQuantity);
    for (const item of items(offer.itemOffered)) result.push(quantity ? { ...item, quantity } : item);
  }
  for (const entry of all(order.orderedItem).filter(isObj)) {
    if (hasType(entry, ['OrderItem'])) {
      const quantity = positiveInt(entry.orderQuantity);
      for (const item of items(entry.orderedItem)) result.push(quantity ? { ...item, quantity } : item);
    } else {
      result.push(...items(entry));
    }
  }
  return result;
}

function order(o: Obj, source: CardSource): Shipment {
  const merchant = nameOf(o.merchant) ?? nameOf(o.seller) ?? nameOf(o.broker);
  const orderNumber = str(o.orderNumber);
  const status = orderStatus(o.orderStatus);
  const total = amount(o.price) ?? amount(o.totalPrice);
  const cur = currency(o.priceCurrency);
  const action = all(o.potentialAction).filter(isObj).find((a) => hasType(a, ['ViewAction']));
  const orderUrl = link(o.url) ?? link(o.Url) ?? link(action?.target) ?? link(action?.url);
  return {
    kind: 'shipment',
    key: '',
    ...(merchant ? { merchant } : {}),
    ...(orderNumber ? { orderNumber } : {}),
    ...(status ? { status } : {}),
    items: orderItems(o),
    ...(total && cur ? { total: { amount: total, currency: cur } } : {}),
    ...(orderUrl ? { orderUrl } : {}),
    parcels: [],
    source,
  };
}

function parcel(p: Obj, source: CardSource): Shipment {
  const partOf = obj(p.partOfOrder);
  const base: Shipment = partOf ? order(partOf, source) : { kind: 'shipment', key: '', items: [], parcels: [], source };
  const carrier = nameOf(p.carrier) ?? nameOf(p.provider);
  const trackingNumber = str(p.trackingNumber);
  const trackingUrl = link(p.trackingUrl);
  // Only the latest bound is an "arrives by" date; expectedArrivalFrom is the
  // earliest one and would promise too much.
  const expectedBy = lenientDate(p.expectedArrivalUntil);
  const shipped: Parcel = {
    ...(carrier ? { carrier } : {}),
    ...(trackingNumber ? { trackingNumber } : {}),
    ...(trackingUrl ? { trackingUrl } : {}),
    ...(expectedBy ? { expectedBy } : {}),
    items: items(p.itemShipped),
  };
  return { ...base, parcels: [shipped] };
}

/** One card per top-level object, unmerged and unvalidated, with a merge key. */
export function normalizeItems(extracted: ExtractedItem[]): StructuredCard[] {
  const cards: StructuredCard[] = [];
  for (const { object, source } of flatten(extracted)) {
    const types = typesOf(object);
    const kindType = types.find((t) => RESERVATION_KINDS[t]);
    let card: StructuredCard | undefined;
    if (kindType) card = reservation(RESERVATION_KINDS[kindType], object, source);
    else if (types.includes('ParcelDelivery')) card = parcel(object, source);
    else if (types.includes('Order')) card = order(object, source);
    if (card) cards.push({ ...card, key: cardKey(card) });
  }
  return cards;
}

/**
 * Whether the markup holds a reservation of any type (known or not, valid or
 * not) under a schema.org context. A mail that describes its booking in
 * markup is read from the markup alone; its Wallet passes are not consulted.
 */
export function hasReservation(extracted: ExtractedItem[]): boolean {
  return flatten(extracted).some(({ object }) => typesOf(object).some((t) => /Reservation$/.test(t)));
}

/** The merge key: equal keys describe the same booking or order. */
export function cardKey(card: StructuredCard): string {
  switch (card.kind) {
    case 'flight': case 'train': case 'bus': {
      const leg = card.legs[0];
      return card.reference ? `${card.kind}|ref:${lower(card.reference)}` : `${card.kind}|leg:${legKey(leg)}`;
    }
    case 'lodging':
      return `lodging|${lower(card.reference)}|${lower(card.name)}|${card.checkin.date}`;
    case 'rentalcar':
      return `rentalcar|${lower(card.reference)}|${lower(card.company)}|${card.pickup.at.date}`;
    case 'event': case 'restaurant':
      return `${card.kind}|${lower(card.reference)}|${lower(card.name)}|${card.start.date}`;
    case 'shipment': {
      if (card.orderNumber) return `shipment|order:${lower(card.orderNumber)}`;
      const tracking = card.parcels.find((p) => p.trackingNumber)?.trackingNumber;
      return tracking ? `shipment|parcel:${lower(tracking)}` : `shipment|anon:${lower(card.merchant)}|${card.parcels.length}`;
    }
  }
}

/**
 * A leg's identity inside a booking: carrier, number, departure day and place.
 * Leading zeros of the number don't count (BA0123 in a mail, 123 in its
 * Wallet pass).
 */
export function legKey(leg: TransportLeg): string {
  return [lower(leg.carrierCode ?? leg.carrier), lower(leg.number).replace(/^0+(?=\d)/, ''), leg.departure.at.date, lower(leg.departure.place.code ?? leg.departure.place.name)].join('|');
}
