/**
 * The model booking, shipping and order mail is read into. Plain data, no
 * React and no app imports, so the native app can reuse the parser.
 */

export type BookingKind = 'flight' | 'train' | 'bus' | 'lodging' | 'rentalcar' | 'event' | 'restaurant';
export type TransportKind = 'flight' | 'train' | 'bus';
export type ReservationStatus = 'confirmed' | 'pending' | 'hold' | 'cancelled';
export type OrderStatus =
  | 'payment_due' | 'processing' | 'problem' | 'in_transit'
  | 'pickup_available' | 'returned' | 'delivered' | 'cancelled';

/** A time as the mail wrote it, local to the place it belongs to. */
export interface Moment {
  /** YYYY-MM-DD, local. */
  date: string;
  /** HH:mm:ss, local; absent for a date-only value. */
  time?: string;
  /** Minutes east of UTC, from the value; absent when the mail gave none. */
  offsetMinutes?: number;
  /** ISO instant; set when the time and its zone or offset are known. */
  utc?: string;
  /**
   * IANA zone after resolution (resolveCards): airport, country or a
   * fixed-offset zone; null for a time that stays floating. Absent before.
   */
  zone?: string | null;
  /**
   * Set by the .pkpass reader for a UTC time with no zone for its place:
   * `utc` is the instant, but date, time and offset are UTC, not local.
   * Resolution takes the wall clock from the airport's zone and clears it.
   */
  instantOnly?: true;
}

export interface Address {
  street?: string;
  locality?: string;
  region?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-2, when the mail gave one. */
  country?: string;
  /** Country as the mail named it, when that wasn't a code. */
  countryName?: string;
}

export interface Place {
  name?: string;
  /** IATA airport code for airports, upper case. */
  code?: string;
  address?: Address;
}

/** A link a card may show: http(s) only, host shown next to it. */
export interface Link {
  url: string;
  host: string;
}

export interface Seat {
  passenger?: string;
  seat: string;
}

export interface TransportLeg {
  carrier?: string;
  /** IATA airline code for flights. */
  carrierCode?: string;
  number?: string;
  departure: { place: Place; at: Moment };
  arrival?: { place: Place; at?: Moment };
  seats: Seat[];
  status?: ReservationStatus;
}

export interface BookingLinks {
  checkin?: Link;
  manage?: Link;
  ticket?: Link;
}

export type CardSource = 'json-ld' | 'microdata' | 'pkpass';

interface BookingBase {
  /** Merge key: equal keys are the same booking. */
  key: string;
  kind: BookingKind;
  reference?: string;
  status?: ReservationStatus;
  passengers: string[];
  provider?: string;
  links: BookingLinks;
  modified?: string;
  source: CardSource;
}

export interface TransportBooking extends BookingBase {
  kind: TransportKind;
  legs: TransportLeg[];
}

export interface LodgingBooking extends BookingBase {
  kind: 'lodging';
  name: string;
  address?: Address;
  phone?: string;
  checkin: Moment;
  checkout: Moment;
}

export interface RentalCarBooking extends BookingBase {
  kind: 'rentalcar';
  company?: string;
  car?: string;
  pickup: { place: Place; at: Moment };
  dropoff: { place: Place; at: Moment };
}

export interface EventBooking extends BookingBase {
  kind: 'event';
  name: string;
  venue?: Place;
  start: Moment;
  end?: Moment;
  tickets: string[];
}

export interface RestaurantBooking extends BookingBase {
  kind: 'restaurant';
  name: string;
  address?: Address;
  start: Moment;
  partySize?: number;
}

export type Booking = TransportBooking | LodgingBooking | RentalCarBooking | EventBooking | RestaurantBooking;

export interface Item {
  name: string;
  quantity?: number;
  /** Remote image; a card shows it only when remote content may load. */
  image?: Link;
}

export interface Parcel {
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: Link;
  expectedBy?: Moment;
  items: Item[];
}

/** An Order and/or the ParcelDeliveries for one order number. */
export interface Shipment {
  kind: 'shipment';
  key: string;
  merchant?: string;
  orderNumber?: string;
  status?: OrderStatus;
  items: Item[];
  /** Amount normalised to a dot decimal ("399.00"). */
  total?: { amount: string; currency: string };
  orderUrl?: Link;
  parcels: Parcel[];
  source: CardSource;
}

export type StructuredCard = Booking | Shipment;

/** A card plus the reasons validation found to doubt it (empty = fine). */
export interface Candidate {
  card: StructuredCard;
  problems: string[];
}

export function isBooking(card: StructuredCard): card is Booking {
  return card.kind !== 'shipment';
}

export function isTransport(card: StructuredCard): card is TransportBooking {
  return card.kind === 'flight' || card.kind === 'train' || card.kind === 'bus';
}
