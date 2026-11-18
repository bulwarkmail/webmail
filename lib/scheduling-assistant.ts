/**
 * The grid of the scheduling assistant (#1751): one day in the user's time
 * zone, as minutes from midnight on its wall clock, with everyone's busy time
 * from Principal/getAvailability laid on it.
 *
 * Positions are wall-clock minutes, not elapsed time, so the hour labels stay
 * under their hours on the day a clock goes forward or back.
 */

import type { BusyPeriod } from "@/lib/jmap/types";
import { fromWallClock, getWallClock } from "@/lib/timezone";

export const DAY_MINUTES = 1440;
/** Clicks, drags and arrow keys move the event in steps of this many minutes. */
export const SNAP_MINUTES = 15;

export interface GridDay {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
}

export type BusyKind = "busy" | "tentative";

/** A stretch of the day in minutes from midnight, end excluded. */
export interface GridSpan {
  from: number;
  to: number;
}

export interface BusySpan extends GridSpan {
  kind: BusyKind;
}

/** The day `instant` falls on in `timeZone`. */
export function dayOf(instant: Date, timeZone: string): GridDay {
  const w = getWallClock(instant, timeZone);
  return { year: w.year, month: w.month, day: w.day };
}

/** The day `count` days after (or before, when negative) `day`. */
export function addDays(day: GridDay, count: number): GridDay {
  const d = new Date(Date.UTC(day.year, day.month - 1, day.day + count));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 0 = Sunday, as Date.getDay. */
export function weekdayOf(day: GridDay): number {
  return new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
}

export function sameDay(a: GridDay, b: GridDay): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/** The instant the clock in `timeZone` reads `minutes` past midnight of `day`; 1440 is the next midnight. */
export function instantAt(day: GridDay, minutes: number, timeZone: string): Date {
  const d = minutes >= DAY_MINUTES ? addDays(day, 1) : day;
  const m = Math.max(0, minutes) % DAY_MINUTES;
  return fromWallClock({ ...d, hour: Math.floor(m / 60), minute: m % 60, second: 0 }, timeZone);
}

/** The instants the day starts and ends at. */
export function dayBounds(day: GridDay, timeZone: string): { start: Date; end: Date } {
  return { start: instantAt(day, 0, timeZone), end: instantAt(day, DAY_MINUTES, timeZone) };
}

/** Where `instant` sits on the day, clamped to it: 0 before the day, 1440 after. */
export function minuteOfDay(instant: Date, day: GridDay, timeZone: string): number {
  const { start, end } = dayBounds(day, timeZone);
  if (instant.getTime() <= start.getTime()) return 0;
  if (instant.getTime() >= end.getTime()) return DAY_MINUTES;
  const w = getWallClock(instant, timeZone);
  return w.hour * 60 + w.minute;
}

/** The part of `start`-`end` on the day, or null when it is on another day. */
export function spanOnDay(start: Date, end: Date, day: GridDay, timeZone: string): GridSpan | null {
  const { start: dayStart, end: dayEnd } = dayBounds(day, timeZone);
  if (end.getTime() <= dayStart.getTime() || start.getTime() >= dayEnd.getTime()) return null;
  return { from: minuteOfDay(start, day, timeZone), to: minuteOfDay(end, day, timeZone) };
}

export function snapMinutes(minutes: number, step = SNAP_MINUTES): number {
  return Math.round(minutes / step) * step;
}

/**
 * The busy periods on the day. A period with exactly the times of `exclude`
 * (the edited event as it is saved, in everyone's calendar) is left out, or
 * the event would block its own slot.
 */
export function busySpans(
  periods: BusyPeriod[],
  day: GridDay,
  timeZone: string,
  exclude?: { start: Date; end: Date } | null,
): BusySpan[] {
  const spans: BusySpan[] = [];
  for (const p of periods) {
    const start = new Date(p.utcStart);
    const end = new Date(p.utcEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (exclude && start.getTime() === exclude.start.getTime() && end.getTime() === exclude.end.getTime()) continue;
    const span = spanOnDay(start, end, day, timeZone);
    if (!span || span.to <= span.from) continue;
    spans.push({ ...span, kind: p.busyStatus === "tentative" ? "tentative" : "busy" });
  }
  return spans.sort((a, b) => a.from - b.from);
}

/**
 * Everyone's busy time as one row: busy where anyone is busy, tentative
 * where someone is only tentative, nothing where all are free.
 */
export function combineSpans(rows: BusySpan[][]): BusySpan[] {
  const all = rows.flat();
  const edges = [...new Set(all.flatMap((s) => [s.from, s.to]))].sort((a, b) => a - b);
  const out: BusySpan[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const from = edges[i];
    const to = edges[i + 1];
    const covering = all.filter((s) => s.from < to && s.to > from);
    if (covering.length === 0) continue;
    const kind: BusyKind = covering.some((s) => s.kind === "busy") ? "busy" : "tentative";
    const last = out[out.length - 1];
    if (last && last.to === from && last.kind === kind) last.to = to;
    else out.push({ from, to, kind });
  }
  return out;
}

/** The parts of `within` that no span covers. */
export function freeSpans(busy: GridSpan[], within: GridSpan): GridSpan[] {
  const out: GridSpan[] = [];
  let at = within.from;
  for (const s of [...busy].sort((a, b) => a.from - b.from)) {
    if (s.to <= at) continue;
    if (s.from >= within.to) break;
    if (s.from > at) out.push({ from: at, to: Math.min(s.from, within.to) });
    at = Math.max(at, s.to);
  }
  if (at < within.to) out.push({ from: at, to: within.to });
  return out;
}

/** The working part of the day, or null on a day off. */
export function workingSpan(
  day: GridDay,
  workingDays: Set<number>,
  hours: { startMinutes: number; endMinutes: number },
): GridSpan | null {
  if (!workingDays.has(weekdayOf(day))) return null;
  return { from: hours.startMinutes, to: hours.endMinutes };
}

/** The shaded parts of the day: all of a day off, else before and after the working hours. */
export function outsideWorkingSpans(working: GridSpan | null): GridSpan[] {
  if (!working) return [{ from: 0, to: DAY_MINUTES }];
  return [
    ...(working.from > 0 ? [{ from: 0, to: working.from }] : []),
    ...(working.to < DAY_MINUTES ? [{ from: working.to, to: DAY_MINUTES }] : []),
  ];
}

/**
 * The event moved so that it starts `startMinute` past midnight of `day`,
 * keeping its length. It may not start before the day or after its last step.
 */
export function moveSlotTo(
  slot: { start: Date; end: Date },
  day: GridDay,
  startMinute: number,
  timeZone: string,
): { start: Date; end: Date } {
  const minute = Math.max(0, Math.min(DAY_MINUTES - SNAP_MINUTES, snapMinutes(startMinute)));
  const start = instantAt(day, minute, timeZone);
  return { start, end: new Date(start.getTime() + (slot.end.getTime() - slot.start.getTime())) };
}

/**
 * The event with its end at `endMinute` past midnight of `day`, at least one
 * step after its start and no later than the end of the day.
 */
export function resizeSlotTo(
  slot: { start: Date; end: Date },
  day: GridDay,
  endMinute: number,
  timeZone: string,
): { start: Date; end: Date } {
  const minEnd = slot.start.getTime() + SNAP_MINUTES * 60_000;
  const minute = Math.max(0, Math.min(DAY_MINUTES, snapMinutes(endMinute)));
  const end = instantAt(day, minute, timeZone);
  return { start: slot.start, end: new Date(Math.max(minEnd, end.getTime())) };
}
