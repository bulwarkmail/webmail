"use client";

import { useState, useMemo, Fragment } from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import {
  addMonths, subMonths, addYears, subYears, setMonth, setYear,
  getISOWeek, getWeek, format,
} from "date-fns";
import { cn } from "@/lib/utils";
import { getEventDayBounds } from "@/lib/calendar-utils";
import type { CalendarEvent } from "@/lib/jmap/types";
import { useCalendarLocale } from "@/hooks/use-calendar-locale";

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
    getMonth,
    getYear,
    monthLabelKeys,
  } = useCalendarLocale();
  const [pickerView, setPickerView] = useState<PickerView>("days");

  const days = useMemo(
    () => getMonthGridDays(displayMonth),
    [displayMonth, getMonthGridDays],
  );

  const eventDates = useMemo(() => {
    const set = new Set<string>();
    events.forEach(e => {
      try {
        const { startDay, endDay } = getEventDayBounds(e);
        const cursor = new Date(startDay);
        while (cursor <= endDay) {
          set.add(format(cursor, "yyyy-MM-dd"));
          cursor.setDate(cursor.getDate() + 1);
        }
      } catch { /* skip */ }
    });
    return set;
  }, [events]);

  // Compute week numbers for each row (one per 7-day chunk)
  const weekNumbers = useMemo(() => {
    if (!showWeekNumbers) return [];
    const nums: number[] = [];
    for (let i = 0; i < days.length; i += 7) {
      // Use the first day of each row to determine the week number
      nums.push(weekStartsOn === 1 ? getISOWeek(days[i]) : getWeek(days[i], { weekStartsOn: 0 }));
    }
    return nums;
  }, [days, showWeekNumbers, weekStartsOn]);

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
        : `${decadeStart}\u2013${decadeStart + 9}`;

  return (
    <div className="select-none">
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={handlePrev}
          className="p-1 rounded hover:bg-muted transition-colors"
          aria-label={t("nav_prev")}
        >
          <ChevronLeft className="w-4 h-4 text-muted-foreground" />
        </button>
        <button
          onClick={handleHeaderClick}
          disabled={pickerView === "years"}
          title={pickerView !== "years" ? t("mini_calendar_change") : undefined}
          className={cn(
            "text-sm font-medium px-2 py-1 rounded-md transition-colors inline-flex items-center gap-1",
            pickerView !== "years" && "hover:bg-muted cursor-pointer",
            pickerView === "years" && "cursor-default"
          )}
        >
          {headerLabel}
          {pickerView !== "years" && (
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
          )}
        </button>
        <button
          onClick={handleNext}
          className="p-1 rounded hover:bg-muted transition-colors"
          aria-label={t("nav_next")}
        >
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      {pickerView === "days" && (
        <div className={cn("grid gap-0", showWeekNumbers ? "grid-cols-[auto_repeat(7,1fr)]" : "grid-cols-7")}>
          {showWeekNumbers && (
            <div className="text-center text-[10px] font-medium text-muted-foreground py-1 w-5" />
          )}
          {dayHeaderKeys.map((d) => (
            <div key={d} className="text-center text-[10px] font-medium text-muted-foreground py-1">
              {t(`days.${d}`)}
            </div>
          ))}
          {days.map((day, index) => {
            const inMonth = checkIsSameMonth(day, displayMonth);
            const selected = checkIsSameDay(day, selectedDate);
            const today = checkIsToday(day);
            const hasEvent = eventDates.has(format(day, "yyyy-MM-dd"));
            const isFirstDayOfRow = index % 7 === 0;

            return (
              <Fragment key={day.toISOString()}>
                {showWeekNumbers && isFirstDayOfRow && (
                  <div
                    key={`wk-${index}`}
                    className="flex items-center justify-center w-5 text-[9px] text-muted-foreground/60 font-medium"
                  >
                    {weekNumbers[index / 7]}
                  </div>
                )}
                <button
                  key={`day-${day.toISOString()}`}
                  onClick={() => onSelectDate(day)}
                  className={cn(
                    "relative flex items-center justify-center w-7 h-7 text-xs rounded-full transition-colors",
                    !inMonth && "text-muted-foreground/40",
                    inMonth && !selected && "hover:bg-muted",
                    today && !selected && "font-bold text-primary",
                    selected && "bg-primary text-primary-foreground"
                  )}
                >
                  {formatDayNumber(day)}
                  {hasEvent && !selected && (
                    <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary" />
                  )}
                </button>
              </Fragment>
            );
          })}
        </div>
      )}

      {pickerView === "months" && (
        <div className="grid grid-cols-3 gap-1 py-1">
          {monthLabelKeys.map((labelKey, i) => {
            const isCurrentMonth = i === currentMonth && currentYear === getYear(new Date());
            const isSelected = i === getMonth(selectedDate) && currentYear === getYear(selectedDate);
            return (
              <button
                key={i}
                onClick={() => handlePickMonth(i)}
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
        <div className="grid grid-cols-3 gap-1 py-1">
          {years.map((year) => {
            const inDecade = year >= decadeStart && year <= decadeStart + 9;
            const isCurrentYear = year === getYear(new Date());
            const isSelected = year === getYear(selectedDate);
            return (
              <button
                key={year}
                onClick={() => handlePickYear(year)}
                className={cn(
                  "py-2 text-xs rounded-md transition-colors",
                  isSelected && "bg-primary text-primary-foreground",
                  !isSelected && isCurrentYear && "font-bold text-primary",
                  !isSelected && !isCurrentYear && !inDecade && "text-muted-foreground/40",
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
