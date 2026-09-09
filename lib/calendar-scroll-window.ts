import { addDays, subDays, startOfWeek, endOfWeek, startOfDay, startOfMonth, endOfMonth, format } from "date-fns";

/**
 * The calendar views scroll freely (#759): each keeps one window of days
 * around the day the user navigated to. Reaching an edge of the rendered
 * range widens that side and the whole window is refetched, so the store
 * never has to merge partial results. A navigation that lands inside the
 * window just scrolls; one that leaves it starts a fresh window there.
 */

export type ScrollViewMode = "month" | "week" | "day" | "agenda";

export interface DayRange {
  start: Date;
  end: Date;
}

export interface ScrollWindowState {
  mode: ScrollViewMode;
  /** yyyy-MM-dd of the day the window was started from. */
  anchorKey: string;
  /** Days added before the base range of the anchor. */
  before: number;
  /** Days added after the base range of the anchor. */
  after: number;
}

export interface ScrollWindow extends DayRange {
  canExtendStart: boolean;
  canExtendEnd: boolean;
}

/** The day the user navigated to; `nonce` changes on every navigation. */
export interface CalendarFocus {
  date: Date;
  nonce: number;
}

/** Props every freely scrolling calendar view receives from the app. */
export interface ScrollWindowViewProps {
  focus: CalendarFocus;
  /** Loaded window (whole days, inclusive). */
  rangeStart: Date;
  rangeEnd: Date;
  /** Changes whenever a fresh window is started. */
  windowKey: string;
  /** Widen the window at the start; omitted once the limit is reached. */
  onExtendStart?: () => void;
  /** Widen the window at the end; omitted once the limit is reached. */
  onExtendEnd?: () => void;
  isLoading?: boolean;
  /** Reports the day at the top / start of the viewport as the user scrolls. */
  onVisibleDateChange?: (date: Date) => void;
}

export interface ScrollWindowOptions {
  weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Locale-aware month grid (Jalali support); Gregorian when omitted. */
  monthGridDays?: (date: Date) => Date[];
}

/** First growth step in days; every further step doubles the side. */
export const SCROLL_WINDOW_STEP = 30;

/** Furthest a side may grow, in days. Time grids render one column per day. */
export const SCROLL_WINDOW_MAX: Record<ScrollViewMode, number> = {
  month: 365,
  agenda: 365,
  week: 180,
  day: 180,
};

/** Days loaded after the base range before the user scrolls anywhere. */
const INITIAL_AFTER: Record<ScrollViewMode, number> = {
  month: SCROLL_WINDOW_STEP,
  agenda: SCROLL_WINDOW_STEP,
  week: SCROLL_WINDOW_STEP,
  day: SCROLL_WINDOW_STEP,
};

export function dayKey(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

export function freshScrollWindowState(mode: ScrollViewMode, anchor: Date): ScrollWindowState {
  return { mode, anchorKey: dayKey(anchor), before: 0, after: INITIAL_AFTER[mode] };
}

/** The range a view shows for a date when nothing has been scrolled yet. */
export function baseRange(mode: ScrollViewMode, date: Date, opts: ScrollWindowOptions): DayRange {
  const day = startOfDay(date);
  switch (mode) {
    case "day":
      return { start: day, end: day };
    case "week":
      return {
        start: startOfWeek(day, { weekStartsOn: opts.weekStartsOn }),
        end: endOfWeek(day, { weekStartsOn: opts.weekStartsOn }),
      };
    case "month": {
      const grid = opts.monthGridDays?.(day);
      if (grid && grid.length > 0) return { start: startOfDay(grid[0]), end: startOfDay(grid[grid.length - 1]) };
      return {
        start: startOfWeek(startOfMonth(day), { weekStartsOn: opts.weekStartsOn }),
        end: endOfWeek(endOfMonth(day), { weekStartsOn: opts.weekStartsOn }),
      };
    }
    case "agenda":
      return { start: day, end: addDays(day, SCROLL_WINDOW_STEP) };
  }
}

/** Ensures the state belongs to the view mode; otherwise starts over at the anchor. */
export function normalizeScrollWindowState(
  state: ScrollWindowState,
  mode: ScrollViewMode,
  anchor: Date,
): ScrollWindowState {
  return state.mode === mode ? state : freshScrollWindowState(mode, anchor);
}

export function computeScrollWindow(
  state: ScrollWindowState,
  opts: ScrollWindowOptions,
): ScrollWindow {
  const anchor = parseDayKey(state.anchorKey);
  const base = baseRange(state.mode, anchor, opts);
  let start = subDays(base.start, state.before);
  let end = addDays(base.end, state.after);
  if (state.mode === "month" || state.mode === "week") {
    start = startOfWeek(start, { weekStartsOn: opts.weekStartsOn });
    end = endOfWeek(end, { weekStartsOn: opts.weekStartsOn });
  }
  const max = SCROLL_WINDOW_MAX[state.mode];
  return {
    start: startOfDay(start),
    end: startOfDay(end),
    canExtendStart: state.before < max,
    canExtendEnd: state.after < max,
  };
}

export function growScrollWindow(state: ScrollWindowState, side: "before" | "after"): ScrollWindowState {
  const max = SCROLL_WINDOW_MAX[state.mode];
  const grown = Math.min(max, Math.max(SCROLL_WINDOW_STEP, state[side] * 2));
  return grown === state[side] ? state : { ...state, [side]: grown };
}

/** True when the view's base range for `date` is already loaded. */
export function scrollWindowContains(window: DayRange, mode: ScrollViewMode, date: Date, opts: ScrollWindowOptions): boolean {
  const base = baseRange(mode, date, opts);
  return base.start.getTime() >= window.start.getTime() && base.end.getTime() <= window.end.getTime();
}

export function parseDayKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}
