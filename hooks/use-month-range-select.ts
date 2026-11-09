import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { isSameDay } from "date-fns";
import { parseDayKey } from "@/lib/calendar-scroll-window";

/** Days picked in the month grid, first and last in date order. */
export interface MonthRange {
  start: Date;
  end: Date;
}

/** Days being picked; `keyboard` when Shift+arrows picked them (Enter creates). */
export interface MonthSelection extends MonthRange {
  keyboard?: boolean;
}

/** How long a finger rests on a day before a drag picks days instead of scrolling. */
export const LONG_PRESS_MS = 450;
/** A finger that moves this far before the long press is scrolling. */
const TOUCH_SLOP_PX = 10;

/** The days from `a` to `b` in reading order, whichever way the drag went. */
export function monthRange(a: Date, b: Date): MonthRange {
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

export function isInMonthRange(day: Date, range: MonthRange | null | undefined): boolean {
  if (!range) return false;
  return (day >= range.start || isSameDay(day, range.start)) && (day <= range.end || isSameDay(day, range.end));
}

/**
 * The day cell under a point of the month grid: the week row at that
 * height, then the cell at that position in it. Measured from the cells
 * themselves, so a right-to-left grid needs nothing extra; a point past
 * the grid takes the nearest row and cell. Not elementFromPoint: an event
 * bar over several days belongs to its first day's cell.
 */
export function monthDayAtPoint(root: HTMLElement, x: number, y: number): Date | null {
  const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-week]"));
  if (rows.length === 0) return null;
  const nearest = <T extends HTMLElement>(items: T[], from: (rect: DOMRect) => [number, number], at: number): T => {
    let best = items[0];
    let bestDistance = Infinity;
    for (const item of items) {
      const [low, high] = from(item.getBoundingClientRect());
      const distance = at < low ? low - at : at >= high ? at - high + 1 : 0;
      if (distance < bestDistance) {
        best = item;
        bestDistance = distance;
        if (distance === 0) break;
      }
    }
    return best;
  };
  const row = nearest(rows, (rect) => [rect.top, rect.bottom], y);
  const cells = Array.from(row.querySelectorAll<HTMLElement>("[data-month-day]"));
  if (cells.length === 0) return null;
  const cell = nearest(cells, (rect) => [rect.left, rect.right], x);
  return parseDayKey(cell.dataset.monthDay ?? "");
}

/** What a press on the grid hits that isn't empty day space. */
const NOT_EMPTY_SPACE = "[data-month-entry], button, a, input, select, textarea, [role='button'], [data-calendar-event]";

interface PressState {
  pointerId: number;
  touch: boolean;
  anchor: Date;
  current: Date;
  x: number;
  y: number;
  /** Days are being picked (mouse: the pointer left the first day; touch: the long press). */
  active: boolean;
  /** The touch's own context menu, held back until it is clear whether days were picked. */
  heldMenu: { event: MouseEvent; day: Date } | null;
  timer: ReturnType<typeof setTimeout> | null;
  stop: () => void;
}

interface UseMonthRangeSelectOptions {
  /** The month grid's scroll container: its rows carry data-week, its cells data-month-day. */
  scrollRef: RefObject<HTMLElement | null>;
  /** Off when no calendar can take a new event. */
  enabled: boolean;
  /** Days were picked: open the quick editor for them. */
  onCreateRange: (start: Date, end: Date) => void;
  /** A long press that picked no other day keeps opening the day's menu. */
  onContextMenuDay?: (event: MouseEvent, day: Date) => void;
}

/**
 * Picking days in the month view to create an event over them, as Google
 * Calendar and Outlook do: press on a day's empty space and drag to another
 * day (across week rows in reading order, either way), or Shift+arrows from
 * the focused day and Enter. On touch a long press starts it, so a swipe
 * still scrolls. The days go to the same quick editor as a drag in the week
 * and day views.
 */
export function useMonthRangeSelect({ scrollRef, enabled, onCreateRange, onContextMenuDay }: UseMonthRangeSelectOptions) {
  const [selection, setSelection] = useState<MonthSelection | null>(null);
  const pressRef = useRef<PressState | null>(null);
  // The click that ends a drag is not a click on the day it ended on.
  const wasDragging = useRef(false);
  // A touch drag's own context menu (Windows sends it after the finger lifts).
  const muteMenuUntil = useRef(0);
  // Shift+arrows: the day the keyboard selection started on.
  const keyAnchor = useRef<Date | null>(null);

  const show = useCallback((press: PressState) => {
    const range = monthRange(press.anchor, press.current);
    setSelection((prev) => (prev && isSameDay(prev.start, range.start) && isSameDay(prev.end, range.end) ? prev : range));
  }, []);

  const end = useCallback(() => {
    const press = pressRef.current;
    pressRef.current = null;
    if (press) {
      if (press.timer) clearTimeout(press.timer);
      press.stop();
    }
    setSelection(null);
    return press;
  }, []);

  useEffect(() => () => {
    const press = pressRef.current;
    if (press?.timer) clearTimeout(press.timer);
    press?.stop();
  }, []);

  const follow = useCallback((press: PressState) => {
    const root = scrollRef.current;
    if (!root) return;
    const day = monthDayAtPoint(root, press.x, press.y);
    if (!day) return;
    if (!press.active) {
      if (isSameDay(day, press.anchor)) return;
      press.active = true;
    }
    press.current = day;
    show(press);
  }, [scrollRef, show]);

  const activate = useCallback((press: PressState, root: HTMLElement) => {
    press.active = true;
    show(press);
    // From here a moving finger picks days: the grid must not scroll.
    const holdStill = (e: TouchEvent) => { if (e.cancelable) e.preventDefault(); };
    root.addEventListener("touchmove", holdStill, { passive: false });
    const previous = press.stop;
    press.stop = () => {
      previous();
      root.removeEventListener("touchmove", holdStill);
    };
  }, [show]);

  const onPointerDown = useCallback((e: PointerEvent<HTMLElement>) => {
    if (!enabled || !e.isPrimary) return;
    const touch = e.pointerType === "touch";
    if (!touch && e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(NOT_EMPTY_SPACE)) return;
    const cell = target.closest<HTMLElement>("[data-month-day]");
    const root = scrollRef.current;
    if (!cell || !root) return;
    end();
    keyAnchor.current = null;
    const anchor = parseDayKey(cell.dataset.monthDay ?? "");
    const press: PressState = {
      pointerId: e.pointerId, touch, anchor, current: anchor, x: e.clientX, y: e.clientY,
      active: false, heldMenu: null, timer: null, stop: () => {},
    };
    // The wheel moves the grid under a pointer that stands still: follow it.
    const onScroll = () => { if (press.active) follow(press); };
    root.addEventListener("scroll", onScroll);
    press.stop = () => root.removeEventListener("scroll", onScroll);
    if (touch) {
      press.timer = setTimeout(() => {
        press.timer = null;
        if (pressRef.current === press) activate(press, root);
      }, LONG_PRESS_MS);
    }
    pressRef.current = press;
  }, [enabled, scrollRef, end, follow, activate]);

  const onPointerMove = useCallback((e: PointerEvent<HTMLElement>) => {
    const press = pressRef.current;
    if (!press || e.pointerId !== press.pointerId) return;
    if (press.touch && !press.active) {
      // A swipe before the long press: the grid scrolls, nothing is picked.
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > TOUCH_SLOP_PX) end();
      return;
    }
    press.x = e.clientX;
    press.y = e.clientY;
    const wasActive = press.active;
    follow(press);
    if (press.active && !wasActive && !press.touch) {
      try { e.currentTarget.setPointerCapture(press.pointerId); } catch { /* the pointer is gone */ }
    }
  }, [end, follow]);

  const onPointerUp = useCallback((e: PointerEvent<HTMLElement>) => {
    const press = pressRef.current;
    if (!press || e.pointerId !== press.pointerId) return;
    end();
    if (!press.active) return;
    wasDragging.current = true;
    requestAnimationFrame(() => { wasDragging.current = false; });
    try { e.currentTarget.releasePointerCapture(press.pointerId); } catch { /* not captured */ }
    const range = monthRange(press.anchor, press.current);
    if (press.touch && isSameDay(range.start, range.end)) {
      // A long press that stayed on its day: the day's menu, as before.
      if (press.heldMenu) onContextMenuDay?.(press.heldMenu.event, press.heldMenu.day);
      return;
    }
    if (press.touch) muteMenuUntil.current = Date.now() + 1000;
    onCreateRange(range.start, range.end);
  }, [end, onCreateRange, onContextMenuDay]);

  const onPointerCancel = useCallback((e: PointerEvent<HTMLElement>) => {
    const press = pressRef.current;
    if (!press || e.pointerId !== press.pointerId) return;
    end();
  }, [end]);

  /** Captured before the cells' own handler: a touch drag's long press is not a right-click. */
  const onContextMenuCapture = useCallback((e: MouseEvent<HTMLElement>) => {
    const press = pressRef.current;
    if (press?.touch) {
      // The browser's long press can come before ours: it starts the pick.
      if (!press.active && scrollRef.current) {
        if (press.timer) clearTimeout(press.timer);
        press.timer = null;
        activate(press, scrollRef.current);
      }
      e.preventDefault();
      e.stopPropagation();
      press.heldMenu = { event: e, day: press.anchor };
      return;
    }
    if (Date.now() < muteMenuUntil.current) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, [scrollRef, activate]);

  // --- Keyboard ---

  /** Shift+arrow from `from` to `to`: the selection grows or shrinks from where it started. */
  const extendTo = useCallback((from: Date, to: Date) => {
    if (!enabled) return;
    if (!keyAnchor.current) keyAnchor.current = from;
    setSelection({ ...monthRange(keyAnchor.current, to), keyboard: true });
  }, [enabled]);

  /** Enter: create over the keyboard selection. False when there is none. */
  const commitKeyboard = useCallback((): boolean => {
    if (!keyAnchor.current || !selection) return false;
    const range = selection;
    keyAnchor.current = null;
    setSelection(null);
    onCreateRange(range.start, range.end);
    return true;
  }, [selection, onCreateRange]);

  /** Escape or a plain arrow: the keyboard selection goes. False when there was none. */
  const clearKeyboard = useCallback((): boolean => {
    if (!keyAnchor.current) return false;
    keyAnchor.current = null;
    setSelection(null);
    return true;
  }, []);

  return {
    selection,
    wasDragging,
    pointerHandlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onContextMenuCapture },
    extendTo,
    commitKeyboard,
    clearKeyboard,
  };
}
