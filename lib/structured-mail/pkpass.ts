/**
 * Apple Wallet passes (.pkpass) attached to booking mail: the same cards as
 * schema.org markup would give. A boarding pass becomes a flight, train or
 * bus booking and an event ticket an event booking; every other pass is
 * ignored. Only the pass's `semantics` dictionary counts, as that is the
 * machine-readable part (Apple's "SemanticTags"); the display fields are
 * free text for people. A pass that leaves anything in doubt gives no card.
 *
 * The signature is not checked (that needs Apple's certificate chain); the
 * mail-level trust gate stands in for it. Nothing in the pass is fetched:
 * webServiceURL, images and links are never read.
 *
 * Plain TypeScript, no React; jszip is imported only when a pass is opened.
 */
import type JSZip from 'jszip';
import { cardKey } from './normalize';
import { isValidTimeZone, wallClockAt, zoneOffsetAt } from './time-zones';
import type { EventBooking, Moment, Place, Seat, StructuredCard, TransportBooking, TransportKind, TransportLeg } from './types';
import { validateCard } from './validate';
import { isObj, moment, str, type Obj } from './values';

/** Largest attachment that is downloaded and opened. */
export const PKPASS_MAX_BYTES = 5 * 1024 * 1024;
/** At most this many passes are read from one mail. */
export const PKPASS_MAX_PER_MAIL = 3;
/** Largest pass.json read, once inflated. */
export const PASS_JSON_MAX_BYTES = 256 * 1024;
/** Archives with more entries are refused unread. */
export const PKPASS_MAX_ENTRIES = 100;

const PKPASS_TYPE = 'application/vnd.apple.pkpass';

export interface PkpassAttachmentLike {
  name?: string | null;
  type?: string | null;
  size?: number | null;
}

/** An attachment that may be a Wallet pass: `*.pkpass` or typed as one, at most 5 MB. */
export function isPkpassAttachment(att: PkpassAttachmentLike | null | undefined): boolean {
  if (!att) return false;
  const size = att.size;
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0 || size > PKPASS_MAX_BYTES) return false;
  const byName = typeof att.name === 'string' && /\.pkpass$/i.test(att.name.trim());
  const byType = typeof att.type === 'string' && att.type.split(';')[0].trim().toLowerCase() === PKPASS_TYPE;
  return byName || byType;
}

export interface ReadPassOptions {
  /** jszip's constructor; defaults to a dynamic import of jszip. */
  loadZip?: () => Promise<typeof JSZip>;
}

async function defaultLoadZip(): Promise<typeof JSZip> {
  const { default: JSZipClass } = await import('jszip');
  return JSZipClass;
}

interface ZipStream {
  on(event: 'data', cb: (chunk: Uint8Array) => void): ZipStream;
  on(event: 'error', cb: (err: Error) => void): ZipStream;
  on(event: 'end', cb: () => void): ZipStream;
  pause(): ZipStream;
  resume(): ZipStream;
}

/**
 * Inflate one entry, giving up as soon as it passes `maxBytes`. The sizes in
 * the ZIP headers are whatever the sender wrote; counting inflated bytes is
 * what stops a ZIP bomb.
 */
function readCapped(entry: JSZip.JSZipObject, maxBytes: number): Promise<Uint8Array | undefined> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let done = false;
    const finish = (value: Uint8Array | undefined) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    let stream: ZipStream;
    try {
      // internalStream is part of jszip's API but missing from its typings.
      stream = (entry as unknown as { internalStream(type: 'uint8array'): ZipStream }).internalStream('uint8array');
    } catch {
      finish(undefined);
      return;
    }
    stream
      .on('data', (chunk) => {
        if (done) return;
        total += chunk.byteLength;
        if (total > maxBytes) {
          stream.pause();
          finish(undefined);
          return;
        }
        chunks.push(chunk);
      })
      .on('error', () => finish(undefined))
      .on('end', () => {
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          out.set(chunk, offset);
          offset += chunk.byteLength;
        }
        finish(out);
      })
      .resume();
  });
}

/**
 * The parsed pass.json of a .pkpass archive, or undefined for anything
 * doubtful: not a ZIP, more than 100 entries, no pass.json, pass.json over
 * 256 KB once inflated, not JSON, not an object. Nothing else in the archive
 * is inflated. Never throws.
 */
export async function readPassJson(bytes: ArrayBuffer | Uint8Array, options: ReadPassOptions = {}): Promise<Obj | undefined> {
  try {
    if (bytes.byteLength === 0 || bytes.byteLength > PKPASS_MAX_BYTES) return undefined;
    const JSZipClass = await (options.loadZip ?? defaultLoadZip)();
    const zip = await JSZipClass.loadAsync(bytes);
    if (Object.keys(zip.files).length > PKPASS_MAX_ENTRIES) return undefined;
    const entry = zip.file('pass.json');
    if (!entry || entry.dir) return undefined;
    const raw = await readCapped(entry, PASS_JSON_MAX_BYTES);
    if (!raw) return undefined;
    let text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed: unknown = JSON.parse(text);
    return isObj(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const PASS_STYLES = ['boardingPass', 'coupon', 'eventTicket', 'generic', 'storeCard'] as const;

const TRANSIT_KINDS: Record<string, TransportKind> = {
  PKTransitTypeAir: 'flight',
  PKTransitTypeTrain: 'train',
  PKTransitTypeBus: 'bus',
};

/** Thrown inside the mapping when a value is present but can't be trusted. */
class Doubtful extends Error {}

function doubt(): never {
  throw new Doubtful();
}

/** A string tag: absent → undefined, present but not text → doubtful. */
function text(semantics: Obj, key: string): string | undefined {
  const value = semantics[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') doubt();
  return str(value);
}

/** A date tag: absent → undefined, present but not ISO 8601 → doubtful. */
function date(semantics: Obj, key: string): Moment | undefined {
  const value = semantics[key];
  if (value === undefined || value === null || value === '') return undefined;
  return moment(value) ?? doubt();
}

/**
 * A time as local to its place. Passes often give times in UTC (`Z`,
 * `+00:00`), which fixes the instant but not the wall clock. With the pass's
 * IANA zone for the place (departureLocationTimeZone,
 * destinationLocationTimeZone) the instant is turned into that zone's wall
 * clock; for a flight without one, the moment is marked `instantOnly` and the
 * airport's zone supplies the wall clock later (resolve.ts); for anything
 * else it is doubtful. A zone given next to a non-UTC offset has to agree
 * with it, otherwise one of the two is wrong.
 */
function placeTime(semantics: Obj, zoneKey: string | undefined, at: Moment | undefined, airport: boolean): Moment | undefined {
  const tag = zoneKey ? semantics[zoneKey] : undefined;
  let zone: string | undefined;
  if (tag !== undefined && tag !== null) {
    if (typeof tag !== 'string' || !isValidTimeZone(tag)) doubt();
    zone = tag;
  }
  if (!at?.utc || at.offsetMinutes === undefined) return at;
  const ms = Date.parse(at.utc);
  if (at.offsetMinutes === 0) {
    if (zone) {
      const local = wallClockAt(ms, zone);
      return { date: local.date, time: local.time, offsetMinutes: zoneOffsetAt(zone, ms), utc: at.utc };
    }
    if (airport) return { ...at, instantOnly: true };
    doubt();
  }
  if (zone && zoneOffsetAt(zone, ms) !== at.offsetMinutes) doubt();
  return at;
}

function sameTime(a: Moment, b: Moment): boolean {
  if (a.utc && b.utc) return a.utc === b.utc;
  return a.date === b.date && (a.time ?? '') === (b.time ?? '');
}

/**
 * transitStatus is free text. Only a status that clearly says the trip runs
 * as planned keeps the card; "Delayed 40 min", "Diverted", "fällt aus" or
 * anything unknown leaves the times in doubt.
 */
const PLANNED_STATUS = new Set(['on time', 'pünktlich', 'boarding', 'scheduled', 'planmäßig']);

function plannedStatus(status: string | undefined): boolean {
  if (status === undefined) return true;
  const normal = status.normalize('NFC').toLowerCase().replace(/[-_]+/g, ' ').replace(/[.!]+$/, '').replace(/\s+/g, ' ').trim();
  return normal === '' || PLANNED_STATUS.has(normal);
}

/** PersonNameComponents → "Given Family". */
function personName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObj(value)) doubt();
  const parts = [str(value.givenName), str(value.middleName), str(value.familyName)].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** Split the IATA flight: airlineCode + flightNumber, flightCode ("LH400"), or both when they agree. */
function flightIdentity(semantics: Obj): { carrierCode: string; number: string } {
  const airline = text(semantics, 'airlineCode')?.toUpperCase();
  if (airline !== undefined && !/^[A-Z0-9]{2}$/.test(airline)) doubt();
  const numberRaw = text(semantics, 'flightNumber');
  if (numberRaw !== undefined && !/^\d{1,4}$/.test(numberRaw)) doubt();
  const number = numberRaw !== undefined ? String(Number(numberRaw)) : undefined;
  const codeRaw = text(semantics, 'flightCode')?.replace(/\s+/g, '').toUpperCase();
  let fromCode: { carrierCode: string; number: string } | undefined;
  if (codeRaw !== undefined) {
    const match = /^([A-Z0-9]{2})(\d{1,4})$/.exec(codeRaw);
    if (!match || !/[A-Z]/.test(match[1])) doubt();
    fromCode = { carrierCode: match[1], number: String(Number(match[2])) };
  }
  const carrierCode = airline ?? fromCode?.carrierCode;
  const flight = number ?? fromCode?.number;
  if (!carrierCode || !flight) doubt();
  if (fromCode && (fromCode.carrierCode !== carrierCode || fromCode.number !== flight)) doubt();
  return { carrierCode, number: flight };
}

function airport(semantics: Obj, prefix: 'departure' | 'destination', codeRequired: boolean): Place {
  const code = text(semantics, `${prefix}AirportCode`)?.toUpperCase();
  if (code !== undefined && !/^[A-Z]{3}$/.test(code)) doubt();
  if (codeRequired && !code) doubt();
  const name = text(semantics, `${prefix}AirportName`);
  return { ...(name ? { name } : {}), ...(code ? { code } : {}) };
}

function station(semantics: Obj, prefix: 'departure' | 'destination'): Place {
  const name = text(semantics, `${prefix}StationName`) ?? text(semantics, `${prefix}LocationDescription`);
  return name ? { name } : {};
}

/** Seats as the markup writes them: "12A" for flights, "section/number" otherwise. */
function seats(semantics: Obj, kind: TransportKind, passenger: string | undefined): Seat[] {
  const value = semantics.seats;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) doubt();
  const car = kind === 'train' ? text(semantics, 'carNumber') : undefined;
  const out: Seat[] = [];
  for (const entry of value) {
    if (!isObj(entry)) doubt();
    const number = str(entry.seatNumber);
    const row = str(entry.seatRow);
    const identifier = str(entry.seatIdentifier);
    let seat: string | undefined;
    if (kind === 'flight') {
      if (number && row) {
        if (number.toUpperCase().startsWith(row.toUpperCase())) seat = number.toUpperCase();
        else if (/^\d{1,3}$/.test(row) && /^[A-Z]$/i.test(number)) seat = `${row}${number.toUpperCase()}`;
        // Any other combination is left out rather than guessed.
      } else {
        seat = (number ?? identifier)?.toUpperCase();
      }
    } else {
      const base = number ?? identifier;
      const section = str(entry.seatSection) ?? car;
      seat = base && section ? `${section}/${base}` : base;
    }
    if (seat) out.push({ ...(passenger ? { passenger } : {}), seat });
  }
  return out;
}

function transportCard(kind: TransportKind, pass: Obj, semantics: Obj): TransportBooking {
  if (!plannedStatus(text(semantics, 'transitStatus'))) doubt();

  const flight = kind === 'flight';
  const departureTime = (key: string) => placeTime(semantics, 'departureLocationTimeZone', date(semantics, key), flight);
  const arrivalTime = (key: string) => placeTime(semantics, 'destinationLocationTimeZone', date(semantics, key), flight);
  const original = departureTime('originalDepartureDate');
  const current = departureTime('currentDepartureDate');
  // A departure moved to another day would make the pass describe another leg.
  if (original && current && original.date !== current.date) doubt();
  const departureAt = current ?? original;
  if (!departureAt) doubt();
  // The scheduled arrival belongs to the scheduled departure only; after a
  // change, only the updated arrival (if any) goes with the updated departure.
  const onSchedule = !current || (!!original && sameTime(current, original));
  const arrivalAt = arrivalTime('currentArrivalDate') ?? (onSchedule ? arrivalTime('originalArrivalDate') : undefined);

  const passenger = personName(semantics.passengerName);
  const provider = text(semantics, 'transitProvider');
  const organization = str(pass.organizationName);
  const reference = text(semantics, 'confirmationNumber');

  let leg: TransportLeg;
  if (kind === 'flight') {
    const { carrierCode, number } = flightIdentity(semantics);
    leg = {
      ...(provider ? { carrier: provider } : {}),
      carrierCode,
      number,
      departure: { place: airport(semantics, 'departure', true), at: departureAt },
      arrival: { place: airport(semantics, 'destination', false), ...(arrivalAt ? { at: arrivalAt } : {}) },
      seats: seats(semantics, kind, passenger),
    };
  } else {
    const number = text(semantics, 'vehicleNumber');
    leg = {
      ...(provider ? { carrier: provider } : {}),
      ...(number ? { number } : {}),
      departure: { place: station(semantics, 'departure'), at: departureAt },
      arrival: { place: station(semantics, 'destination'), ...(arrivalAt ? { at: arrivalAt } : {}) },
      seats: seats(semantics, kind, passenger),
    };
  }
  const shownProvider = provider ?? organization;
  return {
    key: '',
    kind,
    ...(reference ? { reference } : {}),
    passengers: passenger ? [passenger] : [],
    ...(shownProvider ? { provider: shownProvider } : {}),
    links: {},
    source: 'pkpass',
    legs: [leg],
  };
}

function eventCard(pass: Obj, semantics: Obj): EventBooking {
  const name = text(semantics, 'eventName');
  // Event tickets have no zone tag, so a UTC time can't be placed: doubtful.
  const start = placeTime(semantics, undefined, date(semantics, 'eventStartDate'), false);
  if (!name || !start) doubt();
  let end = placeTime(semantics, undefined, date(semantics, 'eventEndDate'), false);
  // A date-only end next to a timed start says nothing reliable about when it ends.
  if (end && !end.time && start.time) end = undefined;
  const venueName = text(semantics, 'venueName');
  const region = text(semantics, 'venueRegionName');
  const venue: Place = {
    ...(venueName ? { name: venueName } : {}),
    ...(region ? { address: { locality: region } } : {}),
  };
  const attendee = text(semantics, 'attendeeName');
  const reference = text(semantics, 'confirmationNumber');
  const organization = str(pass.organizationName);
  return {
    key: '',
    kind: 'event',
    ...(reference ? { reference } : {}),
    passengers: attendee ? [attendee] : [],
    ...(organization ? { provider: organization } : {}),
    links: {},
    source: 'pkpass',
    name,
    ...(venue.name || venue.address ? { venue } : {}),
    start,
    ...(end ? { end } : {}),
    tickets: [],
  };
}

/**
 * The cards a parsed pass.json describes: at most one, validated against
 * the mail's date (validateCard), with its merge key, zones not yet resolved.
 * Empty for any pass that isn't a boarding pass for air, train or bus or an
 * event ticket, for a voided pass, for a pass without `semantics`, and for
 * anything doubtful. Never throws.
 */
export function passToCards(pass: unknown, ctx: { mailDate: Date }): StructuredCard[] {
  try {
    if (!isObj(pass) || pass.formatVersion !== 1 || pass.voided === true) return [];
    const styles = PASS_STYLES.filter((style) => pass[style] !== undefined);
    if (styles.length !== 1) return [];
    const semantics = pass.semantics;
    if (!isObj(semantics)) return [];
    let card: StructuredCard;
    if (styles[0] === 'boardingPass') {
      const boarding = pass.boardingPass;
      if (!isObj(boarding) || typeof boarding.transitType !== 'string') return [];
      const kind = TRANSIT_KINDS[boarding.transitType];
      if (!kind) return [];
      card = transportCard(kind, pass, semantics);
    } else if (styles[0] === 'eventTicket') {
      if (!isObj(pass.eventTicket)) return [];
      card = eventCard(pass, semantics);
    } else {
      return [];
    }
    const keyed = { ...card, key: cardKey(card) } as StructuredCard;
    return validateCard(keyed, ctx.mailDate).problems.length === 0 ? [keyed] : [];
  } catch {
    return [];
  }
}

/** readPassJson + passToCards. */
export async function readPkpass(bytes: ArrayBuffer | Uint8Array, ctx: { mailDate: Date }, options?: ReadPassOptions): Promise<StructuredCard[]> {
  const pass = await readPassJson(bytes, options);
  return pass ? passToCards(pass, ctx) : [];
}
