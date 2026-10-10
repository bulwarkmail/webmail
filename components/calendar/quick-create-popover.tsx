"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Clock, X } from "@/components/icons";
import type { Calendar } from "@/lib/jmap/types";
import { useDisplayDateFormatter } from "@/hooks/use-display-date-formatter";

export interface QuickCreateDraft {
  start: Date;
  end: Date;
  title: string;
  calendarId: string;
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
const GAP = 8;
const MARGIN = 12;

// The views draw the new event's placeholder block with this attribute; the
// popover sits beside it, or under it when neither side has room.
const PLACEHOLDER_SELECTOR = "[data-pending-preview]";

function computePosition(anchor: DOMRect | null, height: number): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!anchor) return { top: Math.max(MARGIN, (vh - height) / 2), left: Math.max(MARGIN, (vw - WIDTH) / 2) };
  const clampTop = (top: number) => Math.min(Math.max(MARGIN, top), vh - height - MARGIN);
  const clampLeft = (left: number) => Math.min(Math.max(MARGIN, left), vw - WIDTH - MARGIN);
  if (anchor.right + GAP + WIDTH + MARGIN <= vw) return { top: clampTop(anchor.top), left: anchor.right + GAP };
  if (anchor.left - GAP - WIDTH >= MARGIN) return { top: clampTop(anchor.top), left: anchor.left - GAP - WIDTH };
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
  const t = useTranslations("calendar");
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
      setPosition(computePosition(anchor, node.offsetHeight));
    };
    place();
    const frame = requestAnimationFrame(place);
    return () => cancelAnimationFrame(frame);
  }, [startKey, endKey]);

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
  const timeLabel = `${format(draft.start, timeFmt)} – ${format(draft.end, timeFmt)}`;

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={t("quick_create.aria_label")}
      className="fixed z-[60] bg-background border border-border rounded-lg shadow-xl"
      style={{
        width: WIDTH,
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        visibility: position ? "visible" : "hidden",
      }}
    >
      <form onSubmit={handleSubmit}>
        <div className="flex justify-end px-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            aria-label={t("form.cancel")}
          >
            <X className="w-4 h-4" />
          </button>
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
                style={{ backgroundColor: calendars.find((c) => c.id === draft.calendarId)?.color || "#3b82f6" }}
                aria-hidden="true"
              />
              <select
                value={draft.calendarId}
                onChange={(e) => onChange({ ...draft, calendarId: e.target.value })}
                aria-label={t("form.calendar_select")}
                className="flex-1 min-w-0 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {calendars.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border">
          <Button type="button" variant="ghost" size="sm" className="h-8" onClick={onMoreOptions}>
            {t("quick_create.more_options")}
          </Button>
          <Button type="submit" size="sm" className="h-8" disabled={!canSave}>
            {t("form.save")}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
