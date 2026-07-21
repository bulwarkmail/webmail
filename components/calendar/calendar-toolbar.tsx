"use client";

import { useState, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Plus, Upload, CalendarDays, Globe, ChevronDown, ArrowLeft, Menu } from "lucide-react";
import { startOfWeek } from "date-fns";
import { cn } from "@/lib/utils";
import type { CalendarViewMode } from "@/stores/calendar-store";
import type { Calendar } from "@/lib/jmap/types";
import { useCalendarLocale } from "@/hooks/use-calendar-locale";

interface CalendarToolbarProps {
  selectedDate: Date;
  viewMode: CalendarViewMode;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onViewModeChange: (mode: CalendarViewMode) => void;
  onCreateEvent: () => void;
  onImport?: () => void;
  onSubscribe?: () => void;
  isMobile?: boolean;
  firstDayOfWeek?: number;
  onNavigateBack?: () => void;
  calendars?: Calendar[];
  selectedCalendarIds?: string[];
  onToggleVisibility?: (id: string) => void;
  enableCalendarTasks?: boolean;
  /** Show a burger button at the start that opens the (overlay) sidebar. */
  onMenuClick?: () => void;
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
  onSubscribe,
  isMobile,
  firstDayOfWeek = 1,
  onNavigateBack,
  calendars,
  selectedCalendarIds,
  onToggleVisibility,
  enableCalendarTasks,
  onMenuClick,
}: CalendarToolbarProps) {
  const t = useTranslations("calendar");
  const {
    weekStartsOn,
    formatMonthYear,
    formatMonthYearShort,
    formatWeekRange,
    formatWeekRangeShort,
    formatFullDate,
  } = useCalendarLocale();
  const views: CalendarViewMode[] = enableCalendarTasks
    ? ["month", "week", "day", "agenda", "tasks"]
    : ["month", "week", "day", "agenda"];
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
          ? formatMonthYearShort(selectedDate)
          : formatMonthYear(selectedDate);
      case "week": {
        const ws = startOfWeek(selectedDate, { weekStartsOn });
        return isMobile
          ? formatWeekRangeShort(ws)
          : formatWeekRange(ws);
      }
      case "day":
        return isMobile
          ? formatFullDate(selectedDate)
          : formatFullDate(selectedDate);
      case "agenda":
        return isMobile
          ? formatMonthYearShort(selectedDate)
          : formatMonthYear(selectedDate);
      case "tasks":
        return t("views.tasks");
    }
  };

  const [showImportDropdown, setShowImportDropdown] = useState(false);
  const importDropdownRef = useRef<HTMLDivElement>(null);


  useEffect(() => {
    if (!showImportDropdown) return;
    function handleClickOutside(e: MouseEvent) {
      if (importDropdownRef.current && !importDropdownRef.current.contains(e.target as Node)) {
        setShowImportDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showImportDropdown]);



  return (
    <div className={cn("border-b border-border", !isMobile && "flex items-center gap-2 px-4 py-3")}>
      {/* Burger menu (rendered in pages that use a narrow overlay sidebar) */}
      {onMenuClick && !isMobile && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onMenuClick}
          className="h-8 w-8 -ms-1 me-1"
          aria-label={t("nav_open_menu")}
        >
          <Menu className="w-4 h-4" />
        </Button>
      )}
      {/* ── MOBILE TOOLBAR ── */}
      {isMobile && (
        <div className="flex flex-col gap-1 px-2 py-2">
          {/* Row 1: Back / Date nav / Today */}
          <div className="flex items-center gap-1">
            {onMenuClick && (
              <button
                onClick={onMenuClick}
                className="p-1.5 -ms-1 rounded-md hover:bg-muted transition-colors touch-manipulation"
                aria-label={t("nav_open_menu")}
              >
                <Menu className="w-4 h-4" />
              </button>
            )}
            {onNavigateBack && (
              <button
                onClick={onNavigateBack}
                className="p-1.5 -ms-1 rounded-md hover:bg-muted transition-colors touch-manipulation"
                aria-label={t("back_to_month")}
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}
            <button onClick={onPrev} className="p-1.5 rounded-md hover:bg-muted transition-colors touch-manipulation" aria-label={t("nav_prev")}>
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-sm font-semibold text-center flex-1 select-none truncate">
              {getDateLabel()}
            </span>
            <button onClick={onNext} className="p-1.5 rounded-md hover:bg-muted transition-colors touch-manipulation" aria-label={t("nav_next")}>
              <ChevronRight className="w-4 h-4" />
            </button>
            <Button variant="ghost" size="sm" onClick={onToday} className="touch-manipulation text-xs h-7 px-2 ms-0.5">
              {t("views.today")}
            </Button>
          </div>

          {/* Row 2: View switcher pills + calendar toggle */}
          <div className="flex items-center gap-1.5">
            <div className="flex flex-1 border border-border rounded-md overflow-hidden">
              {views.map((v) => (
                <button
                  key={v}
                  onClick={() => onViewModeChange(v)}
                  className={cn(
                    "flex-1 py-1.5 text-[11px] font-medium transition-colors touch-manipulation",
                    v === viewMode
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground active:bg-muted"
                  )}
                >
                  {t(`views.${v}`)}
                </button>
              ))}
            </div>

            {calendars && selectedCalendarIds && onToggleVisibility && (
              <div className="relative" ref={dropdownRef}>
                <button
                  onClick={() => setShowCalendarDropdown((v) => !v)}
                  className={cn(
                    "p-1.5 rounded-md border border-border transition-colors touch-manipulation",
                    showCalendarDropdown ? "bg-muted" : "hover:bg-muted"
                  )}
                  aria-label={t("my_calendars")}
                >
                  <CalendarDays className="w-4 h-4" />
                </button>
                {showCalendarDropdown && (
                  <div className="absolute top-full end-0 mt-1 z-50 bg-popover border border-border rounded-lg shadow-lg p-2 min-w-[180px]">
                    <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 px-1">
                      {t("my_calendars")}
                    </h3>
                    <div className="space-y-0.5">
                      {calendars.filter(c => !c.isShared).map((cal) => {
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
                    {(() => {
                      const shared = calendars.filter(c => c.isShared);
                      const groups = new Map<string, { accountName: string; cals: typeof shared }>();
                      for (const c of shared) {
                        const key = c.accountId || c.accountName || c.id;
                        if (!groups.has(key)) groups.set(key, { accountName: c.accountName || key, cals: [] });
                        groups.get(key)!.cals.push(c);
                      }
                      return Array.from(groups.values()).map((group) => (
                        <div key={group.accountName} className="mt-2">
                          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1 px-1">
                            {group.accountName}
                          </h3>
                          <div className="space-y-0.5">
                            {group.cals.map((cal) => {
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
                      ));
                    })()}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── DESKTOP TOOLBAR ── */}
      {!isMobile && (
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={onToday} className="h-8 me-1">
            {t("views.today")}
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onPrev} aria-label={t("nav_prev")}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onNext} aria-label={t("nav_next")}>
            <ChevronRight className="w-4 h-4" />
          </Button>
          <span className="text-base font-semibold ms-2 select-none">
            {getDateLabel()}
          </span>
        </div>
      )}





      <div className="flex-1" />

      {!isMobile && (
        <div className="flex h-8 border border-border rounded-md overflow-hidden">
          {views.map((v) => (
            <button
              key={v}
              onClick={() => onViewModeChange(v)}
              title={t(`views.${v}_hint`)}
              className={cn(
                "inline-flex items-center px-3 text-xs font-medium transition-colors",
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

      {(onImport || onSubscribe) && !isMobile && (
        <div className="relative" ref={importDropdownRef}>
          <Button variant="outline" size="sm" className="h-8" onClick={() => setShowImportDropdown((v) => !v)}>
            <Upload className="w-4 h-4 me-1" />
            {t("import.title")}
            <ChevronDown className="w-3 h-3 ms-1" />
          </Button>
          {showImportDropdown && (
            <div className="absolute top-full end-0 mt-1 z-50 bg-background border border-border rounded-lg shadow-lg p-1 min-w-[180px]">
              {onImport && (
                <button
                  onClick={() => { onImport(); setShowImportDropdown(false); }}
                  className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm hover:bg-muted transition-colors text-foreground"
                >
                  <Upload className="w-4 h-4" />
                  {t("import.title")}
                </button>
              )}
              {onSubscribe && (
                <button
                  onClick={() => { onSubscribe(); setShowImportDropdown(false); }}
                  className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm hover:bg-muted transition-colors text-foreground"
                >
                  <Globe className="w-4 h-4" />
                  {t("subscription.title")}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {!isMobile && (
        <Button size="sm" className="h-8" onClick={onCreateEvent} data-tour="create-event-button">
          <Plus className="w-4 h-4 me-1" />
          {t("events.create")}
        </Button>
      )}
    </div>
  );
}
