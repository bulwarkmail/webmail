import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CalendarEventUpdateOptions, IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarEvent, CalendarParticipant, CalendarParticipantIdentity, CalendarRights, CreateCalendarOptions } from '@/lib/jmap/types';
import { debug } from '@/lib/debug';
import { normalizeAllDayDuration } from '@/lib/calendar-utils';
import { displayNow } from '@/lib/timezone';
import { parseDuration } from '@/components/calendar/event-card';
import { sanitizeOutgoingCalendarEventData } from '@/lib/calendar-event-normalization';
import { expandRecurringEvents } from '@/lib/recurrence-expansion';
import { SchedulingDeniedError } from '@/lib/jmap/scheduling-error';
import {
  baseEventStoreId,
  buildFallbackExcludePatch,
  buildFallbackOverridePatch,
  buildOccurrencePatch,
  buildOccurrenceRsvpPatch,
  isBrowserExpandedOccurrence,
  withNewOverrideDetails,
  isServerRecurrenceInstance,
  isSyntheticIdMutationUnsupported,
} from '@/lib/recurrence-instances';
import { parseISO } from 'date-fns';
import { generateUUID } from '@/lib/utils';
import { apiFetch } from '@/lib/browser-navigation';
import { explainServerAuthError } from '@/lib/server-auth-status';
import { BIRTHDAY_CALENDAR_ID } from '@/lib/birthday-calendar';
import { getClientByLocalAccountId } from './client-registry';

/**
 * When the Pro shell aggregates calendars/events from every connected
 * account, the entity carries a `localAccountId` pointing back to the
 * owning JMAP client. Mutations need to use *that* client - the active
 * client (passed in by the page) could be on a different server entirely.
 * Falls back to the active client when `localAccountId` is unset or no
 * matching client is registered.
 *
 * Lookup goes through `client-registry` (not a direct auth-store import)
 * to avoid a top-level cycle: auth-store already imports this module to
 * bootstrap feature stores after login.
 */
function resolveAccountClient<T extends IJMAPClient>(active: T, localAccountId?: string): T {
  if (!localAccountId) return active;
  const lookup = getClientByLocalAccountId(localAccountId) as T | undefined;
  return lookup ?? active;
}

/**
 * Strip the local-account namespace prefix from an id (if present). Used
 * before passing ids back to a JMAP client, since the prefix only exists
 * to keep multi-account ids unique inside the client-side store.
 */
function stripLocalAccountPrefix(id: string, localAccountId?: string): string {
  if (!localAccountId) return id;
  const prefix = `${localAccountId}${CROSS_ACCOUNT_ID_DELIMITER}`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/** The raw identity of a store id, independent of any `<localAccountId>::` prefix. */
function rawIdentityOf(id: string): string {
  const idx = id.indexOf(CROSS_ACCOUNT_ID_DELIMITER);
  return idx >= 0 ? id.slice(idx + CROSS_ACCOUNT_ID_DELIMITER.length) : id;
}

/**
 * Where a mutation addressed at store id `id` has to go.
 *
 * Occurrences handed out by server-side recurrence expansion carry a
 * synthetic id (lib/recurrence-instances.ts). Addressed with scope
 * 'occurrence' they are written through that id - the server turns the patch
 * into a recurrence override - unless they are the single instance of a
 * non-recurring event, where the base event is the same thing and works on
 * every server version. Occurrences the browser expanded itself resolve to
 * their base event and, with scope 'occurrence', are written as a recurrence
 * override on it. Scope 'series' (an RSVP, a calendar move) always targets
 * the base event. A base event that is not in the store itself but has an
 * expanded occurrence in view (`baseEventStoreId`) borrows that occurrence's
 * account routing.
 */
interface MutationTarget {
  storeEvent?: CalendarEvent;
  realId: string;
  targetAccountId?: string;
  localAccountId?: string;
  /** True when `realId` is the synthetic id of one occurrence of a series. */
  isOccurrence: boolean;
  /** True when `storeEvent` is one occurrence the browser expanded and `realId` its base event. */
  isBrowserOccurrence?: boolean;
}

export function resolveMutationTarget(
  events: CalendarEvent[],
  id: string,
  scope: 'occurrence' | 'series',
): MutationTarget {
  const storeEvent = events.find(e => e.id === id);
  if (storeEvent) {
    const rawId = storeEvent.originalId || stripLocalAccountPrefix(id, storeEvent.localAccountId);
    const context = {
      storeEvent,
      targetAccountId: storeEvent.accountId,
      localAccountId: storeEvent.localAccountId,
    };
    if (isServerRecurrenceInstance(storeEvent) && storeEvent.baseEventId) {
      if (scope === 'series' || !storeEvent.recurrenceId) {
        return { ...context, realId: storeEvent.baseEventId, isOccurrence: false };
      }
      return { ...context, realId: rawId, isOccurrence: true };
    }
    if (scope === 'occurrence' && isBrowserExpandedOccurrence(storeEvent)) {
      return { ...context, realId: rawId, isOccurrence: false, isBrowserOccurrence: true };
    }
    return { ...context, realId: rawId, isOccurrence: false };
  }
  const instance = events.find(e => baseEventStoreId(e) === id);
  if (instance?.baseEventId) {
    return {
      realId: instance.baseEventId,
      targetAccountId: instance.accountId,
      localAccountId: instance.localAccountId,
      isOccurrence: false,
    };
  }
  return { realId: id, isOccurrence: false };
}

/** True when the store shows server-expanded occurrences of base event `baseId` on the given account. */
function hasExpandedOccurrencesOf(events: CalendarEvent[], baseId: string, target: MutationTarget): boolean {
  return events.some(e =>
    isServerRecurrenceInstance(e)
    && e.baseEventId === baseId
    && e.accountId === target.targetAccountId
    && e.localAccountId === target.localAccountId,
  );
}

// Clients whose CalendarEvent/set rejected a synthetic id: skip the doomed
// attempt and go straight to the base-event override for them.
const syntheticIdRejected = new WeakSet<object>();

/**
 * Patch one expanded occurrence through its synthetic id. A server that
 * predates synthetic-id writes rejects it; the same change is then written
 * as a recurrence override on the base event instead (the way Bulwark did it
 * before), and that client is remembered as needing the fallback. A change
 * that creates the override carries the occurrence's details along
 * (`withNewOverrideDetails`).
 */
async function updateOccurrence(
  client: IJMAPClient,
  instance: CalendarEvent,
  syntheticId: string,
  updates: Partial<CalendarEvent>,
  sendSchedulingMessages: boolean | undefined,
  targetAccountId: string | undefined,
): Promise<void> {
  const patch = withNewOverrideDetails(instance, buildOccurrencePatch(updates));
  const options: CalendarEventUpdateOptions | undefined = patch.sequence != null ? { keepSequence: true } : undefined;
  if (!syntheticIdRejected.has(client)) {
    try {
      await client.updateCalendarEvent(syntheticId, patch, sendSchedulingMessages, targetAccountId, options);
      return;
    } catch (error) {
      if (!isSyntheticIdMutationUnsupported(error)) throw error;
      syntheticIdRejected.add(client);
      debug.log('calendar', 'Server rejects synthetic ids; writing a recurrence override on the base event instead');
    }
  }
  const fallback = buildFallbackOverridePatch(instance, patch);
  if (!fallback || !instance.baseEventId) {
    throw new Error('Cannot resolve the occurrence to override');
  }
  await client.updateCalendarEvent(instance.baseEventId, fallback, sendSchedulingMessages, targetAccountId);
}

/** Destroy one expanded occurrence; falls back to excluding it on the base event like `updateOccurrence`. */
async function destroyOccurrence(
  client: IJMAPClient,
  instance: CalendarEvent,
  syntheticId: string,
  sendSchedulingMessages: boolean | undefined,
  targetAccountId: string | undefined,
): Promise<void> {
  if (!syntheticIdRejected.has(client)) {
    try {
      await client.deleteCalendarEvent(syntheticId, sendSchedulingMessages, targetAccountId);
      return;
    } catch (error) {
      if (!isSyntheticIdMutationUnsupported(error)) throw error;
      syntheticIdRejected.add(client);
      debug.log('calendar', 'Server rejects synthetic ids; excluding the occurrence on the base event instead');
    }
  }
  const fallback = buildFallbackExcludePatch(instance);
  if (!fallback || !instance.baseEventId) {
    throw new Error('Cannot resolve the occurrence to exclude');
  }
  await client.updateCalendarEvent(instance.baseEventId, fallback, sendSchedulingMessages, targetAccountId);
}

/**
 * Answer one occurrence of a series as `participantId`. The server stores it
 * as a recurrence override and sends the organizer an iTIP REPLY carrying
 * that occurrence's RECURRENCE-ID.
 */
async function rsvpOccurrence(
  client: IJMAPClient,
  target: MutationTarget,
  occurrence: CalendarEvent,
  participantId: string,
  status: CalendarParticipant['participationStatus'],
): Promise<void> {
  const patch = buildOccurrenceRsvpPatch(occurrence, participantId, status);
  if (!patch) throw new Error('Participant not found on this occurrence');
  if (target.isOccurrence) {
    await updateOccurrence(client, occurrence, target.realId, patch, true, target.targetAccountId);
    return;
  }
  await updateBrowserOccurrence(client, target, patch, true);
}

/**
 * Write a change to one occurrence the browser expanded as a recurrence
 * override on its base event (`target.realId`) - never as a change to the
 * base event itself, which would move or edit the whole series.
 */
async function updateBrowserOccurrence(
  client: IJMAPClient,
  target: MutationTarget,
  updates: Partial<CalendarEvent>,
  sendSchedulingMessages: boolean | undefined,
): Promise<void> {
  const occurrence = target.storeEvent!;
  const patch = buildFallbackOverridePatch(occurrence, withNewOverrideDetails(occurrence, updates));
  if (!patch) throw new Error('Cannot resolve the occurrence to override');
  await client.updateCalendarEvent(target.realId, patch, sendSchedulingMessages, target.targetAccountId);
}

/** Delete one occurrence the browser expanded by excluding it on its base event. */
async function destroyBrowserOccurrence(
  client: IJMAPClient,
  target: MutationTarget,
  sendSchedulingMessages: boolean | undefined,
): Promise<void> {
  const patch = buildFallbackExcludePatch(target.storeEvent!);
  if (!patch) throw new Error('Cannot resolve the occurrence to exclude');
  await client.updateCalendarEvent(target.realId, patch, sendSchedulingMessages, target.targetAccountId);
}

// Re-runs the most recent range fetch. Synthetic occurrence ids are
// positional and reshuffle whenever a series' overrides change, so after
// mutating an occurrence (or a base event with occurrences in view) the
// visible range is reloaded to pick up the new ids; the optimistic store
// update stays in place until then. Concurrent callers share one fetch.
let refetchVisibleRange: (() => Promise<void>) | null = null;
let refetchVisibleRangeInFlight: Promise<void> | null = null;

async function refetchAfterOccurrenceMutation(): Promise<void> {
  if (!refetchVisibleRange) return;
  if (!refetchVisibleRangeInFlight) {
    refetchVisibleRangeInFlight = refetchVisibleRange()
      .catch((error) => {
        debug.error('Failed to refresh events after an occurrence change:', error);
      })
      .finally(() => {
        refetchVisibleRangeInFlight = null;
      });
  }
  await refetchVisibleRangeInFlight;
}

/**
 * Reconcile persisted selectedCalendarIds against a freshly fetched calendars
 * list. A selected id can be stale in id-*form* (not existence): the raw->
 * namespaced transition (aggregation switched on, an account switch, or a
 * just-created calendar added with its raw id) changes the id string while the
 * calendar is the same. Remap by raw identity so the selection survives instead
 * of silently resetting to "all". Keeps BIRTHDAY_CALENDAR_ID; drops ids that
 * resolve to no calendar.
 */
export function reconcileSelectedIds(selectedCalendarIds: string[], calendars: Calendar[]): string[] {
  const byStoreId = new Set(calendars.map((c) => c.id));
  const rawToStoreId = new Map<string, string>();
  for (const c of calendars) {
    const raw = c.originalId ?? stripLocalAccountPrefix(c.id, c.localAccountId);
    if (!rawToStoreId.has(raw)) rawToStoreId.set(raw, c.id);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of selectedCalendarIds) {
    let mapped: string | undefined;
    if (id === BIRTHDAY_CALENDAR_ID || byStoreId.has(id)) mapped = id;
    else mapped = rawToStoreId.get(rawIdentityOf(id));
    if (mapped && !seen.has(mapped)) {
      out.push(mapped);
      seen.add(mapped);
    }
  }
  return out;
}

// In-flight refresh dedup. Concurrent callers (auto-interval +
// manual refresh, two account-switch reloads, etc.) share the same
// promise instead of double-fetching and racing the diff/import phase.
const refreshInFlight = new Map<string, Promise<void>>();

export type CalendarViewMode = 'month' | 'week' | 'day' | 'agenda' | 'tasks';

const CALENDAR_VIEW_MODES: CalendarViewMode[] = ['month', 'week', 'day', 'agenda', 'tasks'];

export function isCalendarViewMode(value: unknown): value is CalendarViewMode {
  return typeof value === 'string' && CALENDAR_VIEW_MODES.includes(value as CalendarViewMode);
}

/**
 * Prefix used to namespace calendar/event IDs when the Pro shell aggregates
 * across accounts. EVERY aggregated account is namespaced (including the active
 * one) so an id stably identifies (account, entity) regardless of which account
 * is active - otherwise switching accounts flipped the id form. Single-account
 * (non-aggregated) code paths carry no localAccountId and keep raw ids.
 */
const CROSS_ACCOUNT_ID_DELIMITER = '::';

function buildCrossAccountIdPrefix(localAccountId: string): string {
  return `${localAccountId}${CROSS_ACCOUNT_ID_DELIMITER}`;
}

// EVERY aggregated account is namespaced, including the active one. Leaving the
// active account's IDs raw made an entity's ID depend on *which* account is
// active, so switching accounts flipped the ID form and invalidated persisted
// references (selectedCalendarIds, colors, subscriptions) - the account-switch
// bug. The invariant is now: an entity is namespaced iff it carries a
// `localAccountId`; `originalId` always holds the raw JMAP ID. Mutation/consumer
// code already resolves the raw ID via `originalId || stripLocalAccountPrefix`,
// so it keeps working unchanged.
function prefixCalendarsWithLocalAccount(
  calendars: Calendar[],
  localAccountId: string,
): Calendar[] {
  const prefix = buildCrossAccountIdPrefix(localAccountId);
  // Preserve each calendar's original `isShared` flag - it distinguishes
  // the user's own calendars on the other account from calendars shared
  // *into* that account by yet another user. The sidebar uses this split
  // to render "My Calendars" vs "Shared" sub-sections per account.
  return calendars.map((cal) => ({
    ...cal,
    id: `${prefix}${cal.id}`,
    originalId: cal.originalId ?? cal.id,
    localAccountId,
  }));
}

function prefixEventsWithLocalAccount(
  events: CalendarEvent[],
  localAccountId: string,
): CalendarEvent[] {
  const prefix = buildCrossAccountIdPrefix(localAccountId);
  return events.map((event) => ({
    ...event,
    id: `${prefix}${event.id}`,
    originalId: event.originalId ?? event.id,
    localAccountId,
    calendarIds: event.calendarIds
      ? Object.fromEntries(
          Object.entries(event.calendarIds).map(([calId, v]) => [`${prefix}${calId}`, v]),
        )
      : event.calendarIds,
  }));
}

function mapCalendarIdsToStoreIds(
  calendarIds: Record<string, boolean> | undefined,
  calendars: Calendar[],
  targetAccountId?: string
): Record<string, boolean> | undefined {
  if (!calendarIds) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(calendarIds).map(([calendarId, included]) => {
      const matchedCalendar = calendars.find((calendar) =>
        (calendar.originalId || calendar.id) === calendarId
        && (!targetAccountId || calendar.accountId === targetAccountId)
      );

      return [matchedCalendar?.id || calendarId, included];
    })
  );
}

function mapServerEventToStoreEvent(
  event: CalendarEvent,
  calendars: Calendar[],
  targetAccountId?: string
): CalendarEvent {
  const mappedCalendarIds = mapCalendarIdsToStoreIds(event.calendarIds, calendars, targetAccountId) || event.calendarIds;
  const matchedCalendar = Object.keys(event.calendarIds || {})
    .map((calendarId) => calendars.find((calendar) =>
      (calendar.originalId || calendar.id) === calendarId
      && (!targetAccountId || calendar.accountId === targetAccountId)
    ))
    .find((calendar): calendar is Calendar => Boolean(calendar));
  const resolvedAccountId = matchedCalendar?.accountId || targetAccountId;
  const isShared = matchedCalendar?.isShared || false;
  // Namespace the event id with the owning account when the store is aggregated
  // (the matched calendar carries a localAccountId). `calendarIds` are already
  // mapped to store ids above; `originalId` keeps the raw id for mutations.
  const localAccountId = matchedCalendar?.localAccountId;
  const baseId = isShared && resolvedAccountId ? `${resolvedAccountId}:${event.id}` : event.id;

  return {
    ...event,
    id: localAccountId ? `${localAccountId}${CROSS_ACCOUNT_ID_DELIMITER}${baseId}` : baseId,
    originalId: event.id,
    originalCalendarIds: event.calendarIds,
    calendarIds: mappedCalendarIds,
    accountId: resolvedAccountId,
    accountName: matchedCalendar?.accountName,
    localAccountId,
    isShared,
  };
}

function getStoreEventDebugSnapshot(event: Partial<CalendarEvent> | null | undefined): Record<string, unknown> | null {
  if (!event) {
    return null;
  }

  return {
    id: event.id,
    originalId: event.originalId,
    uid: event.uid,
    title: event.title,
    start: event.start,
    duration: event.duration,
    timeZone: event.timeZone,
    showWithoutTime: event.showWithoutTime,
    utcStart: event.utcStart,
    utcEnd: event.utcEnd,
    calendarIds: event.calendarIds,
    originalCalendarIds: event.originalCalendarIds,
    accountId: event.accountId,
    accountName: event.accountName,
    isShared: event.isShared,
    created: event.created,
    updated: event.updated,
  };
}

/** Identifies the login a subscription belongs to: server plus login name. */
export function subscriptionOwner(client: Pick<IJMAPClient, 'getServerUrl' | 'getUsername'>): string {
  return `${client.getServerUrl().replace(/\/+$/, '').toLowerCase()}|${client.getUsername().toLowerCase()}`;
}

type CalendarStoreSet = (partial: Partial<CalendarStore> | ((state: CalendarStore) => Partial<CalendarStore>)) => void;

/**
 * Whether `client` may act on `sub`: refresh it (a destructive diff of the
 * calendar's events), rename or delete its calendar. A subscription owned
 * by this login may. One with another owner may not. One without an owner
 * (created before owners were recorded) is adopted only when its calendar
 * id and name both exist in this account - a bare id match would name an
 * unrelated calendar in another account or on another server.
 */
async function claimSubscription(client: IJMAPClient, sub: ICalSubscription, set: CalendarStoreSet): Promise<boolean> {
  const owner = subscriptionOwner(client);
  if (sub.owner) return sub.owner === owner;
  if (sub.accountId && sub.accountId !== client.getAccountId()) return false;
  let calendars: Calendar[];
  try {
    calendars = await client.getCalendars();
  } catch {
    return false;
  }
  const found = calendars.some((c) => (c.originalId ?? c.id) === sub.calendarId && c.name === sub.name);
  if (!found) return false;
  set((state) => ({
    icalSubscriptions: state.icalSubscriptions.map((s) => (s.id === sub.id ? { ...s, owner } : s)),
  }));
  return true;
}

export interface ICalSubscription {
  id: string;
  url: string;
  calendarId: string;
  // The JMAP account this subscription belongs to. Optional for back-
  // compat with subs persisted before multi-account scoping landed -
  // legacy entries with no accountId are shown only in whichever account
  // the user has active (treated as floating). New subs always set it.
  accountId?: string;
  /**
   * The login that owns the subscription (subscriptionOwner()). A JMAP
   * account id alone is not unique - two servers hand out the same small
   * ids - so a subscription is only refreshed or removed through the login
   * it was created with. Missing on subscriptions created before this was
   * recorded; those are adopted once their calendar is found in the account.
   */
  owner?: string;
  name: string;
  color: string;
  refreshInterval: number; // minutes
  lastRefreshed: string | null;
}

/**
 * One connected JMAP account. When the Pro shell aggregates calendars from
 * every logged-in account, the page hands the calendar store a list of
 * these so we can fetch + tag each account's data with its local app-store
 * accountId (used to route mutations back to the right client).
 */
export interface CalendarAccountClient {
  localAccountId: string;
  client: IJMAPClient;
}

export interface FetchEventsOptions {
  /** Reload without flipping `isLoadingEvents` (background refresh after a mutation). */
  silent?: boolean;
}

interface CalendarStore {
  calendars: Calendar[];
  events: CalendarEvent[];
  selectedDate: Date;
  viewMode: CalendarViewMode;
  selectedCalendarIds: string[];
  selectedEventId: string | null;
  isLoading: boolean;
  isLoadingEvents: boolean;
  supportsCalendar: boolean;
  error: string | null;
  dateRange: { start: string; end: string } | null;
  // The user's ParticipantIdentity list (calendar addresses to organise
  // as); the default one is used as organizer of new invitations.
  participantIdentities: CalendarParticipantIdentity[];
  fetchParticipantIdentities: (client: IJMAPClient) => Promise<void>;
  setDefaultParticipantIdentity: (client: IJMAPClient, id: string) => Promise<void>;

  setSupported: (supported: boolean) => void;
  fetchCalendars: (client: IJMAPClient) => Promise<void>;
  fetchEvents: (client: IJMAPClient, start: string, end: string, options?: FetchEventsOptions) => Promise<void>;
  fetchAllAccountsCalendars: (accounts: CalendarAccountClient[]) => Promise<void>;
  fetchAllAccountsEvents: (accounts: CalendarAccountClient[], start: string, end: string, options?: FetchEventsOptions) => Promise<void>;
  createEvent: (client: IJMAPClient, event: Partial<CalendarEvent>, sendSchedulingMessages?: boolean) => Promise<CalendarEvent | null>;
  updateEvent: (client: IJMAPClient, id: string, updates: Partial<CalendarEvent>, sendSchedulingMessages?: boolean) => Promise<void>;
  deleteEvent: (client: IJMAPClient, id: string, sendSchedulingMessages?: boolean) => Promise<void>;
  rsvpEvent: (client: IJMAPClient, eventId: string, participantId: string, status: string, replyTo?: Record<string, string> | null, scope?: 'occurrence' | 'series') => Promise<void>;
  importEvents: (client: IJMAPClient, events: Partial<CalendarEvent>[], calendarId: string) => Promise<number>;
  updateCalendar: (client: IJMAPClient, calendarId: string, updates: Partial<Calendar>) => Promise<void>;
  setDefaultCalendar: (client: IJMAPClient, calendarId: string) => Promise<void>;
  shareCalendar: (client: IJMAPClient, calendarId: string, principalId: string, rights: CalendarRights | null) => Promise<void>;
  createCalendar: (client: IJMAPClient, calendar: Partial<Calendar>, options?: CreateCalendarOptions) => Promise<Calendar | null>;
  removeCalendar: (client: IJMAPClient, calendarId: string) => Promise<void>;
  clearCalendarEvents: (client: IJMAPClient, calendarId: string) => Promise<number>;
  setSelectedDate: (date: Date) => void;
  setViewMode: (mode: CalendarViewMode) => void;
  toggleCalendarVisibility: (calendarId: string) => void;
  setSelectedEventId: (id: string | null) => void;
  clearState: () => void;

  // iCal subscriptions
  icalSubscriptions: ICalSubscription[];
  addICalSubscription: (client: IJMAPClient, url: string, name: string, color: string, refreshInterval?: number) => Promise<ICalSubscription | null>;
  updateICalSubscription: (client: IJMAPClient, subscriptionId: string, updates: { url?: string; name?: string; color?: string; refreshInterval?: number }) => Promise<void>;
  removeICalSubscription: (client: IJMAPClient, subscriptionId: string) => Promise<void>;
  refreshICalSubscription: (client: IJMAPClient, subscriptionId: string) => Promise<void>;
  /** Drop every subscription of a signed-out login (its feed URLs are secrets). */
  forgetICalSubscriptions: (owner: string) => void;
  /** Drop all subscriptions, e.g. once nobody is signed in any more. */
  clearICalSubscriptions: () => void;
  refreshAllSubscriptions: (client: IJMAPClient) => Promise<void>;
  isSubscriptionCalendar: (calendarId: string) => boolean;
}

const initialState = {
  calendars: [],
  events: [],
  selectedDate: displayNow(),
  selectedCalendarIds: [] as string[],
  selectedEventId: null as string | null,
  isLoading: false,
  isLoadingEvents: false,
  supportsCalendar: false,
  participantIdentities: [],
  error: null as string | null,
  dateRange: null as { start: string; end: string } | null,
  icalSubscriptions: [] as ICalSubscription[],
};

function getSafeCalendarViewMode(value: unknown): CalendarViewMode {
  return isCalendarViewMode(value) ? value : 'month';
}

export const useCalendarStore = create<CalendarStore>()(
  persist(
    (set, get) => ({
      ...initialState,
      viewMode: 'month' as CalendarViewMode,

      setSupported: (supported) => set({ supportsCalendar: supported }),

      fetchParticipantIdentities: async (client) => {
        if (!client.getParticipantIdentities) return;
        try {
          set({ participantIdentities: await client.getParticipantIdentities() });
        } catch (error) {
          // Servers without ParticipantIdentity (pre-draft) reject the method;
          // the organizer then falls back to the login addresses.
          debug.log('calendar', 'ParticipantIdentity/get unavailable:', error);
        }
      },

      setDefaultParticipantIdentity: async (client, id) => {
        if (!client.setDefaultParticipantIdentity) return;
        await client.setDefaultParticipantIdentity(id);
        set((state) => ({
          participantIdentities: state.participantIdentities.map((i) => ({ ...i, isDefault: i.id === id })),
        }));
      },

      fetchCalendars: async (client) => {
        set({ isLoading: true, error: null });
        // Identities are independent of the calendar list; load them
        // alongside without blocking the grid.
        void get().fetchParticipantIdentities(client);
        try {
          const calendars = await client.getAllCalendars();
          const { selectedCalendarIds } = get();
          const stillValid = reconcileSelectedIds(selectedCalendarIds, calendars);
          // Default the visible selection to event calendars only - tasks-only
          // calendars stay out of the event grid.
          const defaultSelected = calendars.filter(c => !c.isTasksOnly).map(c => c.id);
          set({
            calendars,
            isLoading: false,
            selectedCalendarIds: stillValid.length > 0 ? stillValid : defaultSelected,
          });
        } catch (error) {
          debug.error('Failed to fetch calendars:', error);
          set({ error: 'Failed to load calendars', isLoading: false });
        }
      },

      fetchEvents: async (client, start, end, options) => {
        refetchVisibleRange = () => get().fetchEvents(client, start, end, { silent: true });
        set(options?.silent ? { error: null } : { isLoadingEvents: true, error: null });
        try {
          const rawEvents = await client.queryAllCalendarEvents({
            after: start,
            before: end,
          });
          // Filter out malformed events missing required 'start' field, or
          // whose start string fails to parse (would otherwise crash format()
          // calls in the rendering path - #316).
          const validEvents = rawEvents.filter(e =>
            typeof e.start === 'string' && e.start && !isNaN(parseISO(e.start).getTime())
          );
          const droppedEvents = rawEvents.length - validEvents.length;
          // Expand recurring series that came back unexpanded - from a server
          // without synthetic-id support (lib/recurrence-instances.ts) or one
          // that ignores expandRecurrences. Occurrences the server already
          // expanded pass through untouched.
          const events = expandRecurringEvents(validEvents, start, end);
          debug.log('calendar', 'Calendar fetchEvents completed', {
            start,
            end,
            rawCount: rawEvents.length,
            validCount: validEvents.length,
            expandedCount: events.length,
            droppedEvents,
          });
          if (droppedEvents > 0) {
            debug.warn('calendar', 'Calendar fetchEvents dropped malformed events without a start field', { droppedEvents });
          }
          set({ events, isLoadingEvents: false, dateRange: { start, end } });
        } catch (error) {
          debug.error('Failed to fetch events:', error);
          set({ error: 'Failed to load events', isLoadingEvents: false });
        }
      },

      fetchAllAccountsCalendars: async (accounts) => {
        set({ isLoading: true, error: null });
        try {
          const results = await Promise.all(
            accounts.map(async ({ client, localAccountId }) => {
              try {
                const list = await client.getAllCalendars();
                return prefixCalendarsWithLocalAccount(list, localAccountId);
              } catch (error) {
                debug.error(`Failed to fetch calendars for account ${localAccountId}:`, error);
                return [] as Calendar[];
              }
            }),
          );
          const calendars = results.flat();
          const { selectedCalendarIds } = get();
          const stillValid = reconcileSelectedIds(selectedCalendarIds, calendars);
          set({
            calendars,
            isLoading: false,
            selectedCalendarIds: stillValid.length > 0 ? stillValid : calendars.map(c => c.id),
          });
        } catch (error) {
          debug.error('Failed to fetch all-account calendars:', error);
          set({ error: 'Failed to load calendars', isLoading: false });
        }
      },

      fetchAllAccountsEvents: async (accounts, start, end, options) => {
        refetchVisibleRange = () => get().fetchAllAccountsEvents(accounts, start, end, { silent: true });
        set(options?.silent ? { error: null } : { isLoadingEvents: true, error: null });
        try {
          const results = await Promise.all(
            accounts.map(async ({ client, localAccountId }) => {
              try {
                const raw = await client.queryAllCalendarEvents({ after: start, before: end });
                const valid = raw.filter(e =>
                  typeof e.start === 'string' && e.start && !isNaN(parseISO(e.start).getTime())
                );
                const expanded = expandRecurringEvents(valid, start, end);
                return prefixEventsWithLocalAccount(expanded, localAccountId);
              } catch (error) {
                debug.error(`Failed to fetch events for account ${localAccountId}:`, error);
                return [] as CalendarEvent[];
              }
            }),
          );
          set({ events: results.flat(), isLoadingEvents: false, dateRange: { start, end } });
        } catch (error) {
          debug.error('Failed to fetch all-account events:', error);
          set({ error: 'Failed to load events', isLoadingEvents: false });
        }
      },

      createEvent: async (client, event, sendSchedulingMessages) => {
        set({ error: null });
        try {
          // Resolve shared calendar context from calendarIds. Also pin the
          // local account from the calendar so we route through that
          // server's client when in multi-account Pro mode.
          let targetAccountId = event.accountId;
          let localAccountId = event.localAccountId;
          const cleanEvent = sanitizeOutgoingCalendarEventData({ ...event });
          if (event.calendarIds) {
            const remapped: Record<string, boolean> = {};
            for (const calId of Object.keys(event.calendarIds)) {
              const cal = get().calendars.find(c => c.id === calId);
              if (cal?.localAccountId) localAccountId = cal.localAccountId;
              if (cal?.isShared && cal.originalId) {
                targetAccountId = cal.accountId;
                remapped[cal.originalId] = true;
              } else if (cal?.originalId) {
                remapped[cal.originalId] = true;
              } else {
                remapped[calId] = true;
              }
            }
            cleanEvent.calendarIds = remapped;
          }
          client = resolveAccountClient(client, localAccountId);
          if (event.originalCalendarIds) {
            cleanEvent.calendarIds = event.originalCalendarIds;
          }
          debug.log('calendar', 'Calendar createEvent request', {
            event: getStoreEventDebugSnapshot(cleanEvent),
            sendSchedulingMessages,
            targetAccountId,
            requestedCalendarIds: event.calendarIds,
            serverCalendarIds: cleanEvent.calendarIds,
            currentDateRange: get().dateRange,
            selectedCalendarIds: get().selectedCalendarIds,
          });
          const created = await client.createCalendarEvent(cleanEvent, sendSchedulingMessages, targetAccountId);
          const mappedCreated = mapServerEventToStoreEvent(created, get().calendars, targetAccountId);
          const selectedCalendarIds = get().selectedCalendarIds;
          const createdCalendarIds = Object.keys(mappedCreated.calendarIds || {});
          const isVisible = createdCalendarIds.some((calendarId) => selectedCalendarIds.includes(calendarId));
          const currentDateRange = get().dateRange;
          const inCurrentDateRange = currentDateRange
            ? mappedCreated.start >= currentDateRange.start && mappedCreated.start <= currentDateRange.end
            : null;

          debug.log('calendar', 'Calendar createEvent response', {
            created: getStoreEventDebugSnapshot(created),
            mappedCreated: getStoreEventDebugSnapshot(mappedCreated),
            isVisible,
            currentDateRange,
            inCurrentDateRange,
          });

          if (!isVisible) {
            debug.warn('calendar', 'Created event is hidden by current calendar filters', {
              selectedCalendarIds,
              createdCalendarIds,
            });
          }

          if (inCurrentDateRange === false) {
            debug.warn('calendar', 'Created event is outside the currently loaded date range', {
              currentDateRange,
              createdStart: mappedCreated.start,
            });
          }

          if (mappedCreated.showWithoutTime && mappedCreated.timeZone !== null) {
            debug.warn('calendar', 'Created all-day event came back with a non-null timeZone', {
              timeZone: mappedCreated.timeZone,
              event: getStoreEventDebugSnapshot(mappedCreated),
            });
          }

          set((state) => ({ events: [...state.events, mappedCreated] }));
          // Invitation emails are sent by the server: `sendSchedulingMessages`
          // on CalendarEvent/set makes Stalwart queue the iTIP REQUEST itself.
          // Sending a client-side iMIP copy here produced duplicate emails.
          return mappedCreated;
        } catch (error) {
          debug.error('Failed to create event:', error);
          set({ error: 'Failed to create event' });
          // The caller can offer to save it without the invitations.
          if (error instanceof SchedulingDeniedError) throw error;
          return null;
        }
      },

      updateEvent: async (client, id, updates, sendSchedulingMessages) => {
        set({ error: null });
        try {
          // Resolve shared event IDs and client-side expanded occurrence IDs
          const target = resolveMutationTarget(get().events, id, 'occurrence');
          const { storeEvent, realId, targetAccountId } = target;
          client = resolveAccountClient(client, target.localAccountId);
          debug.log('calendar', 'Calendar updateEvent', {
            storeId: id,
            realId,
            isOccurrence: target.isOccurrence,
            uid: storeEvent?.uid,
            recurrenceId: storeEvent?.recurrenceId,
            targetAccountId,
            updateKeys: Object.keys(updates),
          });
          // Remap namespaced calendarIds back to original IDs
          const cleanUpdates = sanitizeOutgoingCalendarEventData({ ...updates });
          if (cleanUpdates.calendarIds) {
            const remapped: Record<string, boolean> = {};
            for (const [calId, v] of Object.entries(cleanUpdates.calendarIds)) {
              const cal = get().calendars.find(c => c.id === calId);
              remapped[cal?.originalId || calId] = v;
            }
            cleanUpdates.calendarIds = remapped;
          }
          if (target.isOccurrence && storeEvent) {
            await updateOccurrence(client, storeEvent, realId, cleanUpdates, sendSchedulingMessages, targetAccountId);
          } else if (target.isBrowserOccurrence) {
            await updateBrowserOccurrence(client, target, cleanUpdates, sendSchedulingMessages);
          } else {
            await client.updateCalendarEvent(realId, cleanUpdates, sendSchedulingMessages, targetAccountId);
          }
          set((state) => ({
            events: state.events.map(e => {
              if (e.id !== id) return e;
              const merged = { ...e, ...cleanUpdates };
              // When start changes, shift utcStart/utcEnd by the same delta so the
              // event renders at the new position immediately (optimistic update).
              if (cleanUpdates.start && e.start && e.utcStart) {
                const oldStart = new Date(e.start).getTime();
                const newStart = new Date(cleanUpdates.start).getTime();
                const delta = newStart - oldStart;
                if (delta !== 0) {
                  merged.utcStart = new Date(new Date(e.utcStart).getTime() + delta).toISOString();
                  if (e.utcEnd) {
                    merged.utcEnd = new Date(new Date(e.utcEnd).getTime() + delta).toISOString();
                  }
                }
              }
              // When duration changes (e.g. resize), recompute utcEnd so the event
              // renders with the new length immediately without waiting for refresh.
              if (cleanUpdates.duration !== undefined && merged.utcStart) {
                const durationMinutes = parseDuration(cleanUpdates.duration);
                merged.utcEnd = new Date(
                  new Date(merged.utcStart).getTime() + durationMinutes * 60000,
                ).toISOString();
              }
              return merged;
            }),
          }));
          if (target.isOccurrence || target.isBrowserOccurrence || hasExpandedOccurrencesOf(get().events, realId, target)) {
            await refetchAfterOccurrenceMutation();
          }
          // Update emails (iTIP REQUEST/REPLY) are sent by the server via the
          // `sendSchedulingMessages` argument already passed above - a manual
          // iMIP send here produced duplicate emails.
        } catch (error) {
          debug.error('Failed to update event:', error);
          set({ error: 'Failed to update event' });
          throw error;
        }
      },

      rsvpEvent: async (client, eventId, participantId, status, replyTo, scope = 'series') => {
        set({ error: null });
        // JMAP participant IDs are opaque strings - they can contain @, ., :,
        // / etc. The id is RFC 6901-escaped below before being embedded in the
        // patch pointer, so any character is safe; only reject empty values.
        if (!participantId) {
          set({ error: 'Invalid participant ID' });
          throw new Error('Invalid participant ID');
        }
        try {
          // Resolve shared event IDs and client-side expanded occurrence IDs.
          // Scope 'series' answers for the whole series, so an expanded
          // occurrence is resolved to its base event here; scope 'occurrence'
          // answers for that one occurrence only.
          const target = resolveMutationTarget(get().events, eventId, scope);
          const { storeEvent, realId, targetAccountId, localAccountId } = target;
          client = resolveAccountClient(client, localAccountId);
          const occurrence = target.isOccurrence || target.isBrowserOccurrence ? storeEvent ?? null : null;
          if (occurrence) {
            await rsvpOccurrence(
              client, target, occurrence, participantId,
              status as CalendarParticipant['participationStatus'],
            );
          } else {
            // Escape per RFC 6901 (JSON Pointer): ~ → ~0, / → ~1
            const escapedId = participantId.replace(/~/g, '~0').replace(/\//g, '~1');
            const patchKey = `participants/${escapedId}/participationStatus`;
            const patch: Record<string, unknown> = { [patchKey]: status };
            // Stalwart routes the iTIP REPLY to the stored ORGANIZER
            // (organizerCalendarAddress); the RFC 8984 replyTo property is retired
            // in jscalendarbis and ignored. Repair events that are missing the
            // organizer (e.g. imported ones), but never touch an existing one -
            // attendees may not modify the ORGANIZER.
            if (replyTo?.imip && storeEvent && !storeEvent.organizerCalendarAddress) {
              patch.organizerCalendarAddress = replyTo.imip;
            }
            await client.updateCalendarEvent(
              realId,
              patch as unknown as Partial<CalendarEvent>,
              true,
              targetAccountId
            );
          }
          set((state) => ({
            events: state.events.map(e => {
              if (e.id !== eventId || !e.participants?.[participantId]) return e;
              return {
                ...e,
                participants: {
                  ...e.participants,
                  [participantId]: { ...e.participants[participantId], participationStatus: status as CalendarParticipant['participationStatus'] },
                },
              };
            }),
          }));
          // Only the answered event was updated above: after a series answer
          // the other occurrences in view still show the old status, after an
          // occurrence answer the synthetic ids / overrides are stale.
          if (occurrence || storeEvent?.recurrenceId || hasExpandedOccurrencesOf(get().events, realId, target)) {
            await refetchAfterOccurrenceMutation();
          }
        } catch (error) {
          debug.error('Failed to RSVP:', error);
          set({ error: 'Failed to update RSVP' });
          throw error;
        }
      },

      importEvents: async (client, events, calendarId) => {
        // Resolve shared calendar IDs
        const cal = get().calendars.find(c => c.id === calendarId);
        const realCalendarId = cal?.originalId || stripLocalAccountPrefix(calendarId, cal?.localAccountId);
        const targetAccountId = cal?.accountId;
        client = resolveAccountClient(client, cal?.localAccountId);

        // Drop within-file UID duplicates first (first occurrence wins).
        // CalendarEvent/parse already merges master + RECURRENCE-ID overrides
        // into one object, so anything still sharing a UID here is a corrupt
        // feed - creating both either fails ("UID already exists") or stores
        // two events under one UID, depending on the Stalwart version.
        const seenUids = new Set<string>();
        let eventsToProcess = events.filter((e) => {
          if (!e.uid) return true;
          if (seenUids.has(e.uid)) return false;
          seenUids.add(e.uid);
          return true;
        });

        // Deduplicate UIDs: Stalwart enforces UID uniqueness across all calendars.
        // - Events already in the target calendar → skip (true duplicates)
        // - Events in other calendars → link to target calendar via calendarIds update
        // - New events → create as normal
        let linked = 0;
        try {
          const allServerEvents = await client.getCalendarEvents(undefined, targetAccountId);
          const uidToEvent = new Map<string, { id: string; calendarIds: Record<string, boolean> }>();
          for (const e of allServerEvents) {
            if (e.uid) {
              uidToEvent.set(e.uid, {
                id: (e as CalendarEvent).originalId || e.id,
                calendarIds: (e as CalendarEvent).originalCalendarIds || e.calendarIds || {},
              });
            }
          }

          const newEvents: Partial<CalendarEvent>[] = [];
          const eventsToLink: { eventId: string; calendarIds: Record<string, boolean> }[] = [];

          for (const e of eventsToProcess) {
            if (!e.uid || !uidToEvent.has(e.uid)) {
              // UID doesn't exist on server - create it
              newEvents.push(e);
            } else {
              const existing = uidToEvent.get(e.uid)!;
              if (existing.calendarIds[realCalendarId]) {
                // Already in target calendar - skip
                continue;
              }
              // Exists in another calendar - link to target calendar
              eventsToLink.push({
                eventId: existing.id,
                calendarIds: { ...existing.calendarIds, [realCalendarId]: true },
              });
            }
          }

          // Batch-link existing events to the target calendar
          for (const { eventId, calendarIds } of eventsToLink) {
            try {
              await client.updateCalendarEvent(eventId, { calendarIds } as Partial<CalendarEvent>, undefined, targetAccountId);
              linked++;
            } catch (err) {
              debug.warn('calendar', `Import: failed to link event ${eventId} to target calendar:`, err);
            }
          }

          if (linked > 0) {
            debug.log('calendar', `Import: linked ${linked} existing events to target calendar`);
          }
          const skipped = eventsToProcess.length - newEvents.length - eventsToLink.length;
          if (skipped > 0) {
            debug.log('calendar', `Import: skipped ${skipped} events already in target calendar`);
          }
          eventsToProcess = newEvents;
        } catch (error) {
          debug.warn('calendar', 'Could not fetch existing events for deduplication, proceeding without:', error);
        }

        // Prepare all events for batch creation
        const prepared: Partial<CalendarEvent>[] = [];
        for (const event of eventsToProcess) {
          const src = sanitizeOutgoingCalendarEventData(event as Partial<CalendarEvent>);
          let cleanParticipants: Record<string, CalendarParticipant> | null = null;
          if (src.participants) {
            cleanParticipants = {};
            for (const [key, p] of Object.entries(src.participants)) {
              const participant: Record<string, unknown> = {
                '@type': 'Participant',
                name: p.name,
                email: p.email,
                // calendarAddress carries the scheduling address in jscalendarbis
                // (Stalwart); sendTo is retired there, so it only serves as a
                // fallback source for events parsed from legacy RFC 8984 data.
                calendarAddress: p.calendarAddress || p.sendTo?.imip,
                description: p.description,
                kind: p.kind,
                roles: p.roles,
                participationStatus: p.participationStatus,
                participationComment: p.participationComment,
                expectReply: p.expectReply,
                scheduleAgent: p.scheduleAgent,
                scheduleForceSend: p.scheduleForceSend,
                scheduleId: p.scheduleId,
                delegatedTo: p.delegatedTo,
                delegatedFrom: p.delegatedFrom,
                memberOf: p.memberOf,
                locationId: p.locationId,
                language: p.language,
                links: p.links,
              };
              Object.keys(participant).forEach(k => {
                if (participant[k] === undefined || participant[k] === null) delete participant[k];
              });
              cleanParticipants[key] = participant as unknown as CalendarParticipant;
            }
          }

          const data: Partial<CalendarEvent> = {
            calendarIds: { [realCalendarId]: true },
            uid: src.uid,
            title: src.title,
            description: src.description,
            descriptionContentType: src.descriptionContentType,
            start: src.start,
            duration: src.showWithoutTime ? normalizeAllDayDuration(src.duration) : src.duration,
            timeZone: src.showWithoutTime ? null : src.timeZone,
            showWithoutTime: src.showWithoutTime,
            status: src.status,
            freeBusyStatus: src.freeBusyStatus,
            privacy: src.privacy,
            color: src.color,
            keywords: src.keywords,
            categories: src.categories,
            locale: src.locale,
            // Stalwart derives the iCalendar ORGANIZER solely from
            // organizerCalendarAddress (replyTo is retired in jscalendarbis);
            // dropping it here would strip the ORGANIZER from imported invites
            // and break RSVP replies afterwards.
            organizerCalendarAddress: src.organizerCalendarAddress || src.replyTo?.imip,
            locations: src.locations,
            virtualLocations: src.virtualLocations,
            links: src.links,
            recurrenceRules: src.recurrenceRules,
            recurrenceOverrides: src.recurrenceOverrides,
            excludedRecurrenceRules: src.excludedRecurrenceRules,
            alerts: src.alerts,
            participants: cleanParticipants,
          };
          Object.keys(data).forEach(k => {
            const v = (data as Record<string, unknown>)[k];
            if (v === undefined || v === null) delete (data as Record<string, unknown>)[k];
          });
          prepared.push(data);
        }

        if (prepared.length === 0) return linked;

        // Batch create in chunks of 50 to avoid oversized requests
        const BATCH_SIZE = 50;
        let imported = 0;
        for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
          const batch = prepared.slice(i, i + BATCH_SIZE);
          try {
            const { created, failed, notCreated } = await client.batchCreateCalendarEvents(batch, targetAccountId);
            imported += created.length;
            if (failed.length > 0) {
              const first = Object.values(notCreated)[0];
              const reason = first?.description || first?.type || 'unknown error';
              debug.warn('calendar', `Import batch ${i / BATCH_SIZE + 1}: ${failed.length} events failed (${reason})`);
              set({ error: `${failed.length} event(s) could not be imported: ${reason}` });
            }
          } catch (error) {
            debug.error(`Import batch ${i / BATCH_SIZE + 1} failed:`, error);
          }
        }

        // Re-fetch all events properly so the store state is consistent
        // (with recurrence expansion, multi-account mapping, etc.)
        const { dateRange } = get();
        if (dateRange) {
          await get().fetchEvents(client, dateRange.start, dateRange.end);
        }

        return imported + linked;
      },

      deleteEvent: async (client, id, sendSchedulingMessages) => {
        set({ error: null });
        try {
          // Resolve shared event IDs and client-side expanded occurrence IDs
          const target = resolveMutationTarget(get().events, id, 'occurrence');
          const { storeEvent, realId, targetAccountId } = target;
          client = resolveAccountClient(client, target.localAccountId);
          // Cancellation emails (iTIP CANCEL) are sent by the server via the
          // `sendSchedulingMessages` argument on the destroy below - a manual
          // iMIP send here produced duplicate emails.
          debug.log('calendar', 'Calendar deleteEvent', {
            storeId: id,
            realId,
            uid: storeEvent?.uid,
            recurrenceId: storeEvent?.recurrenceId,
            targetAccountId,
          });
          if (target.isOccurrence && storeEvent) {
            await destroyOccurrence(client, storeEvent, realId, sendSchedulingMessages, targetAccountId);
          } else if (target.isBrowserOccurrence) {
            // `realId` is the base event: destroying it would delete the series.
            await destroyBrowserOccurrence(client, target, sendSchedulingMessages);
          } else {
            await client.deleteCalendarEvent(realId, sendSchedulingMessages, targetAccountId);
          }
          const hadOccurrences = hasExpandedOccurrencesOf(get().events, realId, target);
          set((state) => ({
            events: state.events.filter(e => e.id !== id),
            selectedEventId: state.selectedEventId === id ? null : state.selectedEventId,
          }));
          if (target.isOccurrence || target.isBrowserOccurrence || hadOccurrences) {
            await refetchAfterOccurrenceMutation();
          }
        } catch (error) {
          debug.error('Failed to delete event:', error);
          set({ error: 'Failed to delete event' });
          throw error;
        }
      },

      setSelectedDate: (date) => set({ selectedDate: date }),
      setViewMode: (mode) => set({ viewMode: getSafeCalendarViewMode(mode) }),

      updateCalendar: async (client, calendarId, updates) => {
        set({ error: null });
        try {
          const cal = get().calendars.find(c => c.id === calendarId);
          const realId = cal?.originalId || stripLocalAccountPrefix(calendarId, cal?.localAccountId);
          const targetAccountId = cal?.accountId;
          client = resolveAccountClient(client, cal?.localAccountId);
          await client.updateCalendar(realId, updates, targetAccountId);
          set((state) => ({
            calendars: state.calendars.map(c =>
              c.id === calendarId ? { ...c, ...updates } : c
            ),
          }));
        } catch (error) {
          debug.error('Failed to update calendar:', error);
          set({ error: 'Failed to update calendar' });
          throw error;
        }
      },

      setDefaultCalendar: async (client, calendarId) => {
        set({ error: null });
        try {
          const cal = get().calendars.find(c => c.id === calendarId);
          const realId = cal?.originalId || stripLocalAccountPrefix(calendarId, cal?.localAccountId);
          const targetAccountId = cal?.accountId;
          client = resolveAccountClient(client, cal?.localAccountId);
          await client.setDefaultCalendar(realId, targetAccountId);
          set((state) => ({
            calendars: state.calendars.map(c => {
              if (c.id === calendarId) return { ...c, isDefault: true };
              // Only one default per account - clear the flag on siblings of
              // the same local account / shared-account scope.
              if (
                c.isDefault
                && (c.localAccountId ?? null) === (cal?.localAccountId ?? null)
                && (c.accountId ?? null) === (cal?.accountId ?? null)
              ) {
                return { ...c, isDefault: false };
              }
              return c;
            }),
          }));
        } catch (error) {
          debug.error('Failed to set default calendar:', error);
          set({ error: 'Failed to set default calendar' });
          throw error;
        }
      },

      shareCalendar: async (client, calendarId, principalId, rights) => {
        set({ error: null });
        try {
          const cal = get().calendars.find(c => c.id === calendarId);
          const realId = cal?.originalId || stripLocalAccountPrefix(calendarId, cal?.localAccountId);
          const targetAccountId = cal?.accountId;
          client = resolveAccountClient(client, cal?.localAccountId);
          await client.setCalendarShare(realId, principalId, rights, targetAccountId);
          set((state) => ({
            calendars: state.calendars.map(c => {
              if (c.id !== calendarId) return c;
              const next = { ...(c.shareWith ?? {}) };
              if (rights === null) delete next[principalId];
              else next[principalId] = rights;
              return { ...c, shareWith: next };
            }),
          }));
        } catch (error) {
          debug.error('Failed to share calendar:', error);
          set({ error: 'Failed to share calendar' });
          throw error;
        }
      },

      createCalendar: async (client, calendar, options) => {
        set({ error: null });
        try {
          const created = await client.createCalendar(calendar, undefined, options);
          // Added with its raw id; the next aggregated refetch namespaces it and
          // reconcileSelectedIds() remaps the selection so it stays visible.
          set((state) => ({
            calendars: [...state.calendars, created],
            selectedCalendarIds: [...state.selectedCalendarIds, created.id],
          }));
          return created;
        } catch (error) {
          debug.error('Failed to create calendar:', error);
          set({ error: 'Failed to create calendar' });
          return null;
        }
      },

      removeCalendar: async (client, calendarId) => {
        set({ error: null });
        try {
          const cal = get().calendars.find(c => c.id === calendarId);
          const realId = cal?.originalId || stripLocalAccountPrefix(calendarId, cal?.localAccountId);
          const targetAccountId = cal?.accountId;
          client = resolveAccountClient(client, cal?.localAccountId);
          await client.deleteCalendar(realId, targetAccountId);
          set((state) => ({
            calendars: state.calendars.filter(c => c.id !== calendarId),
            selectedCalendarIds: state.selectedCalendarIds.filter(id => id !== calendarId),
            events: state.events.filter(e => !e.calendarIds?.[calendarId]),
          }));
        } catch (error) {
          debug.error('Failed to delete calendar:', error);
          set({ error: 'Failed to delete calendar' });
          throw error;
        }
      },

      clearCalendarEvents: async (client, calendarId) => {
        set({ error: null });
        try {
          const cal = get().calendars.find(c => c.id === calendarId);
          const realCalId = cal?.originalId || stripLocalAccountPrefix(calendarId, cal?.localAccountId);
          const targetAccountId = cal?.accountId;
          client = resolveAccountClient(client, cal?.localAccountId);
          let totalRemoved = 0;
          let firstRefusalMessage = '';
          // Loop to handle pagination (getCalendarEvents has a 1000 limit)
          let hasMore = true;
          while (hasMore) {
            // Query all events and filter client-side by calendarId
            // to avoid relying on server-side inCalendars filter support
            const allEvents = await client.getCalendarEvents(undefined, targetAccountId);
            const calendarEvents = allEvents.filter(e => e.calendarIds?.[realCalId]);
            if (calendarEvents.length === 0) break;

            // Separate events that live ONLY in this calendar (delete) from
            // events also linked to other calendars (unlink only - don't
            // cascade-delete the user's copy elsewhere).
            const idsToDelete: string[] = [];
            const eventsToUnlink: Array<{ id: string; calendarIds: Record<string, boolean> }> = [];
            for (const e of calendarEvents) {
              const otherCalIds = { ...(e.calendarIds || {}) };
              delete otherCalIds[realCalId];
              if (Object.keys(otherCalIds).length === 0) {
                idsToDelete.push(e.id);
              } else {
                eventsToUnlink.push({ id: e.id, calendarIds: otherCalIds });
              }
            }

            let removedThisPass = 0;
            if (idsToDelete.length > 0) {
              // Rejects on a method-level error or when nothing could be
              // destroyed; partial refusals are reported once below. (#434)
              const { destroyed, notDestroyed } = await client.batchDeleteCalendarEvents(idsToDelete, targetAccountId);
              removedThisPass += destroyed.length;
              const firstRefusal = Object.values(notDestroyed)[0];
              if (firstRefusal && !firstRefusalMessage) {
                firstRefusalMessage = firstRefusal.description || firstRefusal.type || 'server refused the request';
              }
            }
            for (const { id, calendarIds } of eventsToUnlink) {
              try {
                await client.updateCalendarEvent(id, { calendarIds } as Partial<CalendarEvent>, undefined, targetAccountId);
                removedThisPass++;
              } catch (err) {
                debug.warn('calendar', 'Failed to unlink event from cleared calendar:', err);
              }
            }
            totalRemoved += removedThisPass;

            // If we couldn't remove anything, stop to avoid infinite loop -
            // and say why, instead of reporting "0 events cleared". (#434)
            if (removedThisPass === 0) {
              debug.warn('calendar', 'Could not clear any events, stopping. Remaining:', calendarEvents.length);
              throw new Error(
                firstRefusalMessage
                  ? `Failed to clear calendar events: ${firstRefusalMessage}`
                  : 'Failed to clear calendar events: the server did not remove any of them',
              );
            }

            // If we got fewer than the limit, we've fetched everything
            if (allEvents.length < 1000) hasMore = false;
          }

          set((state) => ({
            events: state.events.filter(e => !e.calendarIds?.[calendarId]),
          }));
          return totalRemoved;
        } catch (error) {
          debug.error('Failed to clear calendar events:', error);
          set({ error: error instanceof Error ? error.message : 'Failed to clear calendar events' });
          throw error;
        }
      },

      toggleCalendarVisibility: (calendarId) => set((state) => {
        const ids = state.selectedCalendarIds;
        return {
          selectedCalendarIds: ids.includes(calendarId)
            ? ids.filter(id => id !== calendarId)
            : [...ids, calendarId],
        };
      }),

      setSelectedEventId: (id) => set({ selectedEventId: id }),

      // iCal subscriptions
      isSubscriptionCalendar: (calendarId) => {
        const subs = get().icalSubscriptions;
        // Fast path: exact match (single-account, or a sub stored with the same
        // id form as the query).
        if (subs.some((s) => s.calendarId === calendarId)) return true;
        // Aggregated: the query is a namespaced store id while subs store the raw
        // JMAP calendar id. Resolve the calendar and match by raw id, scoped to
        // the owning JMAP account so raw ids that collide across accounts (e.g.
        // Stalwart's "b"/"c") don't cause false positives.
        const cal = get().calendars.find((c) => c.id === calendarId);
        if (!cal) return false;
        const rawId = cal.originalId ?? stripLocalAccountPrefix(cal.id, cal.localAccountId);
        return subs.some(
          (s) => s.calendarId === rawId && (!s.accountId || !cal.accountId || s.accountId === cal.accountId),
        );
      },

      addICalSubscription: async (client, url, name, color, refreshInterval = 60) => {
        // Normalize webcal(s):// → https:// so the server-side fetcher
        // (which only accepts http/https) doesn't reject every refresh.
        const normalizedUrl = url.replace(/^webcals?:\/\//i, 'https://');

        let calendar: Calendar | null = null;
        try {
          calendar = await client.createCalendar({
            name,
            color,
            isVisible: true,
            isSubscribed: true,
          });
          if (!calendar) throw new Error('Failed to create calendar');

          const subscription: ICalSubscription = {
            id: generateUUID(),
            url: normalizedUrl,
            calendarId: calendar.id,
            accountId: client.getAccountId(),
            owner: subscriptionOwner(client),
            name,
            color,
            refreshInterval,
            lastRefreshed: null,
          };

          set((state) => ({
            calendars: [...state.calendars, calendar!],
            selectedCalendarIds: [...state.selectedCalendarIds, calendar!.id],
            icalSubscriptions: [...state.icalSubscriptions, subscription],
          }));

          // Initial fetch - roll back the calendar create if it fails so we
          // don't leave a phantom calendar around after a bad URL / 404 / etc.
          await get().refreshICalSubscription(client, subscription.id);

          return subscription;
        } catch (error) {
          debug.error('Failed to add iCal subscription:', error);
          if (calendar) {
            const calendarId = calendar.id;
            try {
              await client.deleteCalendar(calendarId);
            } catch (rollbackErr) {
              debug.warn('calendar', 'Rollback failed for subscription calendar:', rollbackErr);
            }
            set((state) => ({
              calendars: state.calendars.filter(c => c.id !== calendarId),
              selectedCalendarIds: state.selectedCalendarIds.filter(id => id !== calendarId),
              icalSubscriptions: state.icalSubscriptions.filter(s => s.calendarId !== calendarId),
              events: state.events.filter(e => !e.calendarIds?.[calendarId]),
            }));
          }
          // Rethrow so the dialog can show the server's reason (size limit,
          // 404, timeout) instead of a generic failure. (#692)
          throw error;
        }
      },

      updateICalSubscription: async (client, subscriptionId, updates) => {
        const sub = get().icalSubscriptions.find(s => s.id === subscriptionId);
        if (!sub) return;
        if (!(await claimSubscription(client, sub, set))) {
          debug.warn('calendar', 'Not updating a subscription of another account', { sub: sub.name });
          return;
        }

        // Normalize webcal(s):// in the new URL so refreshes don't break.
        const normalizedUpdates: typeof updates = updates.url
          ? { ...updates, url: updates.url.replace(/^webcals?:\/\//i, 'https://') }
          : updates;

        // Update the calendar on the server if name or color changed
        if (normalizedUpdates.name || normalizedUpdates.color) {
          const calUpdates: Record<string, unknown> = {};
          if (normalizedUpdates.name) calUpdates.name = normalizedUpdates.name;
          if (normalizedUpdates.color) calUpdates.color = normalizedUpdates.color;
          await client.updateCalendar(sub.calendarId, calUpdates);
        }

        // Update local subscription record
        const updated = { ...sub, ...normalizedUpdates };
        set((state) => ({
          icalSubscriptions: state.icalSubscriptions.map(s => s.id === subscriptionId ? updated : s),
          calendars: state.calendars.map(c => {
            if (c.id !== sub.calendarId) return c;
            return {
              ...c,
              ...(normalizedUpdates.name ? { name: normalizedUpdates.name } : {}),
              ...(normalizedUpdates.color ? { color: normalizedUpdates.color } : {}),
            };
          }),
        }));

        // If URL changed, refresh to fetch events from new source
        if (normalizedUpdates.url && normalizedUpdates.url !== sub.url) {
          await get().refreshICalSubscription(client, subscriptionId);
        }
      },

      removeICalSubscription: async (client, subscriptionId) => {
        const sub = get().icalSubscriptions.find(s => s.id === subscriptionId);
        if (!sub) return;

        // Only destroy the calendar in the account the subscription belongs
        // to: through another login its id names an unrelated calendar.
        if (await claimSubscription(client, sub, set)) {
          try {
            await client.deleteCalendar(sub.calendarId);
          } catch (error) {
            debug.error('Failed to delete subscription calendar:', error);
            // Continue removing subscription record even if calendar delete fails
          }
        }

        set((state) => ({
          icalSubscriptions: state.icalSubscriptions.filter(s => s.id !== subscriptionId),
          calendars: state.calendars.filter(c => c.id !== sub.calendarId),
          selectedCalendarIds: state.selectedCalendarIds.filter(id => id !== sub.calendarId),
          events: state.events.filter(e => !e.calendarIds?.[sub.calendarId]),
        }));
      },

      refreshICalSubscription: async (client, subscriptionId) => {
        const existing = refreshInFlight.get(subscriptionId);
        if (existing) return existing;

        const sub = get().icalSubscriptions.find(s => s.id === subscriptionId);
        if (!sub) return;

        // Skip unless the subscription belongs to this login - otherwise the
        // diff below would delete the events of whatever calendar in this
        // account happens to have the same id.
        if (!(await claimSubscription(client, sub, set))) {
          debug.warn('calendar', 'Skipping subscription refresh: account mismatch', { sub: sub.name });
          return;
        }

        const work = (async () => {
          const response = await apiFetch('/api/fetch-ical', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: sub.url }),
          });

          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(explainServerAuthError(response.status, data.error, 'Failed to fetch calendar'));
          }

          const blob = await response.blob();
          const file = new File([blob], 'subscription.ics', { type: 'text/calendar' });
          const uploaded = await client.uploadBlob(file);
          const accountId = client.getCalendarsAccountId();
          const parsedEvents = await client.parseCalendarEvents(accountId, uploaded.blobId);

          // Fetch ALL server-side events and filter client-side for this calendar
          // (avoids relying on server-side inCalendars filter support)
          const allServerEvents = await client.getCalendarEvents();
          const serverEvents = allServerEvents.filter(e => e.calendarIds?.[sub.calendarId]);

          // Build a map of incoming UIDs for diffing
          const incomingUids = new Set(parsedEvents.map(e => e.uid).filter(Boolean));

          // Build a map of existing UIDs on server
          const existingByUid = new Map<string, CalendarEvent[]>();
          for (const e of serverEvents) {
            if (e.uid) {
              const list = existingByUid.get(e.uid) || [];
              list.push(e);
              existingByUid.set(e.uid, list);
            }
          }

          // Events no longer in the feed. If an event lives only in the
          // subscription calendar, delete it. If it is also linked to other
          // calendars (importEvents links by UID), only unlink the
          // subscription calendar so we don't cascade-delete the user's
          // personal copy.
          const staleEvents = serverEvents.filter(e => !e.uid || !incomingUids.has(e.uid));
          const idsToDelete: string[] = [];
          const eventsToUnlink: Array<{ id: string; calendarIds: Record<string, boolean> }> = [];
          for (const e of staleEvents) {
            const otherCalIds = { ...(e.calendarIds || {}) };
            delete otherCalIds[sub.calendarId];
            if (Object.keys(otherCalIds).length === 0) {
              idsToDelete.push(e.id);
            } else {
              eventsToUnlink.push({ id: e.id, calendarIds: otherCalIds });
            }
          }
          if (idsToDelete.length > 0) {
            await client.batchDeleteCalendarEvents(idsToDelete);
          }
          for (const { id, calendarIds } of eventsToUnlink) {
            try {
              await client.updateCalendarEvent(id, { calendarIds } as Partial<CalendarEvent>);
            } catch (err) {
              debug.warn('calendar', 'Failed to unlink stale event from subscription calendar:', err);
            }
          }

          // Import only events that don't already exist on server
          const eventsToImport = parsedEvents.filter(e => !e.uid || !existingByUid.has(e.uid));

          // Import new events (importEvents will re-fetch all events at the end)
          if (eventsToImport.length > 0) {
            await get().importEvents(client, eventsToImport, sub.calendarId);
          } else {
            // No new events to import, but stale ones may have been deleted
            // Re-fetch to reflect deletions
            const { dateRange } = get();
            if (dateRange) {
              await get().fetchEvents(client, dateRange.start, dateRange.end);
            }
          }

          // Update last refreshed timestamp
          set((state) => ({
            icalSubscriptions: state.icalSubscriptions.map(s =>
              s.id === subscriptionId ? { ...s, lastRefreshed: new Date().toISOString() } : s
            ),
          }));
        })();

        refreshInFlight.set(subscriptionId, work);
        try {
          await work;
        } catch (error) {
          debug.error('Failed to refresh iCal subscription:', sub.name, error);
          throw error;
        } finally {
          refreshInFlight.delete(subscriptionId);
        }
      },

      refreshAllSubscriptions: async (client) => {
        const { icalSubscriptions } = get();
        const currentAccountId = client.getAccountId();
        const owner = subscriptionOwner(client);
        const now = Date.now();

        for (const sub of icalSubscriptions) {
          // Only refresh subs of this login. Older ones without an owner
          // are checked (and adopted) by refreshICalSubscription.
          if (sub.owner ? sub.owner !== owner : (sub.accountId && sub.accountId !== currentAccountId)) continue;

          const lastRefreshed = sub.lastRefreshed ? new Date(sub.lastRefreshed).getTime() : 0;
          const intervalMs = sub.refreshInterval * 60 * 1000;

          if (now - lastRefreshed >= intervalMs) {
            try {
              await get().refreshICalSubscription(client, sub.id);
            } catch {
              debug.warn('calendar', 'Failed to refresh subscription:', sub.name);
            }
          }
        }
      },

      forgetICalSubscriptions: (owner) => {
        set((state) => ({ icalSubscriptions: state.icalSubscriptions.filter(s => s.owner !== owner) }));
      },

      clearICalSubscriptions: () => {
        set({ icalSubscriptions: [] });
      },

      clearState: () => {
        refetchVisibleRange = null;
        // Preserve iCal subscriptions across the account-switch teardown.
        // They're now scoped per-account via sub.accountId - wiping them
        // here would lose them from localStorage on every switch.
        const preservedSubs = get().icalSubscriptions;
        set({
          ...initialState,
          selectedDate: displayNow(),
          icalSubscriptions: preservedSubs,
        });
        import('./calendar-notification-store').then(({ useCalendarNotificationStore }) => {
          useCalendarNotificationStore.getState().clearAll();
        }).catch(() => {});
      },
    }),
    {
      name: 'calendar-storage',
      merge: (persistedState, currentState) => {
        const mergedState = {
          ...currentState,
          ...(persistedState as Partial<CalendarStore> | undefined),
        };

        return {
          ...mergedState,
          selectedDate: displayNow(),
          viewMode: getSafeCalendarViewMode(mergedState.viewMode),
        };
      },
      partialize: (state) => ({
        selectedCalendarIds: state.selectedCalendarIds,
        viewMode: state.viewMode,
        icalSubscriptions: state.icalSubscriptions,
      }),
    }
  )
);
