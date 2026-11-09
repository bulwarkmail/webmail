"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useShallow } from 'zustand/react/shallow';
import { useRouter } from '@/i18n/navigation';
import { useCalendarErrorMessage } from '@/hooks/use-calendar-error-message';
import { canCreateEventsIn } from '@/lib/calendar-editability';
import { getEventStartDate } from '@/lib/calendar-utils';
import type { Calendar, CalendarEvent, Email } from '@/lib/jmap/types';
import {
  bookingEndsAt,
  bookingEventPatch,
  bookingEventSlots,
  eventNeedsUpdate,
  senderDomainOf,
  type BookingEventLabels,
  type BookingEventSlot,
} from '@/lib/structured-mail/calendar';
import type { StructuredCard } from '@/lib/structured-mail';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { usePolicyStore } from '@/stores/policy-store';

/**
 * What the card offers for its booking:
 * - `hidden`: nothing (no calendar, admin gate off, shipment, booking over, lookup failed)
 * - `loading`: looking the events up; nothing to show yet
 * - `add`: none of the booking's events is in the calendar
 * - `in-calendar`: every live event is there and up to date
 * - `update`: some are there, and others are missing, changed or cancelled
 * - `remove`: the booking is cancelled and its events are still there
 * - `cancelled`: the booking is cancelled and nothing of it is in the calendar
 */
export type BookingCalendarStatus = 'hidden' | 'loading' | 'add' | 'in-calendar' | 'update' | 'remove' | 'cancelled';

export interface BookingCalendar {
  status: BookingCalendarStatus;
  /** Calendars an add can go into: own account, writable, not tasks-only; the default first. */
  calendars: Calendar[];
  busy: boolean;
  /** What went wrong with the last action, in the user's language. */
  error: string | null;
  /** What the last action did, for a short confirmation; `blocked` when a plugin stopped it. */
  notice: 'added' | 'updated' | 'removed' | 'blocked' | null;
  /** Add every live event, into `calendarId` or the default calendar. */
  add: (calendarId?: string) => Promise<void>;
  /** Add the missing live events, update the changed ones, remove the cancelled ones. */
  update: () => Promise<void>;
  /** Remove the events of cancelled legs or of the cancelled booking. */
  remove: () => Promise<void>;
  viewInCalendar: () => void;
}

/**
 * Uids whose events a card removed in this session. Another card for the
 * same booking (a conversation showing two of its mails) may still hold the
 * event from its own lookup; this tells it the event is gone.
 */
const removedUids = new Set<string>();

type Lookup = { key: string; failed: false; events: Record<string, CalendarEvent | null> } | { key: string; failed: true };

interface Plan {
  status: BookingCalendarStatus;
  /** Live slots and the stored event of each (null: not in the calendar). */
  live: { slot: BookingEventSlot; existing: CalendarEvent | null }[];
  /** Stored events of cancelled slots. */
  stale: { slot: BookingEventSlot; existing: CalendarEvent }[];
}

/** Own calendars of the primary calendar account an event can be created in, the default first. */
export function bookingTargetCalendars(
  calendars: Calendar[],
  isSubscriptionCalendar: (calendarId: string) => boolean,
  activeLocalAccountId: string | null,
): Calendar[] {
  const own = calendars.filter((c) =>
    !c.isShared
    && (!c.localAccountId || c.localAccountId === activeLocalAccountId)
    && !c.isTasksOnly
    && canCreateEventsIn(c, isSubscriptionCalendar));
  const defaultCalendar = own.find((c) => c.isDefault);
  return defaultCalendar ? [defaultCalendar, ...own.filter((c) => c !== defaultCalendar)] : own;
}

function planFor(slots: BookingEventSlot[], existingOf: (uid: string) => CalendarEvent | null): Plan {
  const live = slots
    .filter((slot) => !slot.cancelled && slot.event)
    .map((slot) => ({ slot, existing: existingOf(slot.uid) }));
  const stale = slots
    .filter((slot) => slot.cancelled)
    .map((slot) => ({ slot, existing: existingOf(slot.uid) }))
    .filter((entry): entry is { slot: BookingEventSlot; existing: CalendarEvent } => entry.existing !== null);
  let status: BookingCalendarStatus;
  if (live.length === 0) {
    status = slots.some((s) => s.cancelled) ? (stale.length > 0 ? 'remove' : 'cancelled') : 'hidden';
  } else {
    const found = live.filter((entry) => entry.existing);
    const changed = found.some((entry) => eventNeedsUpdate(entry.existing as CalendarEvent, entry.slot.event as Partial<CalendarEvent>));
    if (found.length === 0 && stale.length === 0) status = 'add';
    else if (found.length < live.length || changed || stale.length > 0) status = 'update';
    else status = 'in-calendar';
  }
  return { status, live, stale };
}

/**
 * Calendar state and actions for one booking card. Looks each of the
 * booking's event uids up in the primary calendar account
 * (CalendarEvent/query by uid), merges what it finds into the calendar
 * store, and never creates an event whose uid it found. Hidden unless the
 * account has calendars, the admin allows them and the booking isn't over.
 */
export function useBookingCalendar(booking: StructuredCard | null | undefined, email: Pick<Email, 'from' | 'subject'> | null | undefined): BookingCalendar {
  const t = useTranslations('structured_mail_calendar');
  const describeError = useCalendarErrorMessage();
  const router = useRouter();
  const client = useAuthStore((s) => s.client);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const calendarEnabled = usePolicyStore((s) => s.isFeatureEnabled('calendarEnabled'));
  const {
    calendars, supportsCalendar, storeEvents, icalSubscriptions,
    createEvent, updateEvent, deleteEvent, setSelectedDate, isSubscriptionCalendar,
  } = useCalendarStore(useShallow((s) => ({
    calendars: s.calendars,
    supportsCalendar: s.supportsCalendar,
    storeEvents: s.events,
    icalSubscriptions: s.icalSubscriptions,
    createEvent: s.createEvent,
    updateEvent: s.updateEvent,
    deleteEvent: s.deleteEvent,
    setSelectedDate: s.setSelectedDate,
    isSubscriptionCalendar: s.isSubscriptionCalendar,
  })));

  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<BookingCalendar['notice']>(null);
  const [refresh, setRefresh] = useState(0);

  const senderDomain = senderDomainOf(email?.from?.[0]?.email);
  const subject = email?.subject;
  const labels = useMemo<Partial<BookingEventLabels>>(() => ({
    reference: (reference) => t('description.reference', { reference }),
    passengers: (names) => t('description.passengers', { names }),
    seats: (seats) => t('description.seats', { seats }),
    checkin: (url) => t('description.checkin', { url }),
    manage: (url) => t('description.manage', { url }),
    ticket: (url) => t('description.ticket', { url }),
    phone: (phone) => t('description.phone', { phone }),
    car: (car) => t('description.car', { car }),
    tickets: (numbers) => t('description.tickets', { numbers }),
    partySize: (count) => t('description.party_size', { count }),
    rentalCar: (company) => (company ? t('title.rental_car_company', { company }) : t('title.rental_car')),
    addedFrom: (domain, mailSubject) => (mailSubject
      ? t('description.added_from_subject', { domain, subject: mailSubject })
      : t('description.added_from', { domain })),
  }), [t]);

  const slots = useMemo(
    () => (booking && senderDomain ? bookingEventSlots(booking, { senderDomain, mailSubjectOrProvider: subject, labels }) : []),
    [booking, senderDomain, subject, labels],
  );
  const uidKey = slots.map((s) => s.uid).join(' ');

  const endsAt = booking && booking.kind !== 'shipment' ? bookingEndsAt(booking) : null;
  const over = endsAt === null || endsAt < Date.now();
  const active = Boolean(client) && supportsCalendar && calendarEnabled && !over && slots.length > 0;

  useEffect(() => {
    if (!active || !client || !uidKey) return;
    let current = true;
    const uids = uidKey.split(' ');
    // Without targetAccountId this searches only the primary calendar
    // account, the only one the picker offers.
    Promise.all(uids.map((uid) => client.queryCalendarEvents({ uid })))
      .then((results) => {
        if (!current) return;
        const events: Record<string, CalendarEvent | null> = {};
        uids.forEach((uid, i) => {
          events[uid] = results[i].find((e) => e.uid === uid && !e.recurrenceId) ?? null;
          if (events[uid]) removedUids.delete(uid);
        });
        setLookup({ key: uidKey, failed: false, events });
        const hits = Object.values(events).filter((e): e is CalendarEvent => e !== null);
        if (hits.length > 0) {
          useCalendarStore.setState((s) => {
            const ids = new Set(s.events.map((e) => e.id));
            const added = hits.filter((e) => !ids.has(e.id));
            return added.length > 0 ? { events: [...s.events, ...added] } : s;
          });
        }
      })
      .catch(() => {
        // Not knowing what the calendar holds, offering "Add" could duplicate: show nothing.
        if (current) setLookup({ key: uidKey, failed: true });
      });
    return () => { current = false; };
  }, [active, client, uidKey, refresh]);

  const targets = useMemo(
    () => bookingTargetCalendars(calendars, isSubscriptionCalendar, activeAccountId),
    // icalSubscriptions changes what isSubscriptionCalendar answers.
    [calendars, isSubscriptionCalendar, activeAccountId, icalSubscriptions], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const known = lookup && lookup.key === uidKey && !lookup.failed ? lookup.events : null;
  const existingOf = useCallback((uid: string): CalendarEvent | null => {
    if (removedUids.has(uid)) return null;
    const stored = known?.[uid];
    // The store's copy of the same event is fresher after a change elsewhere.
    if (stored) return storeEvents.find((e) => e.id === stored.id) ?? stored;
    // Added since the lookup, maybe by another card for the same booking.
    return storeEvents.find((e) => e.uid === uid && !e.recurrenceId && !e.isShared
      && (!e.localAccountId || e.localAccountId === activeAccountId)) ?? null;
  }, [known, storeEvents, activeAccountId]);

  const plan = useMemo<Plan>(() => {
    if (!active) return { status: 'hidden', live: [], stale: [] };
    if (!lookup || lookup.key !== uidKey) return { status: 'loading', live: [], stale: [] };
    if (lookup.failed) return { status: 'hidden', live: [], stale: [] };
    return planFor(slots, existingOf);
  }, [active, lookup, uidKey, slots, existingOf]);

  const status: BookingCalendarStatus = plan.status === 'add' && targets.length === 0 ? 'hidden' : plan.status;

  const remember = useCallback((uid: string, event: CalendarEvent | null) => {
    setLookup((prev) => (prev && !prev.failed && prev.key === uidKey ? { ...prev, events: { ...prev.events, [uid]: event } } : prev));
  }, [uidKey]);

  /**
   * Run one action. `work` resolves to false when a plugin stopped a step,
   * which is said as such; on failure say why and look the events up again.
   */
  const run = useCallback(async (done: NonNullable<BookingCalendar['notice']>, work: () => Promise<boolean>) => {
    if (!client || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice((await work()) ? done : 'blocked');
    } catch (err) {
      setError(describeError(err, t('action_failed')));
      setRefresh((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }, [client, busy, describeError, t]);

  const createMissing = useCallback(async (calendarId: string): Promise<boolean> => {
    if (!client) return false;
    for (const { slot, existing } of plan.live) {
      if (existing) continue;
      // createEvent answers null both when a plugin stops it and when the
      // server refuses (the uid exists after all, say); only the latter sets
      // the store's error.
      useCalendarStore.setState({ error: null });
      const created = await createEvent(client, { ...slot.event, calendarIds: { [calendarId]: true } });
      if (!created) {
        if (useCalendarStore.getState().error) throw new Error('create failed');
        return false;
      }
      removedUids.delete(slot.uid);
      remember(slot.uid, created);
    }
    return true;
  }, [client, plan.live, createEvent, remember]);

  const removeStale = useCallback(async (): Promise<boolean> => {
    if (!client) return false;
    for (const { slot, existing } of plan.stale) {
      // Marked before the store drops the event, so other cards that
      // re-render on that change already see it gone.
      removedUids.add(slot.uid);
      let removed = false;
      try {
        removed = await deleteEvent(client, existing.id);
      } finally {
        if (!removed) removedUids.delete(slot.uid);
      }
      if (!removed) return false;
      remember(slot.uid, null);
    }
    return true;
  }, [client, plan.stale, deleteEvent, remember]);

  const add = useCallback((calendarId?: string) => run('added', async () => {
    const target = calendarId ?? targets[0]?.id;
    if (!target || !targets.some((c) => c.id === target)) throw new Error('no writable calendar');
    return createMissing(target);
  }), [run, targets, createMissing]);

  const update = useCallback(() => run('updated', async () => {
    if (!client) return false;
    for (const { slot, existing } of plan.live) {
      if (!existing || !eventNeedsUpdate(existing, slot.event as Partial<CalendarEvent>)) continue;
      // Only what moved; title and notes the user changed stay.
      const patch = bookingEventPatch(existing, slot.event as Partial<CalendarEvent>, senderDomain);
      if (Object.keys(patch).length === 0) continue;
      if (!(await updateEvent(client, existing.id, patch))) return false;
      const updated = { ...existing, ...patch } as CalendarEvent;
      remember(slot.uid, updated);
      // The card reads the store's copy first; make sure it holds the change.
      useCalendarStore.setState((s) => ({ events: s.events.map((e) => (e.id === existing.id ? { ...e, ...patch } : e)) }));
    }
    if (plan.live.some((entry) => !entry.existing)) {
      // Missing legs go where the booking's other events are.
      const used = plan.live.flatMap((entry) => Object.keys(entry.existing?.calendarIds ?? {}));
      const target = targets.find((c) => used.includes(c.id))?.id ?? targets[0]?.id;
      if (!target) throw new Error('no writable calendar');
      if (!(await createMissing(target))) return false;
    }
    return removeStale();
  }), [run, client, plan.live, senderDomain, targets, updateEvent, remember, createMissing, removeStale]);

  const remove = useCallback(() => run('removed', removeStale), [run, removeStale]);

  const viewInCalendar = useCallback(() => {
    const target = plan.live.find((entry) => entry.existing)?.existing ?? plan.stale[0]?.existing;
    if (target?.start) {
      const date = getEventStartDate({
        start: target.start,
        utcStart: target.utcStart ?? null,
        showWithoutTime: target.showWithoutTime ?? false,
        timeZone: target.timeZone,
      });
      if (!Number.isNaN(date.getTime())) setSelectedDate(date);
    }
    router.push('/calendar');
  }, [plan, setSelectedDate, router]);

  return {
    status,
    calendars: targets,
    busy,
    error: status === 'hidden' ? null : error,
    notice: status === 'hidden' ? null : notice,
    add,
    update,
    remove,
    viewInCalendar,
  };
}
