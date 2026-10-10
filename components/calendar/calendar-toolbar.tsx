"use client";

import { useState, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Plus, Upload, CalendarDays, Globe, ChevronDown, ArrowLeft, Menu, MoreVertical } from "@/components/icons";
import { startOfWeek } from "date-fns";
import { cn } from "@/lib/utils";
import type { CalendarViewMode } from "@/stores/calendar-store";
import type { Calendar } from "@/lib/jmap/types";
import { useCalendarLocale } from "@/hooks/use-calendar-locale";
import { displayNow } from "@/lib/timezone";

interface CalendarToolbarProps {
  selectedDate: Date;
  /** Day at the top / start of the scrolled view, when it differs from the selection. */
  visibleDate?: Date | null;
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
  /** Show a burger button at the start that shows or hides the sidebar. */
  onMenuClick?: () => void;
  /** Whether the sidebar is currently shown (for the burger's aria-expanded). */
  sidebarOpen?: boolean;
  /**
   * Show a compact create button in the bar. The full "Create" button lives
   * at the top of the sidebar, so this is only needed while it is hidden.
   */
  showCreateButton?: boolean;
}

// Shortcut keys handled by the calendar app (see its keydown handler).
const VIEW_SHORTCUTS: Record<CalendarViewMode, string> = {
  day: "D",
  week: "W",
  month: "M",
  agenda: "A",
  tasks: "K",
};

export function CalendarToolbar({
  selectedDate,
  visibleDate,
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
  sidebarOpen,
  showCreateButton,
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
  // Desktop view menu, in the order Google Calendar lists them.
  const menuViews: CalendarViewMode[] = enableCalendarTasks
    ? ["day", "week", "month", "agenda", "tasks"]
    : ["day", "week", "month", "agenda"];
  const [showViewMenu, setShowViewMenu] = useState(false);
  const viewMenuRef = useRef<HTMLDivElement>(null);
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

  // The views scroll freely (#759): while the user has scrolled away from
  // the selected day, the title describes what is on screen instead.
  const titleDate = visibleDate ?? selectedDate;
  const getDateLabel = (): string => {
    switch (viewMode) {
      case "month":
        return isMobile
          ? formatMonthYearShort(titleDate)
          : formatMonthYear(titleDate);
      case "week": {
        // A reported visible date is the first column in view; the selected
        // day is shown from the start of its week.
        const ws = visibleDate ?? startOfWeek(selectedDate, { weekStartsOn });
        return isMobile
          ? formatWeekRangeShort(ws)
          : formatWeekRange(ws);
      }
      case "day":
        return isMobile
          ? formatFullDate(titleDate)
          : formatFullDate(titleDate);
      case "agenda":
        return isMobile
          ? formatMonthYearShort(titleDate)
          : formatMonthYear(titleDate);
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

  useEffect(() => {
    if (!showViewMenu && !showImportDropdown) return;
    function handleClickOutside(e: MouseEvent) {
      if (viewMenuRef.current && !viewMenuRef.current.contains(e.target as Node)) {
        setShowViewMenu(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setShowViewMenu(false);
        setShowImportDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [showViewMenu, showImportDropdown]);



  if (isMobile) {
    return (
      <div className="border-b border-border">
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
      </div>
    );
  }

  const currentViewLabel = t(`views.${viewMode}`);

  return (
    <div className="flex items-center gap-1 h-16 px-3 border-b border-border">
      {onMenuClick && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onMenuClick}
          className="h-10 w-10 rounded-full text-muted-foreground hover:text-foreground"
          aria-label={t("nav_open_menu")}
          aria-expanded={sidebarOpen}
        >
          <Menu className="w-5 h-5" />
        </Button>
      )}
      {showCreateButton && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onCreateEvent}
          className="h-10 w-10 rounded-full text-primary"
          aria-label={t("events.create")}
          title={t("events.create")}
          data-tour="create-event-button"
        >
          <Plus className="w-5 h-5" />
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={onToday}
        className="h-9 rounded-full px-5 ms-2 me-2 border-border font-medium"
        title={formatFullDate(displayNow())}
      >
        {t("views.today")}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9 rounded-full text-muted-foreground hover:text-foreground"
        onClick={onPrev}
        aria-label={t("nav_prev")}
      >
        <ChevronLeft className="w-5 h-5 rtl:rotate-180" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-9 w-9 rounded-full text-muted-foreground hover:text-foreground"
        onClick={onNext}
        aria-label={t("nav_next")}
      >
        <ChevronRight className="w-5 h-5 rtl:rotate-180" />
      </Button>
      <h1 className="ms-3 text-[22px] leading-7 font-normal text-foreground truncate select-none">
        {getDateLabel()}
      </h1>

      <div className="flex-1" />

      {(onImport || onSubscribe) && (
        <div className="relative" ref={importDropdownRef}>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "h-10 w-10 rounded-full text-muted-foreground hover:text-foreground",
              showImportDropdown && "bg-accent text-foreground",
            )}
            onClick={() => setShowImportDropdown((v) => !v)}
            aria-label={t("toolbar.more")}
            title={t("toolbar.more")}
            aria-haspopup="menu"
            aria-expanded={showImportDropdown}
          >
            <MoreVertical className="w-5 h-5" />
          </Button>
          {showImportDropdown && (
            <div
              role="menu"
              className="absolute top-full end-0 mt-1 z-50 bg-popover text-popover-foreground border border-border rounded-lg shadow-lg py-1.5 min-w-[220px]"
            >
              {onImport && (
                <button
                  role="menuitem"
                  onClick={() => { onImport(); setShowImportDropdown(false); }}
                  className="flex items-center gap-3 w-full px-4 py-2 text-sm hover:bg-muted transition-colors text-foreground"
                >
                  <Upload className="w-4 h-4 text-muted-foreground" />
                  {t("import.title")}
                </button>
              )}
              {onSubscribe && (
                <button
                  role="menuitem"
                  onClick={() => { onSubscribe(); setShowImportDropdown(false); }}
                  className="flex items-center gap-3 w-full px-4 py-2 text-sm hover:bg-muted transition-colors text-foreground"
                >
                  <Globe className="w-4 h-4 text-muted-foreground" />
                  {t("subscription.title")}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="relative ms-1" ref={viewMenuRef}>
        <Button
          variant="outline"
          size="sm"
          className="h-9 rounded-full ps-4 pe-3 gap-1.5 border-border font-medium"
          onClick={() => setShowViewMenu((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={showViewMenu}
          aria-label={t("toolbar.select_view", { view: currentViewLabel })}
          data-testid="calendar-view-menu"
        >
          {currentViewLabel}
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        </Button>
        {showViewMenu && (
          <div
            role="menu"
            className="absolute top-full end-0 mt-1 z-50 bg-popover text-popover-foreground border border-border rounded-lg shadow-lg py-1.5 min-w-[180px]"
          >
            {menuViews.map((v) => (
              <button
                key={v}
                role="menuitemradio"
                aria-checked={v === viewMode}
                onClick={() => { onViewModeChange(v); setShowViewMenu(false); }}
                className={cn(
                  "flex items-center justify-between gap-6 w-full px-4 py-2 text-sm transition-colors",
                  v === viewMode ? "bg-primary/10 text-foreground" : "hover:bg-muted text-foreground",
                )}
              >
                <span>{t(`views.${v}`)}</span>
                <kbd className="font-sans text-xs text-muted-foreground">{VIEW_SHORTCUTS[v]}</kbd>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
