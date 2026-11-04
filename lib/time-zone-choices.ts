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
