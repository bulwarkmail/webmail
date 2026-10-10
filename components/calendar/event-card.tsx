"use client";

import { useCallback, useState, type CSSProperties, type DragEvent } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { CalendarEvent, Calendar } from "@/lib/jmap/types";
import { format } from "date-fns";
import { Users } from "@/components/icons";
import { getParticipantCount, isDeclinedByUser } from "@/lib/calendar-participants";
import { getEventEndDate, getEventStartDate } from "@/lib/calendar-utils";
import { useSettingsStore } from "@/stores/settings-store";
import { readableTextOn } from "@/lib/color-transform";

interface EventCardProps {
  event: CalendarEvent;
  calendar?: Calendar;
  variant: "chip" | "block" | "span";
  onClick?: (anchorRect: DOMRect) => void;
  onMouseEnter?: (anchorRect: DOMRect) => void;
  onMouseLeave?: () => void;
  onContextMenu?: (e: React.MouseEvent, event: CalendarEvent) => void;
  isSelected?: boolean;
  draggable?: boolean;
  continuesBefore?: boolean;
  continuesAfter?: boolean;
  className?: string;
  style?: CSSProperties;
  /** The user's calendar addresses, to tell whether they declined the event. */
  currentUserEmails?: string[];
}

function sanitizeColor(color: string | null | undefined, fallback = "#3b82f6"): string {
  if (!color) return fallback;
  if (/^#[0-9a-fA-F]{3,8}$/.test(color)) return color;
  if (/^(rgb|hsl)a?\([\d\s,.%/]+\)$/.test(color)) return color;
  return fallback;
}

function getEventColor(event: CalendarEvent, calendar?: Calendar): string {
  // A local color override on a shared calendar wins over per-event colors,
  // so the whole shared calendar paints uniformly in the viewer's chosen hue.
  if (calendar?.colorIsLocalOverride && calendar.color) {
    return sanitizeColor(calendar.color);
  }
  return sanitizeColor(event.color, sanitizeColor(calendar?.color));
}

// Events are solid blocks of their calendar colour; declined and cancelled
// ones drop the fill and keep a 1px border in it (repos/branding/APP.md).
// Everything is drawn with box-shadow, so the selection ring joins the list
// here and the browser's focus outline stays free.
function eventFillStyle(
  color: string,
  { inactive, separated, selected }: { inactive: boolean; separated?: boolean; selected?: boolean },
): CSSProperties {
  const shadows: string[] = [];
  if (selected) shadows.push("0 0 0 2px var(--color-primary)");
  else if (separated) shadows.push("0 0 0 1px var(--color-background)");
  if (inactive) shadows.push(`inset 0 0 0 1px ${color}`);
  const fill: CSSProperties = inactive
    ? { backgroundColor: "var(--color-background)", color: `color-mix(in srgb, ${color} 55%, var(--color-foreground))` }
    : { backgroundColor: color, color: readableTextOn(color) };
  return shadows.length > 0 ? { ...fill, boxShadow: shadows.join(", ") } : fill;
}

function parseDuration(duration: string | undefined): number {
  if (!duration) return 0;
  let totalMinutes = 0;
  const weekMatch = duration.match(/(\d+)W/);
  const hourMatch = duration.match(/(\d+)H/);
  const minMatch = duration.match(/(\d+)M/);
  const dayMatch = duration.match(/(\d+)D/);
  if (weekMatch) totalMinutes += parseInt(weekMatch[1]) * 7 * 24 * 60;
  if (dayMatch) totalMinutes += parseInt(dayMatch[1]) * 24 * 60;
  if (hourMatch) totalMinutes += parseInt(hourMatch[1]) * 60;
  if (minMatch) totalMinutes += parseInt(minMatch[1]);
  return totalMinutes;
}

function createEventDragPreview(title: string, timeRange: string, color: string): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = `
    position: fixed; top: -9999px; left: 0;
    padding: 6px 12px; border-radius: 2px;
    background: ${color}; color: ${readableTextOn(color)};
    font-size: 12px; font-weight: 500;
    max-width: 240px; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; pointer-events: none; z-index: 9999;
  `;
  el.textContent = `${title} \u2022 ${timeRange}`;
  document.body.appendChild(el);
  return el;
}

export function EventCard({ event, calendar, variant, onClick, onMouseEnter, onMouseLeave, onContextMenu, isSelected, draggable: isDraggable, continuesBefore = false, continuesAfter = false, className, style, currentUserEmails }: EventCardProps) {
  const t = useTranslations("calendar");
  const [isBeingDragged, setIsBeingDragged] = useState(false);
  const color = getEventColor(event, calendar);
  const startDate = getEventStartDate(event);
  const timeFormat = useSettingsStore((state) => state.timeFormat);
  const showTimeInMonthView = useSettingsStore((state) => state.showTimeInMonthView);
  const timeFmt = timeFormat === "12h" ? "h:mm a" : "HH:mm";

  const calendarName = calendar?.name || "";
  const durationMinutes = parseDuration(event.duration);
  const endTime = getEventEndDate(event);
  const safeFormat = (d: Date, fmt: string) => {
    if (isNaN(d.getTime())) return "--:--";
    try { return format(d, fmt); } catch { return "--:--"; }
  };
  const timeString = `${safeFormat(startDate, timeFmt)} – ${safeFormat(endTime, timeFmt)}`;
  // iTIP CANCEL marks the attendee's copy with status "cancelled" instead of
  // deleting it (#572), and a declined invitation stays on the calendar too
  // (#1110) - render both struck through and dimmed.
  const isCancelled = event.status === "cancelled";
  const isDeclined = !isCancelled && isDeclinedByUser(event, currentUserEmails);
  const isInactive = isCancelled || isDeclined;
  const statusLabel = isCancelled ? t("detail.cancelled") : isDeclined ? t("participants.declined") : null;
  const ariaLabel = `${event.title || t("events.no_title")}, ${timeString}${calendarName ? `, ${calendarName}` : ""}${statusLabel ? `, ${statusLabel}` : ""}`;

  const handleDragStart = useCallback((e: DragEvent) => {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-calendar-event", JSON.stringify({
      type: "calendar-event",
      eventId: event.id,
      originalStart: event.start,
      duration: event.duration,
      durationMinutes,
    }));
    const displayTitle = event.title || t("events.no_title");
    e.dataTransfer.setData("text/plain", displayTitle);
    const preview = createEventDragPreview(displayTitle, timeString, color);
    e.dataTransfer.setDragImage(preview, 0, 0);
    requestAnimationFrame(() => preview.remove());
    setIsBeingDragged(true);
  }, [event, color, t, durationMinutes, timeString]);

  const handleDragEnd = useCallback(() => {
    setIsBeingDragged(false);
  }, []);

  const dragProps = isDraggable ? {
    draggable: true as const,
    onDragStart: handleDragStart,
    onDragEnd: handleDragEnd,
    "aria-roledescription": "draggable event",
  } : {};

  const handleContextMenu = onContextMenu ? (e: React.MouseEvent) => onContextMenu(e, event) : undefined;

  if (variant === "chip") {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onClick?.(e.currentTarget.getBoundingClientRect()); }}
        onMouseEnter={(e) => onMouseEnter?.(e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => onMouseLeave?.()}
        onContextMenu={handleContextMenu}
        aria-label={ariaLabel}
        {...dragProps}
        className={cn(
          "flex items-center w-full text-start text-xs font-medium px-1.5 py-0.5 rounded-xs truncate",
          "min-h-[44px] sm:min-h-0",
          "hover:opacity-90 transition-opacity",
          isBeingDragged && "opacity-50",
          className
        )}
        style={{ ...eventFillStyle(color, { inactive: isInactive, selected: isSelected }), ...style }}
      >
        <span className={cn("truncate", isInactive && "line-through")}>{event.title || t("events.no_title")}</span>
      </button>
    );
  }

  if (variant === "span") {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onClick?.(e.currentTarget.getBoundingClientRect()); }}
        onMouseEnter={(e) => onMouseEnter?.(e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => onMouseLeave?.()}
        onContextMenu={handleContextMenu}
        aria-label={ariaLabel}
        {...dragProps}
        className={cn(
          "w-full h-full text-start rounded-xs px-1.5 py-0.5 text-xs overflow-hidden",
          "hover:opacity-90 transition-opacity cursor-pointer",
          continuesBefore && "rounded-s-none",
          continuesAfter && "rounded-e-none pe-2",
          isBeingDragged && "opacity-50",
          className
        )}
        style={{ ...eventFillStyle(color, { inactive: isInactive, selected: isSelected }), ...style }}
      >
        <div className="flex items-center gap-1 min-w-0">
          {showTimeInMonthView && !event.showWithoutTime && (
            <span className="flex-shrink-0 font-normal opacity-85">{format(startDate, timeFmt)}</span>
          )}
          <span className={cn("truncate font-medium", isInactive && "line-through")}>{event.title || t("events.no_title")}</span>
        </div>
      </button>
    );
  }

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick?.(e.currentTarget.getBoundingClientRect()); }}
      onMouseEnter={(e) => onMouseEnter?.(e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => onMouseLeave?.()}
      onContextMenu={handleContextMenu}
      aria-label={ariaLabel}
      {...dragProps}
      data-calendar-event
      className={cn(
        "w-full h-full text-start rounded-xs px-1.5 py-0.5 text-xs overflow-hidden",
        "hover:opacity-90 transition-opacity cursor-pointer",
        isBeingDragged && "opacity-50",
        className
      )}
      style={{ ...eventFillStyle(color, { inactive: isInactive, separated: true, selected: isSelected }), ...style }}
    >
      {/* Shorter blocks have no room for a second line at the 60px hour, so
          their start time follows the title on the same line, when the
          block is wide enough to keep the title readable. */}
      <div className="@container">
        <div className="flex items-baseline gap-1 min-w-0">
          <span className={cn("font-medium truncate", isInactive && "line-through")}>{event.title || t("events.no_title")}</span>
          {!event.showWithoutTime && durationMinutes < 45 && (
            <span className="hidden @min-[120px]:inline flex-shrink-0 opacity-85 text-[10.5px]">{safeFormat(startDate, timeFmt)}</span>
          )}
        </div>
      </div>
      {!event.showWithoutTime && durationMinutes >= 45 && (
        <div className="opacity-85 text-[10.5px]">
          {timeString}
        </div>
      )}
      {getParticipantCount(event) > 0 && (
        <div
          className="flex items-center gap-0.5 opacity-85 text-[10.5px]"
          title={t("participants.count", { count: getParticipantCount(event) })}
        >
          <Users className="w-3 h-3" />
          <span>{getParticipantCount(event)}</span>
        </div>
      )}
    </button>
  );
}

export { parseDuration, getEventColor, sanitizeColor };
