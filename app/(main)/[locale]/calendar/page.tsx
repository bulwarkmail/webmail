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
import { useAccountStore } from "@/stores/account-store";
import { usePolicyStore } from "@/stores/policy-store";
import { toast } from "@/stores/toast-store";
import { useIsDesktop, useIsMobile } from "@/hooks/use-media-query";
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
import { EventContextMenu } from "@/components/calendar/event-context-menu";
import { AppTopBannerSlot } from "@/components/plugins/app-top-banner-slot";
import { EmptySpaceContextMenu } from "@/components/calendar/empty-space-context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { useRefreshGesture } from "@/hooks/use-refresh-gesture";
import { downloadEventICS } from "@/lib/calendar-ics-export";
import { ICalImportModal } from "@/components/calendar/ical-import-modal";
import { ICalSubscriptionModal } from "@/components/calendar/ical-subscription-modal";
import { ProtocolAccountPicker } from "@/components/protocol/protocol-account-picker";
import { RecurrenceScopeDialog, type RecurrenceEditScope } from "@/components/calendar/recurrence-scope-dialog";
import { NavigationRail } from "@/components/layout/navigation-rail";
import { SidebarAppsModal } from "@/components/layout/sidebar-apps-modal";
import { InlineAppView } from "@/components/layout/inline-app-view";
import { useSidebarApps } from "@/hooks/use-sidebar-apps";
import { useIsEmbedded } from "@/hooks/use-is-embedded";
import { useProMultiAccountCalendars } from "@/hooks/use-pro-multi-account-calendars";
import { ResizeHandle } from "@/components/layout/resize-handle";
import { sanitizeOutgoingCalendarEventData } from "@/lib/calendar-event-normalization";
import { getEventStartDate } from "@/lib/calendar-utils";
import { useTaskStore } from "@/stores/task-store";
import { useContactStore } from "@/stores/contact-store";
import { cn } from "@/lib/utils";
import type { Calendar, CalendarEvent, CalendarParticipant, CalendarRights } from "@/lib/jmap/types";
import { ShareCollectionDialog } from "@/components/settings/share-collection-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { CreateCalendarModal } from "@/components/calendar/create-calendar-modal";
import { getUserParticipantId } from "@/lib/calendar-participants";
import { generateBirthdayEvents, createBirthdayCalendar, BIRTHDAY_CALENDAR_ID } from "@/lib/birthday-calendar";
import { sharedCalendarColorKey, pickUnusedCalendarColor } from "@/lib/shared-calendar-colors";
import { debug } from "@/lib/debug";
import { consumePendingWebcal, hasPendingWebcal, subscribeToPendingWebcal } from "@/lib/protocol-handlers/session";
import type { ParsedWebcal } from "@/lib/protocol-handlers/webcal";

type PendingScopeAction =
  | { type: "edit"; event: CalendarEvent; updates: Partial<CalendarEvent>; sendScheduling?: boolean }
  | { type: "delete"; event: CalendarEvent; sendScheduling?: boolean };

function isRecurringEvent(event: CalendarEvent): boolean {
  return (event.recurrenceRules?.length ?? 0) > 0 || event.recurrenceId != null;
}

export default function CalendarPage() {
  const router = useRouter();
  const t = useTranslations("calendar");
  const tWebcalAction = useTranslations("calendar.webcal_action");
  const isMobile = useIsMobile();
  const isDesktop = useIsDesktop();
  const isEmbedded = useIsEmbedded();
  // When the pane (Pro shell) or window is narrower than `lg`, the sidebar
  // collapses into a burger-toggled overlay instead of taking inline space.
  const isNarrow = !isDesktop;
  const [narrowSidebarOpen, setNarrowSidebarOpen] = useState(false);
  useEffect(() => { if (!isNarrow) setNarrowSidebarOpen(false); }, [isNarrow]);
  const { showAppsModal, inlineApp, loadedApps, handleManageApps, handleInlineApp, closeInlineApp, closeAppsModal } = useSidebarApps();
  const { client, isAuthenticated, logout, checkAuth, switchAccount, activeAccountId, isLoading: authLoading } = useAuthStore();
  const [initialCheckDone, setInitialCheckDone] = useState(() => useAuthStore.getState().isAuthenticated && !!useAuthStore.getState().client);
  const { quota, isPushConnected } = useEmailStore();
  const {
    calendars, events, selectedDate, viewMode, selectedCalendarIds,
    isLoading, isLoadingEvents, supportsCalendar, error,
    fetchCalendars, fetchEvents, createEvent, updateEvent, deleteEvent, rsvpEvent,
    setSelectedDate, setViewMode, toggleCalendarVisibility, updateCalendar, shareCalendar,
    removeCalendar, clearCalendarEvents,
    refreshAllSubscriptions, icalSubscriptions,
  } = useCalendarStore();
  const calendarEnabled = usePolicyStore((s) => s.isFeatureEnabled('calendarEnabled'));
  const { firstDayOfWeek, timeFormat, showWeekNumbers, enableCalendarTasks, showTasksOnCalendar, calendarHoverPreview, showBirthdayCalendar, birthdayCalendarColor, updateSetting } = useSettingsStore();
  const sharedCalendarColors = useSettingsStore((s) => s.sharedCalendarColors);
  const setSharedCalendarColor = useSettingsStore((s) => s.setSharedCalendarColor);
  const removeSharedCalendarColor = useSettingsStore((s) => s.removeSharedCalendarColor);
  const taskStore = useTaskStore();
  const fetchTasksFn = useTaskStore(state => state.fetchTasks);
  const { identities } = useIdentityStore();
  const contacts = useContactStore((s) => s.contacts);
  const normalizedViewMode = isCalendarViewMode(viewMode) ? viewMode : "month";

  const currentUserEmails = useMemo(() =>
    identities.map(id => id.email).filter(Boolean),
    [identities]
  );

  const [showEventModal, setShowEventModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);
  const [pendingSubscription, setPendingSubscription] = useState<{ url: string; name: string } | null>(null);
  const [showWebcalActionChoice, setShowWebcalActionChoice] = useState(false);
  const [pendingWebcalAccountChoice, setPendingWebcalAccountChoice] = useState<ParsedWebcal | null>(null);
  const [isProtocolAccountSwitching, setIsProtocolAccountSwitching] = useState(false);
  const [editingSubscription, setEditingSubscription] = useState<string | null>(null);
  const [sharingCalendarId, setSharingCalendarId] = useState<string | null>(null);
  const [defaultCalendarIdForCreate, setDefaultCalendarIdForCreate] = useState<string | undefined>(undefined);
  const [showCreateCalendar, setShowCreateCalendar] = useState(false);
  const { dialogProps: confirmDialogProps, confirm: confirmAction } = useConfirmDialog();
  const tMgmt = useTranslations("calendar.management");
  const [editEvent, setEditEvent] = useState<CalendarEvent | null>(null);
  const [defaultModalDate, setDefaultModalDate] = useState<Date | undefined>();
  const [defaultModalEndDate, setDefaultModalEndDate] = useState<Date | undefined>();
  const [defaultModalAllDay, setDefaultModalAllDay] = useState(false);
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

  // Keep detailEvent in sync with store events (e.g. after update + refetch)
  useEffect(() => {
    if (detailEvent) {
      const updated = events.find(e => e.id === detailEvent.id);
      if (updated && updated !== detailEvent) {
        setDetailEvent(updated);
      }
    }
  }, [events, detailEvent]);

  // Check auth on mount – skip when already authenticated so that navigating
  // between routes doesn't retrigger checkAuth's transient `{ client: null,
  // isLoading: true }` reset, which was flashing the spinner on every nav.
  useEffect(() => {
    const state = useAuthStore.getState();
    if (state.isAuthenticated && state.client) {
      setInitialCheckDone(true);
      return;
    }
    checkAuth().finally(() => {
      setInitialCheckDone(true);
    });
  }, [checkAuth]);

  useEffect(() => {
    if (initialCheckDone && !isAuthenticated && !authLoading) {
      try { sessionStorage.setItem('redirect_after_login', window.location.pathname); } catch { /* ignore */ }
      redirectToLogin();
    } else if (client && !calendarEnabled) {
      // Calendar disabled by admin policy - send the user back to mail.
      router.push("/");
    } else if (client && !supportsCalendar && !pendingWebcalAccountChoice && !isProtocolAccountSwitching && !pendingSubscription && !showWebcalActionChoice && !hasPendingWebcal()) {
      router.push("/");
    }
  }, [initialCheckDone, isAuthenticated, authLoading, client, calendarEnabled, supportsCalendar, pendingWebcalAccountChoice, isProtocolAccountSwitching, pendingSubscription, showWebcalActionChoice, router]);

  useEffect(() => {
    if (error) {
      toast.error(error);
    }
  }, [error]);

  const getWebcalProtocolAccounts = useCallback(() => {
    const connectedClients = useAuthStore.getState().getAllConnectedClients();
    return useAccountStore.getState().accounts.filter((account) => {
      if (!account.isConnected) return false;
      return connectedClients.get(account.id)?.supportsCalendars() === true;
    });
  }, []);

  const openWebcalForAccount = useCallback(async (pending: ParsedWebcal, accountId: string) => {
    setIsProtocolAccountSwitching(true);
    try {
      if (useAuthStore.getState().activeAccountId !== accountId) {
        await switchAccount(accountId);
      }
      setPendingWebcalAccountChoice(null);
      setPendingSubscription({
        url: pending.subscriptionUrl,
        name: pending.suggestedName,
      });
      setShowWebcalActionChoice(true);
    } finally {
      setIsProtocolAccountSwitching(false);
    }
  }, [switchAccount]);

  const handleWebcalProtocolRequest = useCallback((pending: ParsedWebcal) => {
    const protocolAccounts = getWebcalProtocolAccounts();
    if (protocolAccounts.length > 1) {
      setPendingWebcalAccountChoice(pending);
      return;
    }

    if (protocolAccounts.length === 0 && !supportsCalendar) {
      return;
    }

    const accountId = protocolAccounts[0]?.id ?? activeAccountId;
    if (accountId) {
      void openWebcalForAccount(pending, accountId);
      return;
    }

    setPendingSubscription({
      url: pending.subscriptionUrl,
      name: pending.suggestedName,
    });
    setShowWebcalActionChoice(true);
  }, [activeAccountId, getWebcalProtocolAccounts, openWebcalForAccount, supportsCalendar]);

  const closeWebcalActionChoice = useCallback(() => {
    setShowWebcalActionChoice(false);
    setPendingSubscription(null);
  }, []);

  const handleImportWebcal = useCallback(() => {
    setShowWebcalActionChoice(false);
    setShowImportModal(true);
  }, []);

  const handleSubscribeWebcal = useCallback(() => {
    setShowWebcalActionChoice(false);
    setShowSubscriptionModal(true);
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !client) return;

    const openPendingWebcal = () => {
      const pending = consumePendingWebcal();
      if (!pending) return;

      handleWebcalProtocolRequest(pending);
    };

    openPendingWebcal();
    return subscribeToPendingWebcal(openPendingWebcal);
  }, [isAuthenticated, client, handleWebcalProtocolRequest]);

  // Single-account fetch path. The Pro shell aggregates calendars from
  // every connected account via [[useProMultiAccountCalendars]] below, so
  // skip this fetch there to avoid clobbering the merged list with the
  // active client's calendars only.
  useEffect(() => {
    if (isEmbedded) return;
    if (client && !hasFetched.current) {
      hasFetched.current = true;
      fetchCalendars(client);
    }
  }, [client, fetchCalendars, isEmbedded]);

  // Auto-refresh iCal subscriptions
  useEffect(() => {
    if (!client) return;
    // Refresh on mount (respects per-subscription interval)
    refreshAllSubscriptions(client);
    // Check again every 5 minutes
    const interval = setInterval(() => refreshAllSubscriptions(client), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [client, refreshAllSubscriptions]);

  // Auto-add birthday calendar to selected IDs only when the setting flips
  // off→on. Firing on every mount would undo a user's manual hide via the
  // sidebar each time they navigate back to the calendar (see #204).
  const prevShowBirthdayRef = useRef(showBirthdayCalendar);
  useEffect(() => {
    const wasShown = prevShowBirthdayRef.current;
    prevShowBirthdayRef.current = showBirthdayCalendar;
    if (!wasShown && showBirthdayCalendar && !selectedCalendarIds.includes(BIRTHDAY_CALENDAR_ID)) {
      toggleCalendarVisibility(BIRTHDAY_CALENDAR_ID);
    }
  }, [showBirthdayCalendar]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (isEmbedded) return;
    if (client && calendars.length > 0 && dateRange) {
      fetchEvents(client, dateRange.start, dateRange.end);
    }
  }, [client, calendars.length, dateRange, fetchEvents, isEmbedded]);

  // Pro shell only: aggregate calendars and events from every connected
  // account so the sidebar lists them all (and the views render their
  // events together). The hook is a no-op outside the embedded shell.
  const { enabled: multiAccountEnabled, accountClients } = useProMultiAccountCalendars(
    isEmbedded ? dateRange?.start ?? null : null,
    isEmbedded ? dateRange?.end ?? null : null,
  );
  const fetchAllAccountsCalendarsFn = useCalendarStore((s) => s.fetchAllAccountsCalendars);
  const fetchAllAccountsEventsFn = useCalendarStore((s) => s.fetchAllAccountsEvents);

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
    // Close the narrow-pane sidebar overlay after the user picks a date.
    setNarrowSidebarOpen(false);
  }, [setSelectedDate, isMobile, normalizedViewMode, setViewMode]);

  const navigateBackToMonth = useCallback(() => {
    setMobileReturnToMonth(false);
    setViewMode("month");
  }, [setViewMode]);

  const handleMiniMonthChange = useCallback((date: Date) => {
    setMiniMonth(date);
    setSelectedDate(date);
  }, [setSelectedDate]);

  const openCreateModal = useCallback((date?: Date, endDate?: Date, allDay?: boolean) => {
    setEditEvent(null);
    const d = date || selectedDate;
    setDefaultModalDate(d);
    setDefaultModalEndDate(endDate);
    setDefaultModalAllDay(allDay ?? false);
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

  const {
    contextMenu: eventContextMenu,
    openContextMenu: openEventContextMenu,
    closeContextMenu: closeEventContextMenu,
    menuRef: eventContextMenuRef,
  } = useContextMenu<CalendarEvent>();

  const handleContextMenuEvent = useCallback((e: React.MouseEvent, event: CalendarEvent) => {
    closeDetail();
    openEventContextMenu(e, event);
  }, [closeDetail, openEventContextMenu]);

  const {
    contextMenu: emptyContextMenu,
    openContextMenu: openEmptyContextMenu,
    closeContextMenu: closeEmptyContextMenu,
    menuRef: emptyContextMenuRef,
  } = useContextMenu<{ date: Date; hour?: number; allDayArea?: boolean }>();

  const handleContextMenuEmpty = useCallback(
    (e: React.MouseEvent, date: Date, hour?: number, allDayArea?: boolean) => {
      closeDetail();
      openEmptyContextMenu(e, { date, hour, allDayArea });
    },
    [closeDetail, openEmptyContextMenu],
  );

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
    if (!client || !activeAccountId) return;
    const { dateRange: currentRange } = useCalendarStore.getState();
    if (!currentRange) return;
    if (multiAccountEnabled && accountClients.length > 0) {
      await fetchAllAccountsEventsFn(accountClients, activeAccountId, currentRange.start, currentRange.end);
      return;
    }
    await fetchEvents(client, currentRange.start, currentRange.end);
  }, [client, fetchEvents, multiAccountEnabled, accountClients, activeAccountId, fetchAllAccountsEventsFn]);

  // Intercept browser refresh gestures (F5, Ctrl/Cmd+R, pull-to-refresh)
  // and refresh calendar data via JMAP instead of reloading the page.
  useRefreshGesture({
    enabled: isAuthenticated && !!client,
    onRefresh: async () => {
      if (!client) return;
      const calendarRefresh = multiAccountEnabled && accountClients.length > 0 && activeAccountId
        ? fetchAllAccountsCalendarsFn(accountClients, activeAccountId)
        : fetchCalendars(client);
      await Promise.all([
        calendarRefresh,
        refetchCurrentRange(),
        refreshAllSubscriptions(client),
      ]);
    },
  });

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

  const handleDuplicateContextMenu = useCallback(async (event: CalendarEvent) => {
    if (!client) { toast.error(t("notifications.event_error")); return; }
    const start = parseISO(event.start);
    const newStart = addDays(start, 1);
    const data = sanitizeOutgoingCalendarEventData<Partial<CalendarEvent>>({
      title: event.title,
      description: event.description,
      start: format(newStart, "yyyy-MM-dd'T'HH:mm:ss"),
      duration: event.duration,
      timeZone: event.timeZone,
      showWithoutTime: event.showWithoutTime,
      calendarIds: { ...event.calendarIds },
      status: "confirmed",
      freeBusyStatus: event.freeBusyStatus,
      privacy: event.privacy,
    });
    if (event.locations) data.locations = structuredClone(event.locations);
    if (event.recurrenceRules) data.recurrenceRules = structuredClone(event.recurrenceRules);
    if (event.alerts) data.alerts = structuredClone(event.alerts);
    if (event.participants) data.participants = structuredClone(event.participants);
    try {
      const created = await createEvent(client, data);
      if (created) {
        toast.success(t("notifications.event_duplicated"));
        openEditModal(created);
      }
    } catch {
      toast.error(t("notifications.event_error"));
    }
  }, [client, createEvent, openEditModal, t]);

  const handleExportICS = useCallback((event: CalendarEvent) => {
    try {
      downloadEventICS(event);
      toast.success(t("notifications.event_exported"));
    } catch {
      toast.error(t("notifications.event_error"));
    }
  }, [t]);

  const handleCopyTitle = useCallback(async (event: CalendarEvent) => {
    try {
      await navigator.clipboard.writeText(event.title || "");
      toast.success(t("notifications.title_copied"));
    } catch {
      toast.error(t("notifications.event_error"));
    }
  }, [t]);

  const handleCopyMeetingLink = useCallback(async (event: CalendarEvent) => {
    const uri = event.virtualLocations
      ? Object.values(event.virtualLocations).find((v) => v.uri)?.uri
      : undefined;
    if (!uri) return;
    try {
      await navigator.clipboard.writeText(uri);
      toast.success(t("notifications.link_copied"));
    } catch {
      toast.error(t("notifications.event_error"));
    }
  }, [t]);

  const handleDeleteContextMenu = useCallback((event: CalendarEvent) => {
    const hasParticipants = event.participants && Object.keys(event.participants).length > 0;
    handleDeleteEvent(event.id, hasParticipants || undefined);
  }, [handleDeleteEvent]);

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

  const birthdayEvents = useMemo(() => {
    if (!showBirthdayCalendar || !dateRange) return [];
    return generateBirthdayEvents(contacts, dateRange.start, dateRange.end);
  }, [showBirthdayCalendar, contacts, dateRange]);

  const birthdayCalendarName = (() => {
    try { return t('birthday_calendar'); } catch { return 'Birthdays'; }
  })();

  // Apply each shared calendar's local color override (per-viewer recolor,
  // #345). The override replaces the calendar's color and wins over per-event
  // colors via the `colorIsLocalOverride` flag (see getEventColor). Personal
  // calendars are passed through untouched.
  const displayCalendars = useMemo(() => {
    return calendars.map((cal) => {
      if (!cal.isShared) return cal;
      const override = sharedCalendarColors[sharedCalendarColorKey(cal)];
      if (!override) return cal;
      return { ...cal, color: override, colorIsLocalOverride: true };
    });
  }, [calendars, sharedCalendarColors]);

  // Auto-assign a random, not-yet-used palette color to any freshly shared
  // calendar so multiple shared calendars don't collide on one color. Runs
  // once per calendar (guarded by the presence of an existing key), and the
  // user can still overwrite it from the sidebar.
  useEffect(() => {
    const shared = calendars.filter((c) => c.isShared);
    const missing = shared.filter((c) => !sharedCalendarColors[sharedCalendarColorKey(c)]);
    if (missing.length === 0) return;
    // Seed "used" with personal calendar colors plus already-assigned shared
    // overrides so the picks stay distinct from what's already on screen.
    const used = new Set<string>();
    for (const c of calendars) {
      if (!c.isShared && c.color) used.add(c.color.toLowerCase());
    }
    for (const color of Object.values(sharedCalendarColors)) {
      if (color) used.add(color.toLowerCase());
    }
    for (const cal of missing) {
      const color = pickUnusedCalendarColor(used);
      used.add(color.toLowerCase());
      setSharedCalendarColor(sharedCalendarColorKey(cal), color);
    }
  }, [calendars, sharedCalendarColors, setSharedCalendarColor]);

  const allCalendars = useMemo(() => {
    if (!showBirthdayCalendar) return displayCalendars;
    return [...displayCalendars, createBirthdayCalendar(birthdayCalendarName, birthdayCalendarColor)];
  }, [displayCalendars, showBirthdayCalendar, birthdayCalendarName, birthdayCalendarColor]);

  const visibleEvents = useMemo(() => {
    const filtered = events.filter((e) => {
      if (!e.start || !e.calendarIds) return false;
      const calIds = Object.keys(e.calendarIds);
      return calIds.some((id) => selectedCalendarIds.includes(id));
    });
    if (showBirthdayCalendar && selectedCalendarIds.includes(BIRTHDAY_CALENDAR_ID)) {
      return [...filtered, ...birthdayEvents];
    }
    return filtered;
  }, [events, selectedCalendarIds, showBirthdayCalendar, birthdayEvents]);

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

  const renderWebcalAccountPicker = () => pendingWebcalAccountChoice ? (
    <ProtocolAccountPicker
      kind="webcal"
      operation={pendingWebcalAccountChoice}
      accounts={getWebcalProtocolAccounts()}
      activeAccountId={activeAccountId}
      isSwitching={isProtocolAccountSwitching}
      onSelect={(accountId) => void openWebcalForAccount(pendingWebcalAccountChoice, accountId)}
      onCancel={() => setPendingWebcalAccountChoice(null)}
    />
  ) : null;

  const renderWebcalActionChoice = () => showWebcalActionChoice && pendingSubscription ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" onClick={closeWebcalActionChoice} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tWebcalAction("title")}
        className="relative bg-background border border-border rounded-lg shadow-xl w-full max-w-md mx-4 animate-in zoom-in-95 duration-200"
      >
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold">{tWebcalAction("title")}</h2>
          <p className="text-sm text-muted-foreground mt-1">{tWebcalAction("description", { name: pendingSubscription.name })}</p>
        </div>
        <div className="px-6 py-4 space-y-3">
          <Button variant="outline" className="w-full justify-start h-auto py-3" onClick={handleImportWebcal}>
            <span className="text-start">
              <span className="block font-medium">{tWebcalAction("import_title")}</span>
              <span className="block text-xs text-muted-foreground mt-0.5">{tWebcalAction("import_description")}</span>
            </span>
          </Button>
          <Button variant="outline" className="w-full justify-start h-auto py-3" onClick={handleSubscribeWebcal}>
            <span className="text-start">
              <span className="block font-medium">{tWebcalAction("subscribe_title")}</span>
              <span className="block text-xs text-muted-foreground mt-0.5">{tWebcalAction("subscribe_description")}</span>
            </span>
          </Button>
        </div>
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border">
          <Button variant="ghost" onClick={closeWebcalActionChoice}>{tWebcalAction("cancel")}</Button>
        </div>
      </div>
    </div>
  ) : null;

  if (!isAuthenticated) return null;
  if (!calendarEnabled) return null;
  if (!supportsCalendar) return renderWebcalAccountPicker();

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
              calendars={allCalendars}
              onSelectDate={handleSelectDate}
              onSelectEvent={handleSelectEvent}
              onHoverEvent={handleHoverEvent}
              onHoverLeave={handleHoverLeave}
              onContextMenuEvent={handleContextMenuEvent}
              onContextMenuEmpty={handleContextMenuEmpty}
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
              calendars={allCalendars}
              onSelectDate={handleSelectDate}
              onSelectEvent={handleSelectEvent}
              onHoverEvent={handleHoverEvent}
              onHoverLeave={handleHoverLeave}
              onContextMenuEvent={handleContextMenuEvent}
              onContextMenuEmpty={handleContextMenuEmpty}
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
              calendars={allCalendars}
              onSelectEvent={handleSelectEvent}
              onHoverEvent={handleHoverEvent}
              onHoverLeave={handleHoverLeave}
              onContextMenuEvent={handleContextMenuEvent}
              onContextMenuEmpty={handleContextMenuEmpty}
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
              calendars={allCalendars}
              onSelectEvent={handleSelectEvent}
              onHoverEvent={handleHoverEvent}
              onHoverLeave={handleHoverLeave}
              onContextMenuEvent={handleContextMenuEvent}
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
                calendars={displayCalendars}
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
    <div className={cn("flex flex-col bg-background overflow-hidden pt-[env(safe-area-inset-top)]", isEmbedded ? "h-full" : "h-dvh")}>
      <AppTopBannerSlot />
      <div className={cn("relative flex flex-1 min-h-0 overflow-hidden", isMobile && "flex-col")}>
      {/* Left Navigation Rail (hidden when embedded in Pro shell) */}
      {!isMobile && !isEmbedded && (
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

      {/* Narrow-pane backdrop: dim and close overlay sidebar */}
      {isNarrow && narrowSidebarOpen && !inlineApp && (
        <div
          className={cn(
            "inset-0 bg-black/50 z-40",
            isEmbedded ? "absolute" : "fixed"
          )}
          onClick={() => setNarrowSidebarOpen(false)}
        />
      )}

      {/* Sidebar - in-flow when desktop pane, overlay when narrow */}
      {!inlineApp && (
        <>
          <div
            className={cn(
              "border-e border-border bg-secondary overflow-y-auto flex-shrink-0 p-3",
              !isResizing && "transition-[width] duration-300",
              isNarrow && cn(
                "absolute inset-y-0 left-0 z-50 w-72 pt-[env(safe-area-inset-top)]",
                "transform transition-transform duration-300 ease-in-out",
                !narrowSidebarOpen && "-translate-x-full"
              )
            )}
            style={isNarrow ? undefined : { width: `${calSidebarWidth}px` }}
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
              calendars={allCalendars}
              selectedCalendarIds={selectedCalendarIds}
              onToggleVisibility={toggleCalendarVisibility}
              onColorChange={client ? (calendarId, color) => {
                if (calendarId === BIRTHDAY_CALENDAR_ID) {
                  updateSetting('birthdayCalendarColor', color);
                  return;
                }
                // Shared calendars: recolor locally only (the viewer usually
                // can't write the owner's calendar, and it'd recolor it for
                // everyone). Personal calendars write through to the server.
                const cal = allCalendars.find((c) => c.id === calendarId);
                if (cal?.isShared) {
                  setSharedCalendarColor(sharedCalendarColorKey(cal), color);
                  return;
                }
                updateCalendar(client, calendarId, { color });
              } : undefined}
              onResetColor={(cal) => {
                // Drop the local override; the auto-assign effect picks a
                // fresh unused color (so it never reverts to a collision).
                removeSharedCalendarColor(sharedCalendarColorKey(cal));
              }}
              onShareCalendar={client ? (cal) => setSharingCalendarId(cal.id) : undefined}
              onCreateEvent={(cal: Calendar) => {
                setDefaultCalendarIdForCreate(cal.id);
                openCreateModal();
              }}
              onClearCalendar={client ? async (cal: Calendar) => {
                const ok = await confirmAction({
                  title: tMgmt("clear_events"),
                  message: tMgmt("confirm_clear", { name: cal.name }),
                  variant: "destructive",
                  confirmText: tMgmt("clear_events"),
                });
                if (!ok) return;
                try {
                  const count = await clearCalendarEvents(client, cal.id);
                  toast.success(tMgmt("events_cleared", { count }));
                } catch {
                  toast.error(tMgmt("error_clear"));
                }
              } : undefined}
              onDeleteCalendar={client ? async (cal: Calendar) => {
                const ok = await confirmAction({
                  title: tMgmt("delete"),
                  message: tMgmt("confirm_delete", { name: cal.name }),
                  variant: "destructive",
                  confirmText: tMgmt("delete"),
                });
                if (!ok) return;
                try {
                  await removeCalendar(client, cal.id);
                  toast.success(tMgmt("calendar_deleted"));
                } catch {
                  toast.error(tMgmt("error_delete"));
                }
              } : undefined}
              onCreateCalendar={client ? () => setShowCreateCalendar(true) : undefined}
              onSubscribe={() => setShowSubscriptionModal(true)}
              onEditSubscription={(subId) => setEditingSubscription(subId)}
              client={client}
              multiAccountMode={multiAccountEnabled && accountClients.length > 1}
            />
          </div>
          {!isNarrow && (
            <ResizeHandle
              onResizeStart={() => { dragStartWidth.current = calSidebarWidth; setIsResizing(true); }}
              onResize={(delta) => setCalSidebarWidth(Math.max(180, Math.min(400, dragStartWidth.current + delta)))}
              onResizeEnd={() => {
                setIsResizing(false);
                localStorage.setItem("calendar-sidebar-width", String(calSidebarWidth));
              }}
              onDoubleClick={() => { setCalSidebarWidth(256); localStorage.setItem("calendar-sidebar-width", "256"); }}
            />
          )}
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
          calendars={displayCalendars}
          selectedCalendarIds={selectedCalendarIds}
          onToggleVisibility={toggleCalendarVisibility}
          enableCalendarTasks={enableCalendarTasks}
          onMenuClick={isNarrow ? () => setNarrowSidebarOpen(true) : undefined}
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
            <div className="w-[400px] border-s border-border flex-shrink-0 overflow-hidden">
              <EventModal
                key={editEvent?.id ?? 'new'}
                event={editEvent}
                calendars={displayCalendars}
                defaultDate={defaultModalDate}
                defaultEndDate={defaultModalEndDate}
                defaultAllDay={defaultModalAllDay}
                defaultCalendarId={defaultCalendarIdForCreate}
                onSave={handleSaveEvent}
                onDelete={handleDeleteEvent}
                onDuplicate={handleDuplicateEvent}
                onRsvp={handleRsvp}
                onClose={() => { setShowEventModal(false); setEditEvent(null); setPendingPreview(null); setDefaultCalendarIdForCreate(undefined); setDefaultModalAllDay(false); }}
                onPreviewChange={setPendingPreview}
                currentUserEmails={currentUserEmails}
                isMobile={false}
              />
            </div>
          )}

          {/* Desktop task panel */}
          {!isMobile && showTaskModal && (
            <div className="w-[400px] border-s border-border flex-shrink-0 overflow-hidden">
              <TaskModal
                key={editTask?.id ?? 'new-task'}
                task={editTask}
                calendars={displayCalendars}
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
      {isMobile && !isEmbedded && (
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

      {eventContextMenu.data && (
        <EventContextMenu
          event={eventContextMenu.data}
          position={eventContextMenu.position}
          isOpen={eventContextMenu.isOpen}
          onClose={closeEventContextMenu}
          menuRef={eventContextMenuRef}
          onEdit={() => openEditModal(eventContextMenu.data!)}
          onDuplicate={() => handleDuplicateContextMenu(eventContextMenu.data!)}
          onExportICS={() => handleExportICS(eventContextMenu.data!)}
          onCopyTitle={() => handleCopyTitle(eventContextMenu.data!)}
          onCopyMeetingLink={() => handleCopyMeetingLink(eventContextMenu.data!)}
          onDelete={() => handleDeleteContextMenu(eventContextMenu.data!)}
        />
      )}

      {emptyContextMenu.data && (() => {
        const { date, hour } = emptyContextMenu.data;
        return (
          <EmptySpaceContextMenu
            position={emptyContextMenu.position}
            isOpen={emptyContextMenu.isOpen}
            onClose={closeEmptyContextMenu}
            menuRef={emptyContextMenuRef}
            onNewEvent={() => {
              const d = new Date(date);
              if (typeof hour === "number") {
                d.setHours(hour, 0, 0, 0);
              } else {
                const now = new Date();
                d.setHours(now.getHours() + 1, 0, 0, 0);
              }
              openCreateModal(d);
            }}
            onNewAllDayEvent={() => {
              const d = new Date(date);
              d.setHours(0, 0, 0, 0);
              openCreateModal(d, undefined, true);
            }}
            onNewTask={enableCalendarTasks ? () => {
              setEditTask(null);
              setShowTaskModal(true);
            } : undefined}
            onGoToToday={goToToday}
          />
        );
      })()}

      {detailEvent && detailAnchorRect && (
        <EventDetailPopover
          event={detailEvent}
          calendar={displayCalendars.find(c => detailEvent.calendarIds[c.id])}
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
          calendars={displayCalendars}
          defaultDate={defaultModalDate}
          defaultEndDate={defaultModalEndDate}
          defaultAllDay={defaultModalAllDay}
          defaultCalendarId={defaultCalendarIdForCreate}
          onSave={handleSaveEvent}
          onDelete={handleDeleteEvent}
          onDuplicate={handleDuplicateEvent}
          onRsvp={handleRsvp}
          onClose={() => { setShowEventModal(false); setEditEvent(null); setDefaultCalendarIdForCreate(undefined); setDefaultModalAllDay(false); }}
          currentUserEmails={currentUserEmails}
          isMobile={true}
        />
      )}

      {showImportModal && client && (
        <ICalImportModal
          calendars={displayCalendars}
          client={client}
          initialUrl={pendingSubscription?.url}
          onClose={() => {
            setShowImportModal(false);
            setPendingSubscription(null);
          }}
        />
      )}

      {showSubscriptionModal && client && (
        <ICalSubscriptionModal
          client={client}
          initialUrl={pendingSubscription?.url}
          initialName={pendingSubscription?.name}
          onClose={() => {
            setShowSubscriptionModal(false);
            setPendingSubscription(null);
          }}
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
      {renderWebcalAccountPicker()}
      {renderWebcalActionChoice()}
      <RecurrenceScopeDialog
        isOpen={!!pendingScopeAction}
        actionType={pendingScopeAction?.type || "edit"}
        onSelect={handleScopeSelect}
        onClose={() => setPendingScopeAction(null)}
      />

      <ConfirmDialog {...confirmDialogProps} />

      {showCreateCalendar && client && (
        <CreateCalendarModal
          client={client}
          onClose={() => setShowCreateCalendar(false)}
        />
      )}

      {sharingCalendarId && client && (() => {
        const cal = allCalendars.find((c) => c.id === sharingCalendarId);
        if (!cal) return null;
        return (
          <ShareCollectionDialog
            client={client}
            kind="calendar"
            collectionName={cal.name}
            shareWith={cal.shareWith}
            ownAccountId={client.getAccountId()}
            onShare={async (principalId, rights) => {
              await shareCalendar(client, cal.id, principalId, rights as CalendarRights | null);
            }}
            onClose={() => setSharingCalendarId(null)}
          />
        );
      })()}
      </div>
    </div>
  );
}
