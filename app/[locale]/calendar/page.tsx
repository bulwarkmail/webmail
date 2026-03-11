"use client";

import { useState, useEffect, useCallback, useRef, useMemo, type TouchEvent as ReactTouchEvent } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import {
  startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  addMonths, subMonths, addWeeks, subWeeks, addDays, subDays,
  format, parseISO,
} from "date-fns";
import { useCalendarStore } from "@/stores/calendar-store";
import { useAuthStore } from "@/stores/auth-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useIdentityStore } from "@/stores/identity-store";
import { toast } from "@/stores/toast-store";
import { useIsMobile } from "@/hooks/use-media-query";
import { Button } from "@/components/ui/button";
import { CalendarToolbar } from "@/components/calendar/calendar-toolbar";
import { CalendarMonthView } from "@/components/calendar/calendar-month-view";
import { CalendarWeekView } from "@/components/calendar/calendar-week-view";
import { CalendarDayView } from "@/components/calendar/calendar-day-view";
import { CalendarAgendaView } from "@/components/calendar/calendar-agenda-view";
import { MiniCalendar } from "@/components/calendar/mini-calendar";
import { CalendarSidebarPanel } from "@/components/calendar/calendar-sidebar-panel";
import { EventModal } from "@/components/calendar/event-modal";
import { EventDetailPopover } from "@/components/calendar/event-detail-popover";
import { ICalImportModal } from "@/components/calendar/ical-import-modal";
import { RecurrenceScopeDialog, type RecurrenceEditScope } from "@/components/calendar/recurrence-scope-dialog";
import { NavigationRail } from "@/components/layout/navigation-rail";
import type { CalendarEvent, CalendarParticipant } from "@/lib/jmap/types";
import { getUserParticipantId } from "@/lib/calendar-participants";
import { debug } from "@/lib/debug";

type PendingScopeAction =
  | { type: "edit"; event: CalendarEvent; updates: Partial<CalendarEvent>; sendScheduling?: boolean }
  | { type: "delete"; event: CalendarEvent; sendScheduling?: boolean };

function isRecurringEvent(event: CalendarEvent): boolean {
  return (event.recurrenceRules?.length ?? 0) > 0 || event.recurrenceId != null;
}

export default function CalendarPage() {
  const router = useRouter();
  const t = useTranslations("calendar");
  const isMobile = useIsMobile();
  const { client, isAuthenticated } = useAuthStore();
  const {
    calendars, events, selectedDate, viewMode, selectedCalendarIds,
    isLoading, isLoadingEvents, supportsCalendar, error,
    fetchCalendars, fetchEvents, createEvent, updateEvent, deleteEvent, rsvpEvent,
    setSelectedDate, setViewMode, toggleCalendarVisibility,
  } = useCalendarStore();
  const { firstDayOfWeek, timeFormat } = useSettingsStore();
  const { identities } = useIdentityStore();

  const currentUserEmails = useMemo(() =>
    identities.map(id => id.email).filter(Boolean),
    [identities]
  );

  const [showEventModal, setShowEventModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [editEvent, setEditEvent] = useState<CalendarEvent | null>(null);
  const [defaultModalDate, setDefaultModalDate] = useState<Date | undefined>();
  const [defaultModalEndDate, setDefaultModalEndDate] = useState<Date | undefined>();
  const [miniMonth, setMiniMonth] = useState(new Date());
  const [pendingScopeAction, setPendingScopeAction] = useState<PendingScopeAction | null>(null);
  const [detailEvent, setDetailEvent] = useState<CalendarEvent | null>(null);
  const [detailAnchorRect, setDetailAnchorRect] = useState<DOMRect | null>(null);
  const hasFetched = useRef(false);

  // Swipe navigation ref (handlers defined after navigatePrev/navigateNext)
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);

  useEffect(() => {
    if (!isAuthenticated) {
      router.push("/login");
    } else if (!supportsCalendar) {
      router.push("/");
    }
  }, [isAuthenticated, supportsCalendar, router]);

  useEffect(() => {
    if (error) {
      toast.error(error);
    }
  }, [error]);

  useEffect(() => {
    if (client && !hasFetched.current) {
      hasFetched.current = true;
      fetchCalendars(client);
    }
  }, [client, fetchCalendars]);

  const dateRange = useMemo(() => {
    const d = selectedDate;
    switch (viewMode) {
      case "month": {
        const ms = startOfMonth(d);
        const me = endOfMonth(d);
        return {
          start: format(startOfWeek(ms, { weekStartsOn: firstDayOfWeek }), "yyyy-MM-dd'T'00:00:00"),
          end: format(endOfWeek(me, { weekStartsOn: firstDayOfWeek }), "yyyy-MM-dd'T'23:59:59"),
        };
      }
      case "week": {
        const ws = startOfWeek(d, { weekStartsOn: firstDayOfWeek });
        return {
          start: format(ws, "yyyy-MM-dd'T'00:00:00"),
          end: format(addDays(ws, 6), "yyyy-MM-dd'T'23:59:59"),
        };
      }
      case "day":
        return {
          start: format(d, "yyyy-MM-dd'T'00:00:00"),
          end: format(d, "yyyy-MM-dd'T'23:59:59"),
        };
      case "agenda":
        return {
          start: format(d, "yyyy-MM-dd'T'00:00:00"),
          end: format(addDays(d, 30), "yyyy-MM-dd'T'23:59:59"),
        };
    }
  }, [selectedDate, viewMode, firstDayOfWeek]);

  useEffect(() => {
    if (client && calendars.length > 0) {
      fetchEvents(client, dateRange.start, dateRange.end);
    }
  }, [client, calendars.length, dateRange, fetchEvents]);

  const navigatePrev = useCallback(() => {
    let next: Date;
    switch (viewMode) {
      case "month": next = subMonths(selectedDate, 1); break;
      case "week": next = subWeeks(selectedDate, 1); break;
      case "day": next = subDays(selectedDate, 1); break;
      case "agenda": next = subMonths(selectedDate, 1); break;
    }
    setSelectedDate(next);
    setMiniMonth(next);
  }, [viewMode, selectedDate, setSelectedDate]);

  const navigateNext = useCallback(() => {
    let next: Date;
    switch (viewMode) {
      case "month": next = addMonths(selectedDate, 1); break;
      case "week": next = addWeeks(selectedDate, 1); break;
      case "day": next = addDays(selectedDate, 1); break;
      case "agenda": next = addMonths(selectedDate, 1); break;
    }
    setSelectedDate(next);
    setMiniMonth(next);
  }, [viewMode, selectedDate, setSelectedDate]);

  const goToToday = useCallback(() => {
    setSelectedDate(new Date());
    setMiniMonth(new Date());
  }, [setSelectedDate]);

  // Swipe navigation handlers for mobile
  const handleTouchStart = useCallback((e: ReactTouchEvent) => {
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
  }, []);

  const handleTouchEnd = useCallback((e: ReactTouchEvent) => {
    if (!touchStartRef.current || !isMobile) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;
    const elapsed = Date.now() - touchStartRef.current.time;
    touchStartRef.current = null;

    // Only trigger swipe if horizontal movement is dominant and fast enough
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && elapsed < 400) {
      if (dx > 0) navigatePrev();
      else navigateNext();
    }
  }, [isMobile, navigatePrev, navigateNext]);

  const handleSelectDate = useCallback((date: Date) => {
    setSelectedDate(date);
    setMiniMonth(date);
    // On mobile month view, tapping a date switches to day view
    if (isMobile && viewMode === "month") {
      setViewMode("day");
    }
  }, [setSelectedDate, isMobile, viewMode, setViewMode]);

  const handleMiniMonthChange = useCallback((date: Date) => {
    setMiniMonth(date);
    setSelectedDate(date);
  }, [setSelectedDate]);

  const openCreateModal = useCallback((date?: Date, endDate?: Date) => {
    setEditEvent(null);
    setDefaultModalDate(date || selectedDate);
    setDefaultModalEndDate(endDate);
    setShowEventModal(true);
  }, [selectedDate]);

  const openEditModal = useCallback((event: CalendarEvent) => {
    setEditEvent(event);
    setDefaultModalDate(undefined);
    setShowEventModal(true);
  }, []);

  const handleSelectEvent = useCallback((event: CalendarEvent, anchorRect: DOMRect) => {
    setDetailEvent(event);
    setDetailAnchorRect(anchorRect);
  }, []);

  const closeDetail = useCallback(() => {
    setDetailEvent(null);
    setDetailAnchorRect(null);
  }, []);

  const handleEditFromDetail = useCallback(() => {
    if (detailEvent) {
      const ev = detailEvent;
      closeDetail();
      openEditModal(ev);
    }
  }, [detailEvent, closeDetail, openEditModal]);

  const findMasterEvent = useCallback(async (occurrence: CalendarEvent): Promise<CalendarEvent | null> => {
    if ((occurrence.recurrenceRules?.length ?? 0) > 0 && !occurrence.recurrenceId) {
      return occurrence;
    }
    const master = events.find(e =>
      e.uid === occurrence.uid && !e.recurrenceId && (e.recurrenceRules?.length ?? 0) > 0
    );
    if (master) return master;
    if (!client) return null;
    try {
      const results = await client.queryCalendarEvents({ uid: occurrence.uid });
      return results.find(e => !e.recurrenceId && (e.recurrenceRules?.length ?? 0) > 0) || null;
    } catch (error) {
      debug.error("Failed to query master event for UID:", occurrence.uid, error);
      throw error;
    }
  }, [events, client]);

  const refetchCurrentRange = useCallback(async () => {
    if (!client) return;
    const { dateRange: currentRange } = useCalendarStore.getState();
    if (currentRange) {
      await fetchEvents(client, currentRange.start, currentRange.end);
    }
  }, [client, fetchEvents]);

  const handleSaveEvent = useCallback(async (data: Partial<CalendarEvent>, sendSchedulingMessages?: boolean) => {
    if (!client) { toast.error(t("notifications.event_error")); return; }
    try {
      if (editEvent) {
        if (isRecurringEvent(editEvent)) {
          setPendingScopeAction({
            type: "edit",
            event: editEvent,
            updates: data,
            sendScheduling: sendSchedulingMessages,
          });
          setShowEventModal(false);
          setEditEvent(null);
          return;
        }
        await updateEvent(client, editEvent.id, data, sendSchedulingMessages);
        toast.success(t("notifications.event_updated"));
      } else {
        const created = await createEvent(client, data, sendSchedulingMessages);
        if (!created) {
          toast.error(t("notifications.event_error"));
          return;
        }
        if (sendSchedulingMessages) {
          toast.success(t("notifications.invitation_sent"));
        } else {
          toast.success(t("notifications.event_created"));
        }
      }
      setShowEventModal(false);
      setEditEvent(null);
    } catch {
      toast.error(t("notifications.event_error"));
    }
  }, [client, editEvent, createEvent, updateEvent, t]);

  const handleDuplicateEvent = useCallback(async (data: Partial<CalendarEvent>) => {
    if (!client) { toast.error(t("notifications.event_error")); return; }
    try {
      const created = await createEvent(client, data);
      if (!created) {
        toast.error(t("notifications.event_error"));
        return;
      }
      toast.success(t("notifications.event_duplicated"));
      setEditEvent(created);
      setDefaultModalDate(undefined);
    } catch {
      toast.error(t("notifications.event_error"));
      setShowEventModal(false);
      setEditEvent(null);
    }
  }, [client, createEvent, t]);

  const handleDeleteEvent = useCallback(async (id: string, sendSchedulingMessages?: boolean) => {
    if (!client) { toast.error(t("notifications.event_error")); return; }
    const eventToDelete = events.find(e => e.id === id) || editEvent;
    if (eventToDelete && isRecurringEvent(eventToDelete)) {
      setPendingScopeAction({
        type: "delete",
        event: eventToDelete,
        sendScheduling: sendSchedulingMessages || undefined,
      });
      setShowEventModal(false);
      setEditEvent(null);
      return;
    }
    try {
      await deleteEvent(client, id, sendSchedulingMessages);
      toast.success(t("notifications.event_deleted"));
    } catch {
      toast.error(t("notifications.event_error"));
    }
  }, [client, deleteEvent, events, editEvent, t]);

  const truncateRecurrenceAtEvent = useCallback(async (event: CalendarEvent): Promise<{
    master: CalendarEvent;
    originalRules: CalendarEvent["recurrenceRules"];
  } | null> => {
    const master = await findMasterEvent(event);
    if (!master) return null;
    const originalRules = master.recurrenceRules
      ? JSON.parse(JSON.stringify(master.recurrenceRules))
      : null;
    const occurrenceDate = event.recurrenceId || event.start;
    const untilDate = new Date(occurrenceDate);
    untilDate.setSeconds(untilDate.getSeconds() - 1);
    const until = format(untilDate, "yyyy-MM-dd'T'HH:mm:ss");
    const truncatedRules = (master.recurrenceRules || []).map(rule => ({
      ...rule,
      until,
      count: null,
    }));
    await updateEvent(client!, master.id, { recurrenceRules: truncatedRules });
    return { master, originalRules };
  }, [client, findMasterEvent, updateEvent]);

  const handleScopeSelect = useCallback(async (scope: RecurrenceEditScope) => {
    if (!client || !pendingScopeAction) { toast.error(t("notifications.event_error")); return; }
    const { type, event, sendScheduling } = pendingScopeAction;
    const updates = type === "edit" ? pendingScopeAction.updates : undefined;
    setPendingScopeAction(null);

    try {
      if (type === "edit" && updates) {
        switch (scope) {
          case "this":
            await updateEvent(client, event.id, updates, sendScheduling);
            break;
          case "this_and_future": {
            const result = await truncateRecurrenceAtEvent(event);
            if (!result) {
              toast.error(t("notifications.event_error"));
              return;
            }
            const { master, originalRules } = result;
            const occurrenceStart = event.recurrenceId || event.start;
            const newEventData: Partial<CalendarEvent> = {
              title: master.title,
              description: master.description,
              duration: master.duration,
              timeZone: master.timeZone,
              calendarIds: { ...master.calendarIds },
              status: master.status,
              freeBusyStatus: master.freeBusyStatus,
              privacy: master.privacy,
              showWithoutTime: master.showWithoutTime,
              recurrenceRules: originalRules,
              ...updates,
              start: updates.start || occurrenceStart,
            };
            delete (newEventData as Record<string, unknown>).id;
            delete (newEventData as Record<string, unknown>).uid;
            delete (newEventData as Record<string, unknown>).recurrenceId;
            try {
              await createEvent(client, newEventData, sendScheduling);
            } catch (createError) {
              debug.error("Failed to create new series, rolling back master truncation:", createError);
              try {
                await updateEvent(client, master.id, { recurrenceRules: originalRules });
              } catch (rollbackError) {
                debug.error("Rollback of master event also failed:", rollbackError);
              }
              throw createError;
            }
            break;
          }
          case "all": {
            const master = await findMasterEvent(event);
            if (!master) {
              toast.error(t("notifications.event_error"));
              return;
            }
            const allUpdates = { ...updates };
            delete (allUpdates as Record<string, unknown>).recurrenceId;
            await updateEvent(client, master.id, allUpdates, sendScheduling);
            break;
          }
          default: {
            const _exhaustive: never = scope;
            throw new Error(`Unhandled scope: ${_exhaustive}`);
          }
        }
        toast.success(t("notifications.event_updated"));
      } else {
        switch (scope) {
          case "this":
            await deleteEvent(client, event.id, sendScheduling);
            break;
          case "this_and_future": {
            const result = await truncateRecurrenceAtEvent(event);
            if (!result) {
              toast.error(t("notifications.event_error"));
              return;
            }
            break;
          }
          case "all": {
            const master = await findMasterEvent(event);
            if (!master) {
              toast.error(t("notifications.event_error"));
              return;
            }
            await deleteEvent(client, master.id, sendScheduling);
            break;
          }
          default: {
            const _exhaustive: never = scope;
            throw new Error(`Unhandled scope: ${_exhaustive}`);
          }
        }
        toast.success(t("notifications.event_deleted"));
      }
      try {
        await refetchCurrentRange();
      } catch {
        debug.error("Failed to refresh calendar after scope operation");
      }
    } catch {
      toast.error(t("notifications.event_error"));
    }
  }, [client, pendingScopeAction, updateEvent, deleteEvent, createEvent, findMasterEvent, truncateRecurrenceAtEvent, refetchCurrentRange, t]);

  const handleRsvp = useCallback(async (eventId: string, participantId: string, status: CalendarParticipant['participationStatus']) => {
    if (!client) return;
    try {
      await rsvpEvent(client, eventId, participantId, status);
      toast.success(t("notifications.rsvp_updated"));
    } catch {
      toast.error(t("notifications.rsvp_error"));
    }
  }, [client, rsvpEvent, t]);

  const handleDeleteFromDetail = useCallback(() => {
    if (!detailEvent) return;
    const hasParticipants = detailEvent.participants && Object.keys(detailEvent.participants).length > 0;
    closeDetail();
    handleDeleteEvent(detailEvent.id, hasParticipants || undefined);
  }, [detailEvent, closeDetail, handleDeleteEvent]);

  const handleDuplicateFromDetail = useCallback(async () => {
    if (!detailEvent || !client) return;
    const start = parseISO(detailEvent.start);
    const newStart = addDays(start, 1);
    const data: Partial<CalendarEvent> = {
      title: detailEvent.title,
      description: detailEvent.description,
      start: format(newStart, "yyyy-MM-dd'T'HH:mm:ss"),
      duration: detailEvent.duration,
      timeZone: detailEvent.timeZone,
      showWithoutTime: detailEvent.showWithoutTime,
      calendarIds: { ...detailEvent.calendarIds },
      status: "confirmed",
      freeBusyStatus: detailEvent.freeBusyStatus,
      privacy: detailEvent.privacy,
    };
    if (detailEvent.locations) data.locations = structuredClone(detailEvent.locations);
    if (detailEvent.recurrenceRules) data.recurrenceRules = structuredClone(detailEvent.recurrenceRules);
    if (detailEvent.alerts) data.alerts = structuredClone(detailEvent.alerts);
    if (detailEvent.participants) data.participants = structuredClone(detailEvent.participants);
    closeDetail();
    try {
      const created = await createEvent(client, data);
      if (created) {
        toast.success(t("notifications.event_duplicated"));
        openEditModal(created);
      }
    } catch {
      toast.error(t("notifications.event_error"));
    }
  }, [detailEvent, client, createEvent, closeDetail, openEditModal, t]);

  const handleSaveNoteFromDetail = useCallback(async (note: string) => {
    if (!detailEvent || !client) return;
    const timestamp = format(new Date(), "yyyy-MM-dd HH:mm");
    const separator = `\n\n--- ${timestamp} ---\n`;
    const newDescription = detailEvent.description
      ? `${detailEvent.description}${separator}${note}`
      : `--- ${timestamp} ---\n${note}`;
    try {
      await updateEvent(client, detailEvent.id, { description: newDescription });
      setDetailEvent({ ...detailEvent, description: newDescription });
      toast.success(t("detail.note_saved"));
    } catch {
      toast.error(t("notifications.event_error"));
    }
  }, [detailEvent, client, updateEvent, t]);

  const handleRsvpFromDetail = useCallback(async (status: CalendarParticipant['participationStatus']) => {
    if (!detailEvent || !client) return;
    const participantId = getUserParticipantId(detailEvent, currentUserEmails);
    if (!participantId) return;
    closeDetail();
    await handleRsvp(detailEvent.id, participantId, status);
  }, [detailEvent, client, currentUserEmails, closeDetail, handleRsvp]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
      if (showEventModal || detailEvent) return;

      switch (e.key) {
        case "ArrowLeft": e.preventDefault(); navigatePrev(); break;
        case "ArrowRight": e.preventDefault(); navigateNext(); break;
        case "t": goToToday(); break;
        case "m": setViewMode("month"); break;
        case "w": setViewMode("week"); break;
        case "d": setViewMode("day"); break;
        case "a": setViewMode("agenda"); break;
        case "n": openCreateModal(); break;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [navigatePrev, navigateNext, goToToday, setViewMode, openCreateModal, showEventModal, detailEvent]);

  const visibleEvents = useMemo(() =>
    events.filter((e) => {
      const calIds = Object.keys(e.calendarIds);
      return calIds.some((id) => selectedCalendarIds.includes(id));
    }),
    [events, selectedCalendarIds]
  );

  if (!isAuthenticated || !supportsCalendar) return null;

  const renderView = () => {
    if (isLoading && calendars.length === 0) {
      return (
        <div className="flex items-center justify-center flex-1 text-muted-foreground">
          <p className="text-sm">{t("status.loading_calendars")}</p>
        </div>
      );
    }

    const viewContent = (() => {
      switch (viewMode) {
        case "month":
          return (
            <CalendarMonthView
              selectedDate={selectedDate}
              events={visibleEvents}
              calendars={calendars}
              onSelectDate={handleSelectDate}
              onSelectEvent={handleSelectEvent}
              firstDayOfWeek={firstDayOfWeek}
              isMobile={isMobile}
            />
          );
        case "week":
          return (
            <CalendarWeekView
              selectedDate={selectedDate}
              events={visibleEvents}
              calendars={calendars}
              onSelectDate={handleSelectDate}
              onSelectEvent={handleSelectEvent}
              onCreateAtTime={openCreateModal}
              firstDayOfWeek={firstDayOfWeek}
              timeFormat={timeFormat}
              isMobile={isMobile}
            />
          );
        case "day":
          return (
            <CalendarDayView
              selectedDate={selectedDate}
              events={visibleEvents}
              calendars={calendars}
              onSelectEvent={handleSelectEvent}
              onCreateAtTime={openCreateModal}
              timeFormat={timeFormat}
              isMobile={isMobile}
            />
          );
        case "agenda":
          return (
            <CalendarAgendaView
              selectedDate={selectedDate}
              events={visibleEvents}
              calendars={calendars}
              onSelectEvent={handleSelectEvent}
              timeFormat={timeFormat}
            />
          );
      }
    })();

    return (
      <div className="relative flex-1 flex flex-col overflow-hidden">
        {viewContent}
        {isLoadingEvents && calendars.length > 0 && (
          <div className="absolute inset-0 bg-background/50 flex items-center justify-center pointer-events-none">
            <div className="h-5 w-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-screen bg-background">
      {/* Left Navigation Rail */}
      {!isMobile && (
        <div className="w-14 border-r border-border bg-secondary flex flex-col items-center py-3 flex-shrink-0">
          <NavigationRail collapsed className="py-0" />
        </div>
      )}

      <div className="flex flex-col flex-1 min-w-0">
        <CalendarToolbar
          selectedDate={selectedDate}
          viewMode={viewMode}
          onPrev={navigatePrev}
          onNext={navigateNext}
          onToday={goToToday}
          onViewModeChange={setViewMode}
          onCreateEvent={() => openCreateModal()}
          onImport={() => setShowImportModal(true)}
          isMobile={isMobile}
          calendars={calendars}
          selectedCalendarIds={selectedCalendarIds}
          onToggleVisibility={toggleCalendarVisibility}
        />

        <div
          className="flex flex-1 overflow-hidden relative"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {!isMobile && (
            <div className="w-60 border-r border-border p-3 overflow-y-auto flex-shrink-0">
              <MiniCalendar
                selectedDate={selectedDate}
                displayMonth={miniMonth}
                onSelectDate={handleSelectDate}
                onChangeMonth={handleMiniMonthChange}
                events={events}
                firstDayOfWeek={firstDayOfWeek}
              />
              <CalendarSidebarPanel
                calendars={calendars}
                selectedCalendarIds={selectedCalendarIds}
                onToggleVisibility={toggleCalendarVisibility}
              />
            </div>
          )}

          {renderView()}

          {/* Floating Create Event Button (mobile) */}
          {isMobile && (
            <Button
              onClick={() => openCreateModal()}
              className="absolute bottom-4 right-4 z-40 h-14 w-14 rounded-full shadow-lg"
              aria-label={t("events.create")}
            >
              <Plus className="h-6 w-6" />
            </Button>
          )}
        </div>

        {/* Mobile Bottom Navigation */}
        {isMobile && (
          <NavigationRail orientation="horizontal" />
        )}
      </div>

      {detailEvent && detailAnchorRect && (
        <EventDetailPopover
          event={detailEvent}
          calendar={calendars.find(c => detailEvent.calendarIds[c.id])}
          anchorRect={detailAnchorRect}
          onEdit={handleEditFromDetail}
          onDelete={handleDeleteFromDetail}
          onDuplicate={handleDuplicateFromDetail}
          onClose={closeDetail}
          onSaveNote={handleSaveNoteFromDetail}
          onRsvp={handleRsvpFromDetail}
          currentUserEmails={currentUserEmails}
          timeFormat={timeFormat}
          isMobile={isMobile}
        />
      )}

      {showEventModal && (
        <EventModal
          event={editEvent}
          calendars={calendars}
          defaultDate={defaultModalDate}
          defaultEndDate={defaultModalEndDate}
          onSave={handleSaveEvent}
          onDelete={handleDeleteEvent}
          onDuplicate={handleDuplicateEvent}
          onRsvp={handleRsvp}
          onClose={() => { setShowEventModal(false); setEditEvent(null); }}
          currentUserEmails={currentUserEmails}
        />
      )}

      {showImportModal && client && (
        <ICalImportModal
          calendars={calendars}
          client={client}
          onClose={() => setShowImportModal(false)}
        />
      )}

      <RecurrenceScopeDialog
        isOpen={!!pendingScopeAction}
        actionType={pendingScopeAction?.type || "edit"}
        onSelect={handleScopeSelect}
        onClose={() => setPendingScopeAction(null)}
      />
    </div>
  );
}
