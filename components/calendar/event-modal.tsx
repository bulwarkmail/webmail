"use client";

import { useState, useEffect, useCallback, useRef, useMemo, useId } from "react";
import { useCloseBesideControls } from "@/hooks/use-close-beside-controls";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "@/stores/toast-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LinkifiedText } from "@/components/ui/linkified-text";
import { X, Trash2, Users, CalendarDays, CopyPlus, Pencil, Clock, MapPin, Video, Repeat, Bell, AlignLeft, AlertTriangle, MoreVertical } from "@/components/icons";
import { IconButton } from "@/components/ui/icon-button";
import { findMeetingLink, locationAction, mapsUrl, primaryLocationName } from "@/lib/event-links";
import { descriptionAsText, isHtmlDescription, plainDescriptionFields } from "@/lib/calendar-description";
import { ParticipantStatusBadge } from "./rsvp-buttons";
import { format, parseISO, addHours, isSameDay } from "date-fns";
import type { CalendarEvent, Calendar, CalendarParticipant, CalendarEventAlert, CalendarRecurrenceRule } from "@/lib/jmap/types";
import { AlertListEditor, AlertSummary, formatEventAlertsLabel } from "./alert-list-editor";
import { alertRowToOffset, describeAlert, getCalendarDefaultAlerts, newAlertRow, withOwnAlertIds, type AlertAction, type AlertRow as EditableAlertRow, type AlertUnit } from "@/lib/calendar-alerts";
import { RecurrenceEditor, buildRecurrenceSummary, isSimpleRecurrenceRule } from "./recurrence-editor";
import { parseDuration, getEventColor } from "./event-card";
import { buildAllDayDuration, getEventDisplayEndDate, getEventEndDate, getEventStartDate, getPrimaryCalendarId } from "@/lib/calendar-utils";
import { displayNow, fromDisplayDate, fromWallClock, getEffectiveTimeZone, listTimeZones, parseLocalDateTime, toZonedDisplayDate } from "@/lib/timezone";
import { displayToZoneWall, eventFormTimeZone, eventZonedTimes, timeZoneCity, zonedTimesText, zoneWallToDisplay } from "@/lib/event-time-zone";
import { createRecurrenceRule, sameRecurrenceRules } from "@/lib/recurrence-rule";
import { ParticipantInput, type ParticipantInputHandle } from "./participant-input";
import { ParticipantAvailability } from "./participant-availability";
import { FindATime } from "./find-a-time";
import { AnswerBars, useAnswerView } from "./answer-bars";
import type { AnswerTarget } from "@/lib/calendar-delegate";
import {
  eventOrganizer,
  getUserParticipantId,
  getParticipantList,
  getStatusCounts,
  participantFieldsToSave,
  userOrganizes,
} from "@/lib/calendar-participants";
import { canUserRsvp, getEventEditability, canCreateEventsIn } from "@/lib/calendar-editability";
import { changesWhen, type EditorAttendee, type EventEditorState } from "@/lib/recurrence-scope-edit";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import { useSettingsStore } from "@/stores/settings-store";
import { generateUUID } from "@/lib/utils";
import { buildDuplicateEventData } from "@/lib/calendar-duplicate";
import { useFormatEventDate } from "@/hooks/use-format-event-date";
import { useCalendarLocale } from "@/hooks/use-calendar-locale";
import { useIsPaneScoped } from "@/hooks/use-pane-context";
import { useContactNameResolver } from "@/hooks/use-contact-name-resolver";
import { confirmInvitationRecipients } from "@/lib/outgoing/external-recipients";
import {
  calendarFormHooks,
  calendarHooks,
  type CalendarEventFormSavePatch,
} from "@/lib/plugin-hooks";
import type { CalendarEventView, ConflictWarning } from "@/lib/plugin-types";
import { eventToView } from "@/lib/plugin-projection";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useCvdColor } from "@/hooks/use-cvd-color";
import { gateLinkClick } from "@/lib/plugin-hook-result";

export interface PendingEventPreview {
  start: Date;
  end: Date;
  title: string;
  allDay: boolean;
  calendarId: string;
}

interface EventModalProps {
  event?: CalendarEvent | null;
  calendars: Calendar[];
  defaultDate?: Date;
  defaultEndDate?: Date;
  defaultAllDay?: boolean;
  /** Open an existing event straight in the form instead of its summary. */
  startInEditMode?: boolean;
  /** Title to start a new event with (from the quick editor's "More options"). */
  defaultTitle?: string;
  defaultCalendarId?: string;
  /**
   * `editor` is what the editor had besides `data`, for a save that covers
   * more than the event it was opened on (every occurrence of a series).
   */
  onSave: (data: Partial<CalendarEvent>, sendSchedulingMessages?: boolean, editor?: EventEditorState) => void | Promise<void>;
  onDelete?: (id: string, sendSchedulingMessages?: boolean) => void;
  onDuplicate?: (data: Partial<CalendarEvent>) => void;
  /** `sentBy`: answering for the calendar's owner (lib/calendar-delegate.ts). */
  onRsvp?: (eventId: string, participantId: string, status: CalendarParticipant['participationStatus'], sentBy?: string) => void;
  onClose: () => void;
  onPreviewChange?: (preview: PendingEventPreview | null) => void;
  /** Opens the event's action menu (export, copy, ...) under the ⋮ of the event view. */
  onMore?: (anchor: HTMLElement) => void;
  /** Told whether the form holds changes that aren't saved, so the page can ask before it drops them. */
  onDirtyChange?: (dirty: boolean) => void;
  currentUserEmails?: string[];
  isSubscriptionCalendar?: (calendarId: string) => boolean;
  /** The server's maxParticipantsPerEvent, for a warning; null when not advertised. */
  maxParticipants?: number | null;
  isMobile?: boolean;
}

/**
 * When an event's start is edited, the end moves with it to keep the SAME
 * duration (oldEnd - oldStart), so the appointment's length is preserved.
 * Returns the new end, or null for invalid or already-negative-duration input.
 * Pure, for testing.
 */
export function shiftedEnd(oldStart: Date, oldEnd: Date, newStart: Date): Date | null {
  if (isNaN(oldStart.getTime()) || isNaN(oldEnd.getTime()) || isNaN(newStart.getTime())) return null;
  const durationMs = oldEnd.getTime() - oldStart.getTime();
  if (durationMs < 0) return null;
  return new Date(newStart.getTime() + durationMs);
}

/**
 * Status, free/busy and privacy for a save. The editor has no controls for
 * them, so only a new event gets them (the defaults) and an edit keeps what
 * the event has. Every edit used to reset them to confirmed, busy and public,
 * and Stalwart 1.0 refuses an edit of one occurrence whose privacy differs
 * from its series'. Pure, for testing.
 */
export function savedStatusFields(
  event: CalendarEvent | null | undefined,
): Partial<Pick<CalendarEvent, "status" | "freeBusyStatus" | "privacy">> {
  if (event) return {};
  return { status: "confirmed", freeBusyStatus: "busy", privacy: "public" };
}

function formatDateInput(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

function formatTimeInput(d: Date): string {
  return format(d, "HH:mm");
}

function buildDuration(startDate: Date, endDate: Date): string {
  const diffMs = endDate.getTime() - startDate.getTime();
  const totalMinutes = Math.max(0, Math.floor(diffMs / 60000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  let dur = "P";
  if (days > 0) dur += `${days}D`;
  if (hours > 0 || minutes > 0) {
    dur += "T";
    if (hours > 0) dur += `${hours}H`;
    if (minutes > 0) dur += `${minutes}M`;
  }
  if (dur === "P") dur = "PT0M";
  return dur;
}

type RecurrenceOption = "none" | "daily" | "weekly" | "monthly" | "yearly" | "custom";

/**
 * An editor row, with the event alert it was read from: a row left as it was
 * keeps that alert, under its id.
 */
export interface AlertRow extends EditableAlertRow {
  source?: { alertId: string; value: number; unit: AlertUnit; action: AlertAction };
}

/**
 * The editor rows for an event's alerts, and the alerts the rows cannot
 * show (absolute triggers, offsets after the start or relative to the end),
 * which a save keeps as they are.
 */
export function alertRowsOf(alerts: CalendarEvent["alerts"] | undefined): {
  rows: AlertRow[];
  preserved: Record<string, CalendarEventAlert>;
} {
  const rows: AlertRow[] = [];
  const preserved: Record<string, CalendarEventAlert> = {};
  for (const [id, alert] of Object.entries(alerts ?? {})) {
    const row = describeAlert(alert);
    if (!row) {
      preserved[id] = alert;
      continue;
    }
    rows.push({ ...newAlertRow(row.value, row.unit, row.action), source: { alertId: id, ...row } });
  }
  return { rows, preserved };
}

/**
 * What a save sends for the alerts the user set themselves: nothing when
 * they are as the event had them. Rows the user left alone keep their alert
 * as it was, under its id; new and changed rows become new alerts.
 *
 * On an event that used its calendar's default alerts, setting them turns
 * the defaults off: while `useDefaultAlerts` is on, Stalwart 1.0 fills the
 * defaults into `alerts` and shows those instead of the event's own, so a
 * change would not stick. The alerts then get ids of their own
 * (withOwnAlertIds), away from the event's and the calendar's default ids
 * (`reservedIds`). 0.16 stores the alerts either way.
 */
export function buildAlertsPatch(
  event: Pick<CalendarEvent, "alerts" | "useDefaultAlerts"> | null | undefined,
  rows: AlertRow[],
  preserved: Record<string, CalendarEventAlert>,
  reservedIds: Iterable<string> = [],
): Partial<Pick<CalendarEvent, "alerts" | "useDefaultAlerts">> {
  const original = event?.alerts ?? {};
  const kept: Record<string, CalendarEventAlert> = { ...preserved };
  const added: CalendarEventAlert[] = [];
  for (const row of rows) {
    const offset = alertRowToOffset(row);
    if (offset === null) continue;
    const { source } = row;
    if (source && row.value === source.value && row.unit === source.unit && row.action === source.action
      && original[source.alertId]) {
      kept[source.alertId] = original[source.alertId];
      continue;
    }
    added.push({
      "@type": "Alert",
      trigger: { "@type": "OffsetTrigger", offset, relativeTo: "start" },
      action: row.action,
      acknowledged: null,
      relatedTo: null,
    });
  }

  // A new event, or one that leaves its calendar's defaults, says so.
  const leavesDefaults = !event || !!event.useDefaultAlerts;
  const keptAll = Object.keys(original).every((id) => id in kept);
  if (!leavesDefaults && added.length === 0 && keptAll) return {};

  const taken = [...Object.keys(original), ...reservedIds];
  const alerts = event?.useDefaultAlerts
    ? withOwnAlertIds([...Object.values(kept), ...added], taken)
    : { ...kept, ...withOwnAlertIds(added, taken) };
  const patch: Partial<Pick<CalendarEvent, "alerts" | "useDefaultAlerts">> = {};
  if (leavesDefaults) patch.useDefaultAlerts = false;
  // A new event without alerts sends none.
  if (Object.keys(alerts).length > 0) patch.alerts = alerts;
  else if (event) patch.alerts = null;
  return patch;
}

function formatDurationDisplay(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) return `${h}h`;
  return `${h}h${m}min`;
}

function getRecurrenceLabel(event: CalendarEvent, t: ReturnType<typeof useTranslations>, locale: string): string | null {
  if (!event.recurrenceRules?.length) return null;
  return buildRecurrenceSummary(event.recurrenceRules[0], t, locale);
}

export function EventModal({
  event,
  calendars,
  defaultDate,
  defaultEndDate,
  defaultAllDay,
  defaultTitle,
  startInEditMode,
  defaultCalendarId,
  onSave,
  onDelete,
  onDuplicate,
  onRsvp,
  onClose,
  onPreviewChange,
  onMore,
  onDirtyChange,
  currentUserEmails = [],
  isSubscriptionCalendar,
  maxParticipants = null,
  isMobile = false,
}: EventModalProps) {
  const t = useTranslations("calendar");
  const paint = useCvdColor();
  // Ids that tie each visible label to its field.
  const labelIdBase = useId();
  const labelFor = (key: string) => `${labelIdBase}-${key}`;
  const tCommon = useTranslations("common");
  const tEvent = useTranslations("ux_pim_event");
  // The header's close goes to its start when the window's own close is at its end.
  const [header, setHeader] = useState<HTMLDivElement | null>(null);
  const closeFirst = useCloseBesideControls(header);
  const locale = useLocale();
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const timeDisplayFmt = timeFormat === "12h" ? "h:mm a" : "HH:mm";
  // Inside a Pro pane the "mobile" layout must cover the pane, not the
  // viewport - a `fixed inset-0` editor from a split pane would take over
  // the whole app. The absolute variant anchors to the pane's tab-body
  // wrapper (the nearest positioned ancestor), covering exactly the pane.
  const isPaneScoped = useIsPaneScoped();
  const mobileRootClass = isPaneScoped
    ? "absolute inset-0 z-40 flex flex-col bg-background"
    : "fixed inset-0 z-50 flex flex-col bg-background pt-[var(--titlebar-inset)]";
  const isEdit = !!event;
  const formatEventDate = useFormatEventDate();
  const { formatDateRangeLabel } = useCalendarLocale();
  const [mode, setMode] = useState<"view" | "edit">(isEdit && !startInEditMode ? "view" : "edit");

  // Only the organizer invites: someone else's invitation keeps its
  // attendees as the organizer sent them, and a save of the user's own copy
  // sends no messages. The owner's meeting in a calendar shared with the
  // user is the organizer's copy (userOrganizes).
  const userIsOrganizer = useMemo(() => {
    if (!event?.participants) return true;
    return userOrganizes(event, currentUserEmails);
  }, [event, currentUserEmails]);

  // Gate affordances on calendar rights, not identity (see calendar-editability).
  const editability = useMemo(() => {
    if (!event) return "editable" as const;
    const calendarsById = new Map(calendars.map((c) => [c.id, c]));
    return getEventEditability(event, {
      calendarsById,
      userCalendarAddresses: currentUserEmails,
      isSubscriptionCalendar: isSubscriptionCalendar ?? (() => false),
    });
  }, [event, calendars, currentUserEmails, isSubscriptionCalendar]);
  const canEditBody = editability === "editable";
  const rsvpMode = editability === "rsvp-only";

  // A received invite lands in the user's own calendar, resolves to 'editable',
  // and so never reaches the rsvp-only view below.
  const canRsvp = useMemo(() => {
    if (!event) return false;
    return canUserRsvp(event, {
      calendarsById: new Map(calendars.map((c) => [c.id, c])),
      userCalendarAddresses: currentUserEmails,
      isSubscriptionCalendar: isSubscriptionCalendar ?? (() => false),
    });
  }, [event, calendars, currentUserEmails, isSubscriptionCalendar]);

  // Bare addresses (the organizer above all — Stalwart drops its display name)
  // render with the contact card's name instead of the raw email.
  const resolveContactName = useContactNameResolver();

  const userParticipantId = useMemo(() => {
    if (!event) return null;
    return getUserParticipantId(event, currentUserEmails);
  }, [event, currentUserEmails]);

  const existingParticipants = useMemo(() => {
    if (!event) return [];
    return getParticipantList(event, { resolveName: resolveContactName });
  }, [event, resolveContactName]);

  const organizerInfo = useMemo(() => {
    if (!event?.participants) return null;
    const organizer = existingParticipants.find(p => p.isOrganizer);
    return organizer ? { name: organizer.name, email: organizer.email } : null;
  }, [event, existingParticipants]);

  const getInitialStart = (): Date => {
    if (event?.start) return getEventStartDate(event);
    if (defaultDate) {
      const d = new Date(defaultDate);
      if (defaultEndDate) return d;
      const now = displayNow();
      d.setHours(now.getHours() + 1, 0, 0, 0);
      return d;
    }
    const d = displayNow();
    d.setHours(d.getHours() + 1, 0, 0, 0);
    return d;
  };

  const getInitialEnd = (): Date => {
    if (event?.start) {
      if (event.showWithoutTime) {
        return getEventDisplayEndDate(event);
      }
      return getEventEndDate(event);
    }
    if (defaultEndDate) return new Date(defaultEndDate);
    return addHours(getInitialStart(), 1);
  };

  const [title, setTitle] = useState(event?.title || defaultTitle || "");
  // An HTML description is shown and edited as its text.
  const eventDescription = useMemo(() => (event ? descriptionAsText(event) : ""), [event]);
  const [description, setDescription] = useState(eventDescription);
  const [location, setLocation] = useState(
    event?.locations ? Object.values(event.locations)[0]?.name || "" : ""
  );
  const [virtualLocation, setVirtualLocation] = useState(
    event?.virtualLocations ? Object.values(event.virtualLocations)[0]?.uri || "" : ""
  );
  // The zone the date and time fields are in, and a save writes: the
  // event's own, the user's for a new event, none for a floating one. An
  // edit used to save every event in the user's zone (pim-2).
  const userTimeZone = getEffectiveTimeZone();
  const [timeZone, setTimeZone] = useState<string | null>(() => eventFormTimeZone(event, userTimeZone));
  const [showZonePicker, setShowZonePicker] = useState(false);
  const [initialStartWall] = useState(() => displayToZoneWall(getInitialStart(), timeZone));
  const [initialEndWall] = useState(() => displayToZoneWall(getInitialEnd(), timeZone));
  const [startDate, setStartDate] = useState(formatDateInput(initialStartWall));
  const [startTime, setStartTime] = useState(formatTimeInput(initialStartWall));
  const [endDate, setEndDate] = useState(formatDateInput(initialEndWall));
  const [endTime, setEndTime] = useState(formatTimeInput(initialEndWall));
  const [allDay, setAllDay] = useState(event?.showWithoutTime || defaultAllDay || false);
  // The zone the fields are on: none for an all-day event.
  const fieldZone = allDay ? null : timeZone;
  const zoneOptions = useMemo(() => {
    if (!showZonePicker) return [];
    const zones = listTimeZones();
    return timeZone && !zones.includes(timeZone) ? [timeZone, ...zones] : zones;
  }, [showZonePicker, timeZone]);
  // The form's times on the user's clock, beside another zone's.
  const formYourTimes = useMemo(() => {
    if (!fieldZone || fieldZone === userTimeZone) return null;
    const from = zoneWallToDisplay(new Date(`${startDate}T${startTime || "00:00"}:00`), fieldZone);
    const to = zoneWallToDisplay(new Date(`${endDate}T${endTime || "00:00"}:00`), fieldZone);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return null;
    const time = (d: Date) => format(d, timeDisplayFmt);
    const onOtherDay = !isSameDay(from, new Date(`${startDate}T00:00:00`));
    const day = onOtherDay ? `${new Intl.DateTimeFormat(locale, { weekday: "short" }).format(from)} ` : "";
    return `${day}${time(from)}–${time(to)}`;
  }, [fieldZone, userTimeZone, startDate, startTime, endDate, endTime, timeDisplayFmt, locale]);

  // Editing the start shifts the end with it, preserving the event's current
  // length (end - start) - so moving the start never leaves the end before it
  // and never silently changes the duration.
  const shiftEndKeepingDuration = (nextStartDate: string, nextStartTime: string) => {
    const oldStart = new Date(`${startDate}T${allDay ? "00:00" : (startTime || "00:00")}:00`);
    const oldEnd = new Date(`${endDate}T${allDay ? "00:00" : (endTime || "00:00")}:00`);
    const newStart = new Date(`${nextStartDate}T${allDay ? "00:00" : (nextStartTime || "00:00")}:00`);
    const nextEnd = shiftedEnd(oldStart, oldEnd, newStart);
    if (!nextEnd) return;
    setEndDate(formatDateInput(nextEnd));
    if (!allDay) setEndTime(formatTimeInput(nextEnd));
  };
  const handleStartDateChange = (v: string) => { setStartDate(v); shiftEndKeepingDuration(v, startTime); };
  const handleStartTimeChange = (v: string) => { setStartTime(v); shiftEndKeepingDuration(startDate, v); };
  const [calendarId, setCalendarId] = useState<string>(() => {
    if (event?.calendarIds) return getPrimaryCalendarId(event) || calendars[0]?.id || "";
    if (defaultCalendarId && calendars.some(c => c.id === defaultCalendarId)) return defaultCalendarId;
    const defaultCal = calendars.find(c => c.isDefault);
    // Never default new events into a subscription / read-only calendar (#762).
    return defaultCal?.id
      || calendars.find(c => canCreateEventsIn(c, isSubscriptionCalendar))?.id
      || calendars[0]?.id || "";
  });

  // Calendars offered as create/move targets: writable, non-subscription, plus
  // the event's current calendar so an in-place edit never blanks the select.
  const selectableCalendars = useMemo(
    () => calendars.filter(c => canCreateEventsIn(c, isSubscriptionCalendar) || c.id === calendarId),
    [calendars, isSubscriptionCalendar, calendarId]
  );
  const [recurrence, setRecurrence] = useState<RecurrenceOption>(() => {
    if (!event?.recurrenceRules?.length) return "none";
    const rule = event.recurrenceRules[0];
    return isSimpleRecurrenceRule(rule) ? (rule.frequency as RecurrenceOption) : "custom";
  });
  const [customRule, setCustomRule] = useState<CalendarRecurrenceRule | null>(() => {
    if (!event?.recurrenceRules?.length) return null;
    const rule = event.recurrenceRules[0];
    return isSimpleRecurrenceRule(rule) ? null : rule;
  });
  // The recurrence the editor opened with: a rule the user did not touch is
  // no change, however the server spells it.
  const initialRecurrenceRef = useRef({ recurrence, customRule });
  const [showRecurrenceEditor, setShowRecurrenceEditor] = useState(false);
  // Dropdown value to restore when the custom editor is cancelled without a saved rule.
  const recurrenceBeforeCustomRef = useRef<RecurrenceOption>("none");

  const handleRecurrenceEditorSave = useCallback((rule: CalendarRecurrenceRule) => {
    setCustomRule(rule);
    setRecurrence("custom");
    setShowRecurrenceEditor(false);
  }, []);

  const handleRecurrenceEditorCancel = useCallback(() => {
    setShowRecurrenceEditor(false);
    if (!customRule) {
      setRecurrence(recurrenceBeforeCustomRef.current);
    }
  }, [customRule]);

  const customRuleSummary = useMemo(
    () => (customRule ? buildRecurrenceSummary(customRule, t, locale) : null),
    [customRule, t, locale]
  );
  // A new event starts on the calendar's default alerts.
  const [useDefaultAlerts, setUseDefaultAlerts] = useState(() => (event ? event.useDefaultAlerts === true : true));
  // Alerts the rows can't represent (absolute triggers, offsets after the
  // start or relative to the end) are kept here so they survive a save.
  const [initialAlerts] = useState(() =>
    event && !event.useDefaultAlerts ? alertRowsOf(event.alerts) : { rows: [], preserved: {} }
  );
  const [preservedAlerts, setPreservedAlerts] = useState<Record<string, CalendarEventAlert>>(initialAlerts.preserved);
  const [alertRows, setAlertRows] = useState<AlertRow[]>(initialAlerts.rows);

  // Set once "Use calendar defaults" is clicked: from then on the event takes
  // the calendar's current defaults, not the copy it stored.
  const [refreshDefaults, setRefreshDefaults] = useState(false);

  // What defaults mode stands for. Stalwart copies the calendar's defaults
  // into an event only when it is created, so an existing event that stays
  // in its calendar and keeps its all-day state shows the copy it stored;
  // otherwise the selected calendar's current defaults apply.
  const defaultAlerts = useMemo(() => {
    if (
      !refreshDefaults &&
      event?.useDefaultAlerts &&
      event.alerts && Object.keys(event.alerts).length > 0 &&
      getPrimaryCalendarId(event) === calendarId &&
      !!event.showWithoutTime === allDay
    ) {
      return event.alerts;
    }
    return getCalendarDefaultAlerts(calendars.find((c) => c.id === calendarId), allDay);
  }, [refreshDefaults, event, calendars, calendarId, allDay]);

  const customizeAlerts = useCallback(() => {
    const { rows, preserved } = alertRowsOf(defaultAlerts);
    setAlertRows(rows);
    setPreservedAlerts(preserved);
    setUseDefaultAlerts(false);
  }, [defaultAlerts]);
  const [isSaving, setIsSaving] = useState(false);
  // Set synchronously, so a second save in the same tick is refused too.
  const savingRef = useRef(false);

  // The attendees the editor opened with: a save for every occurrence of a
  // series applies only those the user added or removed.
  const [initialAttendees] = useState<EditorAttendee[]>(() => {
    if (!event?.participants) return [];
    // Never seed the invite list with the organizer or with a repeated address:
    // handleSave writes the organizer separately, so either would round-trip
    // into a duplicate entry every time the event is saved (#731). The
    // organizer is the event's own, or the user for an event without one -
    // not the user as such: a sharee who attends the owner's meeting stays
    // on its list.
    const excluded = new Set<string>();
    const organizerAddress = (event && eventOrganizer(event)?.email) || (userIsOrganizer ? currentUserEmails[0] : '');
    if (organizerAddress) {
      excluded.add(organizerAddress.toLowerCase());
    }
    return existingParticipants
      .filter(p => !p.isOrganizer)
      .reduce<{ name: string; email: string }[]>((acc, p) => {
        const key = p.email.trim().toLowerCase();
        if (!key || excluded.has(key)) return acc;
        excluded.add(key);
        acc.push({ name: p.name, email: p.email.trim() });
        return acc;
      }, []);
  });
  const [attendees, setAttendees] = useState<EditorAttendee[]>(initialAttendees);
  const [sendInvitations, setSendInvitations] = useState(true);
  const participantInputRef = useRef<ParticipantInputHandle>(null);

  // What the form holds against what it opened with: a form with changes
  // asks before X, Cancel or Escape drop them (R5).
  const formState = useMemo(() => ({
    title, description, location, virtualLocation, startDate, startTime, endDate, endTime, allDay, timeZone,
    calendarId, recurrence, customRule, useDefaultAlerts, alertRows, preservedAlerts, attendees, sendInvitations,
  }), [title, description, location, virtualLocation, startDate, startTime, endDate, endTime, allDay, timeZone,
    calendarId, recurrence, customRule, useDefaultAlerts, alertRows, preservedAlerts, attendees, sendInvitations]);
  const [initialForm] = useState(formState);
  const isDirty = mode === "edit" && JSON.stringify(formState) !== JSON.stringify(initialForm);
  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const resetForm = useCallback(() => {
    const f = initialForm;
    setTitle(f.title); setDescription(f.description); setLocation(f.location); setVirtualLocation(f.virtualLocation);
    setStartDate(f.startDate); setStartTime(f.startTime); setEndDate(f.endDate); setEndTime(f.endTime); setAllDay(f.allDay);
    setTimeZone(f.timeZone); setShowZonePicker(false);
    setCalendarId(f.calendarId); setRecurrence(f.recurrence); setCustomRule(f.customRule); setShowRecurrenceEditor(false);
    setUseDefaultAlerts(f.useDefaultAlerts); setAlertRows(f.alertRows); setPreservedAlerts(f.preservedAlerts); setRefreshDefaults(false);
    setAttendees(f.attendees); setSendInvitations(f.sendInvitations);
  }, [initialForm]);

  const { dialogProps: discardDialogProps, confirm: confirmDiscard } = useConfirmDialog();
  const askingRef = useRef(false);
  // Runs `then` at once when nothing would be lost, else after "Discard".
  const whenDiscarded = useCallback((then: () => void) => {
    if (!isDirty) { then(); return; }
    if (askingRef.current) return;
    askingRef.current = true;
    void confirmDiscard({
      title: t("discard.title"),
      message: t("discard.message"),
      confirmText: t("discard.confirm"),
      cancelText: t("discard.keep"),
      variant: "destructive",
    }).then((ok) => {
      askingRef.current = false;
      if (ok) then();
    });
  }, [isDirty, confirmDiscard, t]);
  const requestClose = useCallback(() => whenDiscarded(onClose), [whenDiscarded, onClose]);
  // Leaving the form of an existing event goes back to its summary.
  const backToView = useCallback(() => whenDiscarded(() => { resetForm(); setMode("view"); }), [whenDiscarded, resetForm]);

  // The event window the attendees' free/busy is checked against. The
  // fields are a wall clock in the form's zone, as the save path labels
  // them, not in the browser's; an all-day event spans its whole days.
  const availabilityWindow = useMemo(() => {
    const zone = fieldZone ?? getEffectiveTimeZone();
    const instant = (value: string) => {
      const wall = parseLocalDateTime(value);
      if (!wall) return null;
      const date = fromWallClock(wall, zone);
      return Number.isNaN(date.getTime()) ? null : date;
    };
    const startStr = allDay ? `${startDate}T00:00:00` : `${startDate}T${startTime || "00:00"}:00`;
    const endStr = allDay ? `${endDate}T23:59:59` : `${endDate}T${endTime || "00:00"}:00`;
    return {
      start: startDate ? instant(startStr) : null,
      end: endDate ? instant(endStr) : null,
    };
  }, [startDate, startTime, endDate, endTime, allDay, fieldZone]);

  // An existing event's own time, as saved: Suggest times doesn't count it
  // as busy (the attendees who have it in their calendar show it so).
  const savedWindow = useMemo(() => (event?.start && !event.showWithoutTime
    ? { start: fromDisplayDate(getEventStartDate(event)), end: fromDisplayDate(getEventEndDate(event)) }
    : null), [event]);

  // A suggested slot moves the event there; the fields are a wall clock in
  // the form's zone, so the instants are turned back into one.
  const handlePickSlot = useCallback((slot: { start: Date; end: Date }) => {
    const zone = fieldZone ?? getEffectiveTimeZone();
    const from = toZonedDisplayDate(slot.start, zone);
    const to = toZonedDisplayDate(slot.end, zone);
    setStartDate(formatDateInput(from));
    setStartTime(formatTimeInput(from));
    setEndDate(formatDateInput(to));
    setEndTime(formatTimeInput(to));
  }, [fieldZone]);

  // Plugin transform: collect conflict warnings for the current event form.
  // Re-runs (debounced) whenever fields that affect scheduling change.
  const [pluginConflictWarnings, setPluginConflictWarnings] = useState<ConflictWarning[]>([]);
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const startStr = allDay ? `${startDate}T00:00:00` : `${startDate}T${startTime}:00`;
      const endStr = allDay ? `${endDate}T23:59:59` : `${endDate}T${endTime}:00`;
      const warnings = await calendarHooks.onCheckEventConflicts.transform([] as ConflictWarning[], {
        event: {
          title,
          description,
          start: startStr,
          end: endStr,
          isAllDay: allDay,
          location,
          virtualLocation,
          calendarId,
          uid: event?.uid,
          attendees: attendees.map((a) => a.email),
        },
      });
      if (!cancelled) setPluginConflictWarnings(warnings);
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [title, description, startDate, startTime, endDate, endTime, allDay, location, virtualLocation, calendarId, event?.uid, attendees]);

  // Plugins hear about an existing event opened for reading once per event,
  // and about the form each time it opens (new event, or view -> edit).
  const reportedOpenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!event || mode !== "view" || reportedOpenRef.current === event.id) return;
    reportedOpenRef.current = event.id;
    void calendarHooks.onCalendarEventOpen.emit(eventToView(event));
  }, [event, mode]);

  useEffect(() => {
    if (mode !== "edit" || calendarFormHooks.onCalendarEventFormOpen.size === 0) return;
    void calendarFormHooks.onCalendarEventFormOpen.emit({
      title,
      description,
      start: allDay ? `${startDate}T00:00:00` : `${startDate}T${startTime}:00`,
      end: allDay ? `${endDate}T23:59:59` : `${endDate}T${endTime}:00`,
      isAllDay: allDay,
      location,
      virtualLocation,
      calendarId,
      uid: event?.uid,
      attendees: attendees.map((a) => a.email),
    });
    // Only the opening counts; the fields are read as they are at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // calendar-event-detail: the event as plugins see it, in the read views.
  const eventDetailProps = useMemo(() => (event ? { event: eventToView(event) } : null), [event]);

  // calendar-event-form: the form's current state in the same shape. Typing
  // would hand the plugin iframe new props on every key, so the view settles
  // for half a second first.
  const formEventView = useMemo<CalendarEventView>(() => {
    const startStr = allDay ? `${startDate}T00:00:00` : `${startDate}T${startTime || "00:00"}:00`;
    const start = new Date(startStr);
    let duration = event?.duration ?? "PT1H";
    if (!isNaN(start.getTime())) {
      if (allDay) {
        const inclusiveEnd = new Date(`${endDate}T00:00:00`);
        if (!isNaN(inclusiveEnd.getTime())) duration = buildAllDayDuration(start, inclusiveEnd < start ? start : inclusiveEnd);
      } else {
        const end = new Date(`${endDate}T${endTime || "00:00"}:00`);
        if (!isNaN(end.getTime())) duration = buildDuration(start, end);
      }
    }
    const base = event ? eventToView(event) : null;
    return {
      id: event?.id ?? "",
      uid: event?.uid ?? "",
      calendarId,
      title,
      description,
      start: startStr,
      duration,
      timeZone: fieldZone,
      utcStart: null,
      utcEnd: null,
      isAllDay: allDay,
      location,
      status: base?.status ?? "confirmed",
      participants: attendees.map((a) => {
        const known = base?.participants.find((p) => p.email.toLowerCase() === a.email.toLowerCase());
        return known ?? { name: a.name, email: a.email, role: "attendee", status: "needs-action" };
      }),
      isRecurring: recurrence !== "none",
      keywords: base?.keywords ?? [],
    };
  }, [event, calendarId, title, description, startDate, startTime, endDate, endTime, allDay, fieldZone, location, attendees, recurrence]);
  const [settledFormEvent, setSettledFormEvent] = useState(formEventView);
  useEffect(() => {
    const timer = setTimeout(() => setSettledFormEvent(formEventView), 500);
    return () => clearTimeout(timer);
  }, [formEventView]);
  const eventFormProps = useMemo(() => ({ event: settledFormEvent }), [settledFormEvent]);

  // Report live preview to parent for grid outline. The label as a string:
  // a new `t` on every render would report it again on each.
  const noTitle = t("events.no_title");
  useEffect(() => {
    if (!onPreviewChange || isEdit) return;
    const startStr = allDay ? `${startDate}T00:00:00` : `${startDate}T${startTime}:00`;
    const endStr = allDay ? `${endDate}T23:59:59` : `${endDate}T${endTime}:00`;
    // Where the grid shows it: the fields are on the form's clock.
    const s = zoneWallToDisplay(new Date(startStr), fieldZone);
    const e = zoneWallToDisplay(new Date(endStr), fieldZone);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) return;
    onPreviewChange({ start: s, end: e, title: title || noTitle, allDay, calendarId });
    return () => onPreviewChange(null);
  }, [startDate, startTime, endDate, endTime, allDay, fieldZone, title, noTitle, calendarId, isEdit, onPreviewChange]);

  const statusCounts = useMemo(() => {
    if (!event?.participants) return null;
    return getStatusCounts(event);
  }, [event]);

  const handleAddAttendee = useCallback((p: { name: string; email: string }) => {
    setAttendees(prev => [...prev, p]);
  }, []);

  const handleRemoveAttendee = useCallback((email: string) => {
    setAttendees(prev => prev.filter(a => a.email.toLowerCase() !== email.toLowerCase()));
  }, []);

  const handleSave = useCallback(async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || isSaving || savingRef.current) return;
    if (trimmedTitle.length > 500 || description.trim().length > 10000 || location.trim().length > 500) {
      // This guard returned silently, so a rejected save was indistinguishable from a dead
      // button. The fields also enforce their limits via maxLength, so this is a backstop —
      // but if it ever fires, say so.
      toast.error(t("notifications.event_error"));
      return;
    }

    const pendingAttendee = participantInputRef.current?.flush() ?? null;
    const effectiveAttendees = pendingAttendee ? [...attendees, pendingAttendee] : attendees;

    const startStr = allDay
      ? `${startDate}T00:00:00`
      : `${startDate}T${startTime}:00`;

    const start = allDay ? parseISO(startStr) : new Date(startStr);
    let duration: string;
    // The last day of an all-day event, the end of a timed one.
    let end: Date;

    if (allDay) {
      let inclusiveEnd = new Date(`${endDate}T00:00:00`);
      if (inclusiveEnd < start) {
        inclusiveEnd = new Date(start);
      }
      duration = buildAllDayDuration(start, inclusiveEnd);
      end = inclusiveEnd;
    } else {
      const endStr = `${endDate}T${endTime}:00`;
      end = new Date(endStr);
      // An end at or before the start becomes an hour - but an event that
      // lasts no time (a deadline, a reminder) keeps doing so.
      const lastedNoTime = !!event && !event.showWithoutTime
        && getEventEndDate(event).getTime() === getEventStartDate(event).getTime();
      if (end < start || (end.getTime() === start.getTime() && !lastedNoTime)) {
        end = new Date(start.getTime() + 3600000);
      }
      duration = buildDuration(start, end);
    }

    // The fields are the wall clock in the form's zone: the event's own, so
    // an edit keeps it, or the one the user picked. The editor state below
    // is in display dates, as the rest of the calendar.
    const when = {
      allDay,
      start: allDay ? start : zoneWallToDisplay(start, timeZone),
      end: allDay ? end : zoneWallToDisplay(end, timeZone),
    };
    const timeZoneChanged = !!event && !allDay && timeZone !== initialForm.timeZone;

    const trimmedDescription = description.trim();

    const data: Partial<CalendarEvent> = {
      title: trimmedTitle,
      start: startStr,
      duration,
      timeZone: allDay ? null : timeZone,
      showWithoutTime: allDay,
      calendarIds: { [calendarId]: true },
      ...savedStatusFields(event),
    };

    // On an existing event the empty string is how a description gets cleared, but
    // sending it on creation writes a `DESCRIPTION:` with nothing after it — which
    // invitation e-mails then render as a "Description" heading over blank space.
    // An HTML description the user did not touch stays as it was; one they
    // edited is saved as the plain text it now is.
    const keepsHtml = !!event && isHtmlDescription(event) && trimmedDescription === eventDescription.trim();
    if ((trimmedDescription || event) && !keepsHtml) {
      Object.assign(data, plainDescriptionFields(event, trimmedDescription));
    }

    if (!event) {
      data.uid = generateUUID();
    }

    if (location.trim()) {
      data.locations = {
        loc1: {
          "@type": "Location",
          name: location.trim(),
          description: null,
          locationTypes: null,
          coordinates: null,
          timeZone: null,
          links: null,
          relativeTo: null,
        },
      };
    } else if (event && event.locations && Object.keys(event.locations).length > 0) {
      data.locations = null;
    }

    if (virtualLocation.trim()) {
      data.virtualLocations = {
        vl1: {
          "@type": "VirtualLocation",
          name: null,
          description: null,
          uri: virtualLocation.trim(),
          features: null,
        },
      };
    } else if (event && event.virtualLocations && Object.keys(event.virtualLocations).length > 0) {
      data.virtualLocations = null;
    }

    if (recurrence === "custom" && customRule) {
      data.recurrenceRules = [customRule];
    } else if (recurrence !== "none" && recurrence !== "custom") {
      data.recurrenceRules = [createRecurrenceRule(recurrence)];
    } else if (event && event.recurrenceRules?.length) {
      data.recurrenceRules = null;
      if (event.recurrenceOverrides) data.recurrenceOverrides = null;
      if (event.excludedRecurrenceRules) data.excludedRecurrenceRules = null;
    }

    if (useDefaultAlerts) {
      data.useDefaultAlerts = true;
      // Stalwart copies the calendar's defaults into a new event itself
      // (sending alerts too would double them), but setting the flag on an
      // update keeps whatever alerts the event had, so updates carry them.
      if (event) data.alerts = defaultAlerts ? structuredClone(defaultAlerts) : null;
    } else {
      const defaultAlertIds = calendars
        .filter((c) => c.id === calendarId || event?.calendarIds?.[c.id])
        .flatMap((c) => [...Object.keys(c.defaultAlertsWithTime ?? {}), ...Object.keys(c.defaultAlertsWithoutTime ?? {})]);
      Object.assign(data, buildAlertsPatch(event, alertRows, preservedAlerts, defaultAlertIds));
    }

    // A rule the user did not touch is no change, however the server spells it.
    const initial = initialRecurrenceRef.current;
    const ruleChanged = !!event && (recurrence !== initial.recurrence || customRule !== initial.customRule)
      && !sameRecurrenceRules(event.recurrenceRules, data.recurrenceRules === undefined ? event.recurrenceRules : data.recurrenceRules);

    // Keeps the event's own organizer - an invitation's sender, the exact
    // address a series is organized under - and the answers of attendees who
    // stay; the user organizes an event that has no organizer yet. Moved by
    // the user as its organizer, or given another recurrence, the others are
    // asked again. The dates are those of the event the editor was opened on
    // - one occurrence of a series - so a move applies to whichever
    // occurrences the save covers; a rule changes only with the series, so
    // on one occurrence it is no move. Someone else's event keeps its
    // participants as its organizer sent them.
    if (userIsOrganizer) {
      Object.assign(data, participantFieldsToSave(event, effectiveAttendees, {
        userEmail: currentUserEmails[0],
        userEmails: currentUserEmails,
        resolveName: resolveContactName,
        rescheduled: !!event && (changesWhen(event, when) || timeZoneChanged || (ruleChanged && !event.recurrenceId)),
      }));
    }

    // Plugin form-save hook: a handler may refresh form-derived values
    // (currently the virtual-location link) in the same save that sends
    // scheduling messages, so invites carry what plugins set here rather
    // than a stale value from before the save.
    // The handlers can take seconds (a plugin minting a meeting room), so the
    // save counts as in flight from here: a second click or Ctrl+Enter must
    // not start another save, which for a new event would create a second
    // copy (fresh uid) and send its invitations twice.
    savingRef.current = true;
    setIsSaving(true);
    try {
      const pluginPatch = await calendarFormHooks.onCalendarEventFormSave.transform<
        CalendarEventFormSavePatch
      >(
        {},
        {
          title: trimmedTitle,
          description: trimmedDescription,
          start: startStr,
          end: allDay ? `${endDate}T23:59:59` : `${endDate}T${endTime}:00`,
          isAllDay: allDay,
          location,
          virtualLocation,
          calendarId,
          uid: data.uid ?? event?.uid,
          attendees: effectiveAttendees.map((a) => a.email),
        },
      );
      if (pluginPatch && typeof pluginPatch.virtualLocation === "string") {
        if (pluginPatch.virtualLocation.trim()) {
          data.virtualLocations = {
            vl1: {
              "@type": "VirtualLocation",
              name: null,
              description: null,
              uri: pluginPatch.virtualLocation.trim(),
              features: null,
            },
          };
        } else if (event) {
          data.virtualLocations = null;
        } else {
          delete data.virtualLocations;
        }
      }

      const shouldSendScheduling = userIsOrganizer && effectiveAttendees.length > 0 && sendInvitations;
      // Invitations are mail too: newly invited people outside the
      // organisation get the same confirm as a message (Back keeps the
      // editor open, nothing saved).
      if (shouldSendScheduling) {
        const known = new Set(initialAttendees.map((a) => a.email.trim().toLowerCase()));
        const invited = effectiveAttendees.map((a) => a.email).filter((email) => email && !known.has(email.trim().toLowerCase()));
        if (!(await confirmInvitationRecipients(invited))) return;
      }
      await onSave(data, shouldSendScheduling, {
        initialAttendees,
        attendees: effectiveAttendees,
        when,
        ruleChanged,
        ...(timeZoneChanged ? { timeZoneChanged } : {}),
      });
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }, [title, description, location, virtualLocation, startDate, startTime, endDate, endTime, allDay, timeZone, initialForm, calendarId, calendars, recurrence, customRule, useDefaultAlerts, defaultAlerts, alertRows, preservedAlerts, attendees, initialAttendees, sendInvitations, currentUserEmails, userIsOrganizer, resolveContactName, event, eventDescription, onSave, isSaving, t]);

  // The user's own answer, and the owner's in a calendar shared with them
  // (lib/calendar-delegate.ts).
  const eventCalendar = useMemo(
    () => (event ? calendars.find((c) => event.calendarIds?.[c.id]) ?? null : null),
    [event, calendars],
  );
  const answerView = useAnswerView(event ?? null, eventCalendar, currentUserEmails, canRsvp && !!userParticipantId);
  const handleAnswer = useCallback((target: AnswerTarget, status: CalendarParticipant['participationStatus']) => {
    if (!onRsvp) return;
    onRsvp(target.eventId, target.participantId, status, target.sentBy);
    onClose();
  }, [onRsvp, onClose]);

  const handleDuplicate = useCallback(() => {
    if (!event || !onDuplicate) return;
    onDuplicate(buildDuplicateEventData(event));
  }, [event, onDuplicate]);

  const titleRef = useRef<HTMLInputElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const initialFocusTarget = useCallback(
    (): HTMLElement | null => (mode === "edit" ? titleRef.current : primaryRef.current),
    [mode],
  );
  // Full screen on the phone: a modal that holds the focus.
  const modalRef = useFocusTrap({ isActive: !!isMobile, initialFocus: initialFocusTarget });

  // Beside the grid on wide screens: the focus moves in on open and with
  // each switch between summary and form, and goes back on close.
  useEffect(() => {
    if (isMobile) return;
    initialFocusTarget()?.focus();
  }, [isMobile, initialFocusTarget]);
  useEffect(() => {
    if (isMobile) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const active = document.activeElement;
      if (opener?.isConnected && (!active || active === document.body)) opener.focus();
    };
  }, [isMobile]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (askingRef.current) return;
        if (mode === "edit" && isEdit) {
          backToView();
        } else {
          requestClose();
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (canEditBody) handleSave();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [requestClose, backToView, handleSave, canEditBody, mode, isEdit]);

  const hasParticipants = attendees.length > 0 || (event?.participants && Object.keys(event.participants).length > 0);

  // View mode: read-only display of event details with Edit button. An
  // invitation the user can only answer is shown by the same view, with a
  // banner on top and the answer buttons below - one layout for every event,
  // like the card's.
  if ((mode === "view" || rsvpMode) && event) {
    const startD = getEventStartDate(event);
    const durMin = parseDuration(event.duration);
    const endD = getEventEndDate(event);
    const locationName = primaryLocationName(event) ?? null;
    // Invitations (Teams above all) leave virtualLocations empty and bury the
    // join URL in the description; it counts as the meeting link anyway.
    const meeting = findMeetingLink(event);
    const virtualLoc = meeting?.uri ?? null;
    const locationHref = locationName
      ? (() => { const action = locationAction(locationName, meeting); return action.kind === "url" ? action.uri : mapsUrl(action.query); })()
      : null;
    const viewParticipants = getParticipantList(event, { resolveName: resolveContactName });
    const recurrenceLabel = getRecurrenceLabel(event, t, locale);
    const alertLabel = formatEventAlertsLabel(event, calendars, t);
    const eventCalendar = calendars.find(c => event.calendarIds[c.id]);
    const color = paint(getEventColor(event, eventCalendar));
    // An event on another zone's clock shows its own times too (pim-2).
    const zoned = eventZonedTimes(event, startD, endD);
    const zonedText = zoned ? zonedTimesText(zoned, startD, endD, timeDisplayFmt, locale) : null;

    const viewClose = (
      <IconButton label={tCommon("close")} onClick={onClose} className="flex-shrink-0 mt-0.5 text-muted-foreground">
        <X />
      </IconButton>
    );

    return (
      <div ref={modalRef} role="dialog" aria-modal={isMobile || undefined} aria-label={event.title || t("events.no_title")} className={isMobile ? mobileRootClass : "flex flex-col h-full bg-background"}>
        {/* Color accent bar */}
        <div className="h-1 w-full flex-shrink-0" style={{ backgroundColor: color }} />

        {/* Header */}
        <div ref={setHeader} data-window-top-row="" className="flex items-start justify-between gap-2 px-6 py-4 border-b border-border flex-shrink-0">
          {closeFirst && viewClose}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
              <h2 className="text-lg font-semibold truncate" title={event.title || t("events.no_title")}>{event.title || t("events.no_title")}</h2>
            </div>
            {eventCalendar && (
              <p className="text-xs text-muted-foreground mt-0.5 ps-[18px]">{eventCalendar.name}</p>
            )}
          </div>
          {onMore && (
            <IconButton label={t("toolbar.more")} aria-haspopup="menu" className="flex-shrink-0 mt-0.5" onClick={(e) => onMore(e.currentTarget)}>
              <MoreVertical />
            </IconButton>
          )}
          {!closeFirst && viewClose}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-6 py-4 space-y-3">
            {rsvpMode && (
            <div className="flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
              <CalendarDays className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
              <div className="text-sm">
                <p className="font-medium text-foreground">
                  {t("participants.invited_by", { name: organizerInfo?.name || organizerInfo?.email || t("participants.organizer") })}
                </p>
                <p className="text-muted-foreground mt-0.5">
                  {t("participants.respond_below")}
                </p>
              </div>
            </div>
            )}

            {/* Date & Time */}
            <div className="flex items-start gap-2.5">
              <Clock className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div className="text-sm">
                {(() => {
                  const displayEnd = getEventDisplayEndDate(event);
                  const multiDay = !isSameDay(startD, displayEnd);
                  if (multiDay && event.showWithoutTime) {
                    return (
                      <>
                        {/* One range as the language writes it (pim-13). */}
                        <div className="font-medium text-foreground">
                          {formatDateRangeLabel(startD, displayEnd, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
                        </div>
                        <div className="text-muted-foreground">{t("events.all_day")}</div>
                      </>
                    );
                  }
                  if (multiDay) {
                    return (
                      <>
                        <div className="font-medium text-foreground">
                          {formatEventDate(startD)}
                          <span className="ms-1.5 font-normal text-muted-foreground">
                            {format(startD, timeDisplayFmt)}
                          </span>
                        </div>
                        <div className="font-medium text-foreground">
                          {formatEventDate(endD)}
                          <span className="ms-1.5 font-normal text-muted-foreground">
                            {format(endD, timeDisplayFmt)}
                          </span>
                        </div>
                        <div className="text-muted-foreground text-xs">
                          ({formatDurationDisplay(durMin)})
                        </div>
                        {zoned && zonedText && (
                          <div className="text-muted-foreground text-xs" data-testid="event-zone-times">
                            {tEvent("zone_only", { times: zonedText.times, zone: zoned.zone })}
                          </div>
                        )}
                      </>
                    );
                  }
                  return (
                    <>
                      <span className="font-medium text-foreground">
                        {formatEventDate(startD)}
                      </span>
                      {event.showWithoutTime ? (
                        <span className="text-muted-foreground ms-1.5">{t("events.all_day")}</span>
                      ) : zoned && zonedText ? (
                        <div className="text-muted-foreground" data-testid="event-zone-times">
                          {tEvent("zone_times", { times: zonedText.times, zone: zoned.zone, local: zonedText.local })}
                        </div>
                      ) : (
                        <div className="text-muted-foreground">
                          {format(startD, timeDisplayFmt)} – {format(endD, timeDisplayFmt)}
                          <span className="ms-1.5 text-xs">({formatDurationDisplay(durMin)})</span>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>

            {/* Location */}
            {locationName && (
              <div className="flex items-start gap-2.5">
                <MapPin className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                {/* A URL opens as a link, a postal address in the maps, as on the card. */}
                <a href={locationHref ?? undefined} target="_blank" rel="noreferrer" onClick={gateLinkClick} onAuxClick={gateLinkClick} className="text-sm text-primary hover:underline min-w-0 break-words" title={locationName}>
                  {/^https?:\/\//i.test(locationName)
                    ? (() => { try { return new URL(locationName).hostname; } catch { return locationName; } })()
                    : locationName}
                </a>
              </div>
            )}

            {/* Virtual Location */}
            {virtualLoc && (
              <div className="flex items-start gap-2.5">
                <Video className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <a href={virtualLoc} target="_blank" rel="noreferrer" onClick={gateLinkClick} onAuxClick={gateLinkClick} className="text-sm text-primary hover:underline truncate" title={virtualLoc}>
                  {(() => { try { return new URL(virtualLoc).hostname; } catch { return virtualLoc; } })()}
                </a>
              </div>
            )}

            {/* Participants */}
            {viewParticipants.length > 0 && (
              <div className="flex items-start gap-2.5">
                <Users className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <div className="text-sm min-w-0">
                  <span className="text-muted-foreground">
                    {t("participants.count", { count: viewParticipants.length })}
                  </span>
                  <div className="mt-1 space-y-0.5">
                    {viewParticipants.map((p) => (
                      <div key={p.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate text-foreground" title={p.email}>
                          {p.name || p.email}
                          {p.isOrganizer && (
                            <span className="text-muted-foreground ms-1">({t("participants.organizer_role")})</span>
                          )}
                        </span>
                        <ParticipantStatusBadge status={p.status} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Recurrence */}
            {recurrenceLabel && (
              <div className="flex items-start gap-2.5">
                <Repeat className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <span className="text-sm text-foreground">{recurrenceLabel}</span>
              </div>
            )}

            {/* Reminder */}
            {alertLabel && (
              <div className="flex items-start gap-2.5">
                <Bell className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <span className="text-sm text-foreground">{alertLabel}</span>
              </div>
            )}

            {/* Description */}
            {eventDescription && (
              <div className="flex items-start gap-2.5">
                <AlignLeft className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <p className="text-sm text-muted-foreground whitespace-pre-line break-words">
                  <LinkifiedText text={eventDescription} />
                </p>
              </div>
            )}

            {eventDetailProps && <PluginSlot name="calendar-event-detail" className="w-full" extraProps={eventDetailProps} />}
          </div>
        </div>

        {/* RSVP:
          The viewer owes a reply but may also edit their own copy,
          so the rsvp-only branch above does not apply to this event.
        */}
        {onRsvp && (
          <AnswerBars
            view={answerView}
            className="px-6 py-3 border-t border-border flex-shrink-0 empty:hidden"
            onRespond={handleAnswer}
          />
        )}

        {/* Action Bar */}
        <div className="px-6 py-3 border-t border-border flex-shrink-0 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            {onDelete && canEditBody && (
              <IconButton label={t("events.delete")} onClick={() => onDelete(event.id, hasParticipants || undefined)} className="text-destructive hover:text-destructive">
                <Trash2 />
              </IconButton>
            )}
            {onDuplicate && (
              <IconButton label={t("events.duplicate")} onClick={handleDuplicate}>
                <CopyPlus />
              </IconButton>
            )}
          </div>
          {canEditBody && (
            <Button ref={primaryRef} size="xs" onClick={() => setMode("edit")} className="whitespace-nowrap">
              <Pencil className="me-1" />
              {t("events.edit")}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const editClose = (
    <IconButton label={tCommon("close")} onClick={requestClose} className="flex-shrink-0 text-muted-foreground">
      <X />
    </IconButton>
  );

  return (
    <div ref={modalRef} role="dialog" aria-modal={isMobile || undefined} aria-label={isEdit ? t("events.edit") : t("events.create")} data-tour="event-modal" className={isMobile ? mobileRootClass : "flex flex-col h-full bg-background"}>
      <div ref={setHeader} data-window-top-row="" className="flex items-center gap-2 px-6 py-4 border-b border-border flex-shrink-0">
        {closeFirst && editClose}
        <h2 className="min-w-0 flex-1 text-lg font-semibold">
          {isEdit ? t("events.edit") : t("events.create")}
        </h2>
        {!closeFirst && editClose}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-4 space-y-4">
          <div>
            <label htmlFor={labelFor("title")} className="text-sm font-medium mb-1 block">{t("form.title")}</label>
            <Input
              id={labelFor("title")}
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("form.title")}
              maxLength={500}
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="allDay"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
              className="rounded border-input"
            />
            <label htmlFor="allDay" className="text-sm">{t("form.all_day_event")}</label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label htmlFor={labelFor("start_date")} className="text-sm font-medium mb-1 block">{t("form.start_date")}</label>
              <input
                id={labelFor("start_date")}
                type="date"
                value={startDate}
                onChange={(e) => handleStartDateChange(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-hidden"
              />
            </div>
            {!allDay && (
              <div>
                <label htmlFor={labelFor("start_time")} className="text-sm font-medium mb-1 block">{t("form.start_time")}</label>
                <input
                  id={labelFor("start_time")}
                  type="time"
                  value={startTime}
                  onChange={(e) => handleStartTimeChange(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-hidden"
                />
              </div>
            )}
            <div>
              <label htmlFor={labelFor("end_date")} className="text-sm font-medium mb-1 block">{t("form.end_date")}</label>
              <input
                id={labelFor("end_date")}
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-hidden"
              />
            </div>
            {!allDay && (
              <div>
                <label htmlFor={labelFor("end_time")} className="text-sm font-medium mb-1 block">{t("form.end_time")}</label>
                <input
                  id={labelFor("end_time")}
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-hidden"
                />
              </div>
            )}
          </div>

          {/* The zone the times are on (pim-2): a line when it isn't the
              user's, a small link when it is; both open the picker. A
              floating event stays without one. */}
          {fieldZone && (
            <div data-testid="event-time-zone">
              {showZonePicker ? (
                <>
                  <label htmlFor={labelFor("time_zone")} className="text-sm font-medium mb-1 block">{tEvent("time_zone")}</label>
                  <select
                    id={labelFor("time_zone")}
                    value={fieldZone}
                    onChange={(e) => setTimeZone(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-hidden"
                  >
                    {zoneOptions.map((zone) => (
                      <option key={zone} value={zone}>{zone.replace(/_/g, " ")}</option>
                    ))}
                  </select>
                </>
              ) : fieldZone !== userTimeZone ? (
                <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <button type="button" onClick={() => setShowZonePicker(true)} className="text-foreground hover:underline">
                    {tEvent("time_zone_line", { zone: timeZoneCity(fieldZone) })}
                  </button>
                  {formYourTimes && (
                    <span className="text-xs text-muted-foreground">{tEvent("your_time", { times: formYourTimes })}</span>
                  )}
                </div>
              ) : (
                <button type="button" onClick={() => setShowZonePicker(true)} className="text-xs text-primary hover:underline">
                  {tEvent("time_zone")}
                </button>
              )}
            </div>
          )}

          {pluginConflictWarnings.length > 0 && (
            <div className="space-y-1.5">
              {pluginConflictWarnings.map(w => (
                <div
                  key={w.key}
                  className={
                    w.severity === 'error'
                      ? 'text-sm rounded-md border border-destructive/50 bg-destructive/10 text-destructive px-3 py-2'
                      : w.severity === 'info'
                        ? 'text-sm rounded-md border border-border bg-muted/40 text-muted-foreground px-3 py-2'
                        : 'text-sm rounded-md border border-warning/50 bg-warning/10 text-amber-600 dark:text-amber-400 px-3 py-2'
                  }
                  title={w.message}
                >
                  {w.message}
                </div>
              ))}
            </div>
          )}

          <div>
            <label htmlFor={labelFor("title-1")} className="text-sm font-medium mb-1 block">{t("recurrence.title")}</label>
            <div className="flex items-center gap-2">
              <select
                id={labelFor("title-1")}
                value={recurrence}
                onChange={(e) => {
                  const value = e.target.value as RecurrenceOption;
                  if (value === "custom") {
                    recurrenceBeforeCustomRef.current = recurrence;
                    setRecurrence("custom");
                    setShowRecurrenceEditor(true);
                  } else {
                    setRecurrence(value);
                    setShowRecurrenceEditor(false);
                  }
                }}
                className="flex-1 min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-hidden"
              >
                <option value="none">{t("recurrence.none")}</option>
                <option value="daily">{t("recurrence.daily")}</option>
                <option value="weekly">{t("recurrence.weekly")}</option>
                <option value="monthly">{t("recurrence.monthly")}</option>
                <option value="yearly">{t("recurrence.yearly")}</option>
                <option value="custom">{customRuleSummary || t("recurrence.custom")}</option>
              </select>
              {recurrence === "custom" && !showRecurrenceEditor && (
                <button
                  type="button"
                  onClick={() => setShowRecurrenceEditor(true)}
                  className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  aria-label={t("recurrence.edit_custom")}
                >
                  <Pencil className="w-4 h-4" />
                </button>
              )}
            </div>
            {showRecurrenceEditor && (
              <RecurrenceEditor
                rule={customRule}
                eventStart={(() => {
                  const d = new Date(`${startDate}T${allDay ? "00:00" : (startTime || "00:00")}:00`);
                  return isNaN(d.getTime()) ? displayNow() : d;
                })()}
                onSave={handleRecurrenceEditorSave}
                onCancel={handleRecurrenceEditorCancel}
              />
            )}
          </div>

          {selectableCalendars.length > 1 && (
            <div>
              <label htmlFor={labelFor("calendar_select")} className="text-sm font-medium mb-1 block">{t("form.calendar_select")}</label>
              <select
                id={labelFor("calendar_select")}
                value={calendarId}
                onChange={(e) => setCalendarId(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-hidden"
              >
                {selectableCalendars.map((cal) => (
                  <option key={cal.id} value={cal.id}>
                    {cal.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label htmlFor={labelFor("location")} className="text-sm font-medium mb-1 block">{t("form.location")}</label>
            <Input
              id={labelFor("location")}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={t("form.location")}
              maxLength={500}
            />
          </div>

          <div>
            <label htmlFor={labelFor("meeting_link")} className="text-sm font-medium mb-1 block">
              <span className="flex items-center gap-1.5">
                <Video className="w-4 h-4" aria-hidden="true" />
                {t("form.meeting_link")}
              </span>
            </label>
            <Input
              id={labelFor("meeting_link")}
              type="url"
              value={virtualLocation}
              onChange={(e) => setVirtualLocation(e.target.value)}
              placeholder="https://meet.example.com/..."
              maxLength={2000}
            />
            <PluginSlot
              name="calendar-event-actions"
              className="mt-2 flex flex-wrap gap-2"
              extraProps={{
                eventData: {
                  title,
                  description,
                  start: startDate + 'T' + startTime,
                  end: endDate + 'T' + endTime,
                  isAllDay: allDay,
                  location,
                  virtualLocation,
                  calendarId,
                  uid: event?.uid,
                  attendees: attendees.map((a) => a.email),
                },
                setVirtualLocation,
              }}
            />
          </div>

          <div>
            <label htmlFor={labelFor("participants")} className="text-sm font-medium mb-1 block">
              <span className="flex items-center gap-1.5">
                <Users className="w-4 h-4" aria-hidden="true" />
                {t("participants.title")}
              </span>
            </label>
            {/* The organizer decides who is invited; an attendee's save
                keeps the list as it came. */}
            <ParticipantInput
              id={labelFor("participants")}
              ref={participantInputRef}
              participants={attendees}
              onAdd={handleAddAttendee}
              onRemove={handleRemoveAttendee}
              disabled={!userIsOrganizer}
            />
            {/* Only a warning: 0.16 advertises the limit without enforcing
                it, Stalwart 1.0 refuses to save more participants - the
                organizer entry a save adds counts too. */}
            {maxParticipants != null && attendees.length > 0 && attendees.length + 1 > maxParticipants && (
              <p role="status" className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" />
                {t("participants.limit_warning", { max: maxParticipants })}
              </p>
            )}
            <ParticipantAvailability
              attendees={attendees}
              start={availabilityWindow.start}
              end={availabilityWindow.end}
            />
            {userIsOrganizer && !allDay && (
              <FindATime
                attendees={attendees}
                start={availabilityWindow.start}
                end={availabilityWindow.end}
                onPick={handlePickSlot}
                savedWindow={savedWindow}
              />
            )}
            {isEdit && statusCounts && (existingParticipants.length > 0) && (
              <p className="text-xs text-muted-foreground mt-1.5">
                {t("participants.status_summary", {
                  accepted: statusCounts.accepted,
                  pending: statusCounts.tentative + statusCounts['needs-action'],
                })}
              </p>
            )}
          </div>

          {/* Only the organizer's messages: the editor never changes the
              user's own answer, which the answer buttons send. */}
          {attendees.length > 0 && userIsOrganizer && (
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="sendInvitations"
                checked={sendInvitations}
                onChange={(e) => setSendInvitations(e.target.checked)}
                className="rounded border-input"
              />
              <label htmlFor="sendInvitations" className="text-sm">
                {t("participants.send_invitations")}
              </label>
            </div>
          )}

          <div>
            <label className="text-sm font-medium mb-1 block">{t("alerts.title")}</label>
            {useDefaultAlerts ? (
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t("alerts.calendar_defaults")}</p>
                <AlertSummary alerts={defaultAlerts} />
                <button
                  type="button"
                  onClick={customizeAlerts}
                  className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  {t("alerts.customize")}
                </button>
              </div>
            ) : (
              <AlertListEditor
                rows={alertRows}
                onChange={setAlertRows}
                keptCount={Object.keys(preservedAlerts).length}
                extraAction={
                  <button
                    type="button"
                    onClick={() => { setUseDefaultAlerts(true); setRefreshDefaults(true); }}
                    className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                  >
                    {t("alerts.use_defaults")}
                  </button>
                }
              />
            )}
          </div>

          <div>
            <label htmlFor={labelFor("description")} className="text-sm font-medium mb-1 block">{t("form.description")}</label>
            <textarea
              id={labelFor("description")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("form.description")}
              rows={3}
              maxLength={10000}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-hidden"
            />
          </div>

          <PluginSlot name="calendar-event-form" className="w-full" extraProps={eventFormProps} />
        </div>
      </div>

      <div className="flex items-center gap-2 px-6 py-4 border-t border-border flex-shrink-0">
        {isEdit && onDelete && (
          <IconButton size="icon" label={t("events.delete")} onClick={() => onDelete(event!.id, hasParticipants || undefined)} className="text-destructive hover:text-destructive">
            <Trash2 className="w-4 h-4" />
          </IconButton>
        )}
        {isEdit && onDuplicate && (
          <IconButton size="icon" label={t("events.duplicate")} onClick={handleDuplicate}>
            <CopyPlus className="w-4 h-4" />
          </IconButton>
        )}

        <div className="flex gap-2 ms-auto">
          <Button
            variant="outline"
            onClick={isEdit ? backToView : requestClose}
            className="whitespace-nowrap"
          >
            {t("form.cancel")}
          </Button>
          <Button
            onClick={handleSave}
            disabled={!title.trim() || isSaving}
            className="whitespace-nowrap"
          >
            {/* While a save is in flight the button was disabled with no visible change, so a
                slow request (mobile, VPN) looked like a dead button for the whole timeout. */}
            {isSaving ? t("subscription.saving") : t("form.save")}
          </Button>
        </div>
      </div>
      <ConfirmDialog {...discardDialogProps} />
    </div>
  );
}
