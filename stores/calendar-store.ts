import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarEvent, CalendarParticipant } from '@/lib/jmap/types';
import { debug } from '@/lib/debug';
import { normalizeAllDayDuration } from '@/lib/calendar-utils';
import { sanitizeOutgoingCalendarEventData } from '@/lib/calendar-event-normalization';
import { expandRecurringEvents } from '@/lib/recurrence-expansion';
import { generateUUID } from '@/lib/utils';
import { apiFetch } from '@/lib/browser-navigation';

export type CalendarViewMode = 'month' | 'week' | 'day' | 'agenda' | 'tasks';

const CALENDAR_VIEW_MODES: CalendarViewMode[] = ['month', 'week', 'day', 'agenda', 'tasks'];

export function isCalendarViewMode(value: unknown): value is CalendarViewMode {
  return typeof value === 'string' && CALENDAR_VIEW_MODES.includes(value as CalendarViewMode);
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

  return {
    ...event,
    id: isShared && resolvedAccountId ? `${resolvedAccountId}:${event.id}` : event.id,
    originalId: event.id,
    originalCalendarIds: event.calendarIds,
    calendarIds: mappedCalendarIds,
    accountId: resolvedAccountId,
    accountName: matchedCalendar?.accountName,
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

export interface ICalSubscription {
  id: string;
  url: string;
  calendarId: string;
  name: string;
  color: string;
  refreshInterval: number; // minutes
  lastRefreshed: string | null;
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

  setSupported: (supported: boolean) => void;
  fetchCalendars: (client: IJMAPClient) => Promise<void>;
  fetchEvents: (client: IJMAPClient, start: string, end: string) => Promise<void>;
  createEvent: (client: IJMAPClient, event: Partial<CalendarEvent>, sendSchedulingMessages?: boolean) => Promise<CalendarEvent | null>;
  updateEvent: (client: IJMAPClient, id: string, updates: Partial<CalendarEvent>, sendSchedulingMessages?: boolean) => Promise<void>;
  deleteEvent: (client: IJMAPClient, id: string, sendSchedulingMessages?: boolean) => Promise<void>;
  rsvpEvent: (client: IJMAPClient, eventId: string, participantId: string, status: string, replyTo?: Record<string, string> | null) => Promise<void>;
  importEvents: (client: IJMAPClient, events: Partial<CalendarEvent>[], calendarId: string) => Promise<number>;
  updateCalendar: (client: IJMAPClient, calendarId: string, updates: Partial<Calendar>) => Promise<void>;
  createCalendar: (client: IJMAPClient, calendar: Partial<Calendar>) => Promise<Calendar | null>;
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
  refreshAllSubscriptions: (client: IJMAPClient) => Promise<void>;
  isSubscriptionCalendar: (calendarId: string) => boolean;
}

const initialState = {
  calendars: [],
  events: [],
  selectedDate: new Date(),
  selectedCalendarIds: [] as string[],
  selectedEventId: null as string | null,
  isLoading: false,
  isLoadingEvents: false,
  supportsCalendar: false,
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

      fetchCalendars: async (client) => {
        set({ isLoading: true, error: null });
        try {
          const calendars = await client.getAllCalendars();
          const { selectedCalendarIds } = get();
          const validIds = calendars.map(c => c.id);
          const stillValid = selectedCalendarIds.filter(id => validIds.includes(id));
          set({
            calendars,
            isLoading: false,
            selectedCalendarIds: stillValid.length > 0 ? stillValid : validIds,
          });
        } catch (error) {
          debug.error('Failed to fetch calendars:', error);
          set({ error: 'Failed to load calendars', isLoading: false });
        }
      },

      fetchEvents: async (client, start, end) => {
        set({ isLoadingEvents: true, error: null });
        try {
          const rawEvents = await client.queryAllCalendarEvents({
            after: start,
            before: end,
          });
          // Filter out malformed events missing required 'start' field
          const validEvents = rawEvents.filter(e => typeof e.start === 'string' && e.start);
          const droppedEvents = rawEvents.length - validEvents.length;
          // Expand recurring events client-side (Stalwart doesn't support
          // mutations on synthetic IDs from server-side expandRecurrences)
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

      createEvent: async (client, event, sendSchedulingMessages) => {
        set({ error: null });
        try {
          // Resolve shared calendar context from calendarIds
          let targetAccountId = event.accountId;
          const cleanEvent = sanitizeOutgoingCalendarEventData({ ...event });
          if (event.calendarIds) {
            const remapped: Record<string, boolean> = {};
            for (const calId of Object.keys(event.calendarIds)) {
              const cal = get().calendars.find(c => c.id === calId);
              if (cal?.isShared && cal.originalId) {
                targetAccountId = cal.accountId;
                remapped[cal.originalId] = true;
              } else {
                remapped[calId] = true;
              }
            }
            cleanEvent.calendarIds = remapped;
          }
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
          if (sendSchedulingMessages && created.participants) {
            try {
              await client.sendImipInvitation(created);
            } catch (e) {
              debug.error('Failed to send invitation emails:', e);
            }
          }
          return mappedCreated;
        } catch (error) {
          debug.error('Failed to create event:', error);
          set({ error: 'Failed to create event' });
          return null;
        }
      },

      updateEvent: async (client, id, updates, sendSchedulingMessages) => {
        set({ error: null });
        try {
          // Resolve shared event IDs and client-side expanded occurrence IDs
          const storeEvent = get().events.find(e => e.id === id);
          const realId = storeEvent?.originalId || id;
          const targetAccountId = storeEvent?.accountId;
          debug.log('calendar', 'Calendar updateEvent', {
            storeId: id,
            realId,
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
          await client.updateCalendarEvent(realId, cleanUpdates, sendSchedulingMessages, targetAccountId);
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
              return merged;
            }),
          }));
          if (sendSchedulingMessages) {
            const mergedParticipants = cleanUpdates.participants ?? storeEvent?.participants;
            if (mergedParticipants) {
              const eventForInvitation = {
                ...(storeEvent ?? {}),
                ...cleanUpdates,
                id: realId,
                participants: mergedParticipants,
              } as import('@/lib/jmap/types').CalendarEvent;
              try {
                await client.sendImipInvitation(eventForInvitation);
              } catch (e) {
                debug.error('Failed to send invitation emails:', e);
              }
            }
          }
        } catch (error) {
          debug.error('Failed to update event:', error);
          set({ error: 'Failed to update event' });
          throw error;
        }
      },

      rsvpEvent: async (client, eventId, participantId, status, replyTo) => {
        set({ error: null });
        // JMAP participant IDs are opaque strings — they can contain @, ., :, / etc.
        // Only reject empty or obviously malicious values (path traversal).
        if (!participantId || participantId.includes('..')) {
          set({ error: 'Invalid participant ID' });
          throw new Error('Invalid participant ID');
        }
        try {
          // Resolve shared event IDs and client-side expanded occurrence IDs
          const storeEvent = get().events.find(e => e.id === eventId);
          const realId = storeEvent?.originalId || eventId;
          const targetAccountId = storeEvent?.accountId;
          // Escape per RFC 6901 (JSON Pointer): ~ → ~0, / → ~1
          const escapedId = participantId.replace(/~/g, '~0').replace(/\//g, '~1');
          const patchKey = `participants/${escapedId}/participationStatus`;
          const patch: Record<string, unknown> = { [patchKey]: status };
          // Include replyTo so the server knows where to deliver the iTIP reply
          // (may be missing if the event was imported or auto-created without it).
          if (replyTo) {
            patch.replyTo = replyTo;
          }
          await client.updateCalendarEvent(
            realId,
            patch as unknown as Partial<CalendarEvent>,
            true,
            targetAccountId
          );
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
        } catch (error) {
          debug.error('Failed to RSVP:', error);
          set({ error: 'Failed to update RSVP' });
          throw error;
        }
      },

      importEvents: async (client, events, calendarId) => {
        // Resolve shared calendar IDs
        const cal = get().calendars.find(c => c.id === calendarId);
        const realCalendarId = cal?.originalId || calendarId;
        const targetAccountId = cal?.accountId;

        // Deduplicate UIDs: Stalwart enforces UID uniqueness across all calendars.
        // - Events already in the target calendar → skip (true duplicates)
        // - Events in other calendars → link to target calendar via calendarIds update
        // - New events → create as normal
        let eventsToProcess = events;
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
              // UID doesn't exist on server — create it
              newEvents.push(e);
            } else {
              const existing = uidToEvent.get(e.uid)!;
              if (existing.calendarIds[realCalendarId]) {
                // Already in target calendar — skip
                continue;
              }
              // Exists in another calendar — link to target calendar
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
                calendarAddress: p.calendarAddress,
                description: p.description,
                sendTo: p.sendTo,
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
            replyTo: src.replyTo || (src.organizerCalendarAddress ? { imip: src.organizerCalendarAddress } : undefined),
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
            const { created, failed } = await client.batchCreateCalendarEvents(batch, targetAccountId);
            imported += created.length;
            if (failed.length > 0) {
              debug.warn('calendar', `Import batch ${i / BATCH_SIZE + 1}: ${failed.length} events failed`);
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
          const storeEvent = get().events.find(e => e.id === id);
          const realId = storeEvent?.originalId || id;
          const targetAccountId = storeEvent?.accountId;
          if (sendSchedulingMessages) {
            try {
              const event = await client.getCalendarEvent(realId, targetAccountId);
              if (event?.participants) {
                await client.sendImipCancellation(event);
              }
            } catch (e) {
              debug.error('Failed to send cancellation emails:', e);
            }
          }
          debug.log('calendar', 'Calendar deleteEvent', {
            storeId: id,
            realId,
            uid: storeEvent?.uid,
            recurrenceId: storeEvent?.recurrenceId,
            targetAccountId,
          });
          await client.deleteCalendarEvent(realId, sendSchedulingMessages, targetAccountId);
          set((state) => ({
            events: state.events.filter(e => e.id !== id),
            selectedEventId: state.selectedEventId === id ? null : state.selectedEventId,
          }));
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
          const realId = cal?.originalId || calendarId;
          const targetAccountId = cal?.accountId;
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

      createCalendar: async (client, calendar) => {
        set({ error: null });
        try {
          const created = await client.createCalendar(calendar);
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
          const realId = cal?.originalId || calendarId;
          const targetAccountId = cal?.accountId;
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
          const realCalId = cal?.originalId || calendarId;
          const targetAccountId = cal?.accountId;
          let totalDeleted = 0;
          // Loop to handle pagination (getCalendarEvents has a 1000 limit)
          let hasMore = true;
          while (hasMore) {
            // Query all events and filter client-side by calendarId
            // to avoid relying on server-side inCalendars filter support
            const allEvents = await client.getCalendarEvents(undefined, targetAccountId);
            const calendarEvents = allEvents.filter(e => e.calendarIds?.[realCalId]);
            if (calendarEvents.length === 0) break;

            const ids = calendarEvents.map(e => e.id);
            const { destroyed } = await client.batchDeleteCalendarEvents(ids, targetAccountId);
            totalDeleted += destroyed.length;

            // If we couldn't destroy any events, stop to avoid infinite loop
            if (destroyed.length === 0) {
              debug.warn('calendar', 'Could not delete any events, stopping clear loop. Not destroyed:', ids.length);
              break;
            }

            // If we got fewer than the limit, we've fetched everything
            if (allEvents.length < 1000) hasMore = false;
          }

          set((state) => ({
            events: state.events.filter(e => !e.calendarIds?.[calendarId]),
          }));
          return totalDeleted;
        } catch (error) {
          debug.error('Failed to clear calendar events:', error);
          set({ error: 'Failed to clear calendar events' });
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
        return get().icalSubscriptions.some(s => s.calendarId === calendarId);
      },

      addICalSubscription: async (client, url, name, color, refreshInterval = 60) => {
        try {
          // Create a new calendar for this subscription
          const calendar = await client.createCalendar({
            name,
            color,
            isVisible: true,
            isSubscribed: true,
          });
          if (!calendar) throw new Error('Failed to create calendar');

          const subscription: ICalSubscription = {
            id: generateUUID(),
            url,
            calendarId: calendar.id,
            name,
            color,
            refreshInterval,
            lastRefreshed: null,
          };

          set((state) => ({
            calendars: [...state.calendars, calendar],
            selectedCalendarIds: [...state.selectedCalendarIds, calendar.id],
            icalSubscriptions: [...state.icalSubscriptions, subscription],
          }));

          // Do initial fetch
          try {
            await get().refreshICalSubscription(client, subscription.id);
          } catch {
            // Subscription created, initial fetch failed - user can retry
            debug.warn('calendar', 'Initial subscription fetch failed for:', name);
          }

          return subscription;
        } catch (error) {
          debug.error('Failed to add iCal subscription:', error);
          return null;
        }
      },

      updateICalSubscription: async (client, subscriptionId, updates) => {
        const sub = get().icalSubscriptions.find(s => s.id === subscriptionId);
        if (!sub) return;

        // Update the calendar on the server if name or color changed
        if (updates.name || updates.color) {
          const calUpdates: Record<string, unknown> = {};
          if (updates.name) calUpdates.name = updates.name;
          if (updates.color) calUpdates.color = updates.color;
          await client.updateCalendar(sub.calendarId, calUpdates);
        }

        // Update local subscription record
        const updated = { ...sub, ...updates };
        set((state) => ({
          icalSubscriptions: state.icalSubscriptions.map(s => s.id === subscriptionId ? updated : s),
          calendars: state.calendars.map(c => {
            if (c.id !== sub.calendarId) return c;
            return {
              ...c,
              ...(updates.name ? { name: updates.name } : {}),
              ...(updates.color ? { color: updates.color } : {}),
            };
          }),
        }));

        // If URL changed, refresh to fetch events from new source
        if (updates.url && updates.url !== sub.url) {
          await get().refreshICalSubscription(client, subscriptionId);
        }
      },

      removeICalSubscription: async (client, subscriptionId) => {
        const sub = get().icalSubscriptions.find(s => s.id === subscriptionId);
        if (!sub) return;

        try {
          await client.deleteCalendar(sub.calendarId);
        } catch (error) {
          debug.error('Failed to delete subscription calendar:', error);
          // Continue removing subscription record even if calendar delete fails
        }

        set((state) => ({
          icalSubscriptions: state.icalSubscriptions.filter(s => s.id !== subscriptionId),
          calendars: state.calendars.filter(c => c.id !== sub.calendarId),
          selectedCalendarIds: state.selectedCalendarIds.filter(id => id !== sub.calendarId),
          events: state.events.filter(e => !e.calendarIds?.[sub.calendarId]),
        }));
      },

      refreshICalSubscription: async (client, subscriptionId) => {
        const sub = get().icalSubscriptions.find(s => s.id === subscriptionId);
        if (!sub) return;

        try {
          const response = await apiFetch('/api/fetch-ical', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: sub.url }),
          });

          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || 'Failed to fetch calendar');
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

          // Delete events that are no longer in the feed
          const idsToDelete = serverEvents
            .filter(e => !e.uid || !incomingUids.has(e.uid))
            .map(e => e.id);
          if (idsToDelete.length > 0) {
            await client.batchDeleteCalendarEvents(idsToDelete);
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
        } catch (error) {
          debug.error('Failed to refresh iCal subscription:', sub.name, error);
          throw error;
        }
      },

      refreshAllSubscriptions: async (client) => {
        const { icalSubscriptions } = get();
        const now = Date.now();

        for (const sub of icalSubscriptions) {
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

      clearState: () => {
        set({
          ...initialState,
          selectedDate: new Date(),
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
          selectedDate: new Date(),
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
