"use client";

import { hoverOpens } from "@/lib/open-on-hover";
import { useState, useEffect, useCallback, useRef, useMemo, type TouchEvent as ReactTouchEvent } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { Plus, ListTodo, CalendarDays, Upload, Globe, RefreshCw, Search } from "@/components/icons";
import {
  addMonths, subMonths, addWeeks, subWeeks, addDays, subDays,
  format, parseISO, startOfWeek,
} from "date-fns";
import { useCalendarStore } from "@/stores/calendar-store";
import { isCalendarViewMode, type CalendarViewMode } from "@/stores/calendar-store";
import { useAuthStore, redirectToLogin, saveRedirectAfterLogin } from '@/stores/auth-store';
import { useEmailStore } from "@/stores/email-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useIdentityStore } from "@/stores/identity-store";
import { useAccountStore } from "@/stores/account-store";
import { usePolicyStore } from "@/stores/policy-store";
import { toast } from "@/stores/toast-store";
import { useIsDesktop, useIsMobile } from "@/hooks/use-media-query";
import { useAccountPrincipalEmails } from "@/hooks/use-account-principal-emails";
import { Button } from "@/components/ui/button";
import { PaneSpinner, Spinner } from "@/components/ui/spinner";
import { CalendarToolbar } from "@/components/calendar/calendar-toolbar";
import { CalendarMonthView } from "@/components/calendar/calendar-month-view";
import { CalendarWeekView } from "@/components/calendar/calendar-week-view";
import { CalendarDayView } from "@/components/calendar/calendar-day-view";
import { CalendarAgendaView } from "@/components/calendar/calendar-agenda-view";
import { TaskListView, filterTasksForList } from "@/components/calendar/task-list-view";
import { CalendarLoadErrorNotice } from "@/components/calendar/calendar-load-error-notice";
import { TaskToolbar } from "@/components/calendar/task-toolbar";
import { TaskModal } from "@/components/calendar/task-modal";
import { MiniCalendar } from "@/components/calendar/mini-calendar";
import { CalendarSidebarPanel } from "@/components/calendar/calendar-sidebar-panel";
import { EventModal, type PendingEventPreview } from "@/components/calendar/event-modal";
import { EventDetailPopover } from "@/components/calendar/event-detail-popover";
import { EventContextMenu } from "@/components/calendar/event-context-menu";
import { AppTopBannerSlot } from "@/components/plugins/app-top-banner-slot";
import { useStrictestDevices } from "@/hooks/use-device-policy";
import { EmptySpaceContextMenu } from "@/components/calendar/empty-space-context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { useRefreshGesture } from "@/hooks/use-refresh-gesture";
import { useCalendarPushRefresh } from "@/hooks/use-calendar-push-refresh";
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
import { useIsFocusedProTab, useIsPaneScoped } from "@/hooks/use-pane-context";
import { useProMultiAccountCalendars } from "@/hooks/use-pro-multi-account-calendars";
import { ResizeHandle } from "@/components/layout/resize-handle";
import { buildDuplicateEventData } from "@/lib/calendar-duplicate";
import { filterTasksByCalendars } from "@/lib/calendar-tasks";
import { baseEventStoreId, isServerRecurrenceInstance } from "@/lib/recurrence-instances";
import { deleteOccurrence, saveOccurrenceEdit, type EventEditorState } from "@/lib/recurrence-scope-edit";
import { useContactNameResolver } from "@/hooks/use-contact-name-resolver";
import { getClientByLocalAccountId } from "@/stores/client-registry";
import { useCalendarErrorMessage } from "@/hooks/use-calendar-error-message";
import { getEventDisplayEndDate, getEventEndDate, getEventStartDate } from "@/lib/calendar-utils";
import { displayNow, getEffectiveTimeZone } from "@/lib/timezone";
import { canCreateEventsIn, getEventEditability, type EditabilityContext } from "@/lib/calendar-editability";
import { QuickCreatePopover, type QuickCreateDraft } from "@/components/calendar/quick-create-popover";
import { TASKS_LOAD_ERROR, useTaskStore } from "@/stores/task-store";
import { useContactStore } from "@/stores/contact-store";
import { cn, generateUUID } from "@/lib/utils";
import type { Calendar, CalendarEvent, CalendarParticipant, CalendarRights, CalendarTask } from "@/lib/jmap/types";
import { ShareCollectionDialog } from "@/components/settings/share-collection-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { SchedulingDeniedError } from "@/lib/jmap/scheduling-error";
import { CreateCalendarModal } from "@/components/calendar/create-calendar-modal";
import { CalendarSidebarHeader } from "@/components/calendar/calendar-sidebar-header";
import { getUserParticipantId, collectUserCalendarAddresses, userOrganizes, getParticipantList } from "@/lib/calendar-participants";
import type { AnswerTarget } from "@/lib/calendar-delegate";
import type { MoveEventHandler } from "@/hooks/use-time-grid-interactions";
import type { RevealTime } from "@/hooks/use-display-hours";
import { generateBirthdayEvents, createBirthdayCalendar, BIRTHDAY_CALENDAR_ID } from "@/lib/birthday-calendar";
import { feedIdOf, isCompanyCalendarId } from "@/lib/company-calendars";
import { expandRecurringEvents } from "@/lib/recurrence-expansion";
import { useCompanyCalendars } from "./use-company-calendars";
import { sharedCalendarColorKey, autoAssignSharedCalendarColors } from "@/lib/shared-calendar-colors";
import { debug } from "@/lib/debug";
import { consumePendingWebcal, hasPendingWebcal, subscribeToPendingWebcal } from "@/lib/protocol-handlers/session";
import type { ParsedWebcal } from "@/lib/protocol-handlers/webcal";
import { appPath, buildCalendarPath, parseCalendarPath, type CalendarDeepLink } from "@/lib/deep-links";
import { consumePendingDeepLinkEntry, subscribePendingDeepLink } from "@/lib/deep-link-handoff";
import { useDeepLinkUrl } from "@/hooks/use-deep-link-url";
import { useCloseOnBack } from "@/hooks/use-close-on-back";
import { useLeaveGuard } from "@/lib/leave-guard";
import { useCalendarEventSearch } from "@/hooks/use-calendar-event-search";
import { CalendarSearchField, CalendarSearchResults } from "@/components/calendar/calendar-search";
import { useProInterfaceActive } from "@/components/pro/pro-interface-redirect";
import { useCalendarLocale } from "@/hooks/use-calendar-locale";
import { useHoverPreviewGate } from "@/hooks/use-hover-preview-gate";
import {
  computeScrollWindow, fixedScrollWindowState, freshScrollWindowState, growScrollWindow, normalizeScrollWindowState,
  scrollWindowContains, type CalendarFocus, type ScrollViewMode, type ScrollWindowOptions,
  type ScrollWindowState, type ScrollWindowViewProps,
} from "@/lib/calendar-scroll-window";
import { useLiteLinkSegments } from "@/hooks/use-lite-link-segments";
import { IS_LITE } from "@/lib/lite";
import { findMeetingLink } from "@/lib/event-links";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { MvTopBar } from "@/components/layout/mv-top-bar";
import { useMountainViewShell } from "@/hooks/use-mountain-view-shell";
import { calendarHooks } from "@/lib/plugin-hooks";
import { eventToView } from "@/lib/plugin-projection";
import { AppMain, SkipLink } from "@/components/layout/app-landmarks";
import { calendarShortcutAction } from "@/lib/calendar-shortcuts";
import { isAppShortcutBlocked, isArrowKeyWidgetTarget } from "@/lib/keyboard";
import { isContextMenuOpen } from "@/components/ui/context-menu";
import { useRegisterCommands } from "@/lib/command-registry";
import { useConfig } from "@/hooks/use-config";
import { CalendarPrint, type CalendarPrintContent } from "@/components/calendar/calendar-print";
import { usePrintListener, usePrinting } from "@/components/print/print-root";
import { requestPrint, usePrintStore } from "@/stores/print-store";

// `fromEditor`: asked on the way out of the event editor, which stays open
// until a scope is picked, so Cancel goes back to it with the changes.
type PendingScopeAction =
  | { type: "edit"; event: CalendarEvent; updates: Partial<CalendarEvent>; editor?: EventEditorState; sendScheduling?: boolean; fromEditor?: boolean }
  | { type: "delete"; event: CalendarEvent; sendScheduling?: boolean; fromEditor?: boolean }
  | { type: "rsvp"; event: CalendarEvent; participantId: string; status: CalendarParticipant["participationStatus"]; sentBy?: string };

function isRecurringEvent(event: CalendarEvent): boolean {
  return (event.recurrenceRules?.length ?? 0) > 0 || event.recurrenceId != null;
}

export interface CalendarAppProps {
  /** Path segments after `/calendar` (`['day', '2026-08-06']`). */
  linkSegments?: string[];
}

export function CalendarApp({ linkSegments: routeSegments }: CalendarAppProps = {}) {
  // Static Lite build: the route params are empty, read the link from the URL.
  const linkSegments = useLiteLinkSegments('calendar', routeSegments);
  const router = useRouter();
  const t = useTranslations("calendar");
  // Organisation > Devices > No printing: no Print buttons (Ctrl+P prints a note).
  const printOff = useStrictestDevices().noPrint;
  // The server's reason for a refused change, where the user can act on it.
  const describeError = useCalendarErrorMessage();
  const tSidebar = useTranslations("sidebar");
  useDocumentTitle(tSidebar("calendar"));
  const tWebcalAction = useTranslations("calendar.webcal_action");
  const { demoMode } = useConfig();
  // Subscriptions fetch the feed through /api/fetch-ical, which the demo has no
  // mail server for and the Lite static build does not have at all.
  const canSubscribe = !demoMode && !IS_LITE;
  const tDeepLink = useTranslations("deep_link");
  const isMobile = useIsMobile();
  const isDesktop = useIsDesktop();
  const isEmbedded = useIsEmbedded();
  // The Pro interface takes over this route; the Pro tab loads the data then.
  const proInterfaceActive = useProInterfaceActive();
  // Mountain View's desktop chrome: its top bar in place of the left rail.
  const mvShell = useMountainViewShell(isEmbedded);
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
    isLoading, isLoadingEvents, supportsCalendar, error, eventsLoadError,
    fetchCalendars, fetchEvents, createEvent, updateEvent, deleteEvent, rsvpEvent,
    setSelectedDate, setViewMode, toggleCalendarVisibility, updateCalendar, shareCalendar,
    removeCalendar, clearCalendarEvents,
    refreshAllSubscriptions, icalSubscriptions, isSubscriptionCalendar,
  } = useCalendarStore();
  const calendarEnabled = usePolicyStore((s) => s.isFeatureEnabled('calendarEnabled'));
  const { firstDayOfWeek, timeFormat, showWeekNumbers, enableCalendarTasks, showTasksOnCalendar, calendarHoverPreview, showBirthdayCalendar, birthdayCalendarColor, updateSetting } = useSettingsStore();
  const sharedCalendarColors = useSettingsStore((s) => s.sharedCalendarColors);
  const setSharedCalendarColor = useSettingsStore((s) => s.setSharedCalendarColor);
  const removeSharedCalendarColor = useSettingsStore((s) => s.removeSharedCalendarColor);
  const taskStore = useTaskStore();
  const fetchTasksFn = useTaskStore(state => state.fetchTasks);
  const toggleTaskCompleteFn = useTaskStore(state => state.toggleTaskComplete);
  const { identities } = useIdentityStore();
  const contacts = useContactStore((s) => s.contacts);
  const normalizedViewMode = isCalendarViewMode(viewMode) ? viewMode : "month";
  usePrintListener();
  const printing = usePrinting();
  const printTarget = usePrintStore((s) => s.target);

  // Aliases live on the principal, not on identities; the calendar needs them
  // so an alias-organized event is recognised as the user's own (see isOrganizer).
  const accountEmails = useAccountPrincipalEmails(client);

  // The default ParticipantIdentity (draft-ietf-jmap-calendars §6) is the
  // address new invitations are organised from, so it goes first: the event
  // modal takes currentUserEmails[0] as organizer.
  const participantIdentities = useCalendarStore((s) => s.participantIdentities);
  const currentUserEmails = useMemo(
    () => collectUserCalendarAddresses(
      participantIdentities.filter(i => i.isDefault).map(i => i.calendarAddress.replace(/^mailto:/i, '')),
      participantIdentities.map(i => i.calendarAddress.replace(/^mailto:/i, '')),
      identities.map(id => id.email),
      accountEmails,
    ),
    [participantIdentities, identities, accountEmails]
  );
  const resolveContactName = useContactNameResolver();

  const [showEventModal, setShowEventModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  // Event search (CAL-16): the query in the toolbar box; on phones the box
  // opens as a row of its own.
  const [searchQuery, setSearchQuery] = useState("");
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
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
  // The attendee limit of the account the edited (or a new) event is in, for
  // the editor's warning.
  const maxParticipants = useMemo(() => {
    const accountClient = (editEvent?.localAccountId && getClientByLocalAccountId(editEvent.localAccountId)) || client;
    return accountClient?.getMaxParticipantsPerEvent?.(editEvent?.accountId) ?? null;
  }, [client, editEvent]);
  const [defaultModalDate, setDefaultModalDate] = useState<Date | undefined>();
  const [defaultModalEndDate, setDefaultModalEndDate] = useState<Date | undefined>();
  const [defaultModalAllDay, setDefaultModalAllDay] = useState(false);
  const [miniMonth, setMiniMonth] = useState(() => displayNow());
  const [pendingScopeAction, setPendingScopeAction] = useState<PendingScopeAction | null>(null);
  const [detailEvent, setDetailEvent] = useState<CalendarEvent | null>(null);
  const [detailAnchorRect, setDetailAnchorRect] = useState<DOMRect | null>(null);
  // A clicked event's card stays until closed; a hover preview goes when
  // the pointer leaves. Held in a ref too for the hover timers.
  const [detailPinned, setDetailPinned] = useState(false);
  const detailPinnedRef = useRef(false);
  useEffect(() => { detailPinnedRef.current = detailPinned; }, [detailPinned]);
  const [pendingPreview, setPendingPreview] = useState<PendingEventPreview | null>(null);
  // Quick create (#calendar redesign): an empty slot clicked in the week or
  // day view opens a small editor beside a placeholder block.
  const [quickDraft, setQuickDraft] = useState<QuickCreateDraft | null>(null);
  const [defaultModalTitle, setDefaultModalTitle] = useState<string | undefined>();
  const [modalStartsInEdit, setModalStartsInEdit] = useState(false);
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [editTask, setEditTask] = useState<import("@/lib/jmap/types").CalendarTask | null>(null);
  const [mobileReturnToMonth, setMobileReturnToMonth] = useState(false);
  // Whether the open event or task editor holds unsaved changes (R5).
  const eventEditorDirtyRef = useRef(false);
  const taskEditorDirtyRef = useRef(false);
  const setEventEditorDirty = useCallback((dirty: boolean) => { eventEditorDirtyRef.current = dirty; }, []);
  const setTaskEditorDirty = useCallback((dirty: boolean) => { taskEditorDirtyRef.current = dirty; }, []);
  const [swipeDirection, setSwipeDirection] = useState<'left' | 'right' | null>(null);
  const [swipeKey, setSwipeKey] = useState(0);
  const hasFetched = useRef(false);

  // Sidebar resize state
  const [calSidebarWidth, setCalSidebarWidth] = useState(() => {
    try { const v = localStorage.getItem("calendar-sidebar-width"); return v ? Number(v) : 256; } catch { return 256; }
  });
  const [isResizing, setIsResizing] = useState(false);
  const dragStartWidth = useRef(256);
  // The burger in the toolbar hides the sidebar on wide screens, like
  // Google Calendar's main menu button; remembered across visits.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("calendar-sidebar-collapsed") === "1"; } catch { return false; }
  });
  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem("calendar-sidebar-collapsed", next ? "1" : "0"); } catch { /* storage unavailable */ }
      return next;
    });
  }, []);

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
      saveRedirectAfterLogin();
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
  // active client's calendars only. That includes the standard instance
  // that renders while the Pro interface takes over the route: its raw ids
  // replaced the merged list after the Pro tab loaded it, and the selection
  // the user made in between went to another account's calendar.
  useEffect(() => {
    if (isEmbedded || proInterfaceActive) return;
    if (client && !hasFetched.current) {
      hasFetched.current = true;
      fetchCalendars(client);
    }
  }, [client, fetchCalendars, isEmbedded, proInterfaceActive]);

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

  // Free scrolling (#759): every view keeps one window of days around the
  // day the user navigated to (the "focus"). Reaching an edge of the view
  // widens that side and the whole window is refetched. Grid clicks only
  // change the selection; navigation moves the focus and, when that leaves
  // the loaded window, starts a fresh window there.
  const { weekStartsOn, getMonthGridDays } = useCalendarLocale();
  const monthGridDaysRef = useRef(getMonthGridDays);
  useEffect(() => {
    monthGridDaysRef.current = getMonthGridDays;
  }, [getMonthGridDays]);
  const scrollWindowOptions = useMemo<ScrollWindowOptions>(
    () => ({ weekStartsOn, monthGridDays: (date) => monthGridDaysRef.current(date) }),
    [weekStartsOn],
  );
  const scrollMode: ScrollViewMode | null = normalizedViewMode === "tasks" ? null : normalizedViewMode;
  const [focus, setFocus] = useState<CalendarFocus>(() => ({ date: selectedDate, nonce: 0 }));
  const [visibleDate, setVisibleDate] = useState<Date | null>(null);
  const [scrollWindowState, setScrollWindowState] = useState<ScrollWindowState>(
    () => freshScrollWindowState(scrollMode ?? "month", selectedDate),
  );
  // With free scrolling off, every view shows exactly one period around the
  // focus and the edges never widen it.
  const calendarFreeScroll = useSettingsStore((s) => s.calendarFreeScroll);
  const focusKey = format(focus.date, "yyyy-MM-dd");
  const fixedWindowState = useMemo(
    () => (scrollMode ? fixedScrollWindowState(scrollMode, parseISO(focusKey)) : null),
    [scrollMode, focusKey],
  );
  const windowState = !scrollMode
    ? null
    : calendarFreeScroll
      ? normalizeScrollWindowState(scrollWindowState, scrollMode, focus.date)
      : fixedWindowState;
  useEffect(() => {
    if (windowState && windowState !== scrollWindowState) setScrollWindowState(windowState);
  }, [windowState, scrollWindowState]);
  const scrollWindow = useMemo(
    () => windowState ? computeScrollWindow(windowState, scrollWindowOptions) : null,
    [windowState, scrollWindowOptions],
  );
  const windowKey = windowState ? `${windowState.mode}:${windowState.anchorKey}` : "";

  const jumpTo = useCallback((date: Date) => {
    setSelectedDate(date);
    setMiniMonth(date);
    setVisibleDate(null);
    setFocus((prev) => ({ date, nonce: prev.nonce + 1 }));
    if (!scrollMode) return;
    setScrollWindowState((prev) => {
      const current = normalizeScrollWindowState(prev, scrollMode, date);
      const loaded = computeScrollWindow(current, scrollWindowOptions);
      return scrollWindowContains(loaded, scrollMode, date, scrollWindowOptions)
        ? current
        : freshScrollWindowState(scrollMode, date);
    });
  }, [setSelectedDate, scrollMode, scrollWindowOptions]);

  const extendScrollWindow = useCallback((side: "before" | "after") => {
    if (!scrollMode) return;
    setScrollWindowState((prev) => growScrollWindow(normalizeScrollWindowState(prev, scrollMode, focus.date), side));
  }, [scrollMode, focus.date]);
  const extendWindowStart = useCallback(() => extendScrollWindow("before"), [extendScrollWindow]);
  const extendWindowEnd = useCallback(() => extendScrollWindow("after"), [extendScrollWindow]);

  // The views report the day they show as the user scrolls; the title and
  // the mini calendar follow it, the selection does not.
  const handleVisibleDateChange = useCallback((date: Date) => {
    // Hidden for printing, a view scrolls on its own; the copy keeps the dates on screen.
    if (usePrintStore.getState().printing) return;
    setVisibleDate(date);
    setMiniMonth(date);
  }, []);
  useEffect(() => {
    setVisibleDate(null);
  }, [normalizedViewMode]);

  const scrollViewProps: ScrollWindowViewProps = {
    focus,
    rangeStart: scrollWindow?.start ?? focus.date,
    rangeEnd: scrollWindow?.end ?? focus.date,
    windowKey,
    onExtendStart: calendarFreeScroll && scrollWindow?.canExtendStart ? extendWindowStart : undefined,
    onExtendEnd: calendarFreeScroll && scrollWindow?.canExtendEnd ? extendWindowEnd : undefined,
    isLoading: isLoadingEvents,
    onVisibleDateChange: handleVisibleDateChange,
  };

  const dateRange = useMemo(() => {
    if (!scrollWindow) return null;
    return {
      start: format(scrollWindow.start, "yyyy-MM-dd'T'00:00:00"),
      end: format(scrollWindow.end, "yyyy-MM-dd'T'23:59:59"),
    };
  }, [scrollWindow]);

  // Fetch tasks when tasks view is active or when tasks are shown on calendar grid
  useEffect(() => {
    if (client && enableCalendarTasks && (normalizedViewMode === "tasks" || showTasksOnCalendar)) {
      fetchTasksFn(client);
    }
  }, [client, enableCalendarTasks, normalizedViewMode, showTasksOnCalendar, fetchTasksFn]);

  useEffect(() => {
    if (isEmbedded || proInterfaceActive) return;
    if (client && calendars.length > 0 && dateRange) {
      fetchEvents(client, dateRange.start, dateRange.end);
    }
  }, [client, calendars.length, dateRange, fetchEvents, isEmbedded, proInterfaceActive]);

  // Pro shell only: aggregate calendars and events from every connected
  // account so the sidebar lists them all (and the views render their
  // events together). The hook is a no-op outside the embedded shell.
  const { enabled: multiAccountEnabled, accountClients } = useProMultiAccountCalendars(
    isEmbedded ? dateRange?.start ?? null : null,
    isEmbedded ? dateRange?.end ?? null : null,
  );
  const fetchAllAccountsCalendarsFn = useCalendarStore((s) => s.fetchAllAccountsCalendars);
  const fetchAllAccountsEventsFn = useCalendarStore((s) => s.fetchAllAccountsEvents);

  // Loads the range the view shows now - after a failed load the same as the
  // store's dateRange, which then holds the range asked for.
  const retryEventsLoad = useCallback(() => {
    if (!client || !dateRange) return;
    if (multiAccountEnabled && accountClients.length > 0) {
      void fetchAllAccountsEventsFn(accountClients, dateRange.start, dateRange.end);
      return;
    }
    void fetchEvents(client, dateRange.start, dateRange.end);
  }, [client, dateRange, multiAccountEnabled, accountClients, fetchAllAccountsEventsFn, fetchEvents]);

  // The arrows step from what is on screen, which may have been scrolled
  // away from the selected day.
  const navigatePrev = useCallback(() => {
    const base = visibleDate ?? selectedDate;
    let next: Date;
    switch (normalizedViewMode) {
      case "month": next = subMonths(base, 1); break;
      case "week": next = subWeeks(base, 1); break;
      case "day": next = subDays(base, 1); break;
      case "agenda": next = subMonths(base, 1); break;
      case "tasks": return;
    }
    jumpTo(next);
  }, [normalizedViewMode, selectedDate, visibleDate, jumpTo]);

  const navigateNext = useCallback(() => {
    const base = visibleDate ?? selectedDate;
    let next: Date;
    switch (normalizedViewMode) {
      case "month": next = addMonths(base, 1); break;
      case "week": next = addWeeks(base, 1); break;
      case "day": next = addDays(base, 1); break;
      case "agenda": next = addMonths(base, 1); break;
      case "tasks": return;
    }
    jumpTo(next);
  }, [normalizedViewMode, selectedDate, visibleDate, jumpTo]);

  const goToToday = useCallback(() => {
    jumpTo(displayNow());
  }, [jumpTo]);

  // Swipe navigation handlers for mobile
  const handleTouchStart = useCallback((e: ReactTouchEvent) => {
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
  }, []);

  const handleTouchEnd = useCallback((e: ReactTouchEvent) => {
    if (!touchStartRef.current || !isMobile) return;
    // Week and day views scroll sideways themselves, skip swipe navigation
    if (normalizedViewMode === 'week' || normalizedViewMode === 'day') { touchStartRef.current = null; return; }
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
    // On mobile month view, tapping a date switches to day view on that day.
    if (isMobile && normalizedViewMode === "month") {
      jumpTo(date);
      setMobileReturnToMonth(true);
      setViewMode("day");
    } else {
      // A click in the grid selects the day without moving the view.
      setSelectedDate(date);
      setMiniMonth(date);
    }
    // Close the narrow-pane sidebar overlay after the user picks a date.
    setNarrowSidebarOpen(false);
  }, [setSelectedDate, jumpTo, isMobile, normalizedViewMode, setViewMode]);

  // Clicking a date number in the week or month header opens that day in
  // the day view, as in Google Calendar.
  const handleOpenDay = useCallback((date: Date) => {
    setMobileReturnToMonth(isMobile && normalizedViewMode === "month");
    jumpTo(date);
    setSelectedDate(date);
    setMiniMonth(date);
    setViewMode("day");
    setNarrowSidebarOpen(false);
  }, [jumpTo, setSelectedDate, setViewMode, isMobile, normalizedViewMode]);

  // The mini calendar is a navigation control: unlike a click in the week or
  // month grid, which marks a day that is already on screen, picking a day
  // here has to bring that day into view.
  const handleMiniCalendarSelect = useCallback((date: Date) => {
    jumpTo(date);
    if (isMobile && normalizedViewMode === "month") {
      setMobileReturnToMonth(true);
      setViewMode("day");
    }
    setNarrowSidebarOpen(false);
  }, [jumpTo, isMobile, normalizedViewMode, setViewMode]);

  const navigateBackToMonth = useCallback(() => {
    setMobileReturnToMonth(false);
    setViewMode("month");
  }, [setViewMode]);

  const handleMiniMonthChange = useCallback((date: Date) => {
    jumpTo(date);
  }, [jumpTo]);

  // Runs `then` at once, or, while an editor holds unsaved changes, after
  // the user agreed to drop them: a click elsewhere in the calendar must
  // not throw away what was typed (R5).
  const discardingRef = useRef(false);
  const whenEditorsDiscarded = useCallback((then: () => void) => {
    const dirty = eventEditorDirtyRef.current || taskEditorDirtyRef.current;
    if (!dirty) { then(); return; }
    if (discardingRef.current) return;
    discardingRef.current = true;
    void confirmAction({
      title: t("discard.title"),
      message: t("discard.message"),
      confirmText: t("discard.confirm"),
      cancelText: t("discard.keep"),
      variant: "destructive",
    }).then((ok) => {
      discardingRef.current = false;
      if (!ok) return;
      eventEditorDirtyRef.current = false;
      taskEditorDirtyRef.current = false;
      then();
    });
  }, [confirmAction, t]);

  const openCreateModal = useCallback((date?: Date, endDate?: Date, allDay?: boolean) => whenEditorsDiscarded(() => {
    setQuickDraft(null);
    setDefaultModalTitle(undefined);
    setEditEvent(null);
    const d = date || selectedDate;
    setDefaultModalDate(d);
    setDefaultModalEndDate(endDate);
    setDefaultModalAllDay(allDay ?? false);
    setSelectedDate(d);
    setShowTaskModal(false);
    setEditTask(null);
    setShowEventModal(true);
  }), [selectedDate, setSelectedDate, whenEditorsDiscarded]);

  const openEditModal = useCallback((event: CalendarEvent, startInForm = false) => whenEditorsDiscarded(() => {
    setModalStartsInEdit(startInForm);
    setEditEvent(event);
    setDefaultModalDate(undefined);
    setShowTaskModal(false);
    setEditTask(null);
    setShowEventModal(true);
  }), [whenEditorsDiscarded]);

  // The event and task panels share the space beside the grid; now that
  // tasks open from the month, week and day views (#1107), opening one
  // closes the other.
  const closeEventPanelForTask = useCallback(() => {
    setShowEventModal(false);
    setEditEvent(null);
    setPendingPreview(null);
    setDefaultCalendarIdForCreate(undefined);
    setDefaultModalAllDay(false);
  }, []);

  const openCreateTaskModal = useCallback(() => whenEditorsDiscarded(() => {
    closeEventPanelForTask();
    setEditTask(null);
    setShowTaskModal(true);
  }), [closeEventPanelForTask, whenEditorsDiscarded]);

  const openEditTaskModal = useCallback((task: CalendarTask) => whenEditorsDiscarded(() => {
    closeEventPanelForTask();
    setEditTask(task);
    setShowTaskModal(true);
  }), [closeEventPanelForTask, whenEditorsDiscarded]);

  const handleToggleTaskComplete = useCallback((task: CalendarTask) => {
    if (!client) return;
    // The checkbox shows the result; only a failure needs saying.
    toggleTaskCompleteFn(client, task).catch((error: unknown) => {
      toast.error(describeError(error, t("notifications.task_update_error")));
    });
  }, [client, toggleTaskCompleteFn, describeError, t]);

  // false: a plugin stopped it and said why, or the save failed: the task
  // form stays open with what was typed.
  const handleSaveTask = useCallback(async (data: Partial<import("@/lib/jmap/types").CalendarTask>) => {
    if (!client) return false;
    let saved: boolean;
    try {
      saved = editTask
        ? await taskStore.updateTask(client, editTask.id, data)
        : (await taskStore.createTask(client, data)) !== null;
    } catch (error) {
      toast.error(describeError(error, t("notifications.task_save_error")));
      return false;
    }
    if (!saved) return false;
    toast.success(t(editTask ? "notifications.task_updated" : "notifications.task_created"));
    setShowTaskModal(false);
    setEditTask(null);
    return true;
  }, [client, editTask, taskStore, describeError, t]);

  // A task delete can't be taken back: ask first (R3), then say how it went.
  const handleDeleteTask = useCallback(async (id: string) => {
    if (!client) return;
    const task = taskStore.tasks.find((x) => x.id === id);
    const ok = await confirmAction({
      title: t("delete_dialog.task_title"),
      message: t("delete_dialog.task_message", { title: task?.title || t("tasks.no_title") }),
      confirmText: t("delete_dialog.confirm"),
      variant: "destructive",
    });
    if (!ok) return;
    try {
      // false: a plugin stopped it and said why.
      if (!(await taskStore.deleteTask(client, id))) return;
    } catch (error) {
      toast.error(describeError(error, t("notifications.task_delete_error")));
      return;
    }
    toast.success(t("notifications.task_deleted"));
    setShowTaskModal(false);
    setEditTask(null);
  }, [client, taskStore, confirmAction, describeError, t]);

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeDetail = useCallback(() => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    detailPinnedRef.current = false;
    setDetailPinned(false);
    setDetailEvent(null);
    setDetailAnchorRect(null);
  }, []);

  const handleSelectEvent = useCallback((event: CalendarEvent, anchorRect: DOMRect) => {
    // Phones open the full editor; wide screens show the event's card next
    // to it, with edit and delete at the top (as in Google Calendar).
    if (isMobile) {
      closeDetail();
      openEditModal(event);
      return;
    }
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    setQuickDraft(null);
    detailPinnedRef.current = true;
    setDetailPinned(true);
    setDetailEvent(event);
    setDetailAnchorRect(anchorRect);
    // A click opens the event's card; the hover preview does not count as
    // opening it. The editor reports its own opens (event-modal).
    void calendarHooks.onCalendarEventOpen.emit(eventToView(event));
  }, [isMobile, closeDetail, openEditModal]);

  const {
    contextMenu: eventContextMenu,
    openContextMenu: openEventContextMenu,
    openContextMenuFrom: openEventContextMenuFrom,
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

  // No preview over an open editor, card or dialog, nor after one closed
  // until the pointer moves.
  const canHoverPreview = useHoverPreviewGate(showEventModal || showTaskModal || detailPinned || quickDraft !== null);

  const handleHoverEvent = useCallback((event: CalendarEvent, anchorRect: DOMRect) => {
    if (isMobile) return;
    if (detailPinnedRef.current) return;
    if (calendarHoverPreview === 'off') return;
    // Settings > Accessibility: previews open on click only.
    if (!hoverOpens()) return;
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    if (!canHoverPreview()) return;
    if (calendarHoverPreview === 'delay-500ms' || calendarHoverPreview === 'delay-1s' || calendarHoverPreview === 'delay-2s') {
      const ms = calendarHoverPreview === 'delay-500ms' ? 500 : calendarHoverPreview === 'delay-1s' ? 1000 : 2000;
      hoverTimerRef.current = setTimeout(() => {
        if (!canHoverPreview()) return;
        setDetailEvent(event);
        setDetailAnchorRect(anchorRect);
      }, ms);
    } else {
      setDetailEvent(event);
      setDetailAnchorRect(anchorRect);
    }
  }, [isMobile, calendarHoverPreview, canHoverPreview]);

  const handleHoverLeave = useCallback(() => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    if (detailPinnedRef.current) return;
    hoverTimerRef.current = setTimeout(() => {
      if (detailPinnedRef.current) return;
      setDetailEvent(null);
      setDetailAnchorRect(null);
    }, 300);
  }, []);

  // ---- Deep links (#733) ---------------------------------------------------
  // `/calendar/<view>/<date>` moves the grid; `/calendar/event/<id>` opens the
  // event's sidebar and parks the grid on the day it starts. Applied once the
  // JMAP session is up, then the URL becomes an output of the view (below).
  // Held in a ref so the live-delivery subscription (Pro shell) always calls
  // the copy that closes over the current client and handlers.
  const applyCalendarDeepLink = (link: CalendarDeepLink) => {
    if (link.kind === 'view') {
      setViewMode(link.view);
      if (link.date) jumpTo(link.date);
      return;
    }

    // A hit from another login (global search) is fetched through that
    // login's client - the active one can't see it (#847).
    const reachingClient = (link.login ? getClientByLocalAccountId(link.login) : null) ?? client;
    if (!reachingClient) return;
    void (async () => {
      try {
        const event = await reachingClient.getCalendarEvent(link.id, link.accountId);
        if (!event) {
          toast.error(tDeepLink('event_not_found'));
          return;
        }
        const start = getEventStartDate(event);
        if (start) jumpTo(start);
        openEditModal(event);
      } catch (err) {
        debug.error('Failed to open calendar deep link:', err);
        toast.error(tDeepLink('event_not_found'));
      }
    })();
  };
  const applyCalendarDeepLinkRef = useRef(applyCalendarDeepLink);
  applyCalendarDeepLinkRef.current = applyCalendarDeepLink;

  const deepLinkHandledRef = useRef(false);
  useEffect(() => {
    if (deepLinkHandledRef.current) return;
    if (!isAuthenticated || !client) return;

    const entry = linkSegments ? { segments: linkSegments } : consumePendingDeepLinkEntry('calendar');
    const segments = entry?.segments ?? [];
    const link = parseCalendarPath(segments, new URLSearchParams(entry?.search ?? window.location.search));
    deepLinkHandledRef.current = true;
    if (!link) return;
    applyCalendarDeepLinkRef.current(link);
  }, [isAuthenticated, client, linkSegments]);

  // Pro shell only: this surface stays mounted for the whole session, so links
  // arriving after mount are delivered live instead of being parked forever.
  // Embedded-only: during a cold-load redirect the standard instance renders
  // briefly and must not steal the link parked for the Pro one.
  useEffect(() => {
    if (!isEmbedded) return;
    return subscribePendingDeepLink('calendar', (segments, search) => {
      const link = parseCalendarPath(segments, new URLSearchParams(search ?? window.location.search));
      if (link) applyCalendarDeepLinkRef.current(link);
    });
  }, [isEmbedded]);

  // The permalink for what the calendar is currently showing. In the Pro
  // shell only the focused tab writes the address bar; the standard instance
  // that renders while Pro takes over a route stays silent.
  const isFocusedProTab = useIsFocusedProTab();
  const isPaneScoped = useIsPaneScoped();
  // The phone's full-screen task editor: Tab stays in it and the focus goes
  // back to the button that opened it. Escape is the editor's own (it asks
  // about unsaved changes).
  const mobileTaskEditorRef = useFocusTrap({ isActive: showTaskModal && isMobile, restoreFocus: true });
  const eventLinkId = showEventModal && editEvent ? editEvent.id : null;
  const calendarLinkPath = appPath(buildCalendarPath({
    view: normalizedViewMode,
    date: selectedDate,
    eventId: eventLinkId,
    accountId: eventLinkId ? editEvent?.accountId : null,
  }));
  useDeepLinkUrl(
    isEmbedded
      ? (isFocusedProTab ? calendarLinkPath : null)
      : proInterfaceActive ? null : calendarLinkPath,
  );

  // Browser Back closes the event or task editor (asking first when it has
  // unsaved changes) instead of leaving the calendar (R5).
  const closeEditors = useCallback(() => {
    setShowEventModal(false);
    setEditEvent(null);
    setPendingPreview(null);
    setDefaultCalendarIdForCreate(undefined);
    setDefaultModalAllDay(false);
    setShowTaskModal(false);
    setEditTask(null);
  }, []);
  const editorsInView = (showEventModal || showTaskModal) && (isEmbedded ? isFocusedProTab : !proInterfaceActive);
  useCloseOnBack({
    active: editorsInView,
    shouldHold: () => eventEditorDirtyRef.current || taskEditorDirtyRef.current,
    onBack: () => whenEditorsDiscarded(closeEditors),
  });
  // The rail, the phone tab bar and the Mountain View top bar ask too,
  // before they leave the calendar (R5). Only ask there: leaving unmounts
  // the editor, and clearing it first would let the Back guard above take
  // its history step back over the navigation.
  useLeaveGuard(
    () => editorsInView && (eventEditorDirtyRef.current || taskEditorDirtyRef.current),
    () => confirmAction({
      title: t("discard.title"),
      message: t("discard.message"),
      confirmText: t("discard.confirm"),
      cancelText: t("discard.keep"),
      variant: "destructive",
    }),
  );

  const handleEditFromDetail = useCallback(() => {
    if (detailEvent) {
      const ev = detailEvent;
      closeDetail();
      // The pencil on the event card goes straight to the form.
      openEditModal(ev, true);
    }
  }, [detailEvent, closeDetail, openEditModal]);

  const findMasterEvent = useCallback(async (occurrence: CalendarEvent): Promise<CalendarEvent | null> => {
    if ((occurrence.recurrenceRules?.length ?? 0) > 0 && !occurrence.recurrenceId) {
      return occurrence;
    }
    // An occurrence expanded by the server names its base event outright.
    // Fetch it through the occurrence's own account and hand it back under
    // the store id the base would have, so the store routes mutations on it
    // through the same account (see resolveMutationTarget).
    if (isServerRecurrenceInstance(occurrence) && occurrence.baseEventId) {
      const accountClient = (occurrence.localAccountId && getClientByLocalAccountId(occurrence.localAccountId)) || client;
      if (!accountClient) return null;
      const master = await accountClient.getCalendarEvent(occurrence.baseEventId, occurrence.accountId);
      if (!master) return null;
      return {
        ...master,
        id: baseEventStoreId(occurrence) ?? master.id,
        originalId: master.id,
        originalCalendarIds: master.calendarIds,
        calendarIds: occurrence.calendarIds,
        accountId: occurrence.accountId,
        accountName: occurrence.accountName,
        localAccountId: occurrence.localAccountId,
        isShared: occurrence.isShared,
      };
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
      await fetchAllAccountsEventsFn(accountClients, currentRange.start, currentRange.end);
      return;
    }
    await fetchEvents(client, currentRange.start, currentRange.end);
  }, [client, fetchEvents, multiAccountEnabled, accountClients, activeAccountId, fetchAllAccountsEventsFn]);

  // Intercept browser refresh gestures (F5, Ctrl/Cmd+R, pull-to-refresh)
  // and refresh calendar data via JMAP instead of reloading the page.
  const refreshCalendar = useCallback(async () => {
    if (!client) return;
    const calendarRefresh = multiAccountEnabled && accountClients.length > 0 && activeAccountId
      ? fetchAllAccountsCalendarsFn(accountClients, activeAccountId)
      : fetchCalendars(client);
    await Promise.all([
      calendarRefresh,
      refetchCurrentRange(),
      refreshAllSubscriptions(client),
    ]);
  }, [client, multiAccountEnabled, accountClients, activeAccountId, fetchAllAccountsCalendarsFn, fetchCalendars, refetchCurrentRange, refreshAllSubscriptions]);
  const { indicator: refreshIndicator } = useRefreshGesture({
    enabled: isAuthenticated && !!client,
    onRefresh: refreshCalendar,
  });

  // Changes made elsewhere (another device, another session, an invitation)
  // reach the open calendar through push (#1349).
  useCalendarPushRefresh(() => {
    if (!client || !supportsCalendar) return;
    // The standard instance under the Pro takeover leaves the data to the Pro tab.
    if (!isEmbedded && proInterfaceActive) return;
    const merged = multiAccountEnabled && accountClients.length > 0 && activeAccountId;
    void (merged ? fetchAllAccountsCalendarsFn(accountClients, activeAccountId) : fetchCalendars(client));
    void refetchCurrentRange();
    // Tasks are calendar objects too (e.g. one created over CalDAV).
    if (enableCalendarTasks && (normalizedViewMode === "tasks" || showTasksOnCalendar)) void fetchTasksFn(client);
  }, { enabled: isAuthenticated && !!client, includeBackground: multiAccountEnabled });

  // The time a saved event starts at, for the week and day grids to show it
  // even when it is outside the hours on screen.
  const [revealAt, setRevealAt] = useState<RevealTime | null>(null);
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

    jumpTo(eventDate);
    if (!event.showWithoutTime) {
      setRevealAt((prev) => ({ minutes: eventDate.getHours() * 60 + eventDate.getMinutes(), nonce: (prev?.nonce ?? 0) + 1 }));
    }
  }, [jumpTo]);

  const handleSaveEvent = useCallback(async (data: Partial<CalendarEvent>, requestedScheduling?: boolean, editor?: EventEditorState) => {
    if (!client) { toast.error(t("notifications.event_error")); return; }
    const save = async (sendSchedulingMessages: boolean | undefined): Promise<void> => {
      try {
        if (editEvent) {
          if (isRecurringEvent(editEvent)) {
            setPendingScopeAction({
              type: "edit",
              event: editEvent,
              updates: data,
              editor,
              sendScheduling: sendSchedulingMessages,
              fromEditor: true,
            });
            return;
          }
          // false: a plugin stopped it and said why; the form stays open.
          if (!(await updateEvent(client, editEvent.id, data, sendSchedulingMessages))) return;
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
      } catch (error) {
        // The server refuses to send the invitations (Stalwart 0.16.21+ fails
        // the whole save then). Offer to keep the event without them.
        if (error instanceof SchedulingDeniedError && sendSchedulingMessages) {
          const ok = await confirmAction({
            title: t("notifications.invitations_denied_title"),
            message: t("notifications.invitations_denied", { reason: error.reason }),
            confirmText: t("notifications.save_without_invitations"),
          });
          if (ok) await save(false);
          return;
        }
        toast.error(describeError(error, t("notifications.event_error")));
      }
    };
    await save(requestedScheduling);
  }, [client, editEvent, createEvent, updateEvent, focusCalendarOnEvent, confirmAction, describeError, t]);

  // Calendars a new task can go into: writable, not a subscription.
  const writableTaskCalendars = useMemo(
    () => calendars.filter((c) => canCreateEventsIn(c, isSubscriptionCalendar)),
    [calendars, isSubscriptionCalendar],
  );

  // Calendars a new event can go into: never a subscription or read-only one (#762).
  const writableCalendars = useMemo(
    () => calendars.filter((c) => !c.isTasksOnly && canCreateEventsIn(c, isSubscriptionCalendar)),
    [calendars, isSubscriptionCalendar],
  );

  // A click or drag on empty grid space. On wide screens it opens the quick
  // editor at that spot; on phones the full editor, as before.
  const handleGridCreate = useCallback((start: Date, end?: Date, allDay = false) => whenEditorsDiscarded(() => {
    if (isMobile) {
      openCreateModal(start, end, allDay);
      return;
    }
    const finalEnd = end ?? (allDay ? start : new Date(start.getTime() + 60 * 60 * 1000));
    const preferred = writableCalendars.find((c) => c.isDefault) ?? writableCalendars[0];
    setShowEventModal(false);
    setEditEvent(null);
    setShowTaskModal(false);
    setEditTask(null);
    closeDetail();
    setQuickDraft((prev) => ({
      start,
      end: finalEnd,
      title: "",
      allDay,
      calendarId: prev && writableCalendars.some((c) => c.id === prev.calendarId)
        ? prev.calendarId
        : preferred?.id ?? "",
    }));
  }), [isMobile, openCreateModal, writableCalendars, closeDetail, whenEditorsDiscarded]);

  // A day in the month view or the all-day row: an all-day event, the same
  // quick editor as a slot in week and day view.
  const handleGridCreateAllDay = useCallback((day: Date) => {
    const start = new Date(day);
    start.setHours(0, 0, 0, 0);
    handleGridCreate(start, start, true);
  }, [handleGridCreate]);

  const closeQuickCreate = useCallback(() => setQuickDraft(null), []);

  // The create button and `n` make what the view shows: a task in Tasks.
  const inTasksView = normalizedViewMode === "tasks";
  const openCreateForView = useCallback(() => {
    if (inTasksView) openCreateTaskModal();
    else openCreateModal();
  }, [inTasksView, openCreateTaskModal, openCreateModal]);
  const createLabel = inTasksView ? t("events.new_task") : t("events.create");

  const handleQuickCreateMoreOptions = useCallback(() => {
    if (!quickDraft) return;
    const draft = quickDraft;
    openCreateModal(draft.start, draft.end, draft.allDay);
    setDefaultCalendarIdForCreate(draft.calendarId || undefined);
    setDefaultModalTitle(draft.title || undefined);
  }, [quickDraft, openCreateModal]);

  const handleQuickCreateSave = useCallback(async () => {
    if (!quickDraft) return;
    const { start, end, title, calendarId, allDay } = quickDraft;
    if (allDay) {
      setQuickDraft(null);
      await handleSaveEvent({
        uid: generateUUID(),
        title: title.trim(),
        start: format(start, "yyyy-MM-dd'T'00:00:00"),
        duration: "P1D",
        timeZone: null,
        showWithoutTime: true,
        calendarIds: { [calendarId]: true },
        status: "confirmed",
        freeBusyStatus: "busy",
        privacy: "public",
      });
      return;
    }
    const minutes = Math.max(15, Math.round((end.getTime() - start.getTime()) / 60000));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    const duration = `PT${hours > 0 ? `${hours}H` : ""}${rest > 0 ? `${rest}M` : ""}`;
    setQuickDraft(null);
    // Grid dates are wall-clock times in the user's zone (#755), the same
    // as the full editor's fields, so they are labelled with that zone.
    await handleSaveEvent({
      uid: generateUUID(),
      title: title.trim(),
      start: format(start, "yyyy-MM-dd'T'HH:mm:ss"),
      duration,
      timeZone: getEffectiveTimeZone(),
      showWithoutTime: false,
      calendarIds: { [calendarId]: true },
      status: "confirmed",
      freeBusyStatus: "busy",
      privacy: "public",
    });
  }, [quickDraft, handleSaveEvent]);

  // While the quick editor is open its placeholder takes the preview slot.
  const gridPreview = useMemo<PendingEventPreview | null>(() => {
    if (!quickDraft) return pendingPreview;
    return {
      start: quickDraft.start,
      end: quickDraft.end,
      title: quickDraft.title.trim() || t("events.no_title"),
      allDay: !!quickDraft.allDay,
      calendarId: quickDraft.calendarId,
    };
  }, [quickDraft, pendingPreview, t]);

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
    } catch (error) {
      toast.error(describeError(error, t("notifications.event_error")));
      setShowEventModal(false);
      setEditEvent(null);
    }
  }, [client, createEvent, focusCalendarOnEvent, describeError, t]);

  const handleDeleteEvent = useCallback(async (id: string, sendSchedulingMessages?: boolean) => {
    if (!client) { toast.error(t("notifications.event_error")); return; }
    const eventToDelete = events.find(e => e.id === id) || editEvent;
    if (eventToDelete && isRecurringEvent(eventToDelete)) {
      setPendingScopeAction({
        type: "delete",
        event: eventToDelete,
        sendScheduling: sendSchedulingMessages || undefined,
        fromEditor: showEventModal && editEvent?.id === eventToDelete.id,
      });
      return;
    }
    // One event: asked here, from every place Delete is offered (R3). A
    // series gets the scope question above instead.
    const title = eventToDelete?.title || t("events.no_title");
    const cancels = !!sendSchedulingMessages && !!eventToDelete && userOrganizes(eventToDelete, currentUserEmails);
    const ok = await confirmAction({
      title: t("delete_dialog.event_title"),
      message: cancels
        ? t("delete_dialog.event_message_attendees", { title })
        : t("delete_dialog.event_message", { title }),
      confirmText: t("delete_dialog.confirm"),
      variant: "destructive",
    });
    if (!ok) return;
    try {
      if (!(await deleteEvent(client, id, sendSchedulingMessages))) return;
      toast.success(t("notifications.event_deleted"));
      if (editEvent?.id === id) {
        setShowEventModal(false);
        setEditEvent(null);
      }
    } catch (error) {
      toast.error(describeError(error, t("notifications.event_delete_error")));
    }
  }, [client, deleteEvent, events, editEvent, showEventModal, confirmAction, currentUserEmails, describeError, t]);

  const submitRsvp = useCallback(async (
    eventId: string,
    participantId: string,
    status: CalendarParticipant['participationStatus'],
    scope: 'occurrence' | 'series' = 'series',
    sentBy?: string,
  ) => {
    if (!client) return;
    try {
      if (await rsvpEvent(client, eventId, participantId, status, undefined, scope, sentBy ? { sentBy } : undefined)) toast.success(t("notifications.rsvp_updated"));
    } catch (error) {
      toast.error(describeError(error, t("notifications.rsvp_error")));
    }
  }, [client, rsvpEvent, describeError, t]);

  const handleScopeSelect = useCallback(async (scope: RecurrenceEditScope) => {
    if (!client || !pendingScopeAction) { toast.error(t("notifications.event_error")); return; }
    if (pendingScopeAction.type === "rsvp") {
      const { event, participantId, status, sentBy } = pendingScopeAction;
      setPendingScopeAction(null);
      await submitRsvp(event.id, participantId, status, scope === "this" ? "occurrence" : "series", sentBy);
      return;
    }
    const { type, event, sendScheduling, fromEditor } = pendingScopeAction;
    const updates = type === "edit" ? pendingScopeAction.updates : undefined;
    const editor = type === "edit" ? pendingScopeAction.editor : undefined;
    setPendingScopeAction(null);
    // The editor the question came from closes once the change went through.
    const closeEditor = () => {
      if (!fromEditor) return;
      setShowEventModal(false);
      setEditEvent(null);
    };

    // false when a plugin stopped the change (it says why): no "updated".
    let done = true;
    try {
      if (type === "edit" && updates) {
        const saved = await saveOccurrenceEdit(scope, {
          event,
          updates,
          editor,
          sendScheduling,
          userEmails: currentUserEmails,
          resolveName: resolveContactName,
        }, { client, updateEvent, createEvent, findMasterEvent });
        done = saved !== "stopped";
        if (!saved) {
          toast.error(t("notifications.event_error"));
          return;
        }
        if (!done) return;
        closeEditor();
        toast.success(t("notifications.event_updated"));
      } else {
        const deleted = await deleteOccurrence(scope, {
          event,
          sendScheduling,
          userEmails: currentUserEmails,
        }, { client, updateEvent, deleteEvent, findMasterEvent });
        done = deleted !== "stopped";
        if (!deleted) {
          toast.error(t("notifications.event_error"));
          return;
        }
        if (!done) return;
        closeEditor();
        toast.success(t("notifications.event_deleted"));
      }
      try {
        await refetchCurrentRange();
      } catch {
        debug.error("Failed to refresh calendar after scope operation");
      }
    } catch (error) {
      toast.error(describeError(error, t(type === "delete" ? "notifications.event_delete_error" : "notifications.event_error")));
    }
  }, [client, pendingScopeAction, updateEvent, deleteEvent, createEvent, findMasterEvent, currentUserEmails, resolveContactName, refetchCurrentRange, submitRsvp, describeError, t]);

  // A drag or resize. A series asks which occurrences it covers, as the
  // editor does; one event moves at once and can be moved back.
  const handleMoveEvent = useCallback<MoveEventHandler>(async (event, updates, sendScheduling, kind) => {
    if (!client) { toast.error(t("notifications.event_move_error")); return; }
    if (isRecurringEvent(event)) {
      const moved = { ...event, ...updates };
      const allDay = !!event.showWithoutTime;
      // The attendees stay as they are; the save works out the rest from
      // where the occurrence went, as for a time changed in the editor.
      const attendees = getParticipantList(event, { resolveName: resolveContactName })
        .filter((p) => !p.isOrganizer && p.email)
        .map((p) => ({ name: p.name, email: p.email.trim() }));
      setPendingScopeAction({
        type: "edit",
        event,
        updates,
        sendScheduling,
        editor: {
          initialAttendees: attendees,
          attendees,
          when: { allDay, start: getEventStartDate(moved), end: allDay ? getEventDisplayEndDate(moved) : getEventEndDate(moved) },
          ruleChanged: false,
        },
      });
      return;
    }
    try {
      // false: a plugin stopped it and said why.
      if (!(await updateEvent(client, event.id, updates, sendScheduling))) return;
    } catch (error) {
      toast.error(describeError(error, t(kind === "resize" ? "notifications.event_resize_error" : "notifications.event_move_error")));
      return;
    }
    const before: Partial<CalendarEvent> = { start: event.start, duration: event.duration };
    if (updates.timeZone !== undefined) before.timeZone = event.timeZone;
    toast.success(t(kind === "resize" ? "notifications.event_updated" : "notifications.event_moved"), {
      action: {
        label: t("notifications.undo"),
        onClick: () => {
          void updateEvent(client, event.id, before, sendScheduling).catch((error: unknown) => {
            toast.error(describeError(error, t("notifications.event_move_error")));
          });
        },
      },
    });
  }, [client, updateEvent, resolveContactName, describeError, t]);

  const handleRsvp = useCallback(async (eventId: string, participantId: string, status: CalendarParticipant['participationStatus'], sentBy?: string) => {
    if (!client) return;
    // An answer on one occurrence of a series asks whether it covers just
    // that occurrence or the whole series (#1086).
    const occurrence = events.find(e => e.id === eventId && e.recurrenceId != null);
    if (occurrence) {
      setPendingScopeAction({ type: "rsvp", event: occurrence, participantId, status, sentBy });
      return;
    }
    await submitRsvp(eventId, participantId, status, "series", sentBy);
  }, [client, events, submitRsvp]);

  const handleDeleteFromDetail = useCallback(() => {
    if (!detailEvent) return;
    const hasParticipants = detailEvent.participants && Object.keys(detailEvent.participants).length > 0;
    closeDetail();
    handleDeleteEvent(detailEvent.id, hasParticipants || undefined);
  }, [detailEvent, closeDetail, handleDeleteEvent]);

  const handleDuplicateFromDetail = useCallback(async () => {
    if (!detailEvent || !client) return;
    const data = buildDuplicateEventData(detailEvent);
    closeDetail();
    try {
      const created = await createEvent(client, data);
      if (created) {
        toast.success(t("notifications.event_duplicated"));
        openEditModal(created);
      }
    } catch (error) {
      toast.error(describeError(error, t("notifications.event_error")));
    }
  }, [detailEvent, client, createEvent, closeDetail, openEditModal, describeError, t]);

  const handleSaveNoteFromDetail = useCallback(async (note: string) => {
    if (!detailEvent || !client) return;
    const timestamp = format(displayNow(), "yyyy-MM-dd HH:mm");
    const separator = `\n\n--- ${timestamp} ---\n`;
    const newDescription = detailEvent.description
      ? `${detailEvent.description}${separator}${note}`
      : `--- ${timestamp} ---\n${note}`;
    try {
      if (!(await updateEvent(client, detailEvent.id, { description: newDescription }))) return;
      setDetailEvent({ ...detailEvent, description: newDescription });
      toast.success(t("detail.note_saved"));
    } catch (error) {
      toast.error(describeError(error, t("notifications.event_error")));
    }
  }, [detailEvent, client, updateEvent, describeError, t]);

  const handleDuplicateContextMenu = useCallback(async (event: CalendarEvent) => {
    if (!client) { toast.error(t("notifications.event_error")); return; }
    const data = buildDuplicateEventData(event);
    try {
      const created = await createEvent(client, data);
      if (created) {
        toast.success(t("notifications.event_duplicated"));
        openEditModal(created);
      }
    } catch (error) {
      toast.error(describeError(error, t("notifications.event_error")));
    }
  }, [client, createEvent, openEditModal, describeError, t]);

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
    const uri = findMeetingLink(event)?.uri;
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

  const handleRsvpFromDetail = useCallback(async (status: CalendarParticipant['participationStatus'], target?: AnswerTarget) => {
    if (!detailEvent || !client) return;
    // A target names the event and participant: the owner's in a calendar
    // shared with the user, or the user's own copy (lib/calendar-delegate.ts).
    const participantId = target?.participantId ?? getUserParticipantId(detailEvent, currentUserEmails);
    if (!participantId) return;
    closeDetail();
    await handleRsvp(target?.eventId ?? detailEvent.id, participantId, status, target?.sentBy);
  }, [detailEvent, client, currentUserEmails, closeDetail, handleRsvp]);

  // `/` and the palette's "Search events" go to the search box.
  const openSearch = useCallback(() => {
    if (isMobile) { setMobileSearchOpen(true); return; }
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [isMobile]);
  // Moving the calendar (a view, a date) goes back to the grid.
  const leaveSearch = useCallback(() => {
    setSearchQuery("");
    setMobileSearchOpen(false);
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // An open menu, popup or dialog owns the keyboard; a hover preview
      // doesn't, only a card the user opened.
      if (isAppShortcutBlocked(e)) return;
      if (isContextMenuOpen()) return;
      if (showEventModal || showTaskModal || detailPinned) return;

      const action = calendarShortcutAction(e, useSettingsStore.getState().singleKeyShortcuts !== false);
      if (!action) return;
      // A slider, tabs or a menu keeps its own arrows.
      if ((action === "prev" || action === "next") && isArrowKeyWidgetTarget(e)) return;
      if (action !== "new" && action !== "search") leaveSearch();
      switch (action) {
        case "prev": e.preventDefault(); navigatePrev(); break;
        case "next": e.preventDefault(); navigateNext(); break;
        case "today": goToToday(); break;
        case "month": setViewMode("month"); break;
        case "week": setViewMode("week"); break;
        case "day": setViewMode("day"); break;
        case "agenda": setViewMode("agenda"); break;
        case "tasks": if (enableCalendarTasks) setViewMode("tasks"); break;
        // Kept from typing itself into the title field the editor focuses.
        case "new": e.preventDefault(); openCreateForView(); break;
        case "search": e.preventDefault(); openSearch(); break;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [navigatePrev, navigateNext, goToToday, setViewMode, openCreateForView, openSearch, leaveSearch, showEventModal, showTaskModal, detailPinned, enableCalendarTasks]);

  // The command palette's Calendar group, while this calendar is the one in
  // front (in the Pro shell: its focused tab).
  const tCommon = useTranslations("common");
  const tShell = useTranslations("shell");
  const paletteViews: { mode: CalendarViewMode; key: string }[] = [
    { mode: "day", key: "d" },
    { mode: "week", key: "w" },
    { mode: "month", key: "m" },
    { mode: "agenda", key: "a" },
    { mode: "tasks", key: "k" },
  ];
  useRegisterCommands(tSidebar("calendar"), [
    { id: "new-event", label: t("events.new_event"), icon: Plus, shortcut: "n", run: () => openCreateModal() },
    { id: "new-task", label: t("events.new_task"), icon: ListTodo, run: openCreateTaskModal, when: () => enableCalendarTasks },
    { id: "search-events", label: t("search.title"), icon: Search, shortcut: "/", run: openSearch },
    { id: "today", label: t("events.go_to_today"), icon: CalendarDays, shortcut: "t", run: goToToday, when: () => normalizedViewMode !== "tasks" },
    ...paletteViews.map(({ mode, key }) => ({
      id: `view-${mode}`,
      label: t(`commands.${mode}`),
      icon: CalendarDays,
      shortcut: key,
      run: () => { setMobileReturnToMonth(false); leaveSearch(); setViewMode(mode); },
      when: () => mode !== normalizedViewMode && (mode !== "tasks" || enableCalendarTasks),
    })),
    { id: "import", label: t("toolbar.import"), icon: Upload, run: () => setShowImportModal(true), when: () => !demoMode },
    { id: "subscribe", label: t("toolbar.subscribe"), icon: Globe, run: () => setShowSubscriptionModal(true), when: () => canSubscribe },
    { id: "refresh", label: tCommon("refresh"), icon: RefreshCw, shortcut: "F5", run: () => { void refreshCalendar(); } },
  ], isEmbedded ? isFocusedProTab : !proInterfaceActive);

  const birthdayEvents = useMemo(() => {
    if (!showBirthdayCalendar || !dateRange) return [];
    return generateBirthdayEvents(contacts, dateRange.start, dateRange.end);
  }, [showBirthdayCalendar, contacts, dateRange]);

  // Loaded events answer a search at once; the server adds the rest.
  const searchableEvents = useMemo(() => [...events, ...birthdayEvents], [events, birthdayEvents]);
  const searchResults = useCalendarEventSearch(searchQuery, client, searchableEvents);

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
      return { ...cal, color: override, colorIsLocalOverride: true, serverColor: cal.color };
    });
  }, [calendars, sharedCalendarColors]);

  // Auto-assign a random, not-yet-used palette color to any freshly shared
  // calendar the server gives no color, so multiple shared calendars don't
  // collide on one color. Runs once per calendar (guarded by the presence of
  // an existing key), and the user can still overwrite it from the sidebar.
  useEffect(() => {
    const assigned = autoAssignSharedCalendarColors(calendars, sharedCalendarColors);
    for (const [key, color] of Object.entries(assigned)) {
      setSharedCalendarColor(key, color);
    }
  }, [calendars, sharedCalendarColors, setSharedCalendarColor]);

  // Company calendars the admin set (lib/company-calendars.ts): read-only,
  // shown under "Organisation"; hiding one is a synced setting of its own.
  const company = useCompanyCalendars(client);
  const hiddenCompanyCalendars = useSettingsStore((s) => s.hiddenCompanyCalendars);
  const shownCalendarIds = useMemo(() => {
    if (company.calendars.length === 0) return selectedCalendarIds;
    const hidden = new Set(company.hiddenIds);
    return [...selectedCalendarIds, ...company.calendars.map((c) => c.id).filter((id) => !hidden.has(id))];
  }, [selectedCalendarIds, company.calendars, company.hiddenIds]);
  const toggleShownCalendar = useCallback((calendarId: string) => {
    if (!isCompanyCalendarId(calendarId)) {
      toggleCalendarVisibility(calendarId);
      return;
    }
    const feedId = feedIdOf(calendarId);
    const hidden = Array.isArray(hiddenCompanyCalendars) ? hiddenCompanyCalendars : [];
    updateSetting('hiddenCompanyCalendars', hidden.includes(feedId) ? hidden.filter((id) => id !== feedId) : [...hidden, feedId]);
  }, [toggleCalendarVisibility, hiddenCompanyCalendars, updateSetting]);
  const companyEvents = useMemo(() => {
    if (!dateRange || company.events.length === 0) return [];
    const hidden = new Set(company.hiddenIds);
    return expandRecurringEvents(company.events.filter((e) => !Object.keys(e.calendarIds).some((id) => hidden.has(id))), dateRange.start, dateRange.end);
  }, [company.events, company.hiddenIds, dateRange]);

  // The phone toolbar's calendar list: the user's own and the company calendars.
  const toolbarCalendars = useMemo(
    () => (company.calendars.length > 0 ? [...displayCalendars, ...company.calendars] : displayCalendars),
    [displayCalendars, company.calendars],
  );

  const allCalendars = useMemo(() => {
    const withBirthdays = showBirthdayCalendar
      ? [...displayCalendars, createBirthdayCalendar(birthdayCalendarName, birthdayCalendarColor)]
      : displayCalendars;
    return company.calendars.length > 0 ? [...withBirthdays, ...company.calendars] : withBirthdays;
  }, [displayCalendars, showBirthdayCalendar, birthdayCalendarName, birthdayCalendarColor, company.calendars]);

  // What the user may change, by the rights of each event's calendar
  // (birthdays, subscriptions and read-only shares can't be changed).
  const editabilityContext = useMemo<EditabilityContext>(() => ({
    calendarsById: new Map(allCalendars.map((c) => [c.id, c])),
    userCalendarAddresses: currentUserEmails,
    isSubscriptionCalendar,
  }), [allCalendars, currentUserEmails, isSubscriptionCalendar]);
  const canEditEvent = useCallback(
    (event: CalendarEvent) => getEventEditability(event, editabilityContext) === "editable",
    [editabilityContext],
  );

  // The event the user opened, marked in the grid (APP.md: the selected
  // event gets the primary ring).
  const selectedEventId = detailPinned ? detailEvent?.id ?? null : showEventModal ? editEvent?.id ?? null : null;

  const visibleEvents = useMemo(() => {
    const filtered = events.filter((e) => {
      if (!e.start || !e.calendarIds) return false;
      const calIds = Object.keys(e.calendarIds);
      return calIds.some((id) => selectedCalendarIds.includes(id));
    });
    const withCompany = companyEvents.length > 0 ? [...filtered, ...companyEvents] : filtered;
    if (showBirthdayCalendar && selectedCalendarIds.includes(BIRTHDAY_CALENDAR_ID)) {
      return [...withCompany, ...birthdayEvents];
    }
    return withCompany;
  }, [events, selectedCalendarIds, showBirthdayCalendar, birthdayEvents, companyEvents]);

  // The tasks the task list shows; plugin buttons in its toolbar act on them.
  const listedTaskIds = useMemo(
    () => filterTasksForList(taskStore.tasks, selectedCalendarIds, taskStore.filter).map((task) => task.id),
    [taskStore.tasks, selectedCalendarIds, taskStore.filter],
  );

  // Tasks on the month, week and day grids follow the calendar filter like
  // the events do (#1107).
  const calendarTasks = useMemo(() => {
    if (!enableCalendarTasks || !showTasksOnCalendar) return undefined;
    return filterTasksByCalendars(taskStore.tasks, selectedCalendarIds);
  }, [enableCalendarTasks, showTasksOnCalendar, taskStore.tasks, selectedCalendarIds]);

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
    <Dialog
      isOpen
      onClose={closeWebcalActionChoice}
      title={tWebcalAction("title")}
      description={tWebcalAction("description", { name: pendingSubscription.name })}
      footer={<Button variant="outline" onClick={closeWebcalActionChoice}>{tWebcalAction("cancel")}</Button>}
    >
        <div className="pt-4 space-y-3">
          <Button variant="outline" className="w-full justify-start h-auto py-3" onClick={handleImportWebcal}>
            <span className="text-start">
              <span className="block font-medium">{tWebcalAction("import_title")}</span>
              <span className="block text-xs text-muted-foreground mt-0.5">{tWebcalAction("import_description")}</span>
            </span>
          </Button>
          {!IS_LITE && (
            <Button variant="outline" className="w-full justify-start h-auto py-3" onClick={handleSubscribeWebcal}>
              <span className="text-start">
                <span className="block font-medium">{tWebcalAction("subscribe_title")}</span>
                <span className="block text-xs text-muted-foreground mt-0.5">{tWebcalAction("subscribe_description")}</span>
              </span>
            </Button>
          )}
        </div>
    </Dialog>
  ) : null;

  if (!isAuthenticated) return null;
  if (!calendarEnabled) return null;
  if (!supportsCalendar) return renderWebcalAccountPicker();

  const renderView = () => {
    if (isLoading && calendars.length === 0) {
      return <PaneSpinner label={t("status.loading_calendars")} className="flex-1" />;
    }

    const viewContent = (() => {
      if (searchResults && normalizedViewMode !== "tasks") {
        return (
          <CalendarSearchResults
            query={searchQuery}
            results={searchResults}
            calendars={allCalendars}
            timeFormat={timeFormat}
            currentUserEmails={currentUserEmails}
            onSelectEvent={handleSelectEvent}
            onContextMenuEvent={handleContextMenuEvent}
            onClearSearch={() => { setSearchQuery(""); searchInputRef.current?.focus(); }}
          />
        );
      }
      switch (normalizedViewMode) {
        case "month":
          return (
            <CalendarMonthView
              {...scrollViewProps}
              selectedDate={selectedDate}
              events={visibleEvents}
              calendars={allCalendars}
              onSelectDate={handleSelectDate}
              onOpenDay={handleOpenDay}
              onSelectEvent={handleSelectEvent}
              onHoverEvent={handleHoverEvent}
              onHoverLeave={handleHoverLeave}
              onContextMenuEvent={handleContextMenuEvent}
              onContextMenuEmpty={handleContextMenuEmpty}
              onCreateAllDay={handleGridCreateAllDay}
              firstDayOfWeek={firstDayOfWeek}
              isMobile={isMobile}
              pendingPreview={gridPreview}
              tasks={calendarTasks}
              onToggleTaskComplete={handleToggleTaskComplete}
              onSelectTask={openEditTaskModal}
              currentUserEmails={currentUserEmails}
              canEditEvent={canEditEvent}
              selectedEventId={selectedEventId}
              onMoveEvent={handleMoveEvent}
            />
          );
        case "week":
          return (
            <CalendarWeekView
              {...scrollViewProps}
              selectedDate={selectedDate}
              events={visibleEvents}
              calendars={allCalendars}
              onSelectDate={handleSelectDate}
              onOpenDay={handleOpenDay}
              onSelectEvent={handleSelectEvent}
              onHoverEvent={handleHoverEvent}
              onHoverLeave={handleHoverLeave}
              onContextMenuEvent={handleContextMenuEvent}
              onContextMenuEmpty={handleContextMenuEmpty}
              onCreateAtTime={handleGridCreate}
              onCreateAllDay={handleGridCreateAllDay}
              firstDayOfWeek={firstDayOfWeek}
              timeFormat={timeFormat}
              isMobile={isMobile}
              pendingPreview={gridPreview}
              tasks={calendarTasks}
              onToggleTaskComplete={handleToggleTaskComplete}
              onSelectTask={openEditTaskModal}
              currentUserEmails={currentUserEmails}
              canEditEvent={canEditEvent}
              selectedEventId={selectedEventId}
              onMoveEvent={handleMoveEvent}
              revealAt={revealAt}
            />
          );
        case "day":
          return (
            <CalendarDayView
              {...scrollViewProps}
              selectedDate={selectedDate}
              events={visibleEvents}
              calendars={allCalendars}
              onSelectEvent={handleSelectEvent}
              onHoverEvent={handleHoverEvent}
              onHoverLeave={handleHoverLeave}
              onContextMenuEvent={handleContextMenuEvent}
              onContextMenuEmpty={handleContextMenuEmpty}
              onCreateAtTime={handleGridCreate}
              timeFormat={timeFormat}
              isMobile={isMobile}
              pendingPreview={gridPreview}
              tasks={calendarTasks}
              onToggleTaskComplete={handleToggleTaskComplete}
              onSelectTask={openEditTaskModal}
              currentUserEmails={currentUserEmails}
              canEditEvent={canEditEvent}
              selectedEventId={selectedEventId}
              onMoveEvent={handleMoveEvent}
              revealAt={revealAt}
            />
          );
        case "agenda":
          return (
            <CalendarAgendaView
              {...scrollViewProps}
              events={visibleEvents}
              calendars={allCalendars}
              onSelectEvent={handleSelectEvent}
              onHoverEvent={handleHoverEvent}
              onHoverLeave={handleHoverLeave}
              onContextMenuEvent={handleContextMenuEvent}
              timeFormat={timeFormat}
              currentUserEmails={currentUserEmails}
              onCreateEvent={() => openCreateModal()}
            />
          );
        case "tasks":
          return (
            <div className="flex flex-col h-full">
              {taskStore.error === TASKS_LOAD_ERROR && (
                <CalendarLoadErrorNotice what="tasks" onRetry={() => { if (client) void fetchTasksFn(client); }} />
              )}
              <TaskToolbar
                filter={taskStore.filter}
                onFilterChange={taskStore.setFilter}
                onCreateTask={openCreateTaskModal}
                taskIds={listedTaskIds}
                compact={isMobile}
              />
              <TaskListView
                tasks={taskStore.tasks}
                calendars={displayCalendars}
                selectedCalendarIds={selectedCalendarIds}
                filter={taskStore.filter}
                onSelectTask={openEditTaskModal}
                onToggleComplete={handleToggleTaskComplete}
                selectedTaskId={taskStore.selectedTaskId}
                onQuickCreate={(title) => {
                  // Into a calendar that takes it: the default one, else the
                  // first the user may write to.
                  const target = writableTaskCalendars.find((c) => c.isDefault) ?? writableTaskCalendars[0];
                  if (!client || !target) {
                    toast.error(t("notifications.task_save_error"));
                    return;
                  }
                  taskStore.createTask(client, { "@type": "Task", title, progress: "needs-action", calendarIds: { [target.id]: true } })
                    .then((created) => { if (created) toast.success(t("notifications.task_created")); })
                    .catch((error: unknown) => toast.error(describeError(error, t("notifications.task_save_error"))));
                }}
              />
            </div>
          );
      }
    })();

    return (
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {eventsLoadError && normalizedViewMode !== "tasks" && (
          <CalendarLoadErrorNotice onRetry={retryEventsLoad} />
        )}
        {viewContent}
        {isLoadingEvents && calendars.length > 0 && events.length === 0 && (
          <div className="absolute inset-0 bg-background/50 flex items-center justify-center pointer-events-none">
            <Spinner label={t("status.loading_events")} />
          </div>
        )}
      </div>
    );
  };

  // The print copy (Ctrl+P or Print): an event opened by click, else the
  // view with the dates on screen.
  const printContent: CalendarPrintContent = printTarget?.kind === "calendar-event"
    ? { kind: "event", event: printTarget.event }
    : !printTarget && detailPinned && detailEvent
      ? { kind: "event", event: detailEvent }
      : { kind: "view" };
  const printCopy = printing ? (
    <CalendarPrint
      content={printContent}
      viewMode={normalizedViewMode}
      periodDate={visibleDate ?? selectedDate}
      weekStart={visibleDate ?? startOfWeek(selectedDate, { weekStartsOn })}
      rangeStart={scrollWindow?.start ?? selectedDate}
      rangeEnd={scrollWindow?.end ?? selectedDate}
      events={visibleEvents}
      calendars={allCalendars}
      shownCalendars={allCalendars.filter((c) => shownCalendarIds.includes(c.id))}
      gridTasks={calendarTasks}
      tasks={taskStore.tasks}
      taskFilter={taskStore.filter}
      selectedCalendarIds={selectedCalendarIds}
      timeFormat={timeFormat}
      timeZone={getEffectiveTimeZone()}
      currentUserEmails={currentUserEmails}
      search={searchResults && normalizedViewMode !== "tasks"
        ? { query: searchQuery, events: [...searchResults.upcoming, ...searchResults.past] }
        : null}
    />
  ) : null;

  const calendarToolbar = (
    <CalendarToolbar
      selectedDate={selectedDate}
      visibleDate={visibleDate}
      viewMode={normalizedViewMode}
      onPrev={() => { leaveSearch(); navigatePrev(); }}
      onNext={() => { leaveSearch(); navigateNext(); }}
      onToday={() => { leaveSearch(); goToToday(); }}
      onViewModeChange={(mode) => { setMobileReturnToMonth(false); leaveSearch(); setViewMode(mode); }}
      onCreateEvent={openCreateForView}
      createLabel={createLabel}
      onImport={demoMode ? undefined : () => setShowImportModal(true)}
      onSubscribe={canSubscribe ? () => setShowSubscriptionModal(true) : undefined}
      onRefresh={() => { void refreshCalendar(); }}
      onPrint={printOff ? undefined : () => { void requestPrint({ kind: "calendar-view" }); }}
      isMobile={isMobile}
      onNavigateBack={isMobile && mobileReturnToMonth && normalizedViewMode === "day" ? navigateBackToMonth : undefined}
      calendars={toolbarCalendars}
      selectedCalendarIds={shownCalendarIds}
      onToggleVisibility={toggleShownCalendar}
      enableCalendarTasks={enableCalendarTasks}
      onMenuClick={isNarrow ? () => setNarrowSidebarOpen(true) : isMobile ? undefined : toggleSidebarCollapsed}
      sidebarOpen={isNarrow ? narrowSidebarOpen : !sidebarCollapsed}
      menuTogglesSidebar={!isNarrow}
      showCreateButton={isNarrow || sidebarCollapsed}
      // Tasks have their own list and no events to search.
      searchField={normalizedViewMode === "tasks" ? undefined : (
        <CalendarSearchField
          ref={searchInputRef}
          value={searchQuery}
          onChange={setSearchQuery}
          className="w-40 lg:w-56 xl:w-64 me-1"
        />
      )}
      onOpenSearch={normalizedViewMode === "tasks" ? undefined : () => setMobileSearchOpen(true)}
      mobileSearchField={mobileSearchOpen ? (
        <CalendarSearchField
          ref={searchInputRef}
          value={searchQuery}
          onChange={setSearchQuery}
          onDismiss={leaveSearch}
          autoFocus
        />
      ) : null}
      onCloseSearch={leaveSearch}
    />
  );

  return (
    <div data-calendar-search-scope="" className={cn("flex flex-col overflow-hidden pt-[env(safe-area-inset-top)]", mvShell ? "bg-[var(--mv-canvas)]" : "bg-background", isEmbedded ? "h-full" : "h-dvh")}>
      {!isEmbedded && <SkipLink>{tShell("skip_to_content")}</SkipLink>}
      <AppTopBannerSlot />
      {refreshIndicator}
      {mvShell && (
        <MvTopBar
          showMenuButton={false}
          onManageApps={handleManageApps}
          onInlineApp={handleInlineApp}
          onCloseInlineApp={closeInlineApp}
          activeAppId={inlineApp?.id ?? null}
        />
      )}
      <div data-mv-card={mvShell ? "" : undefined} className={cn("relative flex flex-1 min-h-0 overflow-hidden", isMobile && "flex-col", mvShell && "mb-4 mx-4")}>
      {/* Left Navigation Rail (hidden when embedded in Pro shell) */}
      {!isMobile && !isEmbedded && !mvShell && (
        <div className="memail-app-rail bg-secondary flex flex-col flex-shrink-0" style={{ borderRight: '1px solid rgba(128, 128, 128, 0.3)' }}>
          <NavigationRail variant="workspace"
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

      {!inlineApp && (
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
      <div className="flex flex-1 min-w-0 min-h-0">
      {/* Sidebar - in-flow when desktop pane, overlay when narrow */}
      {(isNarrow || !sidebarCollapsed) && (
        <>
          <div
            // A closed drawer is off-screen: not a pane for F6.
            data-pane={!isNarrow || narrowSidebarOpen ? "sidebar" : undefined}
            className={cn(
              "border-e border-border bg-secondary flex flex-col overflow-hidden flex-shrink-0",
              !isResizing && "transition-[width] duration-300",
              isNarrow && cn(
                "absolute inset-y-0 start-0 z-50 w-72 pt-[env(safe-area-inset-top)]",
                "transform transition-transform duration-300 ease-in-out",
                !narrowSidebarOpen && "-translate-x-full rtl:translate-x-full"
              )
            )}
            style={isNarrow ? undefined : { width: `${calSidebarWidth}px` }}
          >
            <CalendarSidebarHeader
              onCreateEvent={() => { setNarrowSidebarOpen(false); openCreateForView(); }}
              createLabel={createLabel}
              tourTarget={!isNarrow}
            />
            <div className="flex-1 overflow-y-auto overflow-x-hidden py-3">
            <div className="px-3">
            <MiniCalendar
              selectedDate={selectedDate}
              displayMonth={miniMonth}
              onSelectDate={handleMiniCalendarSelect}
              onChangeMonth={handleMiniMonthChange}
              events={events}
              firstDayOfWeek={firstDayOfWeek}
              showWeekNumbers={showWeekNumbers}
            />
            </div>
            <CalendarSidebarPanel
              calendars={allCalendars}
              selectedCalendarIds={shownCalendarIds}
              onToggleVisibility={toggleShownCalendar}
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
                // Drop the local override. A calendar with a server color goes
                // back to it; one without gets a fresh unused color from the
                // auto-assign effect (so it never reverts to a collision).
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
                } catch (err) {
                  // The store rethrows the server's reason (#434).
                  toast.error(err instanceof Error && err.message ? err.message : tMgmt("error_clear"));
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
              onSubscribe={canSubscribe ? () => setShowSubscriptionModal(true) : undefined}
              onEditSubscription={(subId) => setEditingSubscription(subId)}
              client={client}
              multiAccountMode={multiAccountEnabled && accountClients.length > 1}
            />
            </div>
          </div>
          {!isNarrow && (
            <ResizeHandle
              pane="sidebar"
              value={calSidebarWidth}
              min={180}
              max={400}
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

      <AppMain embedded={isEmbedded} label={tSidebar("calendar")} className="flex flex-col flex-1 min-w-0 min-h-0">
        {calendarToolbar}

        {/* isolate keeps the views' sticky headers (z-50) below the toolbar's
            import dropdown, which overlaps this area (#1049). */}
        <div
          className="flex flex-1 overflow-hidden relative isolate"
          data-tour="calendar-view"
          // Where the focus goes after an event is saved or deleted and
          // what opened its editor is gone (components/layout/focus-rescue).
          data-focus-fallback=""
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
                key={`${editEvent?.id ?? 'new'}${modalStartsInEdit ? ':edit' : ''}`}
                event={editEvent}
                calendars={displayCalendars}
                defaultDate={defaultModalDate}
                defaultEndDate={defaultModalEndDate}
                defaultAllDay={defaultModalAllDay}
                defaultTitle={defaultModalTitle}
                startInEditMode={modalStartsInEdit}
                defaultCalendarId={defaultCalendarIdForCreate}
                onSave={handleSaveEvent}
                onDelete={handleDeleteEvent}
                onDuplicate={handleDuplicateEvent}
                onRsvp={handleRsvp}
                onMore={editEvent ? (anchor) => openEventContextMenuFrom(anchor, editEvent, "end") : undefined}
                onDirtyChange={setEventEditorDirty}
                onClose={() => { setShowEventModal(false); setEditEvent(null); setPendingPreview(null); setDefaultCalendarIdForCreate(undefined); setDefaultModalAllDay(false); }}
                onPreviewChange={setPendingPreview}
                currentUserEmails={currentUserEmails}
                isSubscriptionCalendar={isSubscriptionCalendar}
                maxParticipants={maxParticipants}
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
                isSubscriptionCalendar={isSubscriptionCalendar}
                onSave={handleSaveTask}
                onDelete={handleDeleteTask}
                onDirtyChange={setTaskEditorDirty}
                onClose={() => { setShowTaskModal(false); setEditTask(null); }}
                isMobile={false}
              />
            </div>
          )}

          {/* Floating Create Event Button (mobile) */}
          {isMobile && (
            <Button
              onClick={openCreateForView}
              className="absolute bottom-4 end-4 z-40 h-14 w-14 rounded-full shadow-lg"
              aria-label={createLabel}
              data-tour="create-event-button"
            >
              <Plus className="h-6 w-6" />
            </Button>
          )}
        </div>
      </AppMain>
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
          // Edit opens the form, as the card's pencil and `e` do.
          onEdit={() => openEditModal(eventContextMenu.data!, true)}
          onDuplicate={() => handleDuplicateContextMenu(eventContextMenu.data!)}
          onExportICS={() => handleExportICS(eventContextMenu.data!)}
          onCopyTitle={() => handleCopyTitle(eventContextMenu.data!)}
          onCopyMeetingLink={() => handleCopyMeetingLink(eventContextMenu.data!)}
          onDelete={() => handleDeleteContextMenu(eventContextMenu.data!)}
          onPrint={printOff ? undefined : () => { void requestPrint({ kind: "calendar-event", event: eventContextMenu.data! }); }}
          editable={canEditEvent(eventContextMenu.data)}
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
                // Explicit end so the modal keeps the clicked hour instead of
                // applying its next-hour fallback for date-only defaults (#435).
                const end = new Date(date);
                end.setHours(hour + 1, 0, 0, 0);
                openCreateModal(d, end);
              } else {
                const now = displayNow();
                d.setHours(now.getHours() + 1, 0, 0, 0);
                openCreateModal(d);
              }
            }}
            onNewAllDayEvent={() => {
              const d = new Date(date);
              d.setHours(0, 0, 0, 0);
              openCreateModal(d, undefined, true);
            }}
            onNewTask={enableCalendarTasks ? openCreateTaskModal : undefined}
            onGoToToday={goToToday}
          />
        );
      })()}

      {quickDraft && !isMobile && (
        <QuickCreatePopover
          draft={quickDraft}
          calendars={writableCalendars}
          timeFormat={timeFormat}
          onChange={setQuickDraft}
          onSave={handleQuickCreateSave}
          onMoreOptions={handleQuickCreateMoreOptions}
          onClose={closeQuickCreate}
        />
      )}

      {detailEvent && detailAnchorRect && (
        <EventDetailPopover
          event={detailEvent}
          calendar={allCalendars.find(c => detailEvent.calendarIds[c.id])}
          anchorRect={detailAnchorRect}
          onEdit={handleEditFromDetail}
          onDelete={handleDeleteFromDetail}
          onDuplicate={handleDuplicateFromDetail}
          onMore={(e) => handleContextMenuEvent(e, detailEvent)}
          onPrint={printOff ? undefined : () => { void requestPrint({ kind: "calendar-event", event: detailEvent }); }}
          onClose={closeDetail}
          onSaveNote={handleSaveNoteFromDetail}
          onRsvp={handleRsvpFromDetail}
          onMouseEnter={() => { if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; } }}
          onMouseLeave={handleHoverLeave}
          currentUserEmails={currentUserEmails}
          isSubscriptionCalendar={isSubscriptionCalendar}
          timeFormat={timeFormat}
          isMobile={isMobile}
          pinned={detailPinned}
        />
      )}

      {showEventModal && isMobile && (
        <EventModal
          key={`${editEvent?.id ?? 'new'}${modalStartsInEdit ? ':edit' : ''}`}
          event={editEvent}
          calendars={displayCalendars}
          defaultDate={defaultModalDate}
          defaultEndDate={defaultModalEndDate}
          defaultAllDay={defaultModalAllDay}
          defaultTitle={defaultModalTitle}
          startInEditMode={modalStartsInEdit}
          defaultCalendarId={defaultCalendarIdForCreate}
          onSave={handleSaveEvent}
          onDelete={handleDeleteEvent}
          onDuplicate={handleDuplicateEvent}
          onRsvp={handleRsvp}
          onMore={editEvent ? (anchor) => openEventContextMenuFrom(anchor, editEvent, "end") : undefined}
          onDirtyChange={setEventEditorDirty}
          onClose={() => { setShowEventModal(false); setEditEvent(null); setDefaultCalendarIdForCreate(undefined); setDefaultModalAllDay(false); }}
          currentUserEmails={currentUserEmails}
          isSubscriptionCalendar={isSubscriptionCalendar}
          maxParticipants={maxParticipants}
          isMobile={true}
        />
      )}

      {/* Mobile task editor: full screen, like the event editor. */}
      {showTaskModal && isMobile && (
        <div
          ref={mobileTaskEditorRef}
          role="dialog"
          aria-modal="true"
          aria-label={editTask ? t("tasks.edit") : t("tasks.create")}
          className={isPaneScoped ? "absolute inset-0 z-40 flex flex-col bg-background" : "fixed inset-0 z-50 flex flex-col bg-background"}
        >
          <TaskModal
            key={editTask?.id ?? 'new-task'}
            task={editTask}
            calendars={displayCalendars}
            isSubscriptionCalendar={isSubscriptionCalendar}
            onSave={handleSaveTask}
            onDelete={handleDeleteTask}
            onDirtyChange={setTaskEditorDirty}
            onClose={() => { setShowTaskModal(false); setEditTask(null); }}
            isMobile={true}
          />
        </div>
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
        note={pendingScopeAction?.type === "delete" && pendingScopeAction.sendScheduling
          && userOrganizes(pendingScopeAction.event, currentUserEmails)
          ? t("participants.cancel_notification")
          : undefined}
        eventTitle={pendingScopeAction?.event.title || t("events.no_title")}
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
      {printCopy}
    </div>
  );
}
