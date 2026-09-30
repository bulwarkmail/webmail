/**
 * Server-side recurrence instances ("synthetic ids").
 *
 * `CalendarEvent/query` with `expandRecurrences: true` returns one synthetic
 * id per occurrence in the range instead of the stored base event. Since
 * Stalwart 0.16.20 those ids are also accepted by `CalendarEvent/set`: an
 * update on a synthetic id writes a `recurrenceOverrides` entry for that one
 * occurrence, a destroy excludes it. Older servers reject both with
 * `invalidProperties` ("… synthetic ids is not yet supported."), in which
 * case Bulwark keeps expanding recurrences in the browser
 * (lib/recurrence-expansion.ts) and patches the base event itself.
 *
 * What an expanded occurrence looks like (verified against 0.16.19):
 * - `id` is synthetic, `baseEventId` is the stored event's id; a
 *   non-recurring event in the range gets a synthetic id too.
 * - `recurrenceId` / `recurrenceIdTimeZone` are set for occurrences of a
 *   series, `recurrenceRule` / `recurrenceOverrides` are stripped.
 * - all-day occurrences lose `showWithoutTime` and are stamped with the
 *   request time zone.
 * - the ids are positional and reshuffle whenever the series' overrides
 *   change, so the visible range has to be refetched after mutating one.
 */

import type { CalendarEvent, CalendarParticipant } from '@/lib/jmap/types';
import { parseDurationSeconds } from '@/lib/calendar-event-normalization';
import { RECURRENCE_OVERRIDE_IMMUTABLE_KEYS } from '@/lib/recurrence-overrides';

/**
 * A synthetic id whose event can never exist: expansion 0 of document
 * `u32::MAX` (`Id::from_parts(1, u32::MAX)` in Stalwart's base32 alphabet).
 * A pre-0.16.20 server rejects an update on it as `invalidProperties`
 * before looking anything up; a server that supports synthetic ids answers
 * `notFound`. Either way nothing is written, which makes it a safe probe.
 */
export const SYNTHETIC_ID_PROBE = 'h333333';

/** Base-event properties an expanded occurrence needs back (see `hydrateRecurrenceInstances`). */
export const RECURRENCE_BASE_PROPERTIES = [
  'id',
  'recurrenceRule',
  'excludedRecurrenceRule',
  'recurrenceOverrides',
  'showWithoutTime',
  'timeZone',
  'duration',
] as const;

/**
 * Properties Stalwart refuses on a single occurrence ("This property cannot
 * be modified on a single occurrence."). They describe the stored event, not
 * one of its instances.
 */
export const OCCURRENCE_REJECTED_KEYS = [
  'baseEventId',
  'calendarIds',
  'isDraft',
  'isOrigin',
  'utcStart',
  'utcEnd',
  'useDefaultAlerts',
  'mayInviteSelf',
  'mayInviteOthers',
  'hideAttendees',
] as const;

type EventIdentity = Pick<CalendarEvent, 'id'> & Partial<Pick<CalendarEvent, 'originalId' | 'baseEventId'>>;

/**
 * True for an occurrence handed out by server-side expansion, i.e. an event
 * whose (raw) id is synthetic and differs from its base event's id. A base
 * event fetched directly also carries `baseEventId`, equal to its own id.
 */
export function isServerRecurrenceInstance(event: EventIdentity | null | undefined): boolean {
  if (!event?.baseEventId) return false;
  return event.baseEventId !== (event.originalId ?? event.id);
}

/**
 * The store id under which the base event of `instance` would be addressed.
 * Store ids end with the raw JMAP id (`<accountId>:<raw>`,
 * `<localAccountId>::<raw>` or just `<raw>`), so swap the trailing raw
 * synthetic id for the base id and keep whatever namespace prefix is there.
 */
export function baseEventStoreId(instance: EventIdentity): string | null {
  if (!isServerRecurrenceInstance(instance) || !instance.baseEventId) return null;
  const raw = instance.originalId ?? instance.id;
  if (!instance.id.endsWith(raw)) return instance.baseEventId;
  return instance.id.slice(0, instance.id.length - raw.length) + instance.baseEventId;
}

/**
 * Whether a `CalendarEvent/set` failure is a pre-0.16.20 server refusing a
 * synthetic id ("Updating/Deleting synthetic ids is not yet supported.").
 */
export function isSyntheticIdMutationUnsupported(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : '';
  return /synthetic ids?\b.*\bnot (?:yet )?supported/i.test(message);
}

function firstPointerSegment(key: string): string {
  const slash = key.indexOf('/');
  return slash === -1 ? key : key.slice(0, slash);
}

/**
 * Reduce an event patch to what may be written to a single occurrence
 * through its synthetic id: identity / whole-series keys and the per-event
 * keys the server rejects are dropped (also when addressed through a JSON
 * pointer such as `calendarIds/x`). Everything else - including pointer
 * patches like `locations/loc1/name` - passes through unchanged.
 */
export function buildOccurrencePatch(updates: Partial<CalendarEvent>): Partial<CalendarEvent> {
  const dropped = new Set<string>([
    ...RECURRENCE_OVERRIDE_IMMUTABLE_KEYS,
    ...OCCURRENCE_REJECTED_KEYS,
    'recurrenceId',
    'recurrenceIdTimeZone',
  ]);
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (dropped.has(firstPointerSegment(key))) continue;
    patch[key] = value;
  }
  return patch as Partial<CalendarEvent>;
}

type OverrideMap = NonNullable<CalendarEvent['recurrenceOverrides']>;

/**
 * Given an expanded occurrence, find the key of its entry in the base
 * event's `recurrenceOverrides`. Normally that is `recurrenceId`; a
 * pre-0.16.20 server reports a moved occurrence's *new* start as its
 * recurrenceId, in which case the entry is found by that start instead.
 */
export function resolveOverrideKey(
  instance: Pick<CalendarEvent, 'start' | 'recurrenceId'>,
  overrides: OverrideMap | null | undefined,
): string | null {
  if (!instance.recurrenceId) return null;
  if (!overrides || instance.recurrenceId in overrides) return instance.recurrenceId;
  for (const [key, override] of Object.entries(overrides)) {
    if (override && override.start === instance.start) return key;
  }
  return instance.recurrenceId;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * An override's participants, each completed from the series participant
 * with the same id or calendar address. The override decides who takes part;
 * the series fills what it leaves out. Stalwart records an attendee's reply to
 * one occurrence as an override naming the organizer under a new id and
 * without a participation status, which would otherwise show the organizer as
 * not having answered their own meeting.
 */
export function mergeOverrideParticipants(
  series: CalendarEvent['participants'],
  override: CalendarEvent['participants'],
): CalendarEvent['participants'] {
  if (!override) return override;
  const address = (p: CalendarParticipant) => (p.calendarAddress ?? '').toLowerCase();
  const from = series ?? {};
  const merged: Record<string, CalendarParticipant> = {};
  for (const [id, participant] of Object.entries(override)) {
    const match = id in from
      ? id
      : Object.keys(from).find((key) => address(from[key]) && address(from[key]) === address(participant));
    const defined = Object.fromEntries(Object.entries(participant).filter(([, v]) => v != null));
    merged[match ?? id] = { ...(match ? from[match] : {}), ...defined } as CalendarParticipant;
  }
  return merged;
}

/**
 * Stalwart lists an occurrence twice under one id - once as the series
 * generates it, once from its override - when the override ranks below the
 * series (no or a lower SEQUENCE). It writes such overrides itself: an
 * attendee's reply to one occurrence becomes, on the organizer's side, an
 * override holding little more than that attendee. Collapse each pair into
 * one occurrence: the fields the override defines (per the base event's
 * overrides map) from the override, the rest from the series.
 */
function collapseDuplicateInstances(
  instances: CalendarEvent[],
  bases: ReadonlyMap<string, Partial<CalendarEvent>>,
): CalendarEvent[] {
  const groups = new Map<string, CalendarEvent[]>();
  for (const instance of instances) {
    const group = groups.get(instance.id);
    if (group) group.push(instance);
    else groups.set(instance.id, [instance]);
  }
  if (groups.size === instances.length) return instances;

  const collapse = (group: CalendarEvent[]): CalendarEvent => {
    const first = group[0];
    const base = first.baseEventId ? bases.get(first.baseEventId) : undefined;
    const key = base ? resolveOverrideKey(first, base.recurrenceOverrides) : null;
    const entry = key ? base?.recurrenceOverrides?.[key] as Record<string, unknown> | undefined : undefined;
    if (!entry) {
      return group.reduce((a, b) => (Object.keys(b).length > Object.keys(a).length ? b : a));
    }
    const overrideKeys = Object.keys(entry).filter((k) => k !== 'updated' && !k.includes('/'));
    const score = (instance: CalendarEvent) => overrideKeys
      .filter((k) => stableJson((instance as unknown as Record<string, unknown>)[k]) === stableJson(entry[k]))
      .length;
    const override = group.reduce((a, b) => (score(b) > score(a) ? b : a));
    const series = group.find((instance) => instance !== override) ?? first;
    const merged: Record<string, unknown> = { ...series };
    for (const k of overrideKeys) {
      merged[k] = k === 'participants'
        ? mergeOverrideParticipants(series.participants, override.participants)
        : (override as unknown as Record<string, unknown>)[k];
    }
    return merged as unknown as CalendarEvent;
  };

  const seen = new Set<string>();
  const result: CalendarEvent[] = [];
  for (const instance of instances) {
    if (seen.has(instance.id)) continue;
    seen.add(instance.id);
    const group = groups.get(instance.id)!;
    result.push(group.length > 1 ? collapse(group) : instance);
  }
  return result;
}

function shiftIso(from: string | null | undefined, seconds: number): string | null {
  if (!from) return null;
  const ms = Date.parse(from);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + seconds * 1000).toISOString();
}

/**
 * Give expanded occurrences the base-event context the rest of the app
 * expects from an occurrence (and that the client-side expansion used to
 * copy from the master): the recurrence rules and overrides, the all-day
 * flag, and - for an override that does not set its own duration - the
 * inherited duration (RFC 8984 §4.3.4: an override is a patch on the base
 * event; the server's own computed duration for such overrides has been seen
 * to be wrong). Occurrences whose base event is not in `bases` are returned
 * unchanged.
 */
export function hydrateRecurrenceInstances(
  instances: CalendarEvent[],
  bases: ReadonlyMap<string, Partial<CalendarEvent>>,
): CalendarEvent[] {
  return collapseDuplicateInstances(instances, bases).map((instance) => {
    if (!isServerRecurrenceInstance(instance) || !instance.recurrenceId) return instance;
    const base = instance.baseEventId ? bases.get(instance.baseEventId) : undefined;
    if (!base) return instance;

    const hydrated: CalendarEvent = {
      ...instance,
      recurrenceRules: base.recurrenceRules ?? null,
      excludedRecurrenceRules: base.excludedRecurrenceRules ?? null,
      recurrenceOverrides: base.recurrenceOverrides ?? null,
    };
    if (base.showWithoutTime) {
      hydrated.showWithoutTime = true;
      hydrated.timeZone = base.timeZone ?? null;
    }

    const overrideKey = resolveOverrideKey(instance, base.recurrenceOverrides);
    if (overrideKey) hydrated.recurrenceId = overrideKey;
    const override = overrideKey ? base.recurrenceOverrides?.[overrideKey] : undefined;
    if (override && override.duration == null && base.duration && hydrated.duration !== base.duration) {
      hydrated.duration = base.duration;
      const seconds = parseDurationSeconds(base.duration);
      if (seconds !== null && !hydrated.showWithoutTime) {
        hydrated.utcEnd = shiftIso(hydrated.utcStart, seconds) ?? hydrated.utcEnd;
      }
    }
    return hydrated;
  });
}

/**
 * An occurrence of a series that the browser expanded itself
 * (lib/recurrence-expansion.ts), as opposed to one the server handed out.
 * Changes to it are written as a recurrence override on its base event.
 */
export function isBrowserExpandedOccurrence(
  event: Pick<CalendarEvent, 'id' | 'recurrenceId' | 'recurrenceRules'> & Partial<Pick<CalendarEvent, 'originalId' | 'baseEventId'>>,
): boolean {
  return !!event.recurrenceId && (event.recurrenceRules?.length ?? 0) > 0 && !isServerRecurrenceInstance(event);
}

type OccurrenceOverrideContext = Pick<CalendarEvent, 'id' | 'start' | 'recurrenceId' | 'recurrenceOverrides'>
  & Partial<Pick<CalendarEvent, 'originalId' | 'baseEventId'>>;

/**
 * `occurrence` as seen from `master`, the base event it belongs to, for
 * building an override patch on the master: the master's overrides map is
 * the one that counts.
 */
export function overrideContextOf(
  occurrence: CalendarEvent,
  master: Pick<CalendarEvent, 'recurrenceOverrides'>,
): CalendarEvent {
  return { ...occurrence, baseEventId: undefined, recurrenceOverrides: master.recurrenceOverrides ?? null };
}

/**
 * The base event's overrides map as far as `occurrence` knows it, or
 * `undefined` when it does not. The browser's expansion copies the base
 * event's map (absent means none); a server occurrence only has it once
 * hydrated from its base event (`null` then means none).
 */
function knownOverrides(occurrence: Partial<CalendarEvent>): OverrideMap | null | undefined {
  if (isServerRecurrenceInstance({ ...occurrence, id: occurrence.id ?? '' })) return occurrence.recurrenceOverrides;
  return occurrence.recurrenceOverrides ?? null;
}

/** True when a change to `occurrence` creates its override, false when one exists or it is unknown. */
function createsOverride(occurrence: Partial<CalendarEvent>): boolean {
  const overrides = knownOverrides(occurrence);
  if (overrides === undefined || !occurrence.recurrenceId) return false;
  const key = resolveOverrideKey({ start: occurrence.start ?? '', recurrenceId: occurrence.recurrenceId }, overrides);
  return !!key && !(overrides && key in overrides);
}

/**
 * `override` as the entry `key` of the base event's overrides. A
 * `recurrenceOverrides/<key>` pointer fails ("Patch operation failed") while
 * the base event has no overrides at all, so the first one is sent as the
 * whole map - but only when the map is known to be empty.
 */
function overrideEntryPatch(
  instance: OccurrenceOverrideContext,
  key: string,
  override: Record<string, unknown>,
): Partial<CalendarEvent> {
  const overrides = knownOverrides(instance);
  if (overrides !== undefined && Object.keys(overrides ?? {}).length === 0) {
    return { recurrenceOverrides: { [key]: override } } as Partial<CalendarEvent>;
  }
  return { [`recurrenceOverrides/${key}`]: override } as Partial<CalendarEvent>;
}

/**
 * A change to one occurrence expressed as a recurrence override on its base
 * event: used for occurrences the browser expanded, and as the fallback for
 * servers that reject synthetic ids. The existing override (if any) is kept
 * underneath so a partial patch (a drag that only sets `start`) does not wipe
 * fields the occurrence already overrides, and `start`/`duration` are pinned
 * the way the server does it for synthetic-id updates.
 */
export function buildFallbackOverridePatch(
  instance: OccurrenceOverrideContext & Pick<CalendarEvent, 'duration'>,
  patch: Partial<CalendarEvent>,
): Partial<CalendarEvent> | null {
  const key = resolveOverrideKey(instance, instance.recurrenceOverrides);
  if (!key) return null;
  const existing = (instance.recurrenceOverrides?.[key] ?? {}) as Record<string, unknown>;
  const { updated: _updated, ...kept } = existing;
  return overrideEntryPatch(instance, key, {
    ...kept,
    start: instance.start,
    duration: instance.duration,
    ...buildOccurrencePatch(patch),
  });
}

/** Destroying one occurrence as an override on its base event: exclude it. */
export function buildFallbackExcludePatch(
  instance: OccurrenceOverrideContext,
): Partial<CalendarEvent> | null {
  const key = resolveOverrideKey(instance, instance.recurrenceOverrides);
  if (!key) return null;
  return overrideEntryPatch(instance, key, { excluded: true });
}

/**
 * What a new override copies from its occurrence, unless the change sets it
 * itself. Stalwart stores an override as a VEVENT holding only the override's
 * own properties, so without these the occurrence loses its title, place,
 * attendees and reminders - for other CalDAV clients as well as when Stalwart
 * expands it. `sequence` keeps the override from ranking below the series:
 * an override with a lower SEQUENCE does not replace its occurrence and
 * Stalwart then lists that occurrence twice (the organizer's server raises
 * the sequence of a changed override from this value).
 */
const NEW_OVERRIDE_COPIED_KEYS = [
  'title',
  'description',
  'descriptionContentType',
  'locations',
  'virtualLocations',
  'links',
  'keywords',
  'categories',
  'color',
  'locale',
  'status',
  'freeBusyStatus',
  'privacy',
  'alerts',
  'organizerCalendarAddress',
  'participants',
  'sequence',
] as const;

/**
 * `patch` plus the occurrence details a new override needs
 * (NEW_OVERRIDE_COPIED_KEYS). Nothing is added when the occurrence already
 * has an override - an attendee may not add most of these to the organizer's
 * - or when that is unknown.
 */
export function withNewOverrideDetails(
  occurrence: Partial<CalendarEvent>,
  patch: Partial<CalendarEvent>,
): Partial<CalendarEvent> {
  if (!createsOverride(occurrence)) return patch;
  const details: Record<string, unknown> = {};
  for (const name of NEW_OVERRIDE_COPIED_KEYS) {
    if (!(name in patch) && occurrence[name] != null) details[name] = occurrence[name];
  }
  return { ...details, ...patch };
}

/**
 * The patch that answers one occurrence as `participantId`.
 *
 * - The whole participants map, with only that participant's status changed.
 *   Stalwart rejects a `participants/<id>/participationStatus` pointer on a
 *   single occurrence ("Multiple organizers found in iCalendar object",
 *   0.16.23), and a pointer inside an override keeps just the patched
 *   participant, dropping the organizer and everyone else from it.
 * - The organizer: 0.16.19 rejects the override the same way without it.
 * - The sequence (see NEW_OVERRIDE_COPIED_KEYS).
 * - For a new override, the occurrence's details (`withNewOverrideDetails`).
 */
export function buildOccurrenceRsvpPatch(
  occurrence: Partial<CalendarEvent>,
  participantId: string,
  status: CalendarParticipant['participationStatus'],
): Partial<CalendarEvent> | null {
  const participant = occurrence.participants?.[participantId];
  if (!participant) return null;
  const patch: Record<string, unknown> = {};
  if (occurrence.sequence != null) patch.sequence = occurrence.sequence;
  if (occurrence.organizerCalendarAddress) {
    patch.organizerCalendarAddress = occurrence.organizerCalendarAddress;
  }
  patch.participants = {
    ...occurrence.participants,
    [participantId]: { ...participant, participationStatus: status },
  };
  return withNewOverrideDetails(occurrence, patch as Partial<CalendarEvent>);
}
