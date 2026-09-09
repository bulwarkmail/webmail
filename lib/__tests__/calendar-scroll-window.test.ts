import { describe, it, expect } from 'vitest';
import {
  baseRange, computeScrollWindow, freshScrollWindowState, growScrollWindow,
  normalizeScrollWindowState, scrollWindowContains, SCROLL_WINDOW_MAX, SCROLL_WINDOW_STEP,
  type ScrollWindowOptions,
} from '../calendar-scroll-window';

// #759: every calendar view keeps one window of days around the focused
// day; edges double, navigation inside the window does not reset it.

const opts: ScrollWindowOptions = { weekStartsOn: 1 };
const key = (d: Date) => d.toISOString().slice(0, 10);
// Local-midnight dates render in the test's timezone; compare by local fields.
const local = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('baseRange', () => {
  it('is the day itself, the week, the month grid, or 30 days for the agenda', () => {
    const wed = new Date(2026, 8, 9); // Wednesday
    expect(local(baseRange('day', wed, opts).start)).toBe('2026-09-09');
    expect(local(baseRange('day', wed, opts).end)).toBe('2026-09-09');
    expect(local(baseRange('week', wed, opts).start)).toBe('2026-09-07');
    expect(local(baseRange('week', wed, opts).end)).toBe('2026-09-13');
    expect(local(baseRange('month', wed, opts).start)).toBe('2026-08-31');
    expect(local(baseRange('month', wed, opts).end)).toBe('2026-10-04');
    expect(local(baseRange('agenda', wed, opts).start)).toBe('2026-09-09');
    expect(local(baseRange('agenda', wed, opts).end)).toBe('2026-10-09');
  });

  it('uses the locale month grid when one is supplied', () => {
    const grid = [new Date(2026, 7, 24), new Date(2026, 7, 25), new Date(2026, 9, 11)];
    const range = baseRange('month', new Date(2026, 8, 9), { ...opts, monthGridDays: () => grid });
    expect(local(range.start)).toBe('2026-08-24');
    expect(local(range.end)).toBe('2026-10-11');
  });
});

describe('computeScrollWindow', () => {
  it('starts as the base range plus the initial days after it, snapped to whole weeks', () => {
    const win = computeScrollWindow(freshScrollWindowState('month', new Date(2026, 8, 9)), opts);
    expect(local(win.start)).toBe('2026-08-31');
    // 2026-10-04 + 30 days = 2026-11-03 (Tuesday) -> end of that week
    expect(local(win.end)).toBe('2026-11-08');
    expect(win.canExtendStart).toBe(true);
    expect(win.canExtendEnd).toBe(true);
  });

  it('does not snap the day view to weeks', () => {
    const win = computeScrollWindow(freshScrollWindowState('day', new Date(2026, 8, 9)), opts);
    expect(local(win.start)).toBe('2026-09-09');
    expect(local(win.end)).toBe('2026-10-09');
  });

  it('reports the limits once a side reached its maximum', () => {
    const state = { ...freshScrollWindowState('week', new Date(2026, 8, 9)), before: SCROLL_WINDOW_MAX.week };
    expect(computeScrollWindow(state, opts).canExtendStart).toBe(false);
    expect(computeScrollWindow(state, opts).canExtendEnd).toBe(true);
  });
});

describe('growScrollWindow', () => {
  it('doubles a side from the first step up to the cap and then stays put', () => {
    let state = freshScrollWindowState('agenda', new Date(2026, 8, 9));
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      state = growScrollWindow(state, 'before');
      seen.push(state.before);
    }
    expect(seen).toEqual([SCROLL_WINDOW_STEP, 60, 120, 240, 365, 365, 365, 365]);
    const capped = growScrollWindow(state, 'before');
    expect(capped).toBe(state);
  });
});

describe('normalizeScrollWindowState / scrollWindowContains', () => {
  it('starts over when the view mode changed', () => {
    const month = freshScrollWindowState('month', new Date(2026, 8, 9));
    expect(normalizeScrollWindowState(month, 'month', new Date(2026, 0, 1))).toBe(month);
    const week = normalizeScrollWindowState(month, 'week', new Date(2026, 0, 1));
    expect(week.mode).toBe('week');
    expect(week.anchorKey).toBe('2026-01-01');
  });

  it('knows whether a navigation target is already loaded', () => {
    const win = computeScrollWindow(freshScrollWindowState('month', new Date(2026, 8, 9)), opts);
    expect(scrollWindowContains(win, 'month', new Date(2026, 9, 15), opts)).toBe(true);  // October grid ends Nov 1
    expect(scrollWindowContains(win, 'month', new Date(2026, 10, 15), opts)).toBe(false); // November grid ends Dec 6
    expect(scrollWindowContains(win, 'week', new Date(2026, 7, 31), opts)).toBe(true);
    expect(scrollWindowContains(win, 'week', new Date(2026, 7, 30), opts)).toBe(false);
  });

  it('keys the anchor by calendar day', () => {
    expect(freshScrollWindowState('day', new Date(2026, 8, 9, 23, 59)).anchorKey).toBe('2026-09-09');
    expect(key(new Date(Date.UTC(2026, 8, 9)))).toBe('2026-09-09');
  });
});
