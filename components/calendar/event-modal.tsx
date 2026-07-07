"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Trash2, Check, Users, CalendarDays, Copy, Pencil, Clock, MapPin, Video, Repeat, Bell, AlignLeft, Plus } from "lucide-react";
import { format, parseISO, addHours, addDays, isSameDay } from "date-fns";
import type { CalendarEvent, Calendar, CalendarParticipant, CalendarEventAlert, CalendarRecurrenceRule } from "@/lib/jmap/types";
import { RecurrenceEditor, buildRecurrenceSummary, isSimpleRecurrenceRule } from "./recurrence-editor";
import { parseDuration, getEventColor } from "./event-card";
import { buildAllDayDuration, getEventDisplayEndDate, getEventEndDate, getEventStartDate, getPrimaryCalendarId } from "@/lib/calendar-utils";
import { ParticipantInput, type ParticipantInputHandle } from "./participant-input";
import {
  isOrganizer,
  getUserParticipantId,
  getUserStatus,
  getParticipantList,
  getStatusCounts,
  buildParticipantMap,
} from "@/lib/calendar-participants";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import { useSettingsStore } from "@/stores/settings-store";
import { generateUUID } from "@/lib/utils";
import { useFormatEventDate } from "@/hooks/use-format-event-date";
import { calendarHooks } from "@/lib/plugin-hooks";
import type { ConflictWarning } from "@/lib/plugin-types";

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
  defaultCalendarId?: string;
  onSave: (data: Partial<CalendarEvent>, sendSchedulingMessages?: boolean) => void | Promise<void>;
  onDelete?: (id: string, sendSchedulingMessages?: boolean) => void;
  onDuplicate?: (data: Partial<CalendarEvent>) => void;
  onRsvp?: (eventId: string, participantId: string, status: CalendarParticipant['participationStatus']) => void;
  onClose: () => void;
  onPreviewChange?: (preview: PendingEventPreview | null) => void;
  currentUserEmails?: string[];
  isMobile?: boolean;
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

type AlertUnit = "at_time" | "minutes" | "hours" | "days" | "weeks";

interface AlertRow {
  id: string;
  value: number;
  unit: AlertUnit;
}

let alertRowSeq = 0;
function newAlertRow(value: number, unit: AlertUnit): AlertRow {
  alertRowSeq += 1;
  return { id: `r${alertRowSeq}`, value, unit };
}

function alertRowToOffset(row: AlertRow): string | null {
  if (row.unit === "at_time") return "PT0S";
  const v = Math.max(0, Math.floor(row.value));
  if (!Number.isFinite(v) || v <= 0) return null;
  switch (row.unit) {
    case "minutes": return `-PT${v}M`;
    case "hours": return `-PT${v}H`;
    case "days": return `-P${v}D`;
    case "weeks": return `-P${v}W`;
  }
}

function offsetToAlertRow(offset: string): AlertRow | null {
  if (offset === "PT0S" || offset === "P0D" || offset === "PT0M") {
    return newAlertRow(0, "at_time");
  }
  let m = offset.match(/^-?P(\d+)W$/);
  if (m) return newAlertRow(parseInt(m[1], 10), "weeks");
  m = offset.match(/^-?P(\d+)D$/);
  if (m) return newAlertRow(parseInt(m[1], 10), "days");
  m = offset.match(/^-?PT(\d+)H$/);
  if (m) return newAlertRow(parseInt(m[1], 10), "hours");
  m = offset.match(/^-?PT(\d+)M$/);
  if (m) {
    const mins = parseInt(m[1], 10);
    if (mins > 0 && mins % 1440 === 0) return newAlertRow(mins / 1440, "days");
    if (mins > 0 && mins % 60 === 0) return newAlertRow(mins / 60, "hours");
    return newAlertRow(mins, "minutes");
  }
  return null;
}

function formatAlertRowLabel(
  row: { value: number; unit: AlertUnit },
  t: ReturnType<typeof useTranslations>
): string {
  if (row.unit === "at_time") return t("alerts.at_time");
  switch (row.unit) {
    case "minutes": return t("alerts.minutes_before", { count: row.value });
    case "hours": return t("alerts.hours_before", { count: row.value });
    case "days": return t("alerts.days_before", { count: row.value });
    case "weeks": return t("alerts.weeks_before", { count: row.value });
  }
}

function formatDurationDisplay(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) return `${h}h`;
  return `${h}h${m}min`;
}

function getAlertLabel(event: CalendarEvent, t: ReturnType<typeof useTranslations>): string | null {
  if (!event.alerts) return null;
  const labels: string[] = [];
  for (const alert of Object.values(event.alerts)) {
    if (alert.trigger["@type"] !== "OffsetTrigger") continue;
    const row = offsetToAlertRow(alert.trigger.offset);
    if (!row) continue;
    labels.push(formatAlertRowLabel(row, t));
  }
  if (labels.length === 0) return null;
  return labels.join(", ");
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
  defaultCalendarId,
  onSave,
  onDelete,
  onDuplicate,
  onRsvp,
  onClose,
  onPreviewChange,
  currentUserEmails = [],
  isMobile = false,
}: EventModalProps) {
  const t = useTranslations("calendar");
  const locale = useLocale();
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const timeDisplayFmt = timeFormat === "12h" ? "h:mm a" : "HH:mm";
  const isEdit = !!event;
  const formatEventDate = useFormatEventDate();
  const [mode, setMode] = useState<"view" | "edit">(isEdit ? "view" : "edit");

  const userIsOrganizer = useMemo(() => {
    if (!event) return true;
    if (!event.participants) return true;
    return isOrganizer(event, currentUserEmails);
  }, [event, currentUserEmails]);

  const isAttendeeMode = useMemo(() => {
    if (!event || !event.participants) return false;
    return !event.isOrigin && !userIsOrganizer;
  }, [event, userIsOrganizer]);

  const userParticipantId = useMemo(() => {
    if (!event) return null;
    return getUserParticipantId(event, currentUserEmails);
  }, [event, currentUserEmails]);

  const userCurrentStatus = useMemo(() => {
    if (!event) return null;
    return getUserStatus(event, currentUserEmails);
  }, [event, currentUserEmails]);

  const existingParticipants = useMemo(() => {
    if (!event) return [];
    return getParticipantList(event);
  }, [event]);

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
      const now = new Date();
      d.setHours(now.getHours() + 1, 0, 0, 0);
      return d;
    }
    const d = new Date();
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

  const [title, setTitle] = useState(event?.title || "");
  const [description, setDescription] = useState(event?.description || "");
  const [location, setLocation] = useState(
    event?.locations ? Object.values(event.locations)[0]?.name || "" : ""
  );
  const [virtualLocation, setVirtualLocation] = useState(
    event?.virtualLocations ? Object.values(event.virtualLocations)[0]?.uri || "" : ""
  );
  const [startDate, setStartDate] = useState(formatDateInput(getInitialStart()));
  const [startTime, setStartTime] = useState(formatTimeInput(getInitialStart()));
  const [endDate, setEndDate] = useState(formatDateInput(getInitialEnd()));
  const [endTime, setEndTime] = useState(formatTimeInput(getInitialEnd()));
  const [allDay, setAllDay] = useState(event?.showWithoutTime || defaultAllDay || false);
  const [calendarId, setCalendarId] = useState<string>(() => {
    if (event?.calendarIds) return getPrimaryCalendarId(event) || calendars[0]?.id || "";
    if (defaultCalendarId && calendars.some(c => c.id === defaultCalendarId)) return defaultCalendarId;
    const defaultCal = calendars.find(c => c.isDefault);
    return defaultCal?.id || calendars[0]?.id || "";
  });
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
  const preservedAlertsRef = useRef<Record<string, CalendarEventAlert>>({});
  const [alertRows, setAlertRows] = useState<AlertRow[]>(() => {
    if (!event?.alerts) return [];
    const rows: AlertRow[] = [];
    for (const [id, alert] of Object.entries(event.alerts)) {
      // Preserve alerts we can't represent in this UI (absolute triggers,
      // email actions, offsets with non-canonical shapes) so they survive a save.
      if (alert.trigger["@type"] !== "OffsetTrigger" || alert.action !== "display") {
        preservedAlertsRef.current[id] = alert;
        continue;
      }
      const row = offsetToAlertRow(alert.trigger.offset);
      if (!row) {
        preservedAlertsRef.current[id] = alert;
        continue;
      }
      rows.push(row);
    }
    return rows;
  });

  const addAlertRow = useCallback(() => {
    setAlertRows((prev) => [...prev, newAlertRow(10, "minutes")]);
  }, []);
  const updateAlertRow = useCallback((id: string, patch: Partial<Omit<AlertRow, "id">>) => {
    setAlertRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);
  const removeAlertRow = useCallback((id: string) => {
    setAlertRows((prev) => prev.filter((r) => r.id !== id));
  }, []);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const [attendees, setAttendees] = useState<{ name: string; email: string }[]>(() => {
    if (!event?.participants) return [];
    return existingParticipants
      .filter(p => !p.isOrganizer)
      .map(p => ({ name: p.name, email: p.email }));
  });
  const [sendInvitations, setSendInvitations] = useState(true);
  const participantInputRef = useRef<ParticipantInputHandle>(null);

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
        },
      });
      if (!cancelled) setPluginConflictWarnings(warnings);
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [title, description, startDate, startTime, endDate, endTime, allDay, location, virtualLocation, calendarId]);

  // Report live preview to parent for grid outline
  useEffect(() => {
    if (!onPreviewChange || isEdit) return;
    const startStr = allDay ? `${startDate}T00:00:00` : `${startDate}T${startTime}:00`;
    const endStr = allDay ? `${endDate}T23:59:59` : `${endDate}T${endTime}:00`;
    const s = new Date(startStr);
    const e = new Date(endStr);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) return;
    onPreviewChange({ start: s, end: e, title: title || "(No title)", allDay, calendarId });
    return () => onPreviewChange(null);
  }, [startDate, startTime, endDate, endTime, allDay, title, calendarId, isEdit, onPreviewChange]);

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
    if (!trimmedTitle || isSaving) return;
    if (trimmedTitle.length > 500 || description.trim().length > 10000 || location.trim().length > 500) return;

    const pendingAttendee = participantInputRef.current?.flush() ?? null;
    const effectiveAttendees = pendingAttendee ? [...attendees, pendingAttendee] : attendees;

    const startStr = allDay
      ? `${startDate}T00:00:00`
      : `${startDate}T${startTime}:00`;

    const start = allDay ? parseISO(startStr) : new Date(startStr);
    let duration: string;

    if (allDay) {
      let inclusiveEnd = new Date(`${endDate}T00:00:00`);
      if (inclusiveEnd < start) {
        inclusiveEnd = new Date(start);
      }
      duration = buildAllDayDuration(start, inclusiveEnd);
    } else {
      const endStr = `${endDate}T${endTime}:00`;
      let end = new Date(endStr);
      if (end <= start) {
        end = new Date(start.getTime() + 3600000);
      }
      duration = buildDuration(start, end);
    }

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const data: Partial<CalendarEvent> = {
      title: trimmedTitle,
      description: description.trim(),
      start: startStr,
      duration,
      timeZone: allDay ? null : timeZone,
      showWithoutTime: allDay,
      calendarIds: { [calendarId]: true },
      status: "confirmed",
      freeBusyStatus: "busy",
      privacy: "public",
    };

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
      data.recurrenceRules = [{
        "@type": "RecurrenceRule",
        frequency: recurrence,
        interval: 1,
        rscale: "gregorian",
        skip: "omit",
        firstDayOfWeek: "mo",
        byDay: null,
        byMonthDay: null,
        byMonth: null,
        byYearDay: null,
        byWeekNo: null,
        byHour: null,
        byMinute: null,
        bySecond: null,
        bySetPosition: null,
        count: null,
        until: null,
      }];
    } else if (event && event.recurrenceRules?.length) {
      data.recurrenceRules = null;
      if (event.recurrenceOverrides) data.recurrenceOverrides = null;
      if (event.excludedRecurrenceRules) data.excludedRecurrenceRules = null;
    }

    const builtAlerts: Record<string, CalendarEventAlert> = { ...preservedAlertsRef.current };
    let alertIdx = 0;
    for (const row of alertRows) {
      const offset = alertRowToOffset(row);
      if (offset === null) continue;
      let key = `alert${++alertIdx}`;
      while (key in builtAlerts) key = `alert${++alertIdx}`;
      builtAlerts[key] = {
        "@type": "Alert",
        trigger: { "@type": "OffsetTrigger", offset, relativeTo: "start" },
        action: "display",
        acknowledged: null,
        relatedTo: null,
      };
    }
    if (Object.keys(builtAlerts).length > 0) {
      data.alerts = builtAlerts;
    } else if (event && event.alerts && Object.keys(event.alerts).length > 0) {
      data.alerts = null;
    }

    if (effectiveAttendees.length > 0 && currentUserEmails.length > 0) {
      const organizerEmail = currentUserEmails[0];
      const organizerName = existingParticipants.find(p => p.isOrganizer)?.name || "";
      data.participants = buildParticipantMap(
        { name: organizerName, email: organizerEmail },
        effectiveAttendees
      ) as Record<string, CalendarParticipant>;
      // Stalwart (calcard) derives the iCalendar ORGANIZER property solely from
      // organizerCalendarAddress; without it no ORGANIZER is emitted and iTIP
      // scheduling is silently skipped (NoSchedulingInfo), so no invites are sent.
      // The RFC 8984 replyTo property is retired in jscalendarbis and ignored.
      data.organizerCalendarAddress = `mailto:${organizerEmail}`;
    } else if (effectiveAttendees.length === 0 && event?.participants) {
      data.participants = null;
      // Also clear the retired replyTo that older releases (<= 1.7.6) wrote.
      data.replyTo = null;
      data.organizerCalendarAddress = null;
    }

    const shouldSendScheduling = effectiveAttendees.length > 0 && sendInvitations;
    setIsSaving(true);
    try {
      await onSave(data, shouldSendScheduling);
    } finally {
      setIsSaving(false);
    }
  }, [title, description, location, virtualLocation, startDate, startTime, endDate, endTime, allDay, calendarId, recurrence, customRule, alertRows, attendees, sendInvitations, currentUserEmails, existingParticipants, event, onSave, isSaving]);

  const handleRsvp = useCallback((status: CalendarParticipant['participationStatus']) => {
    if (!event || !userParticipantId || !onRsvp) return;
    onRsvp(event.id, userParticipantId, status);
    onClose();
  }, [event, userParticipantId, onRsvp, onClose]);

  const handleDuplicate = useCallback(() => {
    if (!event || !onDuplicate) return;
    const start = getEventStartDate(event);
    const newStart = addDays(start, 1);
    const newUid = generateUUID();
    const data: Partial<CalendarEvent> = {
      uid: newUid,
      title: event.title,
      description: event.description,
      start: event.showWithoutTime ? format(newStart, "yyyy-MM-dd") : format(newStart, "yyyy-MM-dd'T'HH:mm:ss"),
      duration: event.duration,
      timeZone: event.timeZone,
      showWithoutTime: event.showWithoutTime,
      calendarIds: { ...event.calendarIds },
      status: "confirmed",
      freeBusyStatus: event.freeBusyStatus,
      privacy: event.privacy,
    };
    if (event.locations) data.locations = structuredClone(event.locations);
    if (event.virtualLocations) data.virtualLocations = structuredClone(event.virtualLocations);
    if (event.recurrenceRules) data.recurrenceRules = structuredClone(event.recurrenceRules);
    if (event.alerts) data.alerts = structuredClone(event.alerts);
    if (event.participants) data.participants = structuredClone(event.participants);
    onDuplicate(data);
  }, [event, onDuplicate]);

  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (mode === "edit" && isEdit) {
          setMode("view");
        } else {
          onClose();
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (!isAttendeeMode) handleSave();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, handleSave, isAttendeeMode, mode, isEdit]);

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    const focusableEls = modal.querySelectorAll<HTMLElement>(
      'input, select, textarea, button, [tabindex]:not([tabindex="-1"])'
    );
    const firstEl = focusableEls[0];
    const lastEl = focusableEls[focusableEls.length - 1];

    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl?.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl?.focus();
      }
    };
    modal.addEventListener("keydown", handler);
    firstEl?.focus();
    return () => modal.removeEventListener("keydown", handler);
  }, []);

  const hasParticipants = attendees.length > 0 || (event?.participants && Object.keys(event.participants).length > 0);

  if (isAttendeeMode && event) {
    const startD = getEventStartDate(event);
    const endD = getEventEndDate(event);
    const locationName = event.locations ? Object.values(event.locations)[0]?.name : null;
    const participants = getParticipantList(event);

    return (
      <div ref={modalRef} role="dialog" aria-modal={isMobile || undefined} aria-label={event.title || t("events.no_title")} className={isMobile ? "fixed inset-0 z-50 flex flex-col bg-background" : "flex flex-col h-full bg-background"}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
          <h2 className="text-lg font-semibold truncate">{event.title || t("events.no_title")}</h2>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-muted transition-colors duration-150 text-muted-foreground hover:text-foreground" aria-label={t("form.cancel")}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="px-6 py-4 space-y-3">
            <div className="flex items-start gap-3 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/50 px-4 py-3">
              <CalendarDays className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
              <div className="text-sm">
                <p className="font-medium text-blue-900 dark:text-blue-200">
                  {t("participants.invited_by", { name: organizerInfo?.name || organizerInfo?.email || t("participants.organizer") })}
                </p>
                <p className="text-blue-700 dark:text-blue-400 mt-0.5">
                  {t("participants.respond_below")}
                </p>
              </div>
            </div>

            {(() => {
              const displayEnd = getEventDisplayEndDate(event);
              const multiDay = !isSameDay(startD, displayEnd);
              if (multiDay && event.showWithoutTime) {
                return (
                  <div className="text-sm">
                    <div className="font-medium">{formatEventDate(startD)} –</div>
                    <div className="font-medium">{formatEventDate(displayEnd)}</div>
                  </div>
                );
              }
              if (multiDay) {
                return (
                  <div className="text-sm">
                    <div>
                      <span className="font-medium">{formatEventDate(startD)}</span>
                      <span className="text-muted-foreground ms-2">{format(startD, timeDisplayFmt)}</span>
                    </div>
                    <div>
                      <span className="font-medium">{formatEventDate(endD)}</span>
                      <span className="text-muted-foreground ms-2">{format(endD, timeDisplayFmt)}</span>
                    </div>
                  </div>
                );
              }
              return (
                <div className="text-sm">
                  <span className="font-medium">{formatEventDate(startD)}</span>
                  {!event.showWithoutTime && (
                    <span className="text-muted-foreground ms-2">
                      {format(startD, timeDisplayFmt)} – {format(endD, timeDisplayFmt)}
                    </span>
                  )}
                </div>
              );
            })()}

            {event.description && (
              <p className="text-sm text-muted-foreground">{event.description}</p>
            )}

            {locationName && (
              <p className="text-sm text-muted-foreground">{locationName}</p>
            )}

            {participants.length > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <Users className="w-4 h-4" />
                  {t("participants.title")}
                </div>
                <div className="space-y-1 ps-5">
                  {participants.map(p => (
                    <div key={p.id} className="flex items-center justify-between text-sm">
                      <span className="truncate">{p.name || p.email}</span>
                      <StatusBadge status={p.status} isOrganizer={p.isOrganizer} t={t} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-border flex-shrink-0">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t("participants.rsvp_label")}</span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={userCurrentStatus === "accepted" ? "default" : "outline"}
                onClick={() => handleRsvp("accepted")}
                className={userCurrentStatus === "accepted"
                  ? "bg-success hover:bg-success/80 text-success-foreground"
                  : "text-success border-success/30 hover:bg-success/10"}
              >
                {userCurrentStatus === "accepted" && <Check className="w-4 h-4 me-1" />}
                {t("participants.accepted")}
              </Button>
              <Button
                size="sm"
                variant={userCurrentStatus === "tentative" ? "default" : "outline"}
                onClick={() => handleRsvp("tentative")}
                className={userCurrentStatus === "tentative"
                  ? "bg-warning hover:bg-warning/80 text-warning-foreground"
                  : "border border-warning/30 text-warning hover:bg-warning/10"}
              >
                {userCurrentStatus === "tentative" && <Check className="w-4 h-4 me-1" />}
                {t("participants.tentative")}
              </Button>
              <Button
                size="sm"
                variant={userCurrentStatus === "declined" ? "default" : "ghost"}
                onClick={() => handleRsvp("declined")}
                className={userCurrentStatus === "declined"
                  ? "bg-destructive hover:bg-destructive/80 text-destructive-foreground"
                  : "text-destructive hover:bg-destructive/10"}
              >
                {userCurrentStatus === "declined" && <Check className="w-4 h-4 me-1" />}
                {t("participants.declined")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // View mode: read-only display of event details with Edit button
  if (mode === "view" && event) {
    const startD = getEventStartDate(event);
    const durMin = parseDuration(event.duration);
    const endD = getEventEndDate(event);
    const locationName = event.locations ? Object.values(event.locations)[0]?.name || null : null;
    const virtualLoc = event.virtualLocations ? Object.values(event.virtualLocations)[0]?.uri || null : null;
    const viewParticipants = getParticipantList(event);
    const recurrenceLabel = getRecurrenceLabel(event, t, locale);
    const alertLabel = getAlertLabel(event, t);
    const eventCalendar = calendars.find(c => event.calendarIds[c.id]);
    const color = getEventColor(event, eventCalendar);

    return (
      <div ref={modalRef} role="dialog" aria-modal={isMobile || undefined} aria-label={event.title || t("events.no_title")} className={isMobile ? "fixed inset-0 z-50 flex flex-col bg-background" : "flex flex-col h-full bg-background"}>
        {/* Color accent bar */}
        <div className="h-1 w-full flex-shrink-0" style={{ backgroundColor: color }} />

        {/* Header */}
        <div className="flex items-start justify-between gap-2 px-6 py-4 border-b border-border flex-shrink-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
              <h2 className="text-lg font-semibold truncate">{event.title || t("events.no_title")}</h2>
            </div>
            {eventCalendar && (
              <p className="text-xs text-muted-foreground mt-0.5 ps-[18px]">{eventCalendar.name}</p>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-muted transition-colors duration-150 flex-shrink-0 mt-0.5 text-muted-foreground hover:text-foreground" aria-label={t("form.cancel")}>
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-6 py-4 space-y-3">
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
                        <div className="font-medium text-foreground">{formatEventDate(startD)} –</div>
                        <div className="font-medium text-foreground">{formatEventDate(displayEnd)}</div>
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
                {/^https?:\/\//i.test(locationName) ? (
                  <a href={locationName} target="_blank" rel="noreferrer" className="text-sm text-primary hover:underline truncate" title={locationName}>
                    {(() => { try { return new URL(locationName).hostname; } catch { return locationName; } })()}
                  </a>
                ) : (
                  <span className="text-sm text-foreground">{locationName}</span>
                )}
              </div>
            )}

            {/* Virtual Location */}
            {virtualLoc && (
              <div className="flex items-start gap-2.5">
                <Video className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <a href={virtualLoc} target="_blank" rel="noreferrer" className="text-sm text-primary hover:underline truncate" title={virtualLoc}>
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
                        <span className="truncate text-foreground">
                          {p.name || p.email}
                          {p.isOrganizer && (
                            <span className="text-muted-foreground ms-1">({t("participants.organizer").toLowerCase()})</span>
                          )}
                        </span>
                        <StatusBadge status={p.status} isOrganizer={p.isOrganizer} t={t} />
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
            {event.description && (
              <div className="flex items-start gap-2.5">
                <AlignLeft className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                <p className="text-sm text-muted-foreground whitespace-pre-line">{event.description}</p>
              </div>
            )}
          </div>
        </div>

        {/* Action Bar */}
        <div className="px-6 py-3 border-t border-border flex-shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-1">
            {onDelete && (
              showDeleteConfirm ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-destructive">{t("form.delete_confirm")}</span>
                  <Button variant="outline" size="sm" onClick={() => { onDelete(event.id, hasParticipants || undefined); onClose(); }} className="text-destructive border-destructive/30">
                    {t("events.delete")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setShowDeleteConfirm(false)}>
                    {t("form.cancel")}
                  </Button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setShowDeleteConfirm(true)} className="text-destructive">
                  <Trash2 className="w-4 h-4 me-1" />
                  {t("events.delete")}
                </Button>
              )
            )}
            {onDuplicate && !showDeleteConfirm && (
              <Button variant="ghost" size="sm" onClick={handleDuplicate} aria-label={t("events.duplicate")}>
                <Copy className="w-4 h-4 me-1" />
                {t("events.duplicate")}
              </Button>
            )}
          </div>
          {!showDeleteConfirm && (
            <Button onClick={() => setMode("edit")}>
              <Pencil className="w-4 h-4 me-1" />
              {t("events.edit")}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={modalRef} role="dialog" aria-modal={isMobile || undefined} aria-label={isEdit ? t("events.edit") : t("events.create")} data-tour="event-modal" className={isMobile ? "fixed inset-0 z-50 flex flex-col bg-background" : "flex flex-col h-full bg-background"}>
      <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
        <h2 className="text-lg font-semibold">
          {isEdit ? t("events.edit") : t("events.create")}
        </h2>
        <button onClick={onClose} className="p-1.5 rounded-md hover:bg-muted transition-colors duration-150 text-muted-foreground hover:text-foreground" aria-label={t("form.cancel")}>
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="text-sm font-medium mb-1 block">{t("form.title")}</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("form.title")}
              maxLength={500}
              autoFocus
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">{t("form.description")}</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("form.description")}
              rows={3}
              maxLength={10000}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">{t("form.location")}</label>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={t("form.location")}
              maxLength={500}
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">
              <span className="flex items-center gap-1.5">
                <Video className="w-4 h-4" />
                {t("form.meeting_link")}
              </span>
            </label>
            <Input
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
                },
                setVirtualLocation,
              }}
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">
              <span className="flex items-center gap-1.5">
                <Users className="w-4 h-4" />
                {t("participants.title")}
              </span>
            </label>
            <ParticipantInput
              ref={participantInputRef}
              participants={attendees}
              onAdd={handleAddAttendee}
              onRemove={handleRemoveAttendee}
            />
            {isEdit && statusCounts && (existingParticipants.length > 0) && (
              <p className="text-xs text-muted-foreground mt-1.5">
                {t("participants.status_summary", {
                  accepted: statusCounts.accepted,
                  pending: statusCounts.tentative + statusCounts['needs-action'],
                })}
              </p>
            )}
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
              <label className="text-sm font-medium mb-1 block">{t("form.start_date")}</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {!allDay && (
              <div>
                <label className="text-sm font-medium mb-1 block">{t("form.start_time")}</label>
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            )}
            <div>
              <label className="text-sm font-medium mb-1 block">{t("form.end_date")}</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            {!allDay && (
              <div>
                <label className="text-sm font-medium mb-1 block">{t("form.end_time")}</label>
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            )}
          </div>

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
                        : 'text-sm rounded-md border border-yellow-500/50 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300 px-3 py-2'
                  }
                  title={w.message}
                >
                  {w.message}
                </div>
              ))}
            </div>
          )}

          {calendars.length > 1 && (
            <div>
              <label className="text-sm font-medium mb-1 block">{t("form.calendar_select")}</label>
              <select
                value={calendarId}
                onChange={(e) => setCalendarId(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {calendars.map((cal) => (
                  <option key={cal.id} value={cal.id}>
                    {cal.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="text-sm font-medium mb-1 block">{t("recurrence.title")}</label>
            <div className="flex items-center gap-2">
              <select
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
                className="flex-1 min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
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
                  return isNaN(d.getTime()) ? new Date() : d;
                })()}
                onSave={handleRecurrenceEditorSave}
                onCancel={handleRecurrenceEditorCancel}
              />
            )}
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">{t("alerts.title")}</label>
            {alertRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("alerts.none")}</p>
            ) : (
              <div className="space-y-2">
                {alertRows.map((row) => (
                  <div key={row.id} className="flex items-center gap-2">
                    {row.unit !== "at_time" && (
                      <Input
                        type="number"
                        min={1}
                        max={999}
                        value={row.value}
                        onChange={(e) => {
                          const n = parseInt(e.target.value, 10);
                          updateAlertRow(row.id, { value: Number.isFinite(n) ? Math.max(1, n) : 1 });
                        }}
                        className="w-20"
                        aria-label={t("alerts.amount")}
                      />
                    )}
                    <select
                      value={row.unit}
                      onChange={(e) => {
                        const unit = e.target.value as AlertUnit;
                        updateAlertRow(row.id, {
                          unit,
                          value: unit === "at_time" ? 0 : (row.value || 1),
                        });
                      }}
                      className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      aria-label={t("alerts.unit")}
                    >
                      <option value="at_time">{t("alerts.at_time")}</option>
                      <option value="minutes">{t("alerts.unit_minutes_before")}</option>
                      <option value="hours">{t("alerts.unit_hours_before")}</option>
                      <option value="days">{t("alerts.unit_days_before")}</option>
                      <option value="weeks">{t("alerts.unit_weeks_before")}</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => removeAlertRow(row.id)}
                      className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      aria-label={t("alerts.remove")}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={addAlertRow}
              className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              <Plus className="w-4 h-4" />
              {t("alerts.add")}
            </button>
          </div>

          {attendees.length > 0 && (
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
        </div>
      </div>

      <div className="flex items-center justify-between px-6 py-4 border-t border-border flex-shrink-0">
        <div className="flex items-center gap-1">
          {isEdit && onDelete && (
            showDeleteConfirm ? (
              <div className="flex items-center gap-2">
                <div>
                  <span className="text-sm text-red-600 dark:text-red-400">
                    {t("form.delete_confirm")}
                  </span>
                  {hasParticipants && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t("participants.cancel_notification")}
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { onDelete(event!.id, hasParticipants || undefined); onClose(); }}
                  className="text-red-600 dark:text-red-400 border-red-300 dark:border-red-700"
                >
                  {t("events.delete")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowDeleteConfirm(false)}>
                  {t("form.cancel")}
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowDeleteConfirm(true)}
                className="text-red-600 dark:text-red-400"
              >
                <Trash2 className="w-4 h-4 me-1" />
                {t("events.delete")}
              </Button>
            )
          )}
          {isEdit && onDuplicate && !showDeleteConfirm && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDuplicate}
              aria-label={t("events.duplicate")}
            >
              <Copy className="w-4 h-4 me-1" />
              {t("events.duplicate")}
            </Button>
          )}
        </div>

        <div className="flex gap-2">
          <Button variant="outline" onClick={isEdit ? () => setMode("view") : onClose}>
            {t("form.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!title.trim() || isSaving}>
            {t("form.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status, isOrganizer, t }: {
  status: CalendarParticipant['participationStatus'];
  isOrganizer: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  if (isOrganizer) {
    return <span className="text-xs text-primary">{t("participants.organizer")}</span>;
  }
  const colors: Record<string, string> = {
    accepted: "text-success",
    declined: "text-destructive",
    tentative: "text-warning",
    "needs-action": "text-muted-foreground",
  };
  const labels: Record<string, string> = {
    accepted: "participants.accepted",
    declined: "participants.declined",
    tentative: "participants.tentative",
    "needs-action": "participants.needs_action",
  };
  return <span className={`text-xs ${colors[status] || ""}`}>{t(labels[status] || labels["needs-action"])}</span>;
}
