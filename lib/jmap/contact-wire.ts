import type { AddressComponent, ContactAddress, ContactCard } from './types';

/**
 * Translation between the ContactCard shape the UI works with and the RFC 9553
 * card the server stores.
 *
 * ContactCard/set rejects a whole card over a single property it does not
 * know ("Invalid property."), so client-side fields must never reach it, and
 * the UI's flat conveniences are written as their JSContact equivalents.
 */

/** Fields the client adds to cards it lists; not part of RFC 9553. */
const CLIENT_ONLY_KEYS = [
  'originalId', 'accountId', 'accountName', 'isShared', 'localAccountId',
] as const;

/** vCard CALURI / FBURL / CALADRURI, kept flat in the UI. */
const URI_KEYS = ['calendarUri', 'freeBusyUri', 'schedulingUri', 'source'] as const;

const LEGACY_ADDRESS_FIELDS: Array<[keyof ContactAddress, AddressComponent['kind']]> = [
  ['street', 'name'],
  ['locality', 'locality'],
  ['region', 'region'],
  ['postcode', 'postcode'],
  ['country', 'country'],
];

/** vCard imports store flat fields; RFC 9553 wants `components`. */
function addressToWire(address: ContactAddress): Record<string, unknown> {
  const { street: _s, locality: _l, region: _r, postcode: _p, country: _c, fullAddress, ...rest } = address;
  const out: Record<string, unknown> = { ...rest };
  if (!address.components?.length) {
    const components = LEGACY_ADDRESS_FIELDS
      .map(([field, kind]) => ({ kind, value: (address[field] as string | undefined)?.trim() ?? '' }))
      .filter(c => c.value);
    if (components.length) {
      out.components = components;
      out.isOrdered = true;
      out.defaultSeparator = ', ';
    }
  }
  if (fullAddress && !address.full) out.full = fullAddress;
  return out;
}

type Mode = 'create' | 'update';

/**
 * The card as ContactCard/set expects it. On `update`, a key that is present
 * with the value `undefined` means "the user cleared it" and is sent as
 * `null`: JSON drops undefined, and an omitted property keeps its old value.
 */
export function contactToWire(card: Partial<ContactCard>, mode: Mode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(card)) {
    if ((CLIENT_ONLY_KEYS as readonly string[]).includes(key)) continue;
    if ((URI_KEYS as readonly string[]).includes(key)) continue;
    if (value === undefined) {
      if (mode === 'update') out[key] = null;
      continue;
    }
    out[key] = value;
  }

  if (card.addresses) {
    out.addresses = Object.fromEntries(
      Object.entries(card.addresses).map(([id, a]) => [id, addressToWire(a)]),
    );
  }

  // Rebuild the calendar links only when the caller manages them, so an
  // update that does not mention them leaves the server's entries alone.
  if ('calendarUri' in card || 'freeBusyUri' in card) {
    const calendars: Record<string, unknown> = {};
    if (card.calendarUri) calendars.cal = { '@type': 'Calendar', kind: 'calendar', uri: card.calendarUri };
    if (card.freeBusyUri) calendars.fb = { '@type': 'Calendar', kind: 'freeBusy', uri: card.freeBusyUri };
    if (Object.keys(calendars).length) out.calendars = calendars;
    else if (mode === 'update') out.calendars = null;
  }
  if ('schedulingUri' in card) {
    if (card.schedulingUri) out.schedulingAddresses = { sched: { '@type': 'SchedulingAddress', uri: card.schedulingUri } };
    else if (mode === 'update') out.schedulingAddresses = null;
  }
  if (card.source) {
    // vCard SOURCE is a JSContact directory entry (RFC 9553 §2.6.2).
    const directories = { ...(card.directories ?? {}) } as Record<string, unknown>;
    directories.source = { '@type': 'Directory', kind: 'entry', uri: card.source };
    out.directories = directories;
  }
  return out;
}

/** Fill the UI's flat URI fields from the RFC 9553 properties. */
export function contactFromWire<T extends ContactCard>(card: T): T {
  const calendars = Object.values(card.calendars ?? {});
  const calendarUri = card.calendarUri ?? calendars.find(c => c?.kind === 'calendar')?.uri;
  const freeBusyUri = card.freeBusyUri ?? calendars.find(c => c?.kind === 'freeBusy')?.uri;
  const schedulingUri = card.schedulingUri ?? Object.values(card.schedulingAddresses ?? {})[0]?.uri;
  const source = card.source ?? Object.values(card.directories ?? {}).find(d => d?.kind === 'entry')?.uri;
  if (!calendarUri && !freeBusyUri && !schedulingUri && !source) return card;
  return {
    ...card,
    ...(calendarUri ? { calendarUri } : {}),
    ...(freeBusyUri ? { freeBusyUri } : {}),
    ...(schedulingUri ? { schedulingUri } : {}),
    ...(source ? { source } : {}),
  };
}
