/**
 * Maps minutes-since-midnight (0-1440) to/from a vertical pixel offset in
 * the day/week time-grid views (`calendar-day-view.tsx`,
 * `calendar-week-view.tsx`, `use-time-grid-interactions.ts`).
 *
 * The historical behavior is a flat, linear scale: one constant pixel
 * height per hour, so a full 24h day is always `24 * hourHeight` tall. The
 * "compact night hours" scale instead shrinks the night band (22:00-06:00,
 * configurable via `dayStartMinutes`/`dayEndMinutes`) to a smaller
 * per-hour height, so a full day fits in noticeably less vertical space
 * without any scrolling, while the "waking" hours keep their normal,
 * comfortable height. Both scales expose the same `TimeScale` interface so
 * every consumer (rendering AND pointer-interaction math) can stay
 * agnostic of which one is active.
 */

export interface TimeScale {
  /** Total pixel height of a full 24h (1440-minute) day at this scale. */
  totalHeight: number;
  /** minutes-since-midnight (0-1440) -> pixel Y offset from the grid top. */
  minutesToY: (minutes: number) => number;
  /** Inverse of `minutesToY` - pixel Y offset -> minutes (unclamped/unsnapped). */
  yToMinutes: (y: number) => number;
}

export function createLinearTimeScale(hourHeight: number): TimeScale {
  return {
    totalHeight: 24 * hourHeight,
    minutesToY: (minutes) => (minutes / 60) * hourHeight,
    yToMinutes: (y) => (y / hourHeight) * 60,
  };
}

const MINUTES_PER_DAY = 1440;

export interface CompactNightTimeScaleOptions {
  /** Pixel height per hour during the "day" band. */
  dayHourHeight: number;
  /** Pixel height per hour during the "night" band(s). */
  nightHourHeight: number;
  /** Start of the day band, in minutes-since-midnight. Default 06:00. */
  dayStartMinutes?: number;
  /** End of the day band, in minutes-since-midnight. Default 22:00. */
  dayEndMinutes?: number;
}

/**
 * A three-band piecewise-linear scale: night (00:00-dayStart), day
 * (dayStart-dayEnd), night again (dayEnd-24:00) - the night band wraps
 * around midnight, so it is really one continuous 22:00-06:00 stretch,
 * just split across the two ends of a single day's [0, 1440) range.
 */
export function createCompactNightTimeScale({
  dayHourHeight,
  nightHourHeight,
  dayStartMinutes = 6 * 60,
  dayEndMinutes = 22 * 60,
}: CompactNightTimeScaleOptions): TimeScale {
  const preHeight = (dayStartMinutes / 60) * nightHourHeight;
  const dayHeight = ((dayEndMinutes - dayStartMinutes) / 60) * dayHourHeight;
  const postHeight = ((MINUTES_PER_DAY - dayEndMinutes) / 60) * nightHourHeight;
  const totalHeight = preHeight + dayHeight + postHeight;

  const minutesToY = (minutes: number): number => {
    const m = Math.max(0, Math.min(MINUTES_PER_DAY, minutes));
    if (m <= dayStartMinutes) return (m / 60) * nightHourHeight;
    if (m <= dayEndMinutes) return preHeight + ((m - dayStartMinutes) / 60) * dayHourHeight;
    return preHeight + dayHeight + ((m - dayEndMinutes) / 60) * nightHourHeight;
  };

  const yToMinutes = (y: number): number => {
    const clamped = Math.max(0, Math.min(totalHeight, y));
    if (clamped <= preHeight) return (clamped / nightHourHeight) * 60;
    if (clamped <= preHeight + dayHeight) {
      return dayStartMinutes + ((clamped - preHeight) / dayHourHeight) * 60;
    }
    return dayEndMinutes + ((clamped - preHeight - dayHeight) / nightHourHeight) * 60;
  };

  return { totalHeight, minutesToY, yToMinutes };
}

/** Height (px) of a single hour row `h` (0-23) at the given scale - the
 * gap between the hour's own start and the next hour's start. Used for
 * the gridline rows, which are drawn one per hour rather than as one
 * continuous background. */
export function hourRowHeight(scale: TimeScale, hour: number): number {
  return scale.minutesToY((hour + 1) * 60) - scale.minutesToY(hour * 60);
}
