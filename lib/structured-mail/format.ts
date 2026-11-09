/**
 * Text for the reader cards. Plain TypeScript, no React.
 *
 * A card shows a time the way the mail gave it: the wall clock at the place
 * (departure airport, hotel, venue), never converted to the reader's zone.
 * The local date and time are formatted as if they were UTC, with
 * `timeZone: 'UTC'`, so neither the browser's zone nor DST can move them.
 */
import { zoneOffsetAt } from './time-zones';
import type { Address, Item, Moment, Place, Shipment, TransportBooking, TransportLeg } from './types';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(?::\d{2})?$/;

export interface FormatOptions {
  /** UI locale ("en", "de", ...). */
  locale: string;
  /** true for a 12-hour clock, false for 24 hours, undefined for the locale's own. */
  hour12?: boolean;
  /** "Now", to decide whether the year is shown. Defaults to the current date. */
  now?: Date;
}

/** The moment's local wall clock as a Date whose UTC fields hold it; null when malformed. */
export function wallClockDate(m: Moment): Date | null {
  if (!DATE_RE.test(m.date)) return null;
  if (m.time !== undefined && !TIME_RE.test(m.time)) return null;
  const time = m.time ? (m.time.length === 5 ? `${m.time}:00` : m.time) : '00:00:00';
  const d = new Date(`${m.date}T${time}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatter(options: Intl.DateTimeFormatOptions, opts: FormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(opts.locale, { ...options, timeZone: 'UTC' });
  } catch {
    return new Intl.DateTimeFormat('en', { ...options, timeZone: 'UTC' });
  }
}

function clockOptions(opts: FormatOptions): Intl.DateTimeFormatOptions {
  if (opts.hour12 === true) return { hour: 'numeric', minute: '2-digit', hour12: true };
  if (opts.hour12 === false) return { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  return { hour: 'numeric', minute: '2-digit' };
}

function dateOptions(m: Moment, opts: FormatOptions): Intl.DateTimeFormatOptions {
  const year = Number(m.date.slice(0, 4));
  const currentYear = (opts.now ?? new Date()).getUTCFullYear();
  return { weekday: 'short', day: 'numeric', month: 'short', ...(year !== currentYear ? { year: 'numeric' } : {}) };
}

/** "Tue, Dec 1" (the year only when it isn't this year). */
export function formatMomentDate(m: Moment, opts: FormatOptions): string {
  const d = wallClockDate(m);
  return d ? formatter(dateOptions(m, opts), opts).format(d) : m.date;
}

/** "10:15", or undefined for a date-only moment. */
export function formatMomentTime(m: Moment, opts: FormatOptions): string | undefined {
  if (!m.time) return undefined;
  const d = wallClockDate(m);
  return d ? formatter(clockOptions(opts), opts).format(d) : m.time.slice(0, 5);
}

/** "Tue, Dec 1, 10:15" in the locale's own order; the date alone for a date-only moment. */
export function formatMoment(m: Moment, opts: FormatOptions): string {
  if (!m.time) return formatMomentDate(m, opts);
  const d = wallClockDate(m);
  if (!d) return `${m.date} ${m.time.slice(0, 5)}`;
  return formatter({ ...dateOptions(m, opts), ...clockOptions(opts) }, opts).format(d);
}

/** Whether two moments fall on the same local date. */
export function sameLocalDate(a: Moment, b: Moment): boolean {
  return a.date === b.date;
}

/**
 * The moment's UTC offset in minutes east of UTC: the one the mail gave, or
 * the one its resolved zone implies. Undefined for a floating time (shown as
 * written, no zone known) or a date-only moment.
 */
export function momentOffsetMinutes(m: Moment): number | undefined {
  if (!m.time) return undefined;
  if (m.offsetMinutes !== undefined) return m.offsetMinutes;
  if (!m.utc) return undefined;
  const wall = wallClockDate(m);
  const instant = Date.parse(m.utc);
  if (!wall || Number.isNaN(instant)) return undefined;
  return Math.round((wall.getTime() - instant) / MINUTE);
}

function instantOf(m: Moment, offset: number): number | undefined {
  if (m.utc) {
    const t = Date.parse(m.utc);
    if (!Number.isNaN(t)) return t;
  }
  const wall = wallClockDate(m);
  return wall ? wall.getTime() - offset * MINUTE : undefined;
}

/**
 * Whether a timed moment's place keeps a different clock than the reader
 * at that instant, so the card marks the time as local to the place.
 * `readerOffsetAt` gives the reader's offset (minutes east of UTC) at an
 * instant; by default the offset of `readerZone`.
 */
export function isOtherZone(m: Moment, readerZone: string, readerOffsetAt?: (utcMs: number) => number): boolean {
  const offset = momentOffsetMinutes(m);
  if (offset === undefined) return false;
  const instant = instantOf(m, offset);
  if (instant === undefined) return false;
  try {
    const reader = readerOffsetAt ? readerOffsetAt(instant) : zoneOffsetAt(readerZone, instant);
    return reader !== offset;
  } catch {
    return false;
  }
}

/** Nights between check-in and check-out dates; undefined when it doesn't add up. */
export function nightsBetween(checkin: Moment, checkout: Moment): number | undefined {
  const a = wallClockDate({ date: checkin.date });
  const b = wallClockDate({ date: checkout.date });
  if (!a || !b) return undefined;
  const nights = Math.round((b.getTime() - a.getTime()) / DAY);
  return nights > 0 ? nights : undefined;
}

/** "€129.90" in the UI locale; amount and code as given when Intl can't format them. */
export function formatMoney(total: { amount: string; currency: string }, locale: string): string {
  const n = Number(total.amount);
  if (!Number.isFinite(n)) return `${total.amount} ${total.currency}`;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: total.currency }).format(n);
  } catch {
    return `${total.amount} ${total.currency}`;
  }
}

function regionName(code: string | undefined, locale: string): string | undefined {
  if (!code) return undefined;
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** One line: "Marktplatz 1, 10178 Berlin, Germany". */
export function formatAddress(address: Address | undefined, locale: string): string | undefined {
  if (!address) return undefined;
  const town = [address.postalCode, address.locality].filter(Boolean).join(' ');
  const country = address.countryName ?? regionName(address.country, locale);
  const parts = [address.street, town, address.region, country].filter((p): p is string => !!p && p.trim() !== '');
  // A street given as one string may already hold the town.
  const unique = parts.filter((p, i) => !parts.slice(0, i).some((q) => q.includes(p)));
  return unique.length ? unique.join(', ') : undefined;
}

/** A place on one line: "Stadtpark, Hamburg"; the name alone when it already names the town. */
export function formatPlace(place: Place | undefined): string | undefined {
  if (!place) return undefined;
  const name = place.name?.trim();
  const town = place.address?.locality?.trim();
  if (name && town && !name.toLowerCase().includes(town.toLowerCase())) return `${name}, ${town}`;
  return name || town || place.code;
}

/** An airport or station in a leg row: "Frankfurt Airport (FRA)", "Hamburg Hbf". */
export function legPlaceLabel(place: Place, kind: TransportBooking['kind']): string {
  const name = place.name?.trim() || place.address?.locality?.trim();
  if (kind === 'flight' && place.code) {
    if (!name) return place.code;
    // "Frankfurt" holds the letters FRA; only a code standing on its own counts.
    const code = place.code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const hasCode = new RegExp(`(^|[^A-Z0-9])${code}([^A-Z0-9]|$)`).test(name.toUpperCase());
    return hasCode ? name : `${name} (${place.code})`;
  }
  return name || place.code || '';
}

/** Carrier and number: "Lufthansa LH 400", "Rail Co ICE 577". */
export function legService(leg: TransportLeg): string | undefined {
  const number = leg.carrierCode && leg.number && !leg.number.toUpperCase().startsWith(leg.carrierCode.toUpperCase())
    ? `${leg.carrierCode} ${leg.number}`
    : leg.number;
  const parts = [leg.carrier, number].filter((p): p is string => !!p);
  return parts.length ? parts.join(' ') : undefined;
}

/**
 * The stops of a route, for its title: airport codes for flights, city or
 * station names otherwise. Connecting legs form one run (FRA, JFK, FRA);
 * a leg that doesn't connect starts the next run.
 */
export function routeRuns(booking: TransportBooking): string[][] {
  const legs = booking.legs;
  const towns = legs.flatMap((leg) => [leg.departure.place, leg.arrival?.place]).filter((p): p is Place => !!p)
    .map((p) => p.address?.locality?.trim());
  const useTowns = booking.kind !== 'flight' && towns.every(Boolean)
    && legs.every((leg) => !leg.arrival || leg.departure.place.address?.locality !== leg.arrival.place.address?.locality);
  const label = (place: Place): string => {
    if (booking.kind === 'flight' && place.code) return place.code;
    if (useTowns && place.address?.locality) return place.address.locality.trim();
    return place.name?.trim() || place.address?.locality?.trim() || place.code || '?';
  };
  const runs: string[][] = [];
  for (const leg of legs) {
    const from = label(leg.departure.place);
    const to = leg.arrival ? label(leg.arrival.place) : undefined;
    const run = runs[runs.length - 1];
    if (run && run[run.length - 1] === from) {
      if (to) run.push(to);
    } else {
      runs.push(to ? [from, to] : [from]);
    }
  }
  return runs;
}

/** The route as plain text, "FRA → JFK → FRA"; runs separated by a comma. */
export function routeTitle(booking: TransportBooking): string {
  return routeRuns(booking).map((run) => run.join(' → ')).join(', ');
}

/** The items a shipment card lists: the order's, else the parcels', with images from either. */
export function shipmentItems(shipment: Shipment): Item[] {
  const parcelItems = shipment.parcels.flatMap((p) => p.items);
  if (shipment.items.length === 0) {
    const seen = new Set<string>();
    return parcelItems.filter((item) => (seen.has(item.name) ? false : (seen.add(item.name), true)));
  }
  return shipment.items.map((item) => {
    if (item.image) return item;
    const image = parcelItems.find((p) => p.name === item.name && p.image)?.image;
    return image ? { ...item, image } : item;
  });
}

/** The first `max` item names, how many more there are, and the number of pieces. */
export function summarizeItems(items: Item[], max = 3): { shown: Item[]; more: number; count: number } {
  const count = items.reduce((sum, item) => sum + (item.quantity && item.quantity > 0 ? item.quantity : 1), 0);
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max), count };
}

/** Whether a link may be shown and opened: http(s) only, checked again here. */
export function isWebLink(link: { url: string } | undefined): boolean {
  if (!link) return false;
  try {
    const { protocol } = new URL(link.url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
