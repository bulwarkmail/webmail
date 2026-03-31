"use client";

import { useState, useEffect, useCallback, useRef, useMemo, type TouchEvent as ReactTouchEvent } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import {
  startOfMonth, endOfMonth, startOfWeek, endOfWeek,
  addMonths, subMonths, addWeeks, subWeeks, addDays, subDays,
  startOfDay, format, parseISO,
} from "date-fns";
import { useCalendarStore } from "@/stores/calendar-store";
import { isCalendarViewMode } from "@/stores/calendar-store";
import { useAuthStore, redirectToLogin } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
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
import { TaskListView } from "@/components/calendar/task-list-view";
import { TaskToolbar } from "@/components/calendar/task-toolbar";
import { TaskModal } from "@/components/calendar/task-modal";
import { MiniCalendar } from "@/components/calendar/mini-calendar";
import { CalendarSidebarPanel } from "@/components/calendar/calendar-sidebar-panel";
import { EventModal, type PendingEventPreview } from "@/components/calendar/event-modal";
import { EventDetailPopover } from "@/components/calendar/event-detail-popover";
import { ICalImportModal } from "@/components/calendar/ical-import-modal";
import { ICalSubscriptionModal } from "@/components/calendar/ical-subscription-modal";
import { RecurrenceScopeDialog, type RecurrenceEditScope } from "@/components/calendar/recurrence-scope-dialog";
import { NavigationRail } from "@/components/layout/navigation-rail";
import { SidebarAppsModal } from "@/components/layout/sidebar-apps-modal";
import { InlineAppView } from "@/components/layout/inline-app-view";
import { useSidebarApps } from "@/hooks/use-sidebar-apps";
import { ResizeHandle } from "@/components/layout/resize-handle";
import { sanitizeOutgoingCalendarEventData } from "@/lib/calendar-event-normalization";
import { getEventStartDate } from "@/lib/calendar-utils";
import { useTaskStore } from "@/stores/task-store";
import { cn } from "@/lib/utils";
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
  const { showAppsModal, inlineApp, loadedApps, handleManageApps, handleInlineApp, closeInlineApp, closeAppsModal } = useSidebarApps();
  const { client, isAuthenticated, logout, checkAuth, isLoading: authLoading } = useAuthStore();
  const [initialCheckDone, setInitialCheckDone] = useState(() => useAuthStore.getState().isAuthenticated && !!useAuthStore.getState().client);
  const { quota, isPushConnected } = useEmailStore();
  const {
    calendars, events, selectedDate, viewMode, selectedCalendarIds,
    isLoading, isLoadingEvents, supportsCalendar, error,
    fetchCalendars, fetchEvents, createEvent, updateEvent, deleteEvent, rsvpEvent,
    setSelectedDate, setViewMode, toggleCalendarVisibility, updateCalendar,
    refreshAllSubscriptions, icalSubscriptions,
  } = useCalendarStore();
  const { firstDayOfWeek, timeFormat, showWeekNumbers, enableCalendarTasks, showTasksOnCalendar, calendarHoverPreview } = useSettingsStore();
  const taskStore = useTaskStore();
  const fetchTasksFn = useTaskStore(state => state.fetchTasks);
  const { identities } = useIdentityStore();
  const normalizedViewMode = isCalendarViewMode(viewMode) ? viewMode : "month";

  const currentUserEmails = useMemo(() =>
    identities.map(id => id.email).filter(Boolean),
    [identities]
  );

  const [showEventModal, setShowEventModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);
  const [editingSubscription, setEditingSubscription] = useState<string | null>(null);
  const [editEvent, setEditEvent] = useState<CalendarEvent | null>(null);
  const [defaultModalDate, setDefaultModalDate] = useState<Date | undefined>();
  const [defaultModalEndDate, setDefaultModalEndDate] = useState<Date | undefined>();
  const [miniMonth, setMiniMonth] = useState(new Date());
  const [pendingScopeAction, setPendingScopeAction] = useState<PendingScopeAction | null>(null);
  const [detailEvent, setDetailEvent] = useState<CalendarEvent | null>(null);
  const [detailAnchorRect, setDetailAnchorRect] = useState<DOMRect | null>(null);
  const [pendingPreview, setPendingPreview] = useState<PendingEventPreview | null>(null);
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [editTask, setEditTask] = useState<import("@/lib/jmap/types").CalendarTask | null>(null);
  const [mobileReturnToMonth, setMobileReturnToMonth] = useState(false);
  const [swipeDirection, setSwipeDirection] = useState<'left' | 'right' | null>(null);
  const [swipeKey, setSwipeKey] = useState(0);
  const hasFetched = useRef(false);

  // Sidebar resize state
  const [calSidebarWidth, setCalSidebarWidth] = useState(() => {
    try { const v = localStorage.getItem("calendar-sidebar-width"); return v ? Number(v) : 256; } catch { return 256; }
  });
  const [isResizing, setIsResizing] = useState(false);
  const dragStartWidth = useRef(256);

  // Swipe navigation ref (handlers defined after navigatePrev/navigateNext)
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);

  // Check auth on mount
  useEffect(() => {
    checkAuth().finally(() => {
      setInitialCheckDone(true);
    });
  }, [checkAuth]);

  useEffect(() => {
    if (initialCheckDone && !isAuthenticated && !authLoading) {
      try { sessionStorage.setItem('redirect_after_login', window.location.pathname); } catch { /* ignore */ }
      redirectToLogin();
    } else if (client && !supportsCalendar) {
      router.push("/");
    }
  }, [initialCheckDone, isAuthenticated, authLoading, client, supportsCalendar, router]);

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

  // Auto-refresh iCal subscriptions
  useEffect(() => {
    if (!client) return;
    // Refresh on mount (respects per-subscription interval)
    refreshAllSubscriptions(client);
    // Check again every 5 minutes
    const interval = setInterval(() => refreshAllSubscriptions(client), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [client, refreshAllSubscriptions]);

  const dateRange = useMemo(() => {
    const d = selectedDate;
    switch (normalizedViewMode) {
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
      case "agenda": {
        // Agenda always starts from today at the earliest
        const today = startOfDay(new Date());
        const agendaStart = d >= today ? d : today;
        return {
          start: format(agendaStart, "yyyy-MM-dd'T'00:00:00"),
          end: format(addDays(agendaStart, 30), "yyyy-MM-dd'T'23:59:59"),
        };
      }
      case "tasks":
        return null;
    }
  }, [selectedDate, normalizedViewMode, firstDayOfWeek]);

  // Fetch tasks when tasks view is active or when tasks are shown on calendar grid
  useEffect(() => {
    if (client && enableCalendarTasks && (normalizedViewMode === "tasks" || showTasksOnCalendar)) {
      fetchTasksFn(client);
    }
  }, [client, enableCalendarTasks, normalizedViewMode, showTasksOnCalendar, fetchTasksFn]);

  useEffect(() => {
    if (client && calendars.length > 0 && dateRange) {
      fetchEvents(client, dateRange.start, dateRange.end);
    }
  }, [client, calendars.length, dateRange, fetchEvents]);

  const navigatePrev = useCallback(() => {
    let next: Date;
    switch (normalizedViewMode) {
      case "month": next = subMonths(selectedDate, 1); break;
      case "week": next = subWeeks(selectedDate, 1); break;
      case "day": next = subDays(selectedDate, 1); break;
      case "agenda": next = subMonths(selectedDate, 1); break;
      case "tasks": return;
    }
    setSelectedDate(next);
    setMiniMonth(next);
  }, [normalizedViewMode, selectedDate, setSelectedDate]);

  const navigateNext = useCallback(() => {
    let next: Date;
    switch (normalizedViewMode) {
      case "month": next = addMonths(selectedDate, 1); break;
      case "week": next = addWeeks(selectedDate, 1); break;
      case "day": next = addDays(selectedDate, 1); break;
      case "agenda": next = addMonths(selectedDate, 1); break;
      case "tasks": return;
    }
    setSelectedDate(next);
    setMiniMonth(next);
  }, [normalizedViewMode, selectedDate, setSelectedDate]);

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
    // Week view has its own horizontal scroll, skip swipe navigation
    if (normalizedViewMode === 'week') { touchStartRef.current = null; return; }
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;
    const elapsed = Date.now() - touchStartRef.current.time;
    touchStartRef.current = null;

    // Only trigger swipe if horizontal movement is dominant and fast enough
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && elapsed < 400) {
      if (dx > 0) {
        setSwipeDirection('right');
        navigatePrev();
      } else {
        setSwipeDirection('left');
        navigateNext();
      }
      setSwipeKey(k => k + 1);
      // Clear direction after animation completes
      setTimeout(() => setSwipeDirection(null), 250);
    }
  }, [isMobile, normalizedViewMode, navigatePrev, navigateNext]);

  const handleSelectDate = useCallback((date: Date) => {
    setSelectedDate(date);
    setMiniMonth(date);
    // On mobile month view, tapping a date switches to day view
    if (isMobile && normalizedViewMode === "month") {
      setMobileReturnToMonth(true);
      setViewMode("day");
    }
  }, [setSelectedDate, isMobile, normalizedViewMode, setViewMode]);

  const navigateBackToMonth = useCallback(() => {
    setMobileReturnToMonth(false);
    setViewMode("month");
  }, [setViewMode]);

  const handleMiniMonthChange = useCallback((date: Date) => {
    setMiniMonth(date);
    setSelectedDate(date);
  }, [setSelectedDate]);

  const openCreateModal = useCallback((date?: Date, endDate?: Date) => {
    setEditEvent(null);
    const d = date || selectedDate;
    setDefaultModalDate(d);
    setDefaultModalEndDate(endDate);
    setSelectedDate(d);
    setShowEventModal(true);
  }, [selectedDate, setSelectedDate]);

  const openEditModal = useCallback((event: CalendarEvent) => {
    setEditEvent(event);
    setDefaultModalDate(undefined);
    setShowEventModal(true);
  }, []);

  const openCreateTaskModal = useCallback(() => {
    setEditTask(null);
    setShowTaskModal(true);
  }, []);

  const openEditTaskModal = useCallback((task: import("@/lib/jmap/types").CalendarTask) => {
    setEditTask(task);
    setShowTaskModal(true);
  }, []);

  const handleSaveTask = useCallback(async (data: Partial<import("@/lib/jmap/types").CalendarTask>) => {
    if (!client) return;
    if (editTask) {
      await taskStore.updateTask(client, editTask.id, data);
    } else {
      await taskStore.createTask(client, data);
    }
    setShowTaskModal(false);
    setEditTask(null);
  }, [client, editTask, taskStore]);

  const handleDeleteTask = useCallback(async (id: string) => {
    if (!client) return;
    await taskStore.deleteTask(client, id);
    setShowTaskModal(false);
    setEditTask(null);
  }, [client, taskStore]);

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeDetail = useCallback(() => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    setDetailEvent(null);
    setDetailAnchorRect(null);
  }, []);

  const handleSelectEvent = useCallback((event: CalendarEvent, _anchorRect: DOMRect) => {
    // Click opens the sidebar for viewing/editing
    closeDetail();
    openEditModal(event);
  }, [closeDetail, openEditModal]);

  const handleHoverEvent = useCallback((event: CalendarEvent, anchorRect: DOMRect) => {
    if (isMobile) return;
    if (calendarHoverPreview === 'off') return;
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    // Don't show hover popover if the sidebar is already open for this event
    if (showEventModal && editEvent?.id === event.id) return;
    if (calendarHoverPreview === 'delay-500ms' || calendarHoverPreview === 'delay-1s' || calendarHoverPreview === 'delay-2s') {
      const ms = calendarHoverPreview === 'delay-500ms' ? 500 : calendarHoverPreview === 'delay-1s' ? 1000 : 2000;
      hoverTimerRef.current = setTimeout(() => {
        setDetailEvent(event);
        setDetailAnchorRect(anchorRect);
      }, ms);
    } else {
      setDetailEvent(event);
      setDetailAnchorRect(anchorRect);
    }
  }, [isMobile, calendarHoverPreview, showEventModal, editEvent]);

  const handleHoverLeave = useCallback(() => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    hoverTimerRef.current = setTimeout(() => {
      setDetailEvent(null);
      setDetailAnchorRect(null);
    }, 300);
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

  const focusCalendarOnEvent = useCallback((event: Pick<Partial<CalendarEvent>, "start" | "utcStart" | "showWithoutTime">) => {
    if (!event.start) {
      return;
    }

    const eventDate = getEventStartDate({
      start: event.start,
      utcStart: event.utcStart ?? null,
      showWithoutTime: event.showWithoutTime ?? false,
    });
    if (Number.isNaN(eventDate.getTime())) {
      return;
    }

    setSelectedDate(eventDate);
    setMiniMonth(eventDate);
  }, [setSelectedDate]);

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
        if (data.start) {
          focusCalendarOnEvent({ start: data.start });
        }
        toast.success(t("notifications.event_updated"));
      } else {
        const created = await createEvent(client, data, sendSchedulingMessages);
        if (!created) {
          toast.error(t("notifications.event_error"));
          return;
        }
        focusCalendarOnEvent(created);
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
  }, [client, editEvent, createEvent, updateEvent, focusCalendarOnEvent, t]);

  const handleDuplicateEvent = useCallback(async (data: Partial<CalendarEvent>) => {
    if (!client) { toast.error(t("notifications.event_error")); return; }
    try {
      const created = await createEvent(client, data);
      if (!created) {
        toast.error(t("notifications.event_error"));
        return;
      }
      focusCalendarOnEvent(created);
      toast.success(t("notifications.event_duplicated"));
      setEditEvent(created);
      setDefaultModalDate(undefined);
    } catch {
      toast.error(t("notifications.event_error"));
      setShowEventModal(false);
      setEditEvent(null);
    }
  }, [client, createEvent, focusCalendarOnEvent, t]);

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
          case "this": {
            // Synthetic IDs (from expandRecurrences) can't be updated directly.
            // Patch the master event's recurrenceOverrides instead.
            const master = await findMasterEvent(event);
            if (master && event.recurrenceId) {
              const patchUpdates: Record<string, unknown> = {};
              for (const [key, value] of Object.entries(updates)) {
                if (['id', 'uid', '@type', 'calendarIds', 'recurrenceRules', 'recurrenceOverrides', 'excludedRecurrenceRules'].includes(key)) continue;
                patchUpdates[`recurrenceOverrides/${event.recurrenceId}/${key}`] = value;
              }
              await updateEvent(client, master.id, patchUpdates as Partial<CalendarEvent>, sendScheduling);
            } else {
              await updateEvent(client, event.id, updates, sendScheduling);
            }
            break;
          }
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
          case "this": {
            // Synthetic IDs (from expandRecurrences) can't be destroyed directly.
            // Exclude the instance via recurrenceOverrides on the master event.
            const delMaster = await findMasterEvent(event);
            if (delMaster && event.recurrenceId) {
              await updateEvent(
                client, delMaster.id,
                { [`recurrenceOverrides/${event.recurrenceId}`]: { excluded: true } } as Partial<CalendarEvent>,
              );
            } else {
              await deleteEvent(client, event.id, sendScheduling);
            }
            break;
          }
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
    const data = sanitizeOutgoingCalendarEventData<Partial<CalendarEvent>>({
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
    });
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
      if (target.getAttribute("contenteditable") === "true") return;
      if (showEventModal || detailEvent) return;

      switch (e.key) {
        case "ArrowLeft": e.preventDefault(); navigatePrev(); break;
        case "ArrowRight": e.preventDefault(); navigateNext(); break;
        case "t": goToToday(); break;
        case "m": setViewMode("month"); break;
        case "w": setViewMode("week"); break;
        case "d": setViewMode("day"); break;
        case "a": setViewMode("agenda"); break;
        case "k": if (enableCalendarTasks) setViewMode("tasks"); break;
        case "n": openCreateModal(); break;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [navigatePrev, navigateNext, goToToday, setViewMode, openCreateModal, showEventModal, detailEvent, enableCalendarTasks]);

  const visibleEvents = useMemo(() =>
    events.filter((e) => {
      if (!e.start || !e.calendarIds) return false;
      const calIds = Object.keys(e.calendarIds);
      return calIds.some((id) => selectedCalendarIds.includes(id));
    }),
    [events, selectedCalendarIds]
  );

  useEffect(() => {
    const hiddenEvents = events.filter((event) => {
      if (!event.start || !event.calendarIds) {
        return true;
      }

      return !Object.keys(event.calendarIds).some((calendarId) => selectedCalendarIds.includes(calendarId));
    });

    if (hiddenEvents.length === 0) {
      return;
    }

    debug.log('calendar', 'Calendar visibility summary', {
      totalEvents: events.length,
      visibleEvents: visibleEvents.length,
      hiddenEvents: hiddenEvents.length,
      selectedCalendarIds,
      hiddenSamples: hiddenEvents.slice(0, 5).map((event) => ({
        id: event.id,
        originalId: event.originalId,
        title: event.title,
        calendarIds: event.calendarIds,
        originalCalendarIds: event.originalCalendarIds,
        accountId: event.accountId,
      })),
    });
  }, [events, selectedCalendarIds, visibleEvents]);

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
      switch (normalizedViewMode) {
        case "month":
          return (
            <CalendarMonthView
              selectedDate={selectedDate}
              events={visibleEvents}
              calendars={calendars}
              onSelectDate={handleSelectDate}
              onSelectEvent={handleSelectEvent}
              onHoverEvent={handleHoverEvent}
              onHoverLeave={handleHoverLeave}
              onCreateAtTime={openCreateModal}
              firstDayOfWeek={firstDayOfWeek}
              isMobile={isMobile}
              pendingPreview={pendingPreview}
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
              onHoverEvent={handleHoverEvent}
              onHoverLeave={handleHoverLeave}
              onCreateAtTime={openCreateModal}
              firstDayOfWeek={firstDayOfWeek}
              timeFormat={timeFormat}
              isMobile={isMobile}
              pendingPreview={pendingPreview}
              tasks={enableCalendarTasks && showTasksOnCalendar ? taskStore.tasks : undefined}
              onToggleTaskComplete={(task) => { if (client) taskStore.toggleTaskComplete(client, task); }}
            />
          );
        case "day":
          return (
            <CalendarDayView
              selectedDate={selectedDate}
              events={visibleEvents}
              calendars={calendars}
              onSelectEvent={handleSelectEvent}
              onHoverEvent={handleHoverEvent}
              onHoverLeave={handleHoverLeave}
              onCreateAtTime={openCreateModal}
              timeFormat={timeFormat}
              isMobile={isMobile}
              pendingPreview={pendingPreview}
              tasks={enableCalendarTasks && showTasksOnCalendar ? taskStore.tasks : undefined}
              onToggleTaskComplete={(task) => { if (client) taskStore.toggleTaskComplete(client, task); }}
            />
          );
        case "agenda":
          return (
            <CalendarAgendaView
              selectedDate={selectedDate}
              events={visibleEvents}
              calendars={calendars}
              onSelectEvent={handleSelectEvent}
              onHoverEvent={handleHoverEvent}
              onHoverLeave={handleHoverLeave}
              timeFormat={timeFormat}
            />
          );
        case "tasks":
          return (
            <div className="flex flex-col h-full">
              <TaskToolbar
                filter={taskStore.filter}
                showCompleted={taskStore.showCompleted}
                onFilterChange={taskStore.setFilter}
                onShowCompletedChange={taskStore.setShowCompleted}
                onCreateTask={openCreateTaskModal}
              />
              <TaskListView
                tasks={taskStore.tasks}
                calendars={calendars}
                selectedCalendarIds={selectedCalendarIds}
                filter={taskStore.filter}
                showCompleted={taskStore.showCompleted}
                onSelectTask={openEditTaskModal}
                onToggleComplete={(task) => { if (client) taskStore.toggleTaskComplete(client, task); }}
                selectedTaskId={taskStore.selectedTaskId}
                onQuickCreate={(title) => {
                  if (client) {
                    taskStore.createTask(client, { "@type": "Task", title, progress: "needs-action", calendarIds: { [calendars[0]?.id ?? ""]: true } });
                  }
                }}
              />
            </div>
          );
      }
    })();

    return (
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {viewContent}
        {isLoadingEvents && calendars.length > 0 && events.length === 0 && (
          <div className="absolute inset-0 bg-background/50 flex items-center justify-center pointer-events-none">
            <div className="h-5 w-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={cn("flex h-dvh bg-background overflow-hidden", isMobile && "flex-col")}>
      {/* Left Navigation Rail */}
      {!isMobile && (
        <div className="w-14 bg-secondary flex flex-col flex-shrink-0" style={{ borderRight: '1px solid rgba(128, 128, 128, 0.3)' }}>
          <NavigationRail
            collapsed
            quota={quota}
            isPushConnected={isPushConnected}
            onLogout={logout}
            onManageApps={handleManageApps}
            onInlineApp={handleInlineApp}
            onCloseInlineApp={closeInlineApp}
            activeAppId={inlineApp?.id ?? null}
          />
        </div>
      )}

      {inlineApp && (
        <InlineAppView apps={loadedApps} activeAppId={inlineApp!.id} onClose={closeInlineApp} className="flex-1" />
      )}

      {/* Sidebar - full height */}
      {!isMobile && !inlineApp && (
        <>
          <div
            className={cn(
              "border-r border-border bg-secondary overflow-y-auto flex-shrink-0 p-3",
              !isResizing && "transition-[width] duration-300"
            )}
            style={{ width: `${calSidebarWidth}px` }}
          >
            <MiniCalendar
              selectedDate={selectedDate}
              displayMonth={miniMonth}
              onSelectDate={handleSelectDate}
              onChangeMonth={handleMiniMonthChange}
              events={events}
              firstDayOfWeek={firstDayOfWeek}
              showWeekNumbers={showWeekNumbers}
            />
            <CalendarSidebarPanel
              calendars={calendars}
              selectedCalendarIds={selectedCalendarIds}
              onToggleVisibility={toggleCalendarVisibility}
              onColorChange={client ? (calendarId, color) => {
                updateCalendar(client, calendarId, { color });
              } : undefined}
              onSubscribe={() => setShowSubscriptionModal(true)}
              onEditSubscription={(subId) => setEditingSubscription(subId)}
              client={client}
            />
          </div>
          <ResizeHandle
            onResizeStart={() => { dragStartWidth.current = calSidebarWidth; setIsResizing(true); }}
            onResize={(delta) => setCalSidebarWidth(Math.max(180, Math.min(400, dragStartWidth.current + delta)))}
            onResizeEnd={() => {
              setIsResizing(false);
              localStorage.setItem("calendar-sidebar-width", String(calSidebarWidth));
            }}
            onDoubleClick={() => { setCalSidebarWidth(256); localStorage.setItem("calendar-sidebar-width", "256"); }}
          />
        </>
      )}

      {!inlineApp && (
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        <CalendarToolbar
          selectedDate={selectedDate}
          viewMode={normalizedViewMode}
          onPrev={navigatePrev}
          onNext={navigateNext}
          onToday={goToToday}
          onViewModeChange={(mode) => { setMobileReturnToMonth(false); setViewMode(mode); }}
          onCreateEvent={() => openCreateModal()}
          onImport={() => setShowImportModal(true)}
          onSubscribe={() => setShowSubscriptionModal(true)}
          isMobile={isMobile}
          onNavigateBack={isMobile && mobileReturnToMonth && normalizedViewMode === "day" ? navigateBackToMonth : undefined}
          calendars={calendars}
          selectedCalendarIds={selectedCalendarIds}
          onToggleVisibility={toggleCalendarVisibility}
          enableCalendarTasks={enableCalendarTasks}
        />

        <div
          className="flex flex-1 overflow-hidden relative"
          data-tour="calendar-view"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <div
            key={swipeKey}
            className={cn(
              "flex flex-1 min-w-0",
              isMobile && swipeDirection === 'left' && "animate-slide-in-right",
              isMobile && swipeDirection === 'right' && "animate-slide-in-left",
            )}
          >
            {renderView()}
          </div>

          {/* Desktop event panel */}
          {!isMobile && showEventModal && (
            <div className="w-[400px] border-l border-border flex-shrink-0 overflow-hidden">
              <EventModal
                key={editEvent?.id ?? 'new'}
                event={editEvent}
                calendars={calendars}
                defaultDate={defaultModalDate}
                defaultEndDate={defaultModalEndDate}
                onSave={handleSaveEvent}
                onDelete={handleDeleteEvent}
                onDuplicate={handleDuplicateEvent}
                onRsvp={handleRsvp}
                onClose={() => { setShowEventModal(false); setEditEvent(null); setPendingPreview(null); }}
                onPreviewChange={setPendingPreview}
                currentUserEmails={currentUserEmails}
                isMobile={false}
              />
            </div>
          )}

          {/* Desktop task panel */}
          {!isMobile && showTaskModal && (
            <div className="w-[400px] border-l border-border flex-shrink-0 overflow-hidden">
              <TaskModal
                key={editTask?.id ?? 'new-task'}
                task={editTask}
                calendars={calendars}
                onSave={handleSaveTask}
                onDelete={handleDeleteTask}
                onClose={() => { setShowTaskModal(false); setEditTask(null); }}
                isMobile={false}
              />
            </div>
          )}

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
      </div>
      )}

      {/* Mobile Bottom Navigation */}
      {isMobile && (
        <div className="shrink-0">
          <NavigationRail
            orientation="horizontal"
            onManageApps={handleManageApps}
            onInlineApp={handleInlineApp}
            onCloseInlineApp={closeInlineApp}
            activeAppId={inlineApp?.id ?? null}
          />
        </div>
      )}

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
          onMouseEnter={() => { if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; } }}
          onMouseLeave={handleHoverLeave}
          currentUserEmails={currentUserEmails}
          timeFormat={timeFormat}
          isMobile={isMobile}
        />
      )}

      {showEventModal && isMobile && (
        <EventModal
          key={editEvent?.id ?? 'new'}
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
          isMobile={true}
        />
      )}

      {showImportModal && client && (
        <ICalImportModal
          calendars={calendars}
          client={client}
          onClose={() => setShowImportModal(false)}
        />
      )}

      {showSubscriptionModal && client && (
        <ICalSubscriptionModal
          client={client}
          onClose={() => setShowSubscriptionModal(false)}
        />
      )}

      {editingSubscription && client && (() => {
        const sub = icalSubscriptions.find(s => s.id === editingSubscription);
        if (!sub) return null;
        return (
          <ICalSubscriptionModal
            client={client}
            editSubscription={sub}
            onClose={() => setEditingSubscription(null)}
          />
        );
      })()}

      <SidebarAppsModal isOpen={showAppsModal} onClose={closeAppsModal} />
      <RecurrenceScopeDialog
        isOpen={!!pendingScopeAction}
        actionType={pendingScopeAction?.type || "edit"}
        onSelect={handleScopeSelect}
        onClose={() => setPendingScopeAction(null)}
      />
    </div>
  );
}
