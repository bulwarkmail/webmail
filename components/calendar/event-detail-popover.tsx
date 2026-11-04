"use client";

import { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from "react";
import { useTranslations, useLocale } from "next-intl";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { LinkifiedText } from "@/components/ui/linkified-text";
import {
  X, Clock, MapPin, Video, Users, Repeat, Bell, AlignLeft,
  Pencil, Trash2, Copy, CopyPlus, Send, Check, MoreVertical, Printer, Calendar as CalendarIcon,
} from "@/components/icons";
import { format, isSameDay } from "date-fns";
import { cn } from "@/lib/utils";
import type { CalendarEvent, Calendar, CalendarParticipant } from "@/lib/jmap/types";
import { parseDuration, getEventColor } from "./event-card";
import { getEventDisplayEndDate, getEventEndDate, getEventStartDate } from "@/lib/calendar-utils";
import { buildRecurrenceSummary } from "./recurrence-editor";
import { formatEventAlertsLabel } from "./alert-list-editor";
import {
  getUserParticipantId,
  getParticipantList,
} from "@/lib/calendar-participants";
import { canUserRsvp, getEventEditability, type EditabilityContext } from "@/lib/calendar-editability";
import { useFormatEventDate } from "@/hooks/use-format-event-date";
import { useContactNameResolver } from "@/hooks/use-contact-name-resolver";
import { findMeetingLink, locationAction, mapsUrl, primaryLocationName } from "@/lib/event-links";
import { descriptionAsText } from "@/lib/calendar-description";
import { useNoThirdPartyTraffic } from "@/hooks/use-third-party-mode";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import { eventToView } from "@/lib/plugin-projection";
import { ParticipantStatusBadge } from "./rsvp-buttons";
import { AnswerBars, useAnswerView } from "./answer-bars";
import type { AnswerTarget } from "@/lib/calendar-delegate";
import { isEditableEventTarget } from "@/lib/keyboard";
import { isSingleKeyShortcutOff } from "@/lib/single-key-shortcuts";
import { useCvdColor } from "@/hooks/use-cvd-color";
import { gateLinkClick } from "@/lib/plugin-hook-result";
import { useCollectionNames } from "@/hooks/use-collection-names";

interface EventDetailPopoverProps {
  event: CalendarEvent;
  calendar?: Calendar;
  anchorRect: DOMRect;
  onEdit: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  /** Opens the event's full action menu (export, copy, ...) at the click. */
  onMore?: (e: React.MouseEvent) => void;
  /** Prints the event on a sheet of its own. */
  onPrint?: () => void;
  onClose: () => void;
  onSaveNote: (note: string) => void;
  /** Without a target: the user's own answer on this event. */
  onRsvp?: (status: CalendarParticipant["participationStatus"], target?: AnswerTarget) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  currentUserEmails?: string[];
  isSubscriptionCalendar?: (calendarId: string) => boolean;
  timeFormat?: "12h" | "24h";
  isMobile?: boolean;
  /**
   * Opened by a click or Enter rather than shown on hover: it takes the
   * focus, and gives it back to the event when it closes.
   */
  pinned?: boolean;
}

const POPOVER_WIDTH = 360;
const HEADER_BUTTON = "text-muted-foreground hover:text-foreground";
const POPOVER_GAP = 8;
const VIEWPORT_MARGIN = 12;
const MAX_HEIGHT = 480;

/** As tall as MAX_HEIGHT, but never taller than the window. */
function maxPopoverHeight(): number {
  return Math.max(0, Math.min(MAX_HEIGHT, window.innerHeight - 2 * VIEWPORT_MARGIN));
}

function computePosition(
  anchorRect: DOMRect,
  popoverHeight: number
): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampedHeight = Math.min(popoverHeight, maxPopoverHeight());

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

function getRecurrenceLabel(event: CalendarEvent, t: ReturnType<typeof useTranslations>, locale: string): string | null {
  if (!event.recurrenceRules?.length) return null;
  return buildRecurrenceSummary(event.recurrenceRules[0], t, locale);
}

export function EventDetailPopover({
  event,
  calendar,
  anchorRect,
  onEdit,
  onDelete,
  onDuplicate,
  onMore,
  onPrint,
  onClose,
  onSaveNote,
  onRsvp,
  onMouseEnter,
  onMouseLeave,
  currentUserEmails = [],
  isSubscriptionCalendar,
  timeFormat = "24h",
  isMobile,
  pinned = false,
}: EventDetailPopoverProps) {
  const shownName = useCollectionNames();
  const t = useTranslations("calendar");
  const paint = useCvdColor();
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const popoverRef = useRef<HTMLDivElement>(null);
  const noteInputRef = useRef<HTMLTextAreaElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [noteExpanded, setNoteExpanded] = useState(false);
  const [isSavingNote, setIsSavingNote] = useState(false);

  // Bare addresses (the organizer above all — Stalwart drops its display name)
  // render with the contact card's name instead of the raw email.
  const resolveContactName = useContactNameResolver();

  const color = paint(getEventColor(event, calendar));
  const startDate = getEventStartDate(event);
  const durationMinutes = parseDuration(event.duration);
  const endDate = getEventEndDate(event);
  const displayEndDate = getEventDisplayEndDate(event);
  const isMultiDay = !isSameDay(startDate, displayEndDate);

  const locationName = useMemo(() => primaryLocationName(event) ?? null, [event]);
  // Re-computes the location link once the config is known (#903).
  const noThirdParty = useNoThirdPartyTraffic();

  // Invitations (Teams above all) leave virtualLocations empty and bury the
  // join URL in the description; surface it as the meeting link anyway.
  const meeting = useMemo(() => findMeetingLink(event), [event]);
  const pluginProps = useMemo(() => ({ event: eventToView(event) }), [event]);
  const description = useMemo(() => descriptionAsText(event), [event]);
  const virtualLocation = meeting?.uri ?? null;

  // A URL opens as a link, a location that only names the service joins the
  // meeting, a postal address opens in the maps.
  const locationHref = useMemo(() => {
    if (!locationName) return null;
    const action = locationAction(locationName, meeting);
    if (action.kind === "url") return action.uri;
    // No Google Maps link while third-party traffic is off (#903).
    return noThirdParty ? null : mapsUrl(action.query);
  }, [locationName, meeting, noThirdParty]);
  const [locationCopied, setLocationCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);
  const copyLocation = useCallback(async () => {
    if (!locationName) return;
    try {
      await navigator.clipboard.writeText(locationName);
      setLocationCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setLocationCopied(false), 1500);
    } catch {
      // clipboard refused (insecure context or permission) - nothing to do
    }
  }, [locationName]);

  const participants = useMemo(
    () => getParticipantList(event, { resolveName: resolveContactName }),
    [event, resolveContactName]
  );
  const recurrenceLabel = useMemo(() => getRecurrenceLabel(event, t, locale), [event, t, locale]);
  const alertLabel = useMemo(() => formatEventAlertsLabel(event, calendar ? [calendar] : [], t), [event, calendar, t]);

  // Gate affordances on calendar rights, not identity (see calendar-editability).
  const editabilityCtx = useMemo<EditabilityContext>(() => {
    const calendarsById = new Map(calendar ? [[calendar.id, calendar]] : []);
    return {
      calendarsById,
      userCalendarAddresses: currentUserEmails,
      isSubscriptionCalendar: isSubscriptionCalendar ?? (() => false),
    };
  }, [calendar, currentUserEmails, isSubscriptionCalendar]);

  const editability = useMemo(
    () => getEventEditability(event, editabilityCtx),
    [event, editabilityCtx]
  );
  const canEditBody = editability === "editable";

  // Asked separately from editability: a received invite lands in the user's own
  // calendar and resolves to 'editable', which renders no RSVP bar (#937).
  const canRsvp = useMemo(
    () => canUserRsvp(event, editabilityCtx),
    [event, editabilityCtx]
  );

  const userParticipantId = useMemo(
    () => getUserParticipantId(event, currentUserEmails),
    [event, currentUserEmails]
  );

  const answerView = useAnswerView(event, calendar, currentUserEmails, canRsvp && !!userParticipantId);

  const formatTime = useCallback(
    (d: Date) => format(d, timeFormat === "12h" ? "h:mm a" : "HH:mm"),
    [timeFormat]
  );

  useLayoutEffect(() => {
    if (!popoverRef.current) return;
    const height = popoverRef.current.offsetHeight;
    setPosition(computePosition(anchorRect, height));
    if (!ready) requestAnimationFrame(() => setReady(true));
  }, [anchorRect, noteExpanded, ready]);

  // Content that grows after the popover was placed (a plugin section reports
  // its height a moment later) moves it again, so it stays in the window.
  useEffect(() => {
    const node = popoverRef.current;
    if (!node || isMobile || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const next = computePosition(anchorRect, node.offsetHeight);
      setPosition((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [anchorRect, isMobile]);

  // A card opened by click or Enter takes the focus, and gives it back to
  // the event when it closes.
  useEffect(() => {
    if (!pinned) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = popoverRef.current;
    return () => {
      const active = document.activeElement;
      if (opener?.isConnected && (!active || active === document.body || node?.contains(active))) opener.focus({ preventScroll: true });
    };
  }, [pinned]);

  // The focus goes in once the card is placed: before, it is hidden and
  // can't take the focus, which stayed on the event. A card that just
  // turned visible can still count as hidden for a frame, so it tries again
  // on the next ones, unless the focus moved somewhere else meanwhile.
  const placed = position !== null;
  useEffect(() => {
    const node = popoverRef.current;
    if (!pinned || !placed || !node) return;
    const from = document.activeElement;
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const active = document.activeElement;
      if (node.contains(active) || active !== from) return;
      const first = node.querySelector<HTMLElement>("button");
      first?.focus({ preventScroll: true });
      if (first && document.activeElement !== first && ++tries < 30) frame = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [pinned, placed]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (isEditableEventTarget(e)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (isSingleKeyShortcutOff(e)) return;
      if (e.code === "KeyE" && !noteExpanded && canEditBody) {
        e.preventDefault();
        onEdit();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, onEdit, noteExpanded, canEditBody]);

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
          : "rounded-lg flex flex-col"
      )}
      style={isMobile ? {
        opacity: 1,
        transform: "none",
      } : {
        width: POPOVER_WIDTH,
        maxHeight: maxPopoverHeight(),
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        opacity: ready ? 1 : 0,
        transform: ready ? "scale(1)" : "scale(0.95)",
        visibility: position ? "visible" : "hidden",
      }}
    >
      {/* Actions sit at the top, the event's colour square beside its title. */}
      <div className="flex items-center justify-end gap-0.5 px-2 pt-2">
        {canEditBody && (
          <IconButton
            onClick={onEdit}
            className={HEADER_BUTTON}
            label={t("events.edit")}
          >
            <Pencil className="w-4 h-4" />
          </IconButton>
        )}
        {canEditBody && (
          <IconButton
            onClick={onDelete}
            className={HEADER_BUTTON}
            label={t("events.delete")}
          >
            <Trash2 className="w-4 h-4" />
          </IconButton>
        )}
        {onPrint && (
          <IconButton
            onClick={onPrint}
            className={HEADER_BUTTON}
            label={tCommon("print")}
          >
            <Printer className="w-4 h-4" />
          </IconButton>
        )}
        <IconButton
          onClick={onMore ?? onDuplicate}
          className={HEADER_BUTTON}
          label={onMore ? t("toolbar.more") : t("events.duplicate")}
        >
          {onMore ? <MoreVertical className="w-4 h-4" /> : <CopyPlus className="w-4 h-4" />}
        </IconButton>
        <IconButton
          onClick={onClose}
          className={HEADER_BUTTON}
          label={tCommon("close")}
        >
          <X className="w-4 h-4" />
        </IconButton>
      </div>

      <div className="flex items-start gap-2.5 px-4 pb-1">
        <span
          className="w-4 h-4 rounded-sm flex-shrink-0 mt-1"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <h3 className={cn(
            "text-lg font-semibold leading-snug break-words text-foreground",
            event.status === "cancelled" && "line-through text-muted-foreground"
          )}>
            {/* Its own direction, next to the colour square. */}
            <bdi>{event.title || t("events.no_title")}</bdi>
          </h3>
          {event.status === "tentative" && (
            <span className="mt-1 inline-flex items-center px-1.5 py-0.5 rounded text-[0.625rem] font-medium bg-warning/15 text-amber-600 dark:text-amber-400">
              {t("detail.tentative")}
            </span>
          )}
          {event.status === "cancelled" && (
            <span className="mt-1 inline-flex items-center px-1.5 py-0.5 rounded text-[0.625rem] font-medium bg-destructive/10 text-red-600 dark:text-red-400 line-through">
              {t("detail.cancelled")}
            </span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className={cn(
        "px-4 py-2 space-y-2.5 overflow-y-auto",
        isMobile ? "flex-1" : "min-h-0"
      )} style={isMobile ? undefined : { maxHeight: MAX_HEIGHT - 140 }}>
        {/* Date & Time */}
        <div className="flex items-start gap-2.5">
          <Clock className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
          <div className="text-sm">
            {isMultiDay ? (
              event.showWithoutTime ? (
                <>
                  <div className="font-medium text-foreground">
                    {formatEventDate(startDate)} –
                  </div>
                  <div className="font-medium text-foreground">
                    {formatEventDate(displayEndDate)}
                  </div>
                  <div className="text-muted-foreground">{t("events.all_day")}</div>
                </>
              ) : (
                <>
                  <div className="font-medium text-foreground">
                    {formatEventDate(startDate)}
                    <span className="ms-1.5 font-normal text-muted-foreground">
                      {formatTime(startDate)}
                    </span>
                  </div>
                  <div className="font-medium text-foreground">
                    {formatEventDate(endDate)}
                    <span className="ms-1.5 font-normal text-muted-foreground">
                      {formatTime(endDate)}
                    </span>
                  </div>
                  <div className="text-muted-foreground text-xs">
                    ({formatDurationDisplay(durationMinutes)})
                  </div>
                </>
              )
            ) : (
              <>
                <span className="font-medium text-foreground">
                  {formatEventDate(startDate)}
                </span>
                {event.showWithoutTime ? (
                  <span className="text-muted-foreground ms-1.5">{t("events.all_day")}</span>
                ) : (
                  <div className="text-muted-foreground">
                    <bdi dir="ltr">{formatTime(startDate)} – {formatTime(endDate)}</bdi>
                    <span className="ms-1.5 text-xs">({formatDurationDisplay(durationMinutes)})</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Location */}
        {locationName && (
          <div className="flex items-start gap-2.5">
            <MapPin className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <a
              href={locationHref ?? undefined}
              target="_blank"
              rel="noreferrer"
              onClick={gateLinkClick}
              onAuxClick={gateLinkClick}
              className={cn("text-sm min-w-0 break-words", locationHref ? "text-primary hover:underline" : "text-foreground")}
              dir="auto"
              title={locationName}
            >
              {/^https?:\/\//i.test(locationName)
                ? (() => {
                  try { return new URL(locationName).hostname; } catch { return locationName; }
                })()
                : locationName}
            </a>
            <button
              type="button"
              onClick={copyLocation}
              className="ms-auto p-0.5 text-muted-foreground hover:text-foreground flex-shrink-0"
              title={t("detail.copy_location")}
              aria-label={t("detail.copy_location")}
            >
              {locationCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
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
              onClick={gateLinkClick}
              onAuxClick={gateLinkClick}
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
                    <span dir="auto" className="truncate text-foreground" title={p.email}>
                      {p.name || p.email}
                      {p.isOrganizer && (
                        <span className="text-muted-foreground ms-1">
                          ({t("participants.organizer_role")})
                        </span>
                      )}
                    </span>
                    <ParticipantStatusBadge status={p.status} className="text-[0.625rem]" />
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

        {/* Calendar */}
        {calendar && (
          <div className="flex items-start gap-2.5">
            <CalendarIcon className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <span dir="auto" className="text-sm text-foreground truncate" title={shownName.calendar(calendar)}>{shownName.calendar(calendar)}</span>
          </div>
        )}

        {/* Description */}
        {description && (
          <div className="flex items-start gap-2.5">
            <AlignLeft className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <p dir="auto" className="text-sm text-muted-foreground whitespace-pre-line line-clamp-3 break-words">
              <LinkifiedText text={description} />
            </p>
          </div>
        )}

        <PluginSlot name="calendar-event-detail" className="w-full" extraProps={pluginProps} />
      </div>

      {/* Quick Note */}
      {canEditBody && (
        <div className="px-4 py-2 border-t border-border">
          {noteExpanded ? (
            <div className="space-y-2">
              <textarea
                aria-label={t("detail.add_note")}
                ref={noteInputRef}
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                onKeyDown={handleNoteKeyDown}
                placeholder={t("detail.add_note")}
                rows={2}
                autoFocus
                className="w-full rounded-md border border-input bg-muted/30 px-3 py-2 text-sm resize-none focus:outline-hidden"
              />
              <div className="flex justify-end gap-1.5">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setNoteText("");
                    setNoteExpanded(false);
                  }}
                >
                  {t("form.cancel")}
                </Button>
                <Button
                  size="xs"
                  onClick={handleSaveNote}
                  disabled={!noteText.trim() || isSavingNote}
                >
                  <Send className="w-3 h-3 me-1" />
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

      {/* RSVP bars: the user's own, and "Answer for <owner>" in a calendar shared with them. */}
      {onRsvp && (
        <AnswerBars
          view={answerView}
          size="xs"
          className="px-4 py-3 border-t border-border empty:hidden"
          onRespond={(target, status) => onRsvp(status, target)}
        />
      )}

    </div>
  );

  return createPortal(popover, document.body);
}
