import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import { displayNow } from "@/lib/timezone";
import { FULL_DAY_HOURS, resolveDisplayHours, type DisplayHours } from "@/lib/calendar-display-range";

/** A time of day to bring into view, e.g. a new event's start; a new nonce asks again. */
export interface RevealTime {
  minutes: number;
  nonce: number;
}

interface UseDisplayHoursOptions {
  scrollRef: RefObject<HTMLElement | null>;
  /** The smallest height of an hour row; rows grow to fill a taller pane. */
  minHourHeight: number;
  /** The sticky header above the hour rows, whose height the rows don't get. */
  headerRef?: RefObject<HTMLElement | null>;
  revealAt?: RevealTime | null;
}

/** Room above an hour line for the label centred on it, in pixels. */
export const HOUR_LABEL_ROOM = 8;

/**
 * The height of an hour row: `min`, or more when the hours would leave the
 * pane's bottom empty (a short range on a tall tablet). A pane only a little
 * short of the hours gets slightly lower rows rather than a few pixels of
 * scrolling. Whole pixels, so the hour lines stay sharp.
 */
export function fillHourHeight(min: number, available: number, hourCount: number): number {
  if (hourCount <= 0 || available <= 0) return min;
  const fit = Math.floor(available / hourCount);
  return fit >= Math.ceil(min * 0.9) ? fit : min;
}

/**
 * The hours a time grid draws (#1164): the configured range, or the whole
 * day while the user has asked to see it. Owns the grid's vertical scroll
 * position too - it opens an hour before now, and keeps the same hours in
 * place when the range or the row height changes underneath it. Rows fill
 * the pane when the hours are fewer than it has room for.
 */
export function useDisplayHours({ scrollRef, minHourHeight, headerRef, revealAt }: UseDisplayHoursOptions) {
  const limitHours = useSettingsStore((s) => s.calendarLimitHours);
  const startHour = useSettingsStore((s) => s.calendarDayStartHour);
  const endHour = useSettingsStore((s) => s.calendarDayEndHour);
  const configured = useMemo(
    () => resolveDisplayHours(limitHours, startHour, endHour),
    [limitHours, startHour, endHour],
  );
  const [showAllHours, setShowAllHours] = useState(false);
  const hours: DisplayHours = showAllHours ? FULL_DAY_HOURS : configured;
  const hourCount = (hours.endMinutes - hours.startMinutes) / 60;

  // The room below the header, measured whenever the pane or the header
  // (the all-day row grows with its events) changes size.
  const [available, setAvailable] = useState(0);
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const measure = () => {
      const headerHeight = headerRef?.current?.offsetHeight ?? 0;
      setAvailable(Math.max(0, root.clientHeight - headerHeight));
      // Where an event's title sticks while its block runs above the visible
      // hours: an overnight event's morning part (pim-p2-19).
      root.style?.setProperty("--grid-header-height", `${headerHeight}px`);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    if (headerRef?.current) observer.observe(headerRef.current);
    return () => observer.disconnect();
  }, [scrollRef, headerRef]);
  const hourHeight = fillHourHeight(minHourHeight, available, hourCount);

  // Opens an hour before now, once. Rows of any other height than the
  // minimum fit the pane without scrolling, so the minimum is the height
  // that matters here.
  const initialHoursRef = useRef(hours);
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const { startMinutes, endMinutes } = initialHoursRef.current;
    const now = displayNow();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    // Outside the visible hours (an evening look at a working-hours grid)
    // the day's first hour is more use than its last.
    if (nowMinutes < startMinutes || nowMinutes >= endMinutes) {
      root.scrollTop = 0;
      return;
    }
    // A little above that hour's line: its label sits centred on the line,
    // and its top half would be under the sticky header.
    root.scrollTop = Math.max(0, ((now.getHours() - 1) * 60 - startMinutes) / 60 * minHourHeight - HOUR_LABEL_ROOM);
  }, [scrollRef, minHourHeight]);

  const revealRef = useRef<number | null>(null);
  const renderedRef = useRef({ startMinutes: hours.startMinutes, hourHeight });
  useLayoutEffect(() => {
    const root = scrollRef.current;
    const prev = renderedRef.current;
    renderedRef.current = { startMinutes: hours.startMinutes, hourHeight };
    const reveal = revealRef.current;
    revealRef.current = null;
    if (!root) return;
    if (reveal !== null) {
      root.scrollTop = Math.max(0, ((reveal - hours.startMinutes) / 60 - 0.5) * hourHeight);
    } else if (prev.startMinutes !== hours.startMinutes || prev.hourHeight !== hourHeight) {
      // The time at the top of the pane stays there.
      const topMinutes = prev.startMinutes + (root.scrollTop / prev.hourHeight) * 60;
      root.scrollTop = Math.max(0, ((topMinutes - hours.startMinutes) / 60) * hourHeight);
    }
  }, [scrollRef, hourHeight, hours.startMinutes]);

  const toggleAllHours = useCallback(() => setShowAllHours((v) => !v), []);
  /** Shows the whole day and scrolls to `minutes` from midnight. */
  const revealMinutes = useCallback((minutes: number) => {
    revealRef.current = minutes;
    setShowAllHours(true);
  }, []);

  // A saved event lands where the user can see it: outside the shown hours
  // the whole day opens, else the grid scrolls to it when it is out of view.
  const revealNonce = revealAt?.nonce;
  useEffect(() => {
    if (!revealAt) return;
    const { minutes } = revealAt;
    if (minutes < hours.startMinutes || minutes >= hours.endMinutes) {
      revealMinutes(minutes);
      return;
    }
    const root = scrollRef.current;
    if (!root) return;
    const top = ((minutes - hours.startMinutes) / 60) * hourHeight;
    if (top < root.scrollTop || top > root.scrollTop + root.clientHeight - 2 * hourHeight) {
      root.scrollTop = Math.max(0, top - hourHeight / 2);
    }
    // Only a new request moves the grid, not a change of range under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealNonce]);

  return {
    hours,
    /** The drawn height of an hour row, in pixels. */
    hourHeight,
    /** Whether a range is configured at all, i.e. the toggle has anything to do. */
    canToggle: configured.restricted,
    configured,
    showAllHours,
    toggleAllHours,
    revealMinutes,
  };
}
