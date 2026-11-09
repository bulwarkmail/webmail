/**
 * Time zones for booking cards. Markup gives local times with a UTC offset
 * and never an IANA zone; the card shows the place's local time and the
 * calendar wants a zone that stays right across DST changes. Plain
 * TypeScript on Intl, no React, so the native app can reuse it.
 */

const MINUTE = 60_000;

/**
 * Countries that use one IANA zone throughout, so an address in them names
 * the zone. Countries whose territory spans zones (US, CA, RU, BR, AU, MX,
 * ID, ES with the Canaries, PT with the Azores, ...) are left out on purpose.
 */
const SINGLE_ZONE_COUNTRIES: Record<string, string> = {
  AD: 'Europe/Andorra', AE: 'Asia/Dubai', AL: 'Europe/Tirane', AR: 'America/Argentina/Buenos_Aires',
  AT: 'Europe/Vienna', BA: 'Europe/Sarajevo', BE: 'Europe/Brussels', BG: 'Europe/Sofia',
  BY: 'Europe/Minsk', CH: 'Europe/Zurich', CN: 'Asia/Shanghai', CO: 'America/Bogota',
  CR: 'America/Costa_Rica', CU: 'America/Havana', CY: 'Asia/Nicosia', CZ: 'Europe/Prague',
  DE: 'Europe/Berlin', DK: 'Europe/Copenhagen', DO: 'America/Santo_Domingo', EE: 'Europe/Tallinn',
  EG: 'Africa/Cairo', FI: 'Europe/Helsinki', FR: 'Europe/Paris', GB: 'Europe/London',
  GR: 'Europe/Athens', HK: 'Asia/Hong_Kong', HR: 'Europe/Zagreb', HU: 'Europe/Budapest',
  IE: 'Europe/Dublin', IL: 'Asia/Jerusalem', IN: 'Asia/Kolkata', IS: 'Atlantic/Reykjavik',
  IT: 'Europe/Rome', JM: 'America/Jamaica', JP: 'Asia/Tokyo', KE: 'Africa/Nairobi',
  KR: 'Asia/Seoul', LI: 'Europe/Vaduz', LK: 'Asia/Colombo', LT: 'Europe/Vilnius',
  LU: 'Europe/Luxembourg', LV: 'Europe/Riga', MA: 'Africa/Casablanca', MC: 'Europe/Monaco',
  MD: 'Europe/Chisinau', ME: 'Europe/Podgorica', MK: 'Europe/Skopje', MT: 'Europe/Malta',
  MY: 'Asia/Kuala_Lumpur', NL: 'Europe/Amsterdam', NO: 'Europe/Oslo', NP: 'Asia/Kathmandu',
  NZ: 'Pacific/Auckland', PA: 'America/Panama', PE: 'America/Lima', PH: 'Asia/Manila',
  PL: 'Europe/Warsaw', QA: 'Asia/Qatar', RO: 'Europe/Bucharest', RS: 'Europe/Belgrade',
  SE: 'Europe/Stockholm', SG: 'Asia/Singapore', SI: 'Europe/Ljubljana', SK: 'Europe/Bratislava',
  SM: 'Europe/San_Marino', TH: 'Asia/Bangkok', TN: 'Africa/Tunis', TR: 'Europe/Istanbul',
  TW: 'Asia/Taipei', UY: 'America/Montevideo', VA: 'Europe/Vatican', VN: 'Asia/Ho_Chi_Minh',
  ZA: 'Africa/Johannesburg',
};

/**
 * Countries in the table whose postal addresses also cover overseas places
 * in other zones (a hotel on Réunion often writes "France"). Good enough
 * when the mail's offset confirms the zone, not for a time without one.
 */
const NOT_FOR_FLOATING_TIMES = new Set(['FR']);

/** The single IANA zone of a country (ISO 3166-1 alpha-2), if it has one. */
export function countryZone(country: string | undefined, opts: { floating?: boolean } = {}): string | undefined {
  const code = country?.trim().toUpperCase();
  if (!code || !/^[A-Z]{2}$/.test(code)) return undefined;
  if (opts.floating && NOT_FOR_FLOATING_TIMES.has(code)) return undefined;
  return SINGLE_ZONE_COUNTRIES[code];
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = offsetFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    offsetFormatters.set(zone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(zone: string): boolean {
  try {
    partsFormatter(zone);
    return true;
  } catch {
    return false;
  }
}

interface WallClock { year: number; month: number; day: number; hour: number; minute: number; second: number }

function wallClockParts(utcMs: number, zone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of partsFormatter(zone).formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

/** UTC offset of `zone` at `utcMs`, in minutes east of UTC (Berlin in winter: 60). */
export function zoneOffsetAt(zone: string, utcMs: number): number {
  const w = wallClockParts(utcMs, zone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / MINUTE);
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Local date and time in `zone` at `utcMs`: `{ date: 'YYYY-MM-DD', time: 'HH:mm:ss' }`. */
export function wallClockAt(utcMs: number, zone: string): { date: string; time: string } {
  const w = wallClockParts(utcMs, zone);
  return {
    date: `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`,
    time: `${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`,
  };
}

/**
 * The UTC instant of a local wall-clock time in `zone`. A time that falls in
 * a DST gap or overlap has no single answer; returns null then, so a caller
 * never shows a guessed instant.
 */
export function zonedTimeToUtc(date: string, time: string, zone: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!d || !t) return null;
  const naive = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2], +(t[3] ?? 0));
  const check = new Date(naive);
  if (check.getUTCMonth() !== +d[2] - 1 || check.getUTCDate() !== +d[3] || check.getUTCHours() !== +t[1] || +t[2] > 59 || +(t[3] ?? 0) > 59) {
    return null;
  }
  const candidates = new Set<number>();
  for (const probe of [naive - 14 * 60 * MINUTE, naive, naive + 14 * 60 * MINUTE]) {
    const offset = zoneOffsetAt(zone, probe);
    const utc = naive - offset * MINUTE;
    if (zoneOffsetAt(zone, utc) === offset) candidates.add(utc);
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

/**
 * A zone that has a fixed UTC offset. Whole hours map to `Etc/GMT∓N`, whose
 * sign is inverted (UTC−8 is `Etc/GMT+8`). Anything else, a half-hour offset
 * or one outside `Etc/GMT-14` … `Etc/GMT+12`, has no Etc zone: the caller
 * keeps the UTC instant and gets `Etc/UTC`.
 */
export function fixedOffsetZone(offsetMinutes: number): string {
  if (offsetMinutes === 0 || offsetMinutes % 60 !== 0) return 'Etc/UTC';
  const hours = offsetMinutes / 60;
  if (hours > 14 || hours < -12) return 'Etc/UTC';
  return hours > 0 ? `Etc/GMT-${hours}` : `Etc/GMT+${-hours}`;
}

type AirportTable = { zones: string[]; airports: Record<string, number> };
let airportTable: Promise<AirportTable> | null = null;

/**
 * Load the IATA → IANA table (scripts/generate-airport-timezones.mjs). It is
 * its own chunk, fetched from the app's origin the first time a flight card
 * needs it. A failed load is forgotten so the next card can retry.
 */
export function loadAirportZones(): Promise<(code: string | undefined) => string | undefined> {
  if (!airportTable) {
    airportTable = import('./data/airport-timezones.json').then((mod) => (mod.default ?? mod) as AirportTable);
    airportTable.catch(() => { airportTable = null; });
  }
  return airportTable.then((table) => (code) => {
    const key = code?.trim().toUpperCase();
    if (!key || !/^[A-Z]{3}$/.test(key)) return undefined;
    const index = table.airports[key];
    return index === undefined ? undefined : table.zones[index];
  });
}

export type ZoneSource = 'airport' | 'country' | 'offset' | 'utc' | 'floating';

export interface ResolvedZone {
  /** IANA zone, or null for a floating time that stays as written. */
  zone: string | null;
  source: ZoneSource;
}

/**
 * Pick the zone for one end of a booking. `named` is the zone the place
 * implies (airport table or single-zone country). With an offset from the
 * mail, the named zone must give that same offset at that instant, otherwise
 * the mail and the table disagree and the result is `mismatch` (the caller
 * drops the booking: we can't tell which of the two is wrong). Without a
 * named zone the offset gives a fixed-offset zone. Without an offset the
 * time is read in the named zone, or stays floating.
 */
export function resolveZone(input: {
  named?: { zone: string; source: 'airport' | 'country' };
  offsetMinutes?: number;
  utcMs?: number;
}): ResolvedZone | 'mismatch' {
  const { named, offsetMinutes, utcMs } = input;
  if (offsetMinutes !== undefined && utcMs !== undefined) {
    if (named) {
      return zoneOffsetAt(named.zone, utcMs) === offsetMinutes ? { zone: named.zone, source: named.source } : 'mismatch';
    }
    const zone = fixedOffsetZone(offsetMinutes);
    return { zone, source: zone === 'Etc/UTC' && offsetMinutes !== 0 ? 'utc' : 'offset' };
  }
  if (named) return { zone: named.zone, source: named.source };
  return { zone: null, source: 'floating' };
}
