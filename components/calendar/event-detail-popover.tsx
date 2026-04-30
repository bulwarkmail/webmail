"use client";

import { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from "react";
import { useTranslations } from "next-intl";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import {
  X, Clock, MapPin, Video, Users, Repeat, Bell, AlignLeft,
  Pencil, Trash2, Copy, Send, Check,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";
import type { CalendarEvent, Calendar, CalendarParticipant } from "@/lib/jmap/types";
import { parseDuration, getEventColor } from "./event-card";
import { getEventEndDate, getEventStartDate } from "@/lib/calendar-utils";
import {
  isOrganizer,
  getUserParticipantId,
  getUserStatus,
  getParticipantList,
} from "@/lib/calendar-participants";
import { useFormatEventDate } from "@/hooks/use-format-event-date";

interface EventDetailPopoverProps {
  event: CalendarEvent;
  calendar?: Calendar;
  anchorRect: DOMRect;
  onEdit: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onClose: () => void;
  onSaveNote: (note: string) => void;
  onRsvp?: (status: CalendarParticipant["participationStatus"]) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  currentUserEmails?: string[];
  timeFormat?: "12h" | "24h";
  isMobile?: boolean;
}

const POPOVER_WIDTH = 360;
const POPOVER_GAP = 8;
const VIEWPORT_MARGIN = 12;
const MAX_HEIGHT = 480;

function computePosition(
  anchorRect: DOMRect,
  popoverHeight: number
): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampedHeight = Math.min(popoverHeight, MAX_HEIGHT);

  const clampTop = (top: number) =>
    Math.min(Math.max(VIEWPORT_MARGIN, top), vh - clampedHeight - VIEWPORT_MARGIN);
  const clampLeft = (left: number) =>
    Math.min(Math.max(VIEWPORT_MARGIN, left), vw - POPOVER_WIDTH - VIEWPORT_MARGIN);

  const rightLeft = anchorRect.right + POPOVER_GAP;
  if (rightLeft + POPOVER_WIDTH + VIEWPORT_MARGIN <= vw) {
    return { top: clampTop(anchorRect.top), left: rightLeft };
  }

  const leftLeft = anchorRect.left - POPOVER_GAP - POPOVER_WIDTH;
  if (leftLeft >= VIEWPORT_MARGIN) {
    return { top: clampTop(anchorRect.top), left: leftLeft };
  }

  const belowTop = anchorRect.bottom + POPOVER_GAP;
  if (belowTop + clampedHeight + VIEWPORT_MARGIN <= vh) {
    return { top: belowTop, left: clampLeft(anchorRect.left) };
  }

  const aboveTop = anchorRect.top - POPOVER_GAP - clampedHeight;
  return {
    top: Math.max(VIEWPORT_MARGIN, aboveTop),
    left: clampLeft(anchorRect.left),
  };
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
  const first = Object.values(event.alerts)[0];
  if (!first || !first.trigger || first.trigger["@type"] !== "OffsetTrigger") return null;
  const offset = first.trigger.offset;
  if (offset === "PT0S") return t("alerts.at_time");
  const minMatch = offset.match(/-?PT?(\d+)M$/);
  if (minMatch) return t("alerts.minutes_before", { count: parseInt(minMatch[1]) });
  const hourMatch = offset.match(/-?PT?(\d+)H$/);
  if (hourMatch) return t("alerts.hours_before", { count: parseInt(hourMatch[1]) });
  const dayMatch = offset.match(/-?P(\d+)D/);
  if (dayMatch) return t("alerts.days_before", { count: parseInt(dayMatch[1]) });
  return null;
}

function getRecurrenceLabel(event: CalendarEvent, t: ReturnType<typeof useTranslations>): string | null {
  if (!event.recurrenceRules?.length) return null;
  const freq = event.recurrenceRules[0].frequency;
  const labels: Record<string, string> = {
    daily: t("recurrence.daily"),
    weekly: t("recurrence.weekly"),
    monthly: t("recurrence.monthly"),
    yearly: t("recurrence.yearly"),
  };
  return labels[freq] || null;
}

export function EventDetailPopover({
  event,
  calendar,
  anchorRect,
  onEdit,
  onDelete,
  onDuplicate,
  onClose,
  onSaveNote,
  onRsvp,
  onMouseEnter,
  onMouseLeave,
  currentUserEmails = [],
  timeFormat = "24h",
  isMobile,
}: EventDetailPopoverProps) {
  const t = useTranslations("calendar");
  const popoverRef = useRef<HTMLDivElement>(null);
  const noteInputRef = useRef<HTMLTextAreaElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteExpanded, setNoteExpanded] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isSavingNote, setIsSavingNote] = useState(false);

  const color = getEventColor(event, calendar);
  const startDate = getEventStartDate(event);
  const durationMinutes = parseDuration(event.duration);
  const endDate = getEventEndDate(event);

  const locationName = useMemo(() => {
    if (!event.locations) return null;
    return Object.values(event.locations)[0]?.name || null;
  }, [event.locations]);

  const virtualLocation = useMemo(() => {
    if (!event.virtualLocations) return null;
    const first = Object.values(event.virtualLocations)[0];
    return first?.uri || null;
  }, [event.virtualLocations]);

  const participants = useMemo(() => getParticipantList(event), [event]);
  const recurrenceLabel = useMemo(() => getRecurrenceLabel(event, t), [event, t]);
  const alertLabel = useMemo(() => getAlertLabel(event, t), [event, t]);

  const userIsOrganizer = useMemo(() => {
    if (!event.participants) return true;
    return isOrganizer(event, currentUserEmails);
  }, [event, currentUserEmails]);

  const isAttendeeMode = useMemo(() => {
    if (!event.participants) return false;
    return !event.isOrigin && !userIsOrganizer;
  }, [event, userIsOrganizer]);

  const userParticipantId = useMemo(
    () => getUserParticipantId(event, currentUserEmails),
    [event, currentUserEmails]
  );

  const userCurrentStatus = useMemo(
    () => getUserStatus(event, currentUserEmails),
    [event, currentUserEmails]
  );

  const formatTime = useCallback(
    (d: Date) => format(d, timeFormat === "12h" ? "h:mm a" : "HH:mm"),
    [timeFormat]
  );

  useLayoutEffect(() => {
    if (!popoverRef.current) return;
    const height = popoverRef.current.offsetHeight;
    setPosition(computePosition(anchorRect, height));
    if (!ready) requestAnimationFrame(() => setReady(true));
  }, [anchorRect, noteExpanded, showDeleteConfirm, ready]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      const target = e.target as HTMLElement;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (target?.getAttribute("contenteditable") === "true") return;
      if (e.key === "e" && !noteExpanded) {
        e.preventDefault();
        onEdit();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, onEdit, noteExpanded]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onClose]);

  const handleSaveNote = useCallback(async () => {
    const trimmed = noteText.trim();
    if (!trimmed) return;
    setIsSavingNote(true);
    try {
      onSaveNote(trimmed);
      setNoteText("");
      setNoteExpanded(false);
    } finally {
      setIsSavingNote(false);
    }
  }, [noteText, onSaveNote]);

  const handleNoteKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSaveNote();
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        setNoteText("");
        setNoteExpanded(false);
      }
    },
    [handleSaveNote]
  );

  const hasParticipants = participants.length > 0;

  const formatEventDate = useFormatEventDate();

  const popover = (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={event.title || t("events.no_title")}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={cn(
        "fixed z-[60] bg-background border border-border shadow-xl overflow-hidden transition-[opacity,transform] duration-150 ease-out",
        isMobile
          ? "inset-0 rounded-none flex flex-col"
          : "rounded-lg"
      )}
      style={isMobile ? {
        opacity: 1,
        transform: "none",
      } : {
        width: POPOVER_WIDTH,
        maxHeight: MAX_HEIGHT,
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        opacity: ready ? 1 : 0,
        transform: ready ? "scale(1)" : "scale(0.95)",
        visibility: position ? "visible" : "hidden",
      }}
    >
      {/* Color accent bar */}
      <div className="h-1 w-full" style={{ backgroundColor: color }} />

      {/* Header */}
      <div className="flex items-start justify-between gap-2 px-4 pt-3 pb-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: color }}
            />
            <h3 className="text-base font-semibold truncate text-foreground">
              {event.title || t("events.no_title")}
            </h3>
          </div>
          {calendar && (
            <p className="text-xs text-muted-foreground mt-0.5 pl-[18px]">
              {calendar.name}
              {event.status === "tentative" && (
                <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-warning/15 text-warning">
                  {t("detail.tentative")}
                </span>
              )}
              {event.status === "cancelled" && (
                <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400 line-through">
                  {t("detail.cancelled")}
                </span>
              )}
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-md hover:bg-muted transition-colors duration-150 flex-shrink-0 mt-0.5 text-muted-foreground hover:text-foreground"
          aria-label={t("form.cancel")}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      <div className={cn(
        "px-4 py-2 space-y-2.5 overflow-y-auto",
        isMobile ? "flex-1" : ""
      )} style={isMobile ? undefined : { maxHeight: MAX_HEIGHT - 140 }}>
        {/* Date & Time */}
        <div className="flex items-start gap-2.5">
          <Clock className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
          <div className="text-sm">
            <span className="font-medium text-foreground">
              {formatEventDate(startDate)}
            </span>
            {event.showWithoutTime ? (
              <span className="text-muted-foreground ml-1.5">{t("events.all_day")}</span>
            ) : (
              <div className="text-muted-foreground">
                {formatTime(startDate)} – {formatTime(endDate)}
                <span className="ml-1.5 text-xs">({formatDurationDisplay(durationMinutes)})</span>
              </div>
            )}
          </div>
        </div>

        {/* Location */}
        {locationName && (
          <div className="flex items-start gap-2.5">
            <MapPin className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            {/^https?:\/\//i.test(locationName) ? (
              <a
                href={locationName}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-primary hover:underline truncate"
                title={locationName}
              >
                {(() => {
                  try { return new URL(locationName).hostname; } catch { return locationName; }
                })()}
              </a>
            ) : (
              <span className="text-sm text-foreground">{locationName}</span>
            )}
          </div>
        )}

        {/* Virtual Location / Meeting Link */}
        {virtualLocation && (
          <div className="flex items-start gap-2.5">
            <Video className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <a
              href={virtualLocation}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-primary hover:underline truncate"
              title={virtualLocation}
            >
              {(() => {
                try {
                  return new URL(virtualLocation).hostname;
                } catch {
                  return virtualLocation;
                }
              })()}
            </a>
          </div>
        )}

        {/* Participants */}
        {hasParticipants && (
          <div className="flex items-start gap-2.5">
            <Users className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div className="text-sm min-w-0">
              <span className="text-muted-foreground">
                {t("participants.count", { count: participants.length })}
              </span>
              <div className="mt-1 space-y-0.5">
                {participants.slice(0, 5).map((p) => (
                  <div key={p.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate text-foreground">
                      {p.name || p.email}
                      {p.isOrganizer && (
                        <span className="text-muted-foreground ml-1">
                          ({t("participants.organizer").toLowerCase()})
                        </span>
                      )}
                    </span>
                    <ParticipantStatusBadge status={p.status} t={t} />
                  </div>
                ))}
                {participants.length > 5 && (
                  <span className="text-xs text-muted-foreground">
                    +{participants.length - 5}
                  </span>
                )}
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
            <p className="text-sm text-muted-foreground whitespace-pre-line line-clamp-3">
              {event.description}
            </p>
          </div>
        )}
      </div>

      {/* Quick Note */}
      {!isAttendeeMode && (
        <div className="px-4 py-2 border-t border-border">
          {noteExpanded ? (
            <div className="space-y-2">
              <textarea
                ref={noteInputRef}
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={handleNoteKeyDown}
                placeholder={t("detail.add_note")}
                rows={2}
                autoFocus
                className="w-full rounded-md border border-input bg-muted/30 px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="flex justify-end gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setNoteText("");
                    setNoteExpanded(false);
                  }}
                  className="h-7 text-xs"
                >
                  {t("form.cancel")}
                </Button>
                <Button
                  size="sm"
                  onClick={handleSaveNote}
                  disabled={!noteText.trim() || isSavingNote}
                  className="h-7 text-xs"
                >
                  <Send className="w-3 h-3 mr-1" />
                  {t("detail.save_note")}
                </Button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setNoteExpanded(true)}
              className="flex items-center gap-2 w-full text-sm text-muted-foreground hover:text-foreground transition-colors py-1"
            >
              <AlignLeft className="w-4 h-4" />
              {t("detail.add_note")}
            </button>
          )}
        </div>
      )}

      {/* RSVP Bar (for attendees) */}
      {isAttendeeMode && onRsvp && userParticipantId && (
        <div className="px-4 py-3 border-t border-border">
          <p className="text-xs font-medium text-muted-foreground mb-2">
            {t("participants.rsvp_label")}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={userCurrentStatus === "accepted" ? "default" : "outline"}
              onClick={() => onRsvp("accepted")}
              className={
                userCurrentStatus === "accepted"
                  ? "bg-success hover:bg-success/80 text-success-foreground"
                  : "text-success border-success/30 hover:bg-success/10"
              }
            >
              {userCurrentStatus === "accepted" && <Check className="w-3.5 h-3.5 mr-1" />}
              {t("participants.accepted")}
            </Button>
            <Button
              size="sm"
              variant={userCurrentStatus === "tentative" ? "default" : "outline"}
              onClick={() => onRsvp("tentative")}
              className={
                userCurrentStatus === "tentative"
                  ? "bg-warning hover:bg-warning/80 text-warning-foreground"
                  : "border border-warning/30 text-warning hover:bg-warning/10"
              }
            >
              {userCurrentStatus === "tentative" && <Check className="w-3.5 h-3.5 mr-1" />}
              {t("participants.tentative")}
            </Button>
            <Button
              size="sm"
              variant={userCurrentStatus === "declined" ? "default" : "ghost"}
              onClick={() => onRsvp("declined")}
              className={
                userCurrentStatus === "declined"
                  ? "bg-destructive hover:bg-destructive/80 text-destructive-foreground"
                  : "text-destructive hover:bg-destructive/10"
              }
            >
              {userCurrentStatus === "declined" && <Check className="w-3.5 h-3.5 mr-1" />}
              {t("participants.declined")}
            </Button>
          </div>
        </div>
      )}

      {/* Action Bar */}
      <div className="px-4 py-2.5 border-t border-border flex items-center gap-1.5">
        {showDeleteConfirm ? (
          <div className="flex items-center gap-2 w-full">
            <span className="text-sm text-destructive flex-1">
              {t("form.delete_confirm")}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={onDelete}
              className="text-red-600 dark:text-red-400 border-red-300 dark:border-red-700 h-7 text-xs"
            >
              {t("events.delete")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowDeleteConfirm(false)}
              className="h-7 text-xs"
            >
              {t("form.cancel")}
            </Button>
          </div>
        ) : (
          <>
            <Button variant="default" size="sm" onClick={onEdit} className="h-7 text-xs">
              <Pencil className="w-3.5 h-3.5 mr-1" />
              {t("events.edit")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onDuplicate}
              className="h-7 text-xs"
              title={t("events.duplicate")}
            >
              <Copy className="w-3.5 h-3.5 mr-1" />
              {t("events.duplicate")}
            </Button>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowDeleteConfirm(true)}
              className="h-7 text-xs text-red-600 dark:text-red-400"
              title={t("events.delete")}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </>
        )}
      </div>
    </div>
  );

  return createPortal(popover, document.body);
}

function ParticipantStatusBadge({
  status,
  t,
}: {
  status: CalendarParticipant["participationStatus"];
  t: ReturnType<typeof useTranslations>;
}) {
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
  return (
    <span className={`text-[10px] flex-shrink-0 ${colors[status] || ""}`}>
      {t(labels[status] || labels["needs-action"])}
    </span>
  );
}
