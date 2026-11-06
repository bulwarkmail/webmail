/**
 * When each synced setting last changed, so a change that never reached the
 * server isn't overwritten by the older server copy, and a newer change from
 * another device still wins for that setting (last writer per key).
 *
 * The client keeps the time of its own changes (`dirty`, until the server has
 * taken them) and the time it knows for every other setting (`stamps`). A
 * push carries `stamps` in the blob as `settingsModifiedAt`; the server keeps
 * a stored value whose stamp is newer than the pushed one. Times are the
 * writing device's clock.
 *
 * Shared by the settings store (browser) and the settings route (server):
 * no browser or server imports here.
 */

/** The blob field holding each setting's last change time (ms since epoch). */
export const SETTINGS_STAMPS_FIELD = 'settingsModifiedAt';

/**
 * Blob fields that aren't settings with a stamp of their own: templates and
 * calendar subscriptions merge per item, and the "chosen by the user" list
 * follows whichever value each setting kept.
 */
const UNSTAMPED_BLOB_KEYS = new Set<string>([
  SETTINGS_STAMPS_FIELD,
  'explicitSettings',
  'templates',
  'deletedTemplateIds',
  'templatesInMetadata',
  'icalSubscriptions',
  'deletedSubscriptionIds',
]);

export function isStampedBlobKey(key: string): boolean {
  return !UNSTAMPED_BLOB_KEYS.has(key);
}

type Blob = Record<string, unknown>;

const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

/** Only finite, positive numbers: anything else reads as "no stamp". */
export function readStamps(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = value;
  }
  return out;
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((key): key is string => typeof key === 'string') : [];
}

/**
 * What the server stores when `incoming` is pushed over `stored`. Each
 * setting in the push takes the pushed value unless the stored one changed
 * later. Settings the push leaves out are dropped, as before. A push from a
 * build without stamps replaces the values as it always did; a stored stamp
 * stays only where the value didn't change.
 */
export function mergeStoredSettingStamps(stored: Blob | null, incoming: Blob): Blob {
  if (!stored) return incoming;
  const pushedStamps = hasOwn(incoming, SETTINGS_STAMPS_FIELD) ? readStamps(incoming[SETTINGS_STAMPS_FIELD]) : null;
  const storedStamps = readStamps(stored[SETTINGS_STAMPS_FIELD]);
  const out: Blob = { ...incoming };
  const stamps: Record<string, number> = {};
  const keptStored = new Set<string>();
  for (const key of Object.keys(incoming)) {
    if (!isStampedBlobKey(key)) continue;
    const storedAt = storedStamps[key] ?? 0;
    if (pushedStamps === null) {
      if (storedAt && JSON.stringify(stored[key]) === JSON.stringify(incoming[key])) stamps[key] = storedAt;
      continue;
    }
    const pushedAt = pushedStamps[key] ?? 0;
    if (storedAt > pushedAt && hasOwn(stored, key)) {
      out[key] = stored[key];
      stamps[key] = storedAt;
      keptStored.add(key);
    } else if (pushedAt) {
      stamps[key] = pushedAt;
    }
  }
  if (keptStored.size > 0) {
    // A setting whose stored value stays keeps its stored "chosen" mark.
    out.explicitSettings = [
      ...new Set([
        ...stringList(incoming.explicitSettings).filter((key) => !keptStored.has(key)),
        ...stringList(stored.explicitSettings).filter((key) => keptStored.has(key)),
      ]),
    ];
  }
  if (Object.keys(stamps).length > 0) out[SETTINGS_STAMPS_FIELD] = stamps;
  else delete out[SETTINGS_STAMPS_FIELD];
  return out;
}

/** This device's knowledge of when its settings changed, kept in localStorage. */
export interface LocalSettingStamps {
  /** Last change time of every setting this device knows one for. */
  stamps: Record<string, number>;
  /** Settings changed here that the server hasn't taken yet, with the change time. */
  dirty: Record<string, number>;
}

export function emptyLocalStamps(): LocalSettingStamps {
  return { stamps: {}, dirty: {} };
}

export function parseLocalStamps(raw: string | null): LocalSettingStamps {
  if (!raw) return emptyLocalStamps();
  try {
    const parsed = JSON.parse(raw) as { stamps?: unknown; dirty?: unknown };
    return { stamps: readStamps(parsed?.stamps), dirty: readStamps(parsed?.dirty) };
  } catch {
    return emptyLocalStamps();
  }
}

/**
 * Whether the local value of `key` stays over the server copy's on load: it
 * changed here after the server's value was written, and never got there.
 */
export function localChangeWins(local: LocalSettingStamps, serverStamps: Record<string, number>, key: string): boolean {
  const changedAt = local.dirty[key];
  return changedAt !== undefined && changedAt > (serverStamps[key] ?? 0);
}
