"use client";

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, ChevronDown } from "@/components/icons";
import {
  addDays, addMonths, subMonths, addYears, subYears, setMonth, setYear,
  getISOWeek, getWeek, format,
} from "date-fns";
import { cn } from "@/lib/utils";
import { getEventDayBounds } from "@/lib/calendar-utils";
import { displayNow } from "@/lib/timezone";
import type { CalendarEvent } from "@/lib/jmap/types";
import { useCalendarLocale } from "@/hooks/use-calendar-locale";
import { useDisplayDateFormatter } from "@/hooks/use-display-date-formatter";
import { PluginDayLabel } from "./plugin-day-label";
import { IconButton } from "@/components/ui/icon-button";

type PickerView = "days" | "months" | "years";

interface MiniCalendarProps {
  selectedDate: Date;
  displayMonth: Date;
  onSelectDate: (date: Date) => void;
  onChangeMonth: (date: Date) => void;
  events?: CalendarEvent[];
  firstDayOfWeek?: number;
  showWeekNumbers?: boolean;
}

const dayKey = (date: Date) => format(date, "yyyy-MM-dd");

export function MiniCalendar({
  selectedDate,
  displayMonth,
  onSelectDate,
  onChangeMonth,
  events = [],
  firstDayOfWeek = 1,
  showWeekNumbers = false,
}: MiniCalendarProps) {
  const t = useTranslations("calendar");
  const {
    weekStartsOn,
    dayHeaderKeys,
    getMonthGridDays,
    checkIsToday,
    checkIsSameMonth,
    checkIsSameDay,
    formatDayNumber,
    formatMonthYear,
    formatFullDate,
    getMonth,
    getYear,
    monthLabelKeys,
  } = useCalendarLocale();
  const intlFormatter = useDisplayDateFormatter();
  const [pickerView, setPickerView] = useState<PickerView>("days");

  const days = useMemo(
    () => getMonthGridDays(displayMonth),
    [displayMonth, getMonthGridDays],
  );
  const weeks = useMemo(() => {
    const rows: Date[][] = [];
    for (let i = 0; i < days.length; i += 7) rows.push(days.slice(i, i + 7));
    return rows;
  }, [days]);

  const eventDates = useMemo(() => {
    const set = new Set<string>();
    events.forEach(e => {
      try {
        const { startDay, endDay } = getEventDayBounds(e);
        const cursor = new Date(startDay);
        while (cursor <= endDay) {
          set.add(dayKey(cursor));
          cursor.setDate(cursor.getDate() + 1);
        }
      } catch { /* skip */ }
    });
    return set;
  }, [events]);

  const weekNumberOf = (day: Date) =>
    weekStartsOn === 1 ? getISOWeek(day) : getWeek(day, { weekStartsOn: 0 });

  // The grid is one tab stop (WCAG 2.1.1, ARIA grid pattern): the day the
  // arrows last moved to, else the selected day, today or the 1st.
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const gridRef = useRef<HTMLTableElement>(null);
  const tabStopKey = useMemo(() => {
    const inMonth = (day: Date) => checkIsSameMonth(day, displayMonth);
    const focused = focusedKey ? days.find((day) => dayKey(day) === focusedKey) : undefined;
    if (focused && inMonth(focused)) return focusedKey!;
    if (inMonth(selectedDate)) return dayKey(selectedDate);
    const today = days.find((day) => inMonth(day) && checkIsToday(day));
    if (today) return dayKey(today);
    const first = days.find(inMonth);
    return first ? dayKey(first) : null;
  }, [focusedKey, days, displayMonth, selectedDate, checkIsSameMonth, checkIsToday]);

  const dayButton = (key: string) =>
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-mini-day="${key}"]`) ?? null;

  // After moving into another month, focus the day once that month is drawn.
  useEffect(() => {
    if (!pendingFocus.current) return;
    const el = dayButton(pendingFocus.current);
    pendingFocus.current = null;
    el?.focus();
  }, [days]);

  const moveFocus = useCallback((date: Date) => {
    const key = dayKey(date);
    setFocusedKey(key);
    if (checkIsSameMonth(date, displayMonth)) {
      dayButton(key)?.focus();
    } else {
      pendingFocus.current = key;
      onChangeMonth(date);
    }
  }, [checkIsSameMonth, displayMonth, onChangeMonth]);

  const handleDayKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, day: Date, column: number) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    let next: Date | null = null;
    switch (e.key) {
      case "ArrowLeft": next = addDays(day, rtl ? 1 : -1); break;
      case "ArrowRight": next = addDays(day, rtl ? -1 : 1); break;
      case "ArrowUp": next = addDays(day, -7); break;
      case "ArrowDown": next = addDays(day, 7); break;
      case "Home": next = addDays(day, -column); break;
      case "End": next = addDays(day, 6 - column); break;
      case "PageUp": next = e.shiftKey ? subYears(day, 1) : subMonths(day, 1); break;
      case "PageDown": next = e.shiftKey ? addYears(day, 1) : addMonths(day, 1); break;
      default: return;
    }
    // The grid's keys, not the calendar's previous/next period.
    e.preventDefault();
    e.stopPropagation();
    moveFocus(next);
  };

  const currentYear = getYear(displayMonth);
  const currentMonth = getMonth(displayMonth);
  const decadeStart = Math.floor(currentYear / 10) * 10;
  const years = Array.from({ length: 12 }, (_, i) => decadeStart - 1 + i);

  const handlePickMonth = (month: number) => {
    onChangeMonth(setMonth(displayMonth, month));
    setPickerView("days");
  };

  const handlePickYear = (year: number) => {
    onChangeMonth(setYear(displayMonth, year));
    setPickerView("months");
  };

  const handlePrev = () => {
    if (pickerView === "days") onChangeMonth(subMonths(displayMonth, 1));
    else if (pickerView === "months") onChangeMonth(subYears(displayMonth, 1));
    else onChangeMonth(setYear(displayMonth, decadeStart - 10));
  };

  const handleNext = () => {
    if (pickerView === "days") onChangeMonth(addMonths(displayMonth, 1));
    else if (pickerView === "months") onChangeMonth(addYears(displayMonth, 1));
    else onChangeMonth(setYear(displayMonth, decadeStart + 10));
  };

  const handleHeaderClick = () => {
    if (pickerView === "days") setPickerView("months");
    else if (pickerView === "months") setPickerView("years");
  };

  const headerLabel =
    pickerView === "days"
      ? formatMonthYear(displayMonth)
      : pickerView === "months"
        ? String(currentYear)
        : `${decadeStart}–${decadeStart + 9}`;

  return (
    <div className="select-none">
      <div className="flex items-center justify-between mb-2">
        <IconButton
          onClick={handlePrev}
          className="text-muted-foreground"
          label={t(pickerView === "days" ? "mini_prev_month" : pickerView === "months" ? "mini_prev_year" : "mini_prev_years")}
        >
          <ChevronLeft />
        </IconButton>
        <button
          onClick={handleHeaderClick}
          disabled={pickerView === "years"}
          title={pickerView !== "years" ? t("mini_calendar_change") : undefined}
          aria-live="polite"
          className={cn(
            "text-sm font-medium px-2 py-1 rounded-md transition-colors inline-flex items-center gap-1",
            pickerView !== "years" && "hover:bg-muted cursor-pointer",
            pickerView === "years" && "cursor-default"
          )}
        >
          {headerLabel}
          {pickerView !== "years" && (
            <ChevronDown aria-hidden="true" className="w-3.5 h-3.5 text-muted-foreground" />
          )}
        </button>
        <IconButton
          onClick={handleNext}
          className="text-muted-foreground"
          label={t(pickerView === "days" ? "mini_next_month" : pickerView === "months" ? "mini_next_year" : "mini_next_years")}
        >
          <ChevronRight />
        </IconButton>
      </div>

      {pickerView === "days" && (
        // A real table grid: screen readers read the weekday with each day
        // and move by row and column; the arrows move between days.
        <table
          ref={gridRef}
          role="grid"
          aria-label={formatMonthYear(displayMonth)}
          className="w-full border-collapse table-fixed"
        >
          <thead>
            <tr>
              {showWeekNumbers && (
                <th scope="col" className="w-5 p-0">
                  <span className="sr-only">{t("views.week")}</span>
                </th>
              )}
              {dayHeaderKeys.map((d, index) => (
                <th
                  key={d}
                  scope="col"
                  abbr={weeks[0]?.[index] ? intlFormatter.dateTime(weeks[0][index], { weekday: "long" }) : undefined}
                  className="overflow-hidden text-center text-[0.625rem] font-medium text-muted-foreground py-1"
                >
                  {t(`days.${d}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={dayKey(week[0])}>
                {showWeekNumbers && (
                  <th
                    scope="row"
                    className="w-5 p-0 text-center text-[0.5625rem] text-muted-foreground font-medium"
                  >
                    <span aria-hidden="true">{weekNumberOf(week[0])}</span>
                    <span className="sr-only">{t("mini_week_number", { week: weekNumberOf(week[0]) })}</span>
                  </th>
                )}
                {week.map((day, column) => {
                  const key = dayKey(day);
                  const inMonth = checkIsSameMonth(day, displayMonth);
                  const selected = checkIsSameDay(day, selectedDate);
                  const today = checkIsToday(day);
                  const hasEvent = eventDates.has(key);
                  // "Wednesday, October 29, 2026, has events": the full date,
                  // and events in words, not only as a dot.
                  const label = hasEvent ? `${formatFullDate(day)}, ${t("mini_has_events")}` : formatFullDate(day);
                  return (
                    <td key={key} role="gridcell" aria-selected={selected} className="p-0 text-center">
                      <button
                        type="button"
                        data-mini-day={key}
                        tabIndex={key === tabStopKey ? 0 : -1}
                        onClick={() => { setFocusedKey(key); onSelectDate(day); }}
                        onKeyDown={(e) => handleDayKeyDown(e, day, column)}
                        className="group/day inline-flex items-center justify-center w-full max-w-7 h-7 pointer-coarse:max-w-none pointer-coarse:w-full pointer-coarse:h-11 text-xs"
                        aria-current={today ? "date" : undefined}
                      >
                        <span
                          className={cn(
                            "relative flex items-center justify-center w-full max-w-7 aspect-square rounded-full transition-colors",
                            // Other months' days in the muted text colour, which
                            // still reads at 4.5:1 (a faded one did not).
                            !inMonth && "text-muted-foreground",
                            // Today is the filled circle; the selected day is tinted.
                            today && "bg-primary text-primary-foreground font-semibold",
                            selected && !today && "bg-primary/15 text-primary font-semibold",
                            !today && !selected && "group-hover/day:bg-muted"
                          )}
                        >
                          {/* Named by the hidden full date, not the bare number;
                              a plugin's mark below adds its own words. */}
                          <span className="sr-only">{label}</span>
                          <span aria-hidden="true">{formatDayNumber(day)}</span>
                          {hasEvent && !selected && !today && (
                            <span aria-hidden="true" className="absolute top-[calc(50%+0.55em)] left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary" />
                          )}
                          <PluginDayLabel surface="mini-calendar-marks" date={key} />
                        </span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pickerView === "months" && (
        <div className="grid grid-cols-3 gap-1 py-1" role="group" aria-label={String(currentYear)}>
          {monthLabelKeys.map((labelKey, i) => {
            const isCurrentMonth = i === currentMonth && currentYear === getYear(displayNow());
            const isSelected = i === getMonth(selectedDate) && currentYear === getYear(selectedDate);
            return (
              <button
                key={i}
                type="button"
                onClick={() => handlePickMonth(i)}
                aria-pressed={isSelected}
                aria-current={isCurrentMonth ? "date" : undefined}
                className={cn(
                  "py-2 text-xs rounded-md transition-colors",
                  isSelected && "bg-primary text-primary-foreground",
                  !isSelected && isCurrentMonth && "font-bold text-primary",
                  !isSelected && !isCurrentMonth && "hover:bg-muted"
                )}
              >
                {t(`months.${labelKey}`)}
              </button>
            );
          })}
        </div>
      )}

      {pickerView === "years" && (
        <div className="grid grid-cols-3 gap-1 py-1" role="group" aria-label={headerLabel}>
          {years.map((year) => {
            const inDecade = year >= decadeStart && year <= decadeStart + 9;
            const isCurrentYear = year === getYear(displayNow());
            const isSelected = year === getYear(selectedDate);
            return (
              <button
                key={year}
                type="button"
                onClick={() => handlePickYear(year)}
                aria-pressed={isSelected}
                aria-current={isCurrentYear ? "date" : undefined}
                className={cn(
                  "py-2 text-xs rounded-md transition-colors",
                  isSelected && "bg-primary text-primary-foreground",
                  !isSelected && isCurrentYear && "font-bold text-primary",
                  !isSelected && !isCurrentYear && !inDecade && "text-muted-foreground",
                  !isSelected && !isCurrentYear && "hover:bg-muted"
                )}
              >
                {year}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
