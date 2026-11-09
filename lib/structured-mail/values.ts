/**
 * Readers for single schema.org values, tolerant of the shapes real senders
 * use: a string where an object belongs, an array where one value belongs,
 * numbers for identifiers, German prices, offsets without a colon.
 */
import type { Address, Link, Moment, OrderStatus, ReservationStatus } from './types';

export type Obj = Record<string, unknown>;

export function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The values of a property: an array as is, anything else as one element. */
export function all(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** The first object among the values. */
export function obj(value: unknown): Obj | undefined {
  return all(value).find(isObj);
}

/** The first non-empty string (or number, as a string). */
export function str(value: unknown): string | undefined {
  for (const v of all(value)) {
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'string') {
      const trimmed = v.replace(/\s+/g, ' ').trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

/** A name: a plain string, or an object's `name` (Organization, Person, Place). */
export function nameOf(value: unknown): string | undefined {
  for (const v of all(value)) {
    if (isObj(v)) {
      const name = str(v.name) ?? [str(v.givenName), str(v.familyName)].filter(Boolean).join(' ');
      if (name) return name;
    } else {
      const s = str(v);
      if (s) return s;
    }
  }
  return undefined;
}

/** Types of an object, as their last path segment ("FlightReservation"). */
export function typesOf(value: unknown): string[] {
  if (!isObj(value)) return [];
  return all(value['@type'])
    .map((t) => (typeof t === 'string' ? t.trim().replace(/^schema:/i, '').split(/[/#]/).pop() ?? '' : ''))
    .filter(Boolean);
}

export function hasType(value: unknown, names: readonly string[]): boolean {
  return typesOf(value).some((t) => names.includes(t));
}

const SCHEMA_CONTEXT = /^https?:\/\/(?:www\.)?schema\.org\/?$/i;

/** Whether an `@context` names schema.org (string, array or `@vocab`). */
export function isSchemaContext(context: unknown): boolean {
  return all(context).some((c) =>
    (typeof c === 'string' && SCHEMA_CONTEXT.test(c.trim()))
    || (isObj(c) && typeof c['@vocab'] === 'string' && SCHEMA_CONTEXT.test(c['@vocab'].trim())));
}

/** The last segment of an enum value: a URL or a bare token. */
function enumToken(value: unknown): string | undefined {
  const s = str(value);
  if (!s) return undefined;
  return s.split(/[/#:]/).filter(Boolean).pop();
}

const RESERVATION_STATUS: Record<string, ReservationStatus> = {
  confirmed: 'confirmed', cancelled: 'cancelled', canceled: 'cancelled', pending: 'pending', hold: 'hold',
};

/** ReservationConfirmed / Confirmed, full URL (http/https) or token. The first value that maps wins. */
export function reservationStatus(value: unknown): ReservationStatus | undefined {
  for (const v of all(value)) {
    const token = enumToken(isObj(v) ? v['@id'] ?? v.name : v)?.toLowerCase().replace(/^reservation/, '');
    if (token && RESERVATION_STATUS[token]) return RESERVATION_STATUS[token];
  }
  return undefined;
}

const ORDER_STATUS: Record<string, OrderStatus> = {
  paymentdue: 'payment_due', processing: 'processing', problem: 'problem', intransit: 'in_transit',
  pickupavailable: 'pickup_available', returned: 'returned', delivered: 'delivered',
  cancelled: 'cancelled', canceled: 'cancelled',
};

export function orderStatus(value: unknown): OrderStatus | undefined {
  for (const v of all(value)) {
    const token = enumToken(isObj(v) ? v['@id'] ?? v.name : v)?.toLowerCase().replace(/^order(status)?/, '');
    if (token && ORDER_STATUS[token]) return ORDER_STATUS[token];
  }
  return undefined;
}

const ISO_MOMENT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

function validDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function parseOffset(text: string): number | undefined {
  if (/^z$/i.test(text)) return 0;
  const match = /^([+-])(\d{2}):?(\d{2})?$/.exec(text);
  if (!match) return undefined;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? 0);
  if (hours > 14 || minutes > 59) return undefined;
  return (match[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
}

/**
 * An ISO 8601 date or date-time. Offsets `Z`, `+01:00`, `+0100` and `+01`;
 * fractional seconds dropped. Anything else is undefined, so a doubtful value
 * counts as missing.
 */
export function moment(value: unknown): Moment | undefined {
  const s = str(value);
  if (!s) return undefined;
  const match = ISO_MOMENT.exec(s);
  if (!match) return undefined;
  const [, y, mo, d, h, mi, se, off] = match;
  if (!validDate(+y, +mo, +d)) return undefined;
  const result: Moment = { date: `${y}-${mo}-${d}` };
  if (h === undefined) return result;
  if (+h > 23 || +mi > 59 || +(se ?? 0) > 59) return undefined;
  result.time = `${h}:${mi}:${se ?? '00'}`;
  if (off !== undefined) {
    const offset = parseOffset(off);
    if (offset === undefined) return undefined;
    result.offsetMinutes = offset;
    const local = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se ?? 0));
    result.utc = new Date(local - offset * 60_000).toISOString().replace('.000Z', 'Z');
  }
  return result;
}

/**
 * Only the date of a value whose time part is broken
 * (`2024-10-13CEST03:10:23`, Kaufland). Used where a date is all a card
 * shows (expected parcel arrival); nowhere else.
 */
export function lenientDate(value: unknown): Moment | undefined {
  const parsed = moment(value);
  if (parsed) return { date: parsed.date };
  const s = str(value);
  const match = s ? /^(\d{4})-(\d{2})-(\d{2})(?![\d])/.exec(s) : null;
  if (!match || !validDate(+match[1], +match[2], +match[3])) return undefined;
  return { date: `${match[1]}-${match[2]}-${match[3]}` };
}

/** A PostalAddress, or a plain string kept as the street line. */
export function address(value: unknown): Address | undefined {
  const v = all(value)[0];
  if (typeof v === 'string') {
    const street = str(v);
    return street ? { street } : undefined;
  }
  if (!isObj(v)) return undefined;
  const result: Address = {};
  const set = (key: keyof Address, raw: unknown) => {
    const s = str(raw);
    if (s) result[key] = s;
  };
  set('street', v.streetAddress);
  set('locality', v.addressLocality);
  set('region', v.addressRegion);
  set('postalCode', v.postalCode);
  const country = isObj(v.addressCountry) ? str(v.addressCountry.identifier) ?? nameOf(v.addressCountry) : str(v.addressCountry);
  if (country) {
    if (/^[A-Za-z]{2}$/.test(country)) result.country = country.toUpperCase();
    else result.countryName = country;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * A link a card may show: absolute http(s), a real host name (no single
 * label like Ahoi's `http://default/`, no IP literal, no localhost), no
 * credentials. Anything else is dropped.
 */
export function link(value: unknown): Link | undefined {
  for (const v of all(value)) {
    const raw = isObj(v) ? str(v.url) ?? str(v.target) ?? str(v['@id']) : str(v);
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (url.username || url.password) continue;
    const host = url.hostname.toLowerCase();
    if (!host.includes('.') || host.startsWith('[') || IPV4.test(host) || host === 'localhost' || host.endsWith('.localhost')) continue;
    if (!/^[a-z0-9.-]+$/.test(host) || host.endsWith('.')) continue;
    return { url: url.href, host: host.replace(/^www\./, '') };
  }
  return undefined;
}

/**
 * A price as a dot-decimal string: numbers, "29.99", "14.9700", and German
 * "399,00 €" / "1.299,00 EUR". Ambiguous values ("1,299") give undefined.
 */
export function amount(value: unknown): string | undefined {
  for (const v of all(value)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v.toFixed(2);
    if (typeof v !== 'string') continue;
    const s = v.replace(/[^\d.,]/g, '');
    if (!s) continue;
    let normalised: string | undefined;
    if (/^\d+(\.\d+)?$/.test(s)) normalised = s;
    else if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) normalised = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(,\d{3})+\.\d{1,2}$/.test(s)) normalised = s.replace(/,/g, '');
    if (normalised === undefined) continue;
    const n = Number(normalised);
    if (Number.isFinite(n)) return n.toFixed(2);
  }
  return undefined;
}

export function currency(value: unknown): string | undefined {
  const s = str(value);
  return s && /^[A-Za-z]{3}$/.test(s) ? s.toUpperCase() : undefined;
}

export function positiveInt(value: unknown): number | undefined {
  for (const v of all(value)) {
    const raw = isObj(v) ? v.value : v;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
    if (Number.isInteger(n) && n > 0 && n < 10_000) return n;
  }
  return undefined;
}

/** Names of people: Person objects, strings, arrays; duplicates dropped. */
export function people(value: unknown): string[] {
  const names = all(value).map((v) => nameOf(v)).filter((n): n is string => !!n);
  return [...new Set(names)];
}
