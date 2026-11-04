"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Clock, X } from "@/components/icons";
import { IconButton } from "@/components/ui/icon-button";
import type { Calendar } from "@/lib/jmap/types";
import { useDisplayDateFormatter } from "@/hooks/use-display-date-formatter";
import { useCvdColor } from "@/hooks/use-cvd-color";
import { useCollectionNames } from "@/hooks/use-collection-names";
import { CalendarSelect } from "@/components/calendar/calendar-select";

export interface QuickCreateDraft {
  start: Date;
  end: Date;
  title: string;
  calendarId: string;
  /** A day picked in the month view or the all-day row: an all-day event. */
  allDay?: boolean;
}

interface QuickCreatePopoverProps {
  draft: QuickCreateDraft;
  /** Calendars new events can go into. */
  calendars: Calendar[];
  timeFormat?: "12h" | "24h";
  onChange: (draft: QuickCreateDraft) => void;
  onSave: () => void;
  onMoreOptions: () => void;
  onClose: () => void;
}

const WIDTH = 340;
// Wider for a calendar name that needs it ("Stalwart Calendar
// (someone@example.org)" was cut off at 340 px, pim-21).
const MAX_WIDTH = 480;
const GAP = 8;
const MARGIN = 12;

// The views draw the new event's placeholder block with this attribute; the
// popover sits beside it, or under it when neither side has room.
const PLACEHOLDER_SELECTOR = "[data-pending-preview]";

export function computePosition(anchor: DOMRect | null, height: number, width = WIDTH): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!anchor) return { top: Math.max(MARGIN, (vh - height) / 2), left: Math.max(MARGIN, (vw - width) / 2) };
  const clampTop = (top: number) => Math.min(Math.max(MARGIN, top), vh - height - MARGIN);
  const clampLeft = (left: number) => Math.min(Math.max(MARGIN, left), vw - width - MARGIN);
  if (anchor.right + GAP + width + MARGIN <= vw) return { top: clampTop(anchor.top), left: anchor.right + GAP };
  if (anchor.left - GAP - width >= MARGIN) return { top: clampTop(anchor.top), left: anchor.left - GAP - width };
  if (anchor.bottom + GAP + height + MARGIN <= vh) return { top: anchor.bottom + GAP, left: clampLeft(anchor.left) };
  return { top: Math.max(MARGIN, anchor.top - GAP - height), left: clampLeft(anchor.left) };
}

/**
 * Compact editor that opens next to an empty slot clicked in the week or
 * day view: a title, the time that was picked, the calendar, and a way into
 * the full editor. Enter saves, Escape or a click elsewhere discards.
 */
export function QuickCreatePopover({
  draft,
  calendars,
  timeFormat = "24h",
  onChange,
  onSave,
  onMoreOptions,
  onClose,
}: QuickCreatePopoverProps) {
  const shownName = useCollectionNames();
  const selected = calendars.find((c) => c.id === draft.calendarId);
  const t = useTranslations("calendar");
  const paint = useCvdColor();
  const tCommon = useTranslations("common");
  const intlFormatter = useDisplayDateFormatter();
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  // Re-anchor when the draft moves (a new slot) and once the placeholder
  // block has been drawn by the view.
  const startKey = draft.start.getTime();
  const endKey = draft.end.getTime();
  useLayoutEffect(() => {
    const place = () => {
      const node = ref.current;
      if (!node) return;
      const anchor = document.querySelector(PLACEHOLDER_SELECTOR)?.getBoundingClientRect() ?? null;
      setPosition(computePosition(anchor, node.offsetHeight, node.offsetWidth));
    };
    place();
    const frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [startKey, endKey]);

  // Focus goes back where it came from (the slot a keyboard user created
  // from) when the popover closes, unless something else has taken it.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const popover = ref.current;
    return () => {
      const active = document.activeElement;
      const lost = !active || active === document.body || (popover?.contains(active) ?? false);
      if (lost && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  // Focus once placed. Chrome sometimes refuses the first focus() right
  // after the slot click that opened the popover, so try again briefly.
  const placed = position !== null;
  useEffect(() => {
    if (!placed) return;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tryFocus = () => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      if (document.activeElement !== el && ++attempts < 5) timer = setTimeout(tryFocus, 50);
    };
    const frame = requestAnimationFrame(tryFocus);
    return () => {
      cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
    };
  }, [startKey, placed]);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handleMouseDown), 0);
    document.addEventListener("keydown", handleKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const canSave = draft.title.trim().length > 0 && !!draft.calendarId;
  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (canSave) onSave();
  }, [canSave, onSave]);

  const timeFmt = timeFormat === "12h" ? "h:mm a" : "HH:mm";
  const dateLabel = intlFormatter.dateTime(draft.start, { weekday: "long", month: "long", day: "numeric" });
  const timeLabel = draft.allDay ? t("events.all_day") : `${format(draft.start, timeFmt)} – ${format(draft.end, timeFmt)}`;

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={t("quick_create.aria_label")}
      className="fixed z-[60] bg-background border border-border rounded-lg shadow-xl"
      style={{
        width: "max-content",
        minWidth: WIDTH,
        maxWidth: `min(${MAX_WIDTH}px, calc(100vw - ${2 * MARGIN}px))`,
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        visibility: position ? "visible" : "hidden",
      }}
    >
      <form onSubmit={handleSubmit}>
        <div className="flex justify-end px-2 pt-2">
          <IconButton label={tCommon("close")} onClick={onClose} className="text-muted-foreground">
            <X />
          </IconButton>
        </div>
        <div className="px-4 pb-3 space-y-3">
          <Input
            ref={inputRef}
            value={draft.title}
            onChange={(e) => onChange({ ...draft, title: e.target.value })}
            placeholder={t("quick_create.add_title")}
            aria-label={t("form.title")}
            maxLength={500}
            className="text-base"
          />
          <div className="flex items-start gap-2.5 text-sm">
            <Clock className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div>
              <div className="font-medium text-foreground">{dateLabel}</div>
              <div className="text-muted-foreground">{timeLabel}</div>
            </div>
          </div>
          {calendars.length > 0 && (
            <div className="flex items-center gap-2.5">
              <span
                className="w-4 h-4 rounded-sm flex-shrink-0"
                style={{ backgroundColor: paint(selected?.color || "#3b82f6") }}
                aria-hidden="true"
              />
              <CalendarSelect
                calendars={calendars}
                value={draft.calendarId}
                onChange={(calendarId) => onChange({ ...draft, calendarId })}
                aria-label={t("form.calendar_select")}
                title={selected ? shownName.calendar(selected) : undefined}
                className="flex-1 min-w-0 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-hidden"
              />
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border">
          <Button type="button" variant="ghost" size="xs" onClick={onMoreOptions}>
            {t("quick_create.more_options")}
          </Button>
          <Button type="submit" size="xs" disabled={!canSave}>
            {t("form.save")}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
