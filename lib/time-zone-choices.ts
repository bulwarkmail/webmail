import { canonicalTimeZone } from './timezone';

/**
 * The time zone list in Settings: each zone by its city and UTC offset
 * ("Berlin", "GMT+01:00"), the common ones first, then all of them by
 * offset. The value stays the IANA id the runtime knows, so a stored choice
 * keeps working; only the name shown changes.
 */

// Ids the time zone database still lists under a city's old name. Browsers
// report these (Intl gives "Asia/Calcutta", not "Asia/Kolkata").
const CURRENT_CITY_NAMES: Record<string, string> = {
  'Asia/Calcutta': 'Kolkata',
  'Asia/Kolkata': 'Kolkata',
  'Europe/Kiev': 'Kyiv',
  'Europe/Kyiv': 'Kyiv',
  'Asia/Saigon': 'Ho Chi Minh City',
  'Asia/Ho_Chi_Minh': 'Ho Chi Minh City',
  'Asia/Katmandu': 'Kathmandu',
  'Asia/Rangoon': 'Yangon',
  'Asia/Ulan_Bator': 'Ulaanbaatar',
  'America/Godthab': 'Nuuk',
  'Atlantic/Faeroe': 'Faroe Islands',
  'Europe/Uzhgorod': 'Uzhhorod',
  'Europe/Zaporozhye': 'Zaporizhzhia',
  'Pacific/Ponape': 'Pohnpei',
  'Pacific/Truk': 'Chuuk',
  'Pacific/Enderbury': 'Kanton',
  'Asia/Thimbu': 'Thimphu',
  'Asia/Dacca': 'Dhaka',
  'Asia/Macao': 'Macau',
  'Asia/Ujung_Pandang': 'Makassar',
};

/** Zones most people look for, in this order, before the full list. */
export const COMMON_TIME_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
] as const;

export interface TimeZoneChoice {
  /** The IANA id as the runtime lists it; this is what gets stored. */
  value: string;
  /** City and, for ids with three parts, the region: "La Rioja, Argentina". */
  city: string;
  /** "GMT+01:00", "GMT" for UTC. */
  offset: string;
  offsetMinutes: number;
  /** The zone's name in the given language ("Central European Time"), for search. */
  name?: string;
  common: boolean;
}

/** The city a zone id stands for, by its current name. */
export function timeZoneCity(id: string): string {
  if (id === 'UTC' || id === 'Etc/UTC') return 'UTC';
  const renamed = CURRENT_CITY_NAMES[id];
  if (renamed) return renamed;
  const parts = id.split('/');
  const city = parts[parts.length - 1].replace(/_/g, ' ');
  return parts.length > 2 ? `${city}, ${parts[1].replace(/_/g, ' ')}` : city;
}

function offsetOf(id: string, now: Date): { offset: string; minutes: number } {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: id, timeZoneName: 'longOffset' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = /GMT([+-])(\d{2}):(\d{2})/.exec(part);
    const minutes = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
    // Zero offset reads "GMT", as Windows and macOS write it.
    return { offset: m && minutes !== 0 ? part : 'GMT', minutes };
  } catch {
    return { offset: 'GMT', minutes: 0 };
  }
}

function zoneName(id: string, locale: string | undefined, now: Date): string | undefined {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: id, timeZoneName: 'longGeneric' })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')?.value;
  } catch {
    return undefined;
  }
}

/**
 * Every zone in `zones` (plus `extra`, the zone in use, if it's missing),
 * the common ones first, then all of them by offset and city. Two ids for
 * one city ("Asia/Calcutta" and "Asia/Kolkata") show once, as the id the
 * runtime spells.
 */
export function timeZoneChoices(
  zones: readonly string[],
  opts: { locale?: string; now?: Date; extra?: string[] } = {},
): { common: TimeZoneChoice[]; all: TimeZoneChoice[] } {
  const now = opts.now ?? new Date();
  const listed = new Set(zones);
  for (const id of opts.extra ?? []) if (id) listed.add(id);

  const byCity = new Map<string, TimeZoneChoice>();
  for (const id of listed) {
    const city = timeZoneCity(id);
    const { offset, minutes } = offsetOf(id, now);
    const key = `${city}|${minutes}`;
    const existing = byCity.get(key);
    // Keep an id the caller asked for (the stored one) over its alias.
    if (existing && !(opts.extra ?? []).includes(id)) continue;
    byCity.set(key, { value: id, city, offset, offsetMinutes: minutes, name: zoneName(id, opts.locale, now), common: false });
  }
  const all = [...byCity.values()].sort((a, b) => a.offsetMinutes - b.offsetMinutes || a.city.localeCompare(b.city));

  const byValue = new Map(all.map((c) => [c.value, c]));
  const common: TimeZoneChoice[] = [];
  for (const id of COMMON_TIME_ZONES) {
    const canonical = canonicalTimeZone(id);
    const choice = byValue.get(id) ?? (canonical ? byValue.get(canonical) : undefined)
      ?? all.find((c) => c.city === timeZoneCity(id));
    if (choice && !common.includes(choice)) common.push({ ...choice, common: true });
  }
  return { common, all };
}


// Abbreviations people type for a zone, with the zones they stand for. Both
// the winter and the summer name, since people type either all year.
const CET = ['Europe/Berlin', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome', 'Europe/Amsterdam', 'Europe/Brussels',
  'Europe/Vienna', 'Europe/Zurich', 'Europe/Stockholm', 'Europe/Oslo', 'Europe/Copenhagen', 'Europe/Warsaw',
  'Europe/Prague', 'Europe/Budapest', 'Europe/Belgrade', 'Europe/Luxembourg'];
const EET = ['Europe/Athens', 'Europe/Helsinki', 'Europe/Kyiv', 'Europe/Kiev', 'Europe/Bucharest', 'Europe/Sofia',
  'Europe/Riga', 'Europe/Tallinn', 'Europe/Vilnius', 'Africa/Cairo'];
const WET = ['Europe/Lisbon', 'Atlantic/Canary', 'Atlantic/Madeira', 'Atlantic/Faroe', 'Atlantic/Faeroe'];
const US_EAST = ['America/New_York', 'America/Toronto', 'America/Detroit', 'America/Indiana/Indianapolis'];
const US_CENTRAL = ['America/Chicago', 'America/Winnipeg', 'America/Mexico_City'];
const US_MOUNTAIN = ['America/Denver', 'America/Phoenix', 'America/Edmonton', 'America/Boise'];
const US_PACIFIC = ['America/Los_Angeles', 'America/Vancouver', 'America/Tijuana'];
const AU_EAST = ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Hobart', 'Australia/Canberra'];
const UK = ['Europe/London', 'Europe/Dublin'];

export const TIME_ZONE_ABBREVIATIONS: Record<string, readonly string[]> = {
  UTC: ['UTC', 'Etc/UTC'],
  GMT: ['UTC', 'Etc/UTC', ...UK],
  BST: UK,
  IST: ['Asia/Kolkata', 'Asia/Calcutta'],
  CET, CEST: CET, MEZ: CET, MESZ: CET,
  EET, EEST: EET,
  WET, WEST: WET,
  MSK: ['Europe/Moscow'],
  EST: US_EAST, EDT: US_EAST, ET: US_EAST,
  CST: [...US_CENTRAL, 'Asia/Shanghai'], CDT: US_CENTRAL, CT: US_CENTRAL,
  MST: US_MOUNTAIN, MDT: US_MOUNTAIN, MT: US_MOUNTAIN,
  PST: US_PACIFIC, PDT: US_PACIFIC, PT: US_PACIFIC,
  AKST: ['America/Anchorage'], AKDT: ['America/Anchorage'],
  HST: ['Pacific/Honolulu'],
  JST: ['Asia/Tokyo'],
  KST: ['Asia/Seoul'],
  HKT: ['Asia/Hong_Kong'],
  SGT: ['Asia/Singapore'],
  AEST: AU_EAST, AEDT: AU_EAST,
  ACST: ['Australia/Adelaide', 'Australia/Darwin'], ACDT: ['Australia/Adelaide'],
  AWST: ['Australia/Perth'],
  NZST: ['Pacific/Auckland'], NZDT: ['Pacific/Auckland'],
  BRT: ['America/Sao_Paulo'],
  ART: ['America/Argentina/Buenos_Aires', 'America/Buenos_Aires'],
  SAST: ['Africa/Johannesburg'],
  WAT: ['Africa/Lagos'],
  EAT: ['Africa/Nairobi'],
  PKT: ['Asia/Karachi'],
  WIB: ['Asia/Jakarta'],
  ICT: ['Asia/Bangkok', 'Asia/Ho_Chi_Minh', 'Asia/Saigon'],
  PHT: ['Asia/Manila'],
  GST: ['Asia/Dubai'],
};

/**
 * An offset typed in the search ("GMT+1", "UTC-5", "+05:30", "-0800"), in
 * minutes east of UTC; null when the text isn't one. "GMT" alone is UTC.
 */
export function parseTypedOffset(text: string): number | null {
  const m = /^(?:gmt|utc)?\s*([+\-−])\s*(\d{1,2})(?::?(\d{2}))?$/i.exec(text.trim());
  if (!m) return null;
  const hours = Number(m[2]);
  const minutes = m[3] ? Number(m[3]) : 0;
  if (hours > 14 || minutes > 59) return null;
  return (m[1] === '+' ? 1 : -1) * (hours * 60 + minutes);
}

/**
 * Where a zone goes in the search results, lower first; null leaves it out.
 * An abbreviation ("CET") or an exact offset ("GMT+1") finds its zones
 * first; anything the words match comes after. Without this, "GMT+1" listed
 * GMT+11 and GMT+10 before GMT+01:00, and "CET" found nothing.
 */
export function timeZoneSearchRank(
  query: string,
  zone: { value: string; offsetMinutes?: number },
  wordsMatch: boolean,
): number | null {
  const typed = query.trim();
  const zones = TIME_ZONE_ABBREVIATIONS[typed.toUpperCase()];
  if (zones?.includes(zone.value)) return 0;
  const offset = parseTypedOffset(typed);
  if (offset !== null && zone.offsetMinutes !== undefined) {
    if (zone.offsetMinutes === offset) return 0;
    // "+1" also finds "+10", but after the zones at +01:00.
    return wordsMatch ? 2 : null;
  }
  return wordsMatch ? 1 : null;
}
