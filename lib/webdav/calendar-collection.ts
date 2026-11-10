/**
 * Creating calendar collections over CalDAV (through the /api/webdav proxy).
 *
 * Stalwart's JMAP Calendar/set has no way to express the CalDAV
 * supported-calendar-component-set, and the server only accepts that property
 * while a collection is being created - a later PROPPATCH is rejected with
 * "Property cannot be modified". A calendar without it advertises every
 * component type, so sync clients such as DAVx5 offer it to todo apps as well
 * as calendar apps (#760). Creating the collection with MKCALENDAR pins the
 * set; the calendar's other properties are then applied over JMAP as usual.
 */

import { apiFetch } from '@/lib/browser-navigation';
import { getActiveAccountSlotHeaders } from '@/lib/auth/active-account-slot';
import { generateUUID } from '@/lib/utils';
import { IS_LITE } from '@/lib/lite';
import type { CalendarComponentType } from '@/lib/jmap/types';

/** What a plain "calendar" holds unless the user asks for tasks. */
export const DEFAULT_CALENDAR_COMPONENTS: readonly CalendarComponentType[] = ['VEVENT'];

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Random path segment for a new collection. Stalwart's own JMAP create uses a
 * random alphanumeric name too; the display name lives in a separate property,
 * so the segment never needs to be human readable.
 */
export function newCalendarCollectionName(): string {
  return generateUUID().replace(/-/g, '').slice(0, 16);
}

export function buildMkCalendarBody(displayName: string, components: readonly CalendarComponentType[]): string {
  const comps = components.map((c) => '<C:comp name="' + c + '"/>').join('');
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
    '<D:set><D:prop>' +
    '<D:displayname>' + escapeXml(displayName) + '</D:displayname>' +
    '<C:supported-calendar-component-set>' + comps + '</C:supported-calendar-component-set>' +
    '</D:prop></D:set>' +
    '</C:mkcalendar>';
}

/**
 * MKCALENDAR a collection in the signed-in user's own account. Resolves true
 * when Stalwart reports 201 Created and false for any other status (older
 * server, proxy unavailable, name clash...). Rejects on network failure.
 */
export async function mkCalendarCollection(opts: {
  collectionName: string;
  displayName: string;
  components: readonly CalendarComponentType[];
}): Promise<boolean> {
  const response = await apiFetch('/api/webdav', {
    method: 'POST',
    headers: {
      'X-WebDAV-Method': 'MKCALENDAR',
      'X-WebDAV-Collection': 'cal',
      'X-WebDAV-Path': opts.collectionName,
      'Content-Type': 'application/xml; charset=utf-8',
      ...getActiveAccountSlotHeaders(),
    },
    body: buildMkCalendarBody(opts.displayName, opts.components),
  });
  return response.status === 201;
}

/** Key prefix of the entries parseCalendarCollectionComponents adds by display name. */
const NAME_KEY = '\u0000name:';

/** The PROPFIND waits in front of the calendar list, so it gets a short leash. */
const COMPONENTS_TIMEOUT_MS = 10_000;

/** Decoded path segments of an href or URL, or null when it can't be read. */
function davPathSegments(hrefOrUrl: string): string[] | null {
  try {
    return new URL(hrefOrUrl.trim(), 'http://dav.invalid/').pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/**
 * Parses CalDAV multistatus PROPFIND XML response and extracts the
 * supported-calendar-component-set for each collection, keyed by its path
 * segment, and once more by its display name where no other collection has
 * that name (see davComponentsFor).
 *
 * `homePath` is the calendar home the PROPFIND asked for. Stalwart's Depth 1
 * listing of a home also holds the collections other accounts share with the
 * user (/dav/cal/team%40example.org/default/), which would clash with the
 * user's own by path and by name; with `homePath` only the home's own
 * collections are kept.
 */
export function parseCalendarCollectionComponents(xml: string, homePath?: string): Record<string, CalendarComponentType[]> {
  const result: Record<string, CalendarComponentType[]> = {};
  if (!xml || typeof xml !== 'string') return result;
  const byName = new Map<string, CalendarComponentType[] | null>();
  // Compared by its last two segments (cal/<user>): a reverse proxy may mount
  // the server under a prefix that the server's own hrefs leave out. Decoded
  // and in any case: the home carries the login as typed (Linus@Example.org),
  // the server's hrefs its own spelling (linus%40example.org).
  const homeKey = (segments: string[]) => segments.slice(-2).map((segment) => segment.toLowerCase());
  const homeSegments = homePath === undefined ? null : davPathSegments(homePath);
  const home = homeSegments ? homeKey(homeSegments) : undefined;

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'application/xml');
    const responses = doc.getElementsByTagNameNS('DAV:', 'response');

    for (let i = 0; i < responses.length; i++) {
      const resp = responses[i];
      const hrefEl = resp.getElementsByTagNameNS('DAV:', 'href')[0];
      if (!hrefEl?.textContent) continue;

      const compNodes = resp.getElementsByTagNameNS('urn:ietf:params:xml:ns:caldav', 'comp');
      if (!compNodes || compNodes.length === 0) continue;

      const segments = davPathSegments(hrefEl.textContent);
      if (!segments || segments.length === 0) continue;
      if (home) {
        const parent = homeKey(segments.slice(0, -1));
        if (parent.length !== home.length || parent.some((segment, k) => segment !== home[k])) continue;
      }

      const resTypeNode = resp.getElementsByTagNameNS('DAV:', 'resourcetype')[0];
      const hasCalendarType = Boolean(resTypeNode?.getElementsByTagNameNS('urn:ietf:params:xml:ns:caldav', 'calendar').length);

      // Skip root directories if they have fewer than 3 segments and lack calendar resourcetype
      if (segments.length < 3 && !hasCalendarType) continue;

      const collectionId = segments[segments.length - 1];
      if (!collectionId) continue;

      const comps: CalendarComponentType[] = [];
      for (let j = 0; j < compNodes.length; j++) {
        const name = compNodes[j].getAttribute('name')?.toUpperCase();
        if (name === 'VEVENT' || name === 'VTODO' || name === 'VJOURNAL') {
          comps.push(name as CalendarComponentType);
        }
      }
      if (comps.length > 0) {
        result[collectionId] = comps;
        const displayName = resp.getElementsByTagNameNS('DAV:', 'displayname')[0]?.textContent?.trim();
        // A name two collections share identifies neither.
        if (displayName) byName.set(displayName, byName.has(displayName) ? null : comps);
      }
    }
    for (const [displayName, comps] of byName) {
      if (comps) result[NAME_KEY + displayName] = comps;
    }
  } catch (error) {
    console.error('Failed to parse CalDAV calendar components XML:', error);
  }

  return result;
}

/**
 * Fetches the supported-calendar-component-set for all calendar collections
 * from Stalwart's CalDAV endpoint via the /api/webdav proxy.
 *
 * `accountHeaders` pins the request to a specific account's cookie slot
 * (via {@link getAccountSlotHeadersFor}) - required when scanning an account
 * other than the currently active one, since the proxy otherwise resolves
 * credentials from whichever account is focused in the UI in multi-account setups.
 * Defaults to the active account for single-account callers.
 */
export async function fetchCalendarCollectionComponents(
  accountHeaders: Record<string, string> = getActiveAccountSlotHeaders(),
): Promise<Record<string, CalendarComponentType[]>> {
  // Lite has no /api/webdav proxy.
  if (IS_LITE) return {};
  try {
    const response = await apiFetch('/api/webdav', {
      method: 'POST',
      signal: AbortSignal.timeout(COMPONENTS_TIMEOUT_MS),
      headers: {
        'X-WebDAV-Method': 'PROPFIND',
        'X-WebDAV-Collection': 'cal',
        'X-WebDAV-Path': '/',
        'Depth': '1',
        'Content-Type': 'application/xml; charset=utf-8',
        ...accountHeaders,
      },
      body: `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <C:supported-calendar-component-set/>
  </D:prop>
</D:propfind>`,
    });

    if (response.status !== 207) {
      return {};
    }

    const text = await response.text();
    return parseCalendarCollectionComponents(text, response.headers.get('X-WebDAV-Request-URI') ?? undefined);
  } catch {
    return {};
  }
}


/**
 * The supported components of a calendar's CalDAV collection. Stalwart names a
 * collection by its path (a client's UUID, or the random name
 * mkCalendarCollection picks), not by the JMAP calendar id, and gives no
 * property linking the two; the display name is the link where it names one
 * collection and one calendar.
 */
export function davComponentsFor(
  calendar: { id: string; name?: string },
  davComponents: Record<string, CalendarComponentType[]>,
  calendars: Array<{ name?: string }>,
): CalendarComponentType[] | undefined {
  const byId = davComponents[calendar.id];
  if (byId) return byId;
  if (!calendar.name || calendars.filter((c) => c.name === calendar.name).length !== 1) return undefined;
  return davComponents[NAME_KEY + calendar.name];
}
