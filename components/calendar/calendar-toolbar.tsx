"use client";

import { useState, useRef, useEffect } from "react";
import { useTranslations, useFormatter } from "next-intl";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Plus, Upload, CalendarDays } from "lucide-react";
import { addDays, startOfWeek } from "date-fns";
import { cn } from "@/lib/utils";
import type { CalendarViewMode } from "@/stores/calendar-store";
import type { Calendar } from "@/lib/jmap/types";

interface CalendarToolbarProps {
  selectedDate: Date;
  viewMode: CalendarViewMode;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onViewModeChange: (mode: CalendarViewMode) => void;
  onCreateEvent: () => void;
  onImport?: () => void;
  isMobile?: boolean;
  firstDayOfWeek?: number;
  onNavigateBack?: () => void;
  calendars?: Calendar[];
  selectedCalendarIds?: string[];
  onToggleVisibility?: (id: string) => void;
}

export function CalendarToolbar({
  selectedDate,
  viewMode,
  onPrev,
  onNext,
  onToday,
  onViewModeChange,
  onCreateEvent,
  onImport,
  isMobile,
  firstDayOfWeek = 1,
  calendars,
  selectedCalendarIds,
  onToggleVisibility,
}: CalendarToolbarProps) {
  const t = useTranslations("calendar");
  const formatter = useFormatter();
  const views: CalendarViewMode[] = ["month", "week", "day", "agenda"];
  const [showCalendarDropdown, setShowCalendarDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showCalendarDropdown) return;
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowCalendarDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showCalendarDropdown]);

  const getDateLabel = (): string => {
    switch (viewMode) {
      case "month":
        return isMobile
          ? formatter.dateTime(selectedDate, { month: "short", year: "numeric" })
          : formatter.dateTime(selectedDate, { month: "long", year: "numeric" });
      case "week": {
        const ws = startOfWeek(selectedDate, { weekStartsOn: firstDayOfWeek as 0 | 1 });
        const we = addDays(ws, 6);
        if (isMobile) {
          return `${formatter.dateTime(ws, { month: "short", day: "numeric" })} – ${formatter.dateTime(we, { day: "numeric" })}`;
        }
        const sameMonth = ws.getMonth() === we.getMonth();
        if (sameMonth) {
          return `${formatter.dateTime(ws, { month: "short", day: "numeric" })} – ${formatter.dateTime(we, { day: "numeric" })}, ${we.getFullYear()}`;
        }
        return `${formatter.dateTime(ws, { month: "short", day: "numeric" })} – ${formatter.dateTime(we, { month: "short", day: "numeric" })}, ${we.getFullYear()}`;
      }
      case "day":
        return isMobile
          ? formatter.dateTime(selectedDate, { weekday: "short", month: "short", day: "numeric" })
          : formatter.dateTime(selectedDate, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
      case "agenda":
        return isMobile
          ? formatter.dateTime(selectedDate, { month: "short", year: "numeric" })
          : formatter.dateTime(selectedDate, { month: "long", year: "numeric" });
    }
  };

  const [showViewDropdown, setShowViewDropdown] = useState(false);
  const viewDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showViewDropdown) return;
    function handleClickOutside(e: MouseEvent) {
      if (viewDropdownRef.current && !viewDropdownRef.current.contains(e.target as Node)) {
        setShowViewDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showViewDropdown]);

  return (
    <div className={cn("flex items-center gap-1.5 px-2 py-2 border-b border-border flex-wrap", !isMobile && "px-4 py-3 gap-2")}>
      <div className="flex items-center gap-0.5">
        <button onClick={onPrev} className="p-2 rounded hover:bg-muted transition-colors touch-manipulation" aria-label={t("nav_prev")}>
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className={cn("text-sm font-medium text-center", isMobile ? "min-w-[80px]" : "min-w-[140px]")}>
          {getDateLabel()}
        </span>
        <button onClick={onNext} className="p-2 rounded hover:bg-muted transition-colors touch-manipulation" aria-label={t("nav_next")}>
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      <Button variant="outline" size="sm" onClick={onToday} className="touch-manipulation">
        {t("views.today")}
      </Button>

      {isMobile && calendars && selectedCalendarIds && onToggleVisibility && (
        <div className="relative" ref={dropdownRef}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowCalendarDropdown((v) => !v)}
            aria-label={t("my_calendars")}
            className="touch-manipulation"
          >
            <CalendarDays className="w-4 h-4" />
          </Button>
          {showCalendarDropdown && (
            <div className="absolute top-full right-0 mt-1 z-50 bg-popover border border-border rounded-lg shadow-lg p-2 min-w-[180px]">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 px-1">
                {t("my_calendars")}
              </h3>
              <div className="space-y-0.5">
                {calendars.map((cal) => {
                  const isVisible = selectedCalendarIds.includes(cal.id);
                  const color = cal.color || "#3b82f6";
                  return (
                    <button
                      key={cal.id}
                      onClick={() => onToggleVisibility(cal.id)}
                      className={cn(
                        "flex items-center gap-2 w-full px-2 py-2 rounded-md text-sm transition-colors duration-150 touch-manipulation",
                        "hover:bg-muted"
                      )}
                    >
                      <span
                        className={cn(
                          "w-3.5 h-3.5 rounded-sm border-2 flex-shrink-0 transition-colors",
                          isVisible ? "border-transparent" : "border-muted-foreground/40 bg-transparent"
                        )}
                        style={isVisible ? { backgroundColor: color, borderColor: color } : undefined}
                      />
                      <span className={cn("truncate", !isVisible && "text-muted-foreground")}>
                        {cal.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {isMobile && (
        <div className="relative" ref={viewDropdownRef}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowViewDropdown((v) => !v)}
            className="touch-manipulation capitalize text-xs"
          >
            {t(`views.${viewMode}`)}
            <ChevronLeft className="w-3 h-3 ml-1 rotate-[-90deg]" />
          </Button>
          {showViewDropdown && (
            <div className="absolute top-full right-0 mt-1 z-50 bg-popover border border-border rounded-lg shadow-lg p-1 min-w-[120px]">
              {views.map((v) => (
                <button
                  key={v}
                  onClick={() => { onViewModeChange(v); setShowViewDropdown(false); }}
                  className={cn(
                    "flex items-center w-full px-3 py-2 rounded-md text-sm transition-colors touch-manipulation",
                    v === viewMode ? "bg-primary text-primary-foreground" : "hover:bg-muted text-foreground"
                  )}
                >
                  {t(`views.${v}`)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex-1" />

      {!isMobile && (
        <div className="flex border border-border rounded-md overflow-hidden">
          {views.map((v) => (
            <button
              key={v}
              onClick={() => onViewModeChange(v)}
              title={t(`views.${v}_hint`)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium transition-colors",
                v === viewMode
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted text-muted-foreground"
              )}
            >
              {t(`views.${v}`)}
            </button>
          ))}
        </div>
      )}

      {onImport && !isMobile && (
        <Button variant="outline" size="sm" onClick={onImport}>
          <Upload className="w-4 h-4 mr-1" />
          {t("import.title")}
        </Button>
      )}

      {!isMobile && (
        <Button size="sm" onClick={onCreateEvent}>
          <Plus className="w-4 h-4 mr-1" />
          {t("events.create")}
        </Button>
      )}
    </div>
  );
}
