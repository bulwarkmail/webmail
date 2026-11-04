"use client";

import { useCallback, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { CalendarEvent, Calendar } from "@/lib/jmap/types";
import { parseDuration } from "@/lib/calendar-event-normalization";
import { format } from "date-fns";
import { ChevronDown, ChevronUp, Users } from "@/components/icons";
import { getParticipantCount, isDeclinedByUser } from "@/lib/calendar-participants";
import { gridReplyState, type GridReplyState } from "@/lib/calendar-reply-state";
import { useEventUserEmails } from "@/hooks/use-event-user-emails";
import { getEventEndDate, getEventStartDate } from "@/lib/calendar-utils";
import { useSettingsStore, type MonthTimedEventStyle } from "@/stores/settings-store";
import { readableTextOn } from "@/lib/color-transform";
import { useLongPress } from "@/hooks/use-long-press";
import { useCvdColor } from "@/hooks/use-cvd-color";
import { endEventDragGrab, startEventDragGrab } from "@/lib/calendar/event-drag-grab";
import { useCollectionNames } from "@/hooks/use-collection-names";

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
  /**
   * The event goes on before what is drawn: before the first day of a span,
   * above the first visible hour of a block.
   */
  continuesBefore?: boolean;
  /** The event goes on after what is drawn: past the last day or hour. */
  continuesAfter?: boolean;
  className?: string;
  style?: CSSProperties;
  /**
   * The user's calendar addresses, to tell whether they declined or have yet
   * to answer the event. An event of another signed-in login is read with
   * that login's addresses.
   */
  currentUserEmails?: string[];
  /**
   * The "?" / "Reply" marker of an invitation the user hasn't answered was
   * clicked: offer Accept, Maybe and Decline next to it (pim-9).
   */
  onReply?: (anchor: HTMLElement, event: CalendarEvent) => void;
  /** False for a day scrolled out of view: Tab skips it (arrows still reach it). */
  tabbable?: boolean;
  /**
   * Month view only (span variant): draw a timed event as coloured text or a
   * dot and text instead of a bar (#1449). All-day events, events that run
   * on past the drawn day, and declined or cancelled ones keep their look.
   */
  timedStyle?: MonthTimedEventStyle;
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
// With light event colours on (the Outlook look, as on the printout) an
// event is a light tint of its colour with a bar in it at the start
// (eventFillClass) and text in the text colour.
// Everything is drawn with box-shadow, so the selection ring joins the list
// here and the browser's focus outline stays free.
/**
 * The event colour as text on the page background: mixed with the text
 * colour so a light calendar colour stays readable in the light theme and a
 * dark one in the dark theme.
 */
export function eventTextColor(color: string): string {
  return `color-mix(in srgb, ${color} 55%, var(--color-foreground))`;
}

export function eventFillStyle(
  color: string,
  { inactive, separated, selected, tinted }: { inactive: boolean; separated?: boolean; selected?: boolean; tinted?: boolean },
): CSSProperties {
  const shadows: string[] = [];
  if (selected) shadows.push("0 0 0 2px var(--color-primary)");
  else if (separated) shadows.push("0 0 0 1px var(--color-background)");
  if (inactive) shadows.push(`inset 0 0 0 1px ${color}`);
  const fill: CSSProperties = inactive
    ? { backgroundColor: "var(--color-background)", color: eventTextColor(color) }
    : tinted
      ? {
        backgroundColor: `color-mix(in srgb, ${color} 20%, var(--color-background))`,
        color: "var(--color-foreground)",
        ["--start-bar" as string]: color,
      }
      : { backgroundColor: color, color: readableTextOn(color) };
  return shadows.length > 0 ? { ...fill, boxShadow: shadows.join(", ") } : fill;
}

/**
 * An invitation the user hasn't answered: the calendar colour as an outline
 * over a light hatch. One they answered "maybe": a dashed outline over a
 * light tint (pim-9).
 */
export function replyFillStyle(
  color: string,
  state: Exclude<GridReplyState, null>,
  { separated, selected }: { separated?: boolean; selected?: boolean },
): CSSProperties {
  const ring = selected ? "0 0 0 2px var(--color-primary)" : separated ? "0 0 0 1px var(--color-background)" : null;
  if (state === "tentative") {
    return {
      backgroundColor: `color-mix(in srgb, ${color} 14%, var(--color-background))`,
      color: "var(--color-foreground)",
      border: `1.5px dashed ${color}`,
      ...(ring ? { boxShadow: ring } : {}),
    };
  }
  const tint = `color-mix(in srgb, ${color} 18%, var(--color-background))`;
  return {
    backgroundColor: "var(--color-background)",
    backgroundImage: `repeating-linear-gradient(135deg, ${tint} 0 4px, transparent 4px 8px)`,
    color: eventTextColor(color),
    boxShadow: [ring, `inset 0 0 0 1.5px ${color}`].filter(Boolean).join(", "),
  };
}

/** The class that draws the light style's bar; declined and cancelled events keep their outline. */
export function eventFillClass(tinted: boolean, inactive: boolean): string | undefined {
  return tinted && !inactive ? "start-bar" : undefined;
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

export function EventCard({ event, calendar, variant, onClick, onMouseEnter, onMouseLeave, onContextMenu, onReply, isSelected, draggable: isDraggable, continuesBefore = false, continuesAfter = false, className, style, currentUserEmails, tabbable = true, timedStyle = "bar" }: EventCardProps) {
  const t = useTranslations("calendar");
  const tEvent = useTranslations("ux_pim_event");
  const tGrid = useTranslations("ux_pim_grid");
  const shownName = useCollectionNames();
  // The addresses of the login the event is in (pim-12, pim-9).
  const userEmails = useEventUserEmails(currentUserEmails ?? [])(event);
  const [isBeingDragged, setIsBeingDragged] = useState(false);
  const paint = useCvdColor();
  const color = paint(getEventColor(event, calendar));
  const startDate = getEventStartDate(event);
  const timeFormat = useSettingsStore((state) => state.timeFormat);
  const showTimeInMonthView = useSettingsStore((state) => state.showTimeInMonthView);
  const tinted = useSettingsStore((state) => state.calendarTintedEvents);
  // "Show names next to colours": the calendar's name on the event, so the
  // colour is not the only way to tell Work from Personal (WCAG 1.4.1).
  const showColorNames = useSettingsStore((state) => state.showColorNames);
  const timeFmt = timeFormat === "12h" ? "h:mm a" : "HH:mm";

  const calendarName = calendar ? shownName.calendar(calendar) : "";
  const visibleCalendarName = showColorNames && calendarName ? calendarName : null;
  const durationMinutes = parseDuration(event.duration);
  const endTime = getEventEndDate(event);
  const safeFormat = (d: Date, fmt: string) => {
    if (isNaN(d.getTime())) return "--:--";
    try { return format(d, fmt); } catch { return "--:--"; }
  };
  const timeString = `${safeFormat(startDate, timeFmt)} – ${safeFormat(endTime, timeFmt)}`;
  // An all-day event is read out as such, not as "00:00 – 23:00".
  const spokenTime = event.showWithoutTime ? t("events.all_day") : timeString;
  // iTIP CANCEL marks the attendee's copy with status "cancelled" instead of
  // deleting it (#572), and a declined invitation stays on the calendar too
  // (#1110) - render both struck through and dimmed.
  const isCancelled = event.status === "cancelled";
  const isDeclined = !isCancelled && isDeclinedByUser(event, userEmails);
  const isInactive = isCancelled || isDeclined;
  // An invitation not answered yet, or answered "maybe" (pim-9).
  const replyState = isInactive ? null : gridReplyState(event, userEmails);
  const statusLabel = isCancelled
    ? t("detail.cancelled")
    : isDeclined
      ? t("participants.declined")
      : replyState === "needs-action"
        ? tEvent("status_needs_action")
        : replyState === "tentative" ? tEvent("status_tentative") : null;
  const fillStyle = (opts: { separated?: boolean }) => replyState
    ? replyFillStyle(color, replyState, { ...opts, selected: isSelected })
    : eventFillStyle(color, { inactive: isInactive, selected: isSelected, tinted, ...opts });
  // No light-style bar over the outline of an open answer.
  const fillClass = eventFillClass(tinted, isInactive || replyState !== null);
  const showMarker = replyState === "needs-action";
  // "?" in a narrow event, "Reply" where there is room.
  const markerLabel = (
    <>
      <span aria-hidden="true" className="@min-[11rem]/reply:hidden">?</span>
      <span className="hidden @min-[11rem]/reply:inline">{tGrid("reply")}</span>
    </>
  );
  const markerClass = cn(
    "absolute z-[1] inline-flex items-center justify-center h-5 min-w-5 max-w-20 px-1 rounded-xs",
    "text-[0.625rem] font-semibold leading-none truncate",
    // A block's title runs along its top: the marker sits at the bottom.
    variant === "block" ? (continuesAfter ? "bottom-0.5 end-4" : "bottom-0.5 end-0.5") : "top-1/2 -translate-y-1/2 end-0.5",
  );
  const markerStyle: CSSProperties = { backgroundColor: color, color: readableTextOn(color) };
  const marker = !showMarker ? null : onReply ? (
    <button
      type="button"
      data-reply-marker
      aria-label={tGrid("reply_to_invitation")}
      title={tGrid("reply_to_invitation")}
      tabIndex={tabbable ? undefined : -1}
      onClick={(e) => { e.stopPropagation(); onReply(e.currentTarget, event); }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn(markerClass, "cursor-pointer hover:opacity-90")}
      style={markerStyle}
    >
      {markerLabel}
    </button>
  ) : (
    <span data-reply-marker aria-hidden="true" className={markerClass} style={markerStyle}>{markerLabel}</span>
  );
  // Room for the marker at the end of a one-line card.
  const markerRoom = showMarker && variant !== "block" ? "pe-6 @min-[11rem]/reply:pe-[5.5rem]" : undefined;
  const withMarker = (card: React.ReactElement) => marker ? (
    <div className={cn("relative @container/reply w-full", variant !== "chip" && "h-full")} data-reply-state={replyState ?? undefined}>
      {card}
      {marker}
    </div>
  ) : card;
  const ariaLabel = `${event.title || t("events.no_title")}, ${spokenTime}${calendarName ? `, ${calendarName}` : ""}${statusLabel ? `, ${statusLabel}` : ""}`;

  // A click that ends a drag isn't one: no popover under the moved event (pim-p3-2).
  const dragEndedAt = useRef(0);
  const openFromClick = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    if (Date.now() - dragEndedAt.current < 300) return;
    onClick?.(e.currentTarget.getBoundingClientRect());
  };

  const handleDragStart = useCallback((e: DragEvent) => {
    e.stopPropagation();
    // Where it was grabbed: a drop moves it by the distance dragged from here (pim-p3-2).
    startEventDragGrab(event.id, e.currentTarget as Element, e.clientY);
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
    endEventDragGrab();
    dragEndedAt.current = Date.now();
    setIsBeingDragged(false);
  }, []);

  const dragProps = isDraggable ? {
    draggable: true as const,
    onDragStart: handleDragStart,
    onDragEnd: handleDragEnd,
    "aria-roledescription": t("events.draggable_role"),
  } : {};

  const handleContextMenu = onContextMenu ? (e: React.MouseEvent) => onContextMenu(e, event) : undefined;

  // Touch screens have no right-click: a long press opens the same menu,
  // at the finger (R7).
  const pressedRef = useRef<HTMLElement | null>(null);
  const longPress = useLongPress(({ clientX, clientY }) => {
    const target = pressedRef.current;
    if (!onContextMenu || !target) return;
    onContextMenu({
      type: "contextmenu", clientX, clientY, detail: 1, currentTarget: target, target,
      preventDefault: () => {}, stopPropagation: () => {},
    } as unknown as React.MouseEvent, event);
  }, !!onContextMenu);
  // Shift+F10 opens the same menu from the keyboard (the menu key already
  // fires contextmenu by itself). Prevented here, so a browser that also
  // turns Shift+F10 into a contextmenu event doesn't open it twice.
  const handleKeyDown = onContextMenu ? (e: React.KeyboardEvent<HTMLElement>) => {
    if (!(e.shiftKey && e.key === "F10")) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    const rect = target.getBoundingClientRect();
    onContextMenu({
      type: "contextmenu", clientX: rect.left, clientY: rect.bottom, detail: 0, currentTarget: target, target,
      preventDefault: () => {}, stopPropagation: () => {},
    } as unknown as React.MouseEvent, event);
  } : undefined;

  const touchProps = onContextMenu ? {
    onTouchStart: (e: React.TouchEvent<HTMLElement>) => { pressedRef.current = e.currentTarget; longPress.onTouchStart(e); },
    onTouchMove: longPress.onTouchMove,
    onTouchEnd: longPress.onTouchEnd,
    onTouchCancel: longPress.onTouchCancel,
  } : {};

  if (variant === "chip") {
    return withMarker(
      <button
        onClick={openFromClick}
        onMouseEnter={(e) => onMouseEnter?.(e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => onMouseLeave?.()}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        {...touchProps}
        aria-label={ariaLabel}
        tabIndex={tabbable ? undefined : -1}
        {...dragProps}
        data-event-id={event.id}
        data-reply-state={replyState ?? undefined}
        className={cn(
          "flex items-center w-full text-start text-xs font-medium px-1.5 py-0.5 rounded-xs truncate",
          "min-h-[44px] sm:min-h-0",
          "hover:opacity-90 transition-opacity",
          isBeingDragged && "opacity-50",
          fillClass,
          markerRoom,
          className
        )}
        style={{ ...fillStyle({}), ...style }}
      >
        {/* The whole width, aligned to the title's own start: a short English
            title in Arabic sat at the right, a cut one filled to the left. */}
        <span dir="auto" className={cn("flex-1 min-w-0 truncate text-start", isInactive && "line-through")}>{event.title || t("events.no_title")}</span>
        {visibleCalendarName && (
          <span data-calendar-name dir="auto" className="ms-1 min-w-0 max-w-[45%] shrink truncate font-normal opacity-85">{visibleCalendarName}</span>
        )}
      </button>
    );
  }

  if (variant === "span") {
    // Coloured text or dot and text for a timed event that starts and ends
    // on the drawn day (#1449). Anything else stays a bar, so all-day and
    // multi-day events read as blocked days.
    const textStyle = (timedStyle === "text" || timedStyle === "dot")
      && !event.showWithoutTime && !continuesBefore && !continuesAfter && !isInactive && !replyState
      ? timedStyle : null;
    if (textStyle) {
      return (
        <button
          onClick={openFromClick}
          onMouseEnter={(e) => onMouseEnter?.(e.currentTarget.getBoundingClientRect())}
          onMouseLeave={() => onMouseLeave?.()}
          onContextMenu={handleContextMenu}
          onKeyDown={handleKeyDown}
          {...touchProps}
          aria-label={ariaLabel}
          tabIndex={tabbable ? undefined : -1}
          {...dragProps}
          data-event-id={event.id}
          data-timed-style={textStyle}
          className={cn(
            "w-full h-full text-start rounded-xs px-1.5 py-0.5 text-xs overflow-hidden",
            "hover:bg-muted transition-colors cursor-pointer",
            isBeingDragged && "opacity-50",
            className
          )}
          style={{
            color: textStyle === "text" ? eventTextColor(color) : "var(--color-foreground)",
            ...(isSelected ? { boxShadow: "0 0 0 2px var(--color-primary)" } : {}),
            ...style,
          }}
        >
          <div className="@container">
            <div className="flex items-center gap-1 min-w-0">
              {textStyle === "dot" && (
                <span data-event-dot aria-hidden="true" className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
              )}
              <span className="hidden @min-[5.5rem]:inline flex-shrink-0 font-normal opacity-85">{safeFormat(startDate, timeFmt)}</span>
              <span dir="auto" className="flex-1 min-w-0 truncate text-start font-medium">{event.title || t("events.no_title")}</span>
              {visibleCalendarName && (
                <span data-calendar-name dir="auto" className="hidden @min-[9rem]:inline min-w-0 max-w-[45%] shrink truncate font-normal opacity-85">{visibleCalendarName}</span>
              )}
            </div>
          </div>
        </button>
      );
    }
    return withMarker(
      <button
        onClick={openFromClick}
        onMouseEnter={(e) => onMouseEnter?.(e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => onMouseLeave?.()}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        {...touchProps}
        aria-label={ariaLabel}
        tabIndex={tabbable ? undefined : -1}
        {...dragProps}
        data-event-id={event.id}
        data-reply-state={replyState ?? undefined}
        className={cn(
          "w-full h-full text-start rounded-xs px-1.5 py-0.5 text-xs overflow-hidden",
          "hover:opacity-90 transition-opacity cursor-pointer",
          continuesBefore && "rounded-s-none",
          continuesAfter && "rounded-e-none pe-2",
          isBeingDragged && "opacity-50",
          fillClass,
          markerRoom,
          className
        )}
        style={{ ...fillStyle({}), ...style }}
      >
        {/* The title comes first: in a narrow day the time and the calendar's
            name left it no room, or one letter. */}
        <div className="@container">
          <div className="flex items-center gap-1 min-w-0">
            {showTimeInMonthView && !event.showWithoutTime && (
              <span className="hidden @min-[5.5rem]:inline flex-shrink-0 font-normal opacity-85">{format(startDate, timeFmt)}</span>
            )}
            <span dir="auto" className={cn("flex-1 min-w-0 truncate text-start font-medium", isInactive && "line-through")}>{event.title || t("events.no_title")}</span>
            {visibleCalendarName && (
              <span data-calendar-name dir="auto" className="hidden @min-[9rem]:inline min-w-0 max-w-[45%] shrink truncate font-normal opacity-85">{visibleCalendarName}</span>
            )}
          </div>
        </div>
      </button>
    );
  }

  return withMarker(
    <button
      onClick={openFromClick}
      onMouseEnter={(e) => onMouseEnter?.(e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => onMouseLeave?.()}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      {...touchProps}
      aria-label={ariaLabel}
      tabIndex={tabbable ? undefined : -1}
      {...dragProps}
      data-event-id={event.id}
      data-calendar-event
      data-reply-state={replyState ?? undefined}
      data-continues-before={continuesBefore || undefined}
      data-continues-after={continuesAfter || undefined}
      className={cn(
        // A block box: an inline one hangs its line's descent below the
        // grid's last hour and makes the filled pane scroll. Clipped, not
        // hidden: hidden makes the block a scroller and its title can't stick.
        "relative block w-full h-full text-start rounded-xs px-1.5 py-0.5 text-xs overflow-clip",
        "hover:opacity-90 transition-opacity cursor-pointer",
        // Cut at the edge of the visible hours: a square edge and an arrow
        // say the event runs on past it.
        continuesBefore && "rounded-t-none",
        continuesAfter && "rounded-b-none",
        continuesBefore && "pe-4",
        isBeingDragged && "opacity-50",
        fillClass,
        markerRoom,
        className
      )}
      style={{ ...fillStyle({ separated: true }), ...style }}
    >
      {continuesBefore && <ChevronUp aria-hidden="true" className="absolute top-0.5 end-0.5 w-3 h-3 opacity-85" />}
      {continuesAfter && <ChevronDown aria-hidden="true" className="absolute bottom-0.5 end-0.5 w-3 h-3 opacity-85" />}
      {/* Shorter blocks have no room for a second line at the 60px hour, so
          their start time follows the title on the same line, when the
          block is wide enough to keep the title readable. */}
      {/* The title stays in sight under the grid's header while the block
          is: the morning part of a night train started at midnight, scrolled
          out of view, and showed as a block with no name (pim-p2-19). */}
      <div data-event-title-line className="sticky top-[var(--grid-header-height,0px)]">
      <div className="@container">
        <div className="flex items-baseline gap-1 min-w-0">
          <span dir="auto" className={cn("font-medium truncate", isInactive && "line-through")}>{event.title || t("events.no_title")}</span>
          {!event.showWithoutTime && durationMinutes < 45 && (
            <span className="hidden @min-[120px]:inline flex-shrink-0 opacity-85 text-[0.65625rem]">{safeFormat(startDate, timeFmt)}</span>
          )}
        </div>
      </div>
      {/* Not in a block too narrow for it (several events at once): it broke over three lines of clipped text. */}
      {!event.showWithoutTime && durationMinutes >= 45 && (
        <div className="@container">
          <div className="hidden @min-[4.25rem]:block opacity-85 text-[0.65625rem]">
            {/* Start before end in a right-to-left layout too. */}
            <bdi dir="ltr">{timeString}</bdi>
          </div>
        </div>
      )}
      </div>
      {visibleCalendarName && (
        <div data-calendar-name dir="auto" className="opacity-85 text-[0.65625rem] truncate">{visibleCalendarName}</div>
      )}
      {/* Below 45 minutes the block has room for the title line only: the count was cut in half. */}
      {getParticipantCount(event) > 0 && durationMinutes >= 45 && (
        <div
          className="flex items-center gap-0.5 opacity-85 text-[0.65625rem]"
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
