"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ToolbarButton } from "@/components/ui/toolbar";
import { ChevronLeft, ChevronRight, Plus, Upload, CalendarDays, Globe, ChevronDown, ArrowLeft, Menu, MoreVertical, RefreshCw, Search, Printer } from "@/components/icons";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator, MenuShortcut } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { startOfWeek } from "date-fns";
import { PhoneHeaderActions } from "@/components/layout/phone-header-actions";
import { cn } from "@/lib/utils";
import type { CalendarViewMode } from "@/stores/calendar-store";
import type { Calendar } from "@/lib/jmap/types";
import { useCalendarLocale } from "@/hooks/use-calendar-locale";
import { displayNow } from "@/lib/timezone";
import { useCvdColor } from "@/hooks/use-cvd-color";
import { useCollectionNames } from "@/hooks/use-collection-names";

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
  /** The create button's name: what it makes in the current view. */
  createLabel?: string;
  onImport?: () => void;
  onSubscribe?: () => void;
  /** Reload calendars, events and subscriptions. */
  onRefresh?: () => void;
  /** Print the view with the dates on screen. */
  onPrint?: () => void;
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
  /** The burger shows and hides the sidebar beside the grid, rather than opening it over it. */
  menuTogglesSidebar?: boolean;
  /**
   * Show a compact create button in the bar. The full "Create" button lives
   * at the top of the sidebar, so this is only needed while it is hidden.
   */
  showCreateButton?: boolean;
  /** The search box, shown before the ⋮ on wider screens. */
  searchField?: ReactNode;
  /** Phones: opens the search row in place of the date row. */
  onOpenSearch?: () => void;
  /** Phones: the open search row's field; null while it is closed. */
  mobileSearchField?: ReactNode;
  /** Phones: closes the search row. */
  onCloseSearch?: () => void;
  /** The plugin side panel's button, at the very end of the row (desktop and tablet). */
  panelToggle?: ReactNode;
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
  createLabel,
  onImport,
  onSubscribe,
  onRefresh,
  onPrint,
  isMobile,
  firstDayOfWeek = 1,
  onNavigateBack,
  calendars,
  selectedCalendarIds,
  onToggleVisibility,
  enableCalendarTasks,
  onMenuClick,
  sidebarOpen,
  menuTogglesSidebar,
  showCreateButton,
  searchField,
  onOpenSearch,
  mobileSearchField,
  onCloseSearch,
  panelToggle,
}: CalendarToolbarProps) {
  const shownName = useCollectionNames();
  const t = useTranslations("calendar");
  const paint = useCvdColor();
  const tCommon = useTranslations("common");
  const {
    weekStartsOn,
    formatMonthYear,
    formatMonthYearShort,
    formatWeekRange,
    formatWeekRangeShort,
    formatFullDate,
    formatDayShort,
  } = useCalendarLocale();
  const views: CalendarViewMode[] = enableCalendarTasks
    ? ["month", "week", "day", "agenda", "tasks"]
    : ["month", "week", "day", "agenda"];
  // Desktop view menu, in the order Google Calendar lists them.
  const menuViews: CalendarViewMode[] = enableCalendarTasks
    ? ["day", "week", "month", "agenda", "tasks"]
    : ["day", "week", "month", "agenda"];
  const {
    contextMenu: viewMenu,
    openContextMenuFrom: openViewMenuFrom,
    closeContextMenu: closeViewMenu,
    menuRef: viewMenuRef,
  } = useContextMenu<true>();
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
        // A phone's row has room for "Oct 28"; the full date is the tooltip.
        return isMobile
          ? formatDayShort(titleDate)
          : formatFullDate(titleDate);
      case "agenda":
        return isMobile
          ? formatMonthYearShort(titleDate)
          : formatMonthYear(titleDate);
      case "tasks":
        return t("views.tasks");
    }
  };

  // Tasks have no dates to step through.
  const hasDateNav = viewMode !== "tasks";

  // The ⋮ menu: what the calendar as a whole offers.
  const {
    contextMenu: moreMenu,
    openContextMenuFrom: openMoreMenuFrom,
    closeContextMenu: closeMoreMenu,
    menuRef: moreMenuRef,
  } = useContextMenu<true>();
  const hasMoreMenu = !!(onImport || onSubscribe || onRefresh || onPrint);
  const pick = (fn: () => void) => () => { closeMoreMenu(); fn(); };
  const moreButton = hasMoreMenu ? (
    <>
      <ToolbarButton
        label={t("toolbar.more")}
        active={moreMenu.isOpen}
        onClick={(e) => openMoreMenuFrom(e.currentTarget, true, "end")}
        aria-haspopup="menu"
        aria-expanded={moreMenu.isOpen}
      >
        <MoreVertical />
      </ToolbarButton>
      <ContextMenu ref={moreMenuRef} isOpen={moreMenu.isOpen} position={moreMenu.position} onClose={closeMoreMenu}>
        {onImport && <ContextMenuItem icon={Upload} label={t("toolbar.import")} onClick={pick(onImport)} />}
        {onSubscribe && <ContextMenuItem icon={Globe} label={t("toolbar.subscribe")} onClick={pick(onSubscribe)} />}
        {onRefresh && (onImport || onSubscribe) && <ContextMenuSeparator />}
        {onRefresh && <ContextMenuItem icon={RefreshCw} label={tCommon("refresh")} onClick={pick(onRefresh)} />}
        {onPrint && <ContextMenuItem icon={Printer} label={tCommon("print")} onClick={pick(onPrint)} />}
      </ContextMenu>
    </>
  ) : null;
  // The same entries in the phone header's ⋮.
  const phoneMenuItems = hasMoreMenu ? (close: () => void) => (
    <>
      {onImport && <ContextMenuItem icon={Upload} label={t("toolbar.import")} onClick={() => { close(); onImport(); }} />}
      {onSubscribe && <ContextMenuItem icon={Globe} label={t("toolbar.subscribe")} onClick={() => { close(); onSubscribe(); }} />}
      {onRefresh && <ContextMenuItem icon={RefreshCw} label={tCommon("refresh")} onClick={() => { close(); onRefresh(); }} />}
      {onPrint && <ContextMenuItem icon={Printer} label={tCommon("print")} onClick={() => { close(); onPrint(); }} />}
    </>
  ) : undefined;




  if (isMobile) {
    return (
      <div className="border-b border-border">
        {/* ── MOBILE TOOLBAR ── */}
        {isMobile && (
          <div data-window-top-row="" className="flex flex-col gap-1 px-2 py-2">
            {/* Row 1 while searching: the search box with a way back. */}
            {mobileSearchField ? (
              <div className="flex items-center gap-1">
                <IconButton size="icon-lg" label={t("search.close")} onClick={onCloseSearch} className="-ms-1 touch-manipulation">
                  <ArrowLeft />
                </IconButton>
                <div className="flex-1 min-w-0">{mobileSearchField}</div>
              </div>
            ) : (
            /* Row 1: Back / Date nav / Today. Below 400px (25rem, so a larger
               text size counts too) the period title takes a line of its own
               above the buttons: beside them it was cut to one letter. */
            <div className="flex flex-wrap items-center gap-1">
              {/* The way back to the month takes the menu's place: both left the date no room. */}
              {onMenuClick && !onNavigateBack && (
                <IconButton size="icon-lg" label={t("nav_open_menu")} onClick={onMenuClick} className="-ms-1 touch-manipulation">
                  <Menu />
                </IconButton>
              )}
              {onNavigateBack && (
                <IconButton size="icon-lg" label={t("back_to_month")} onClick={onNavigateBack} className="-ms-1 touch-manipulation">
                  <ArrowLeft />
                </IconButton>
              )}
              {hasDateNav && (
                <IconButton size="icon-lg" label={t("nav_prev")} onClick={onPrev} className="touch-manipulation">
                  <ChevronLeft />
                </IconButton>
              )}
              <span
                className="text-sm font-semibold text-center flex-1 select-none truncate max-[25rem]:order-first max-[25rem]:basis-full max-[25rem]:ps-1 max-[25rem]:text-start"
                title={viewMode === "day" ? formatFullDate(titleDate) : getDateLabel()}
              >
                {getDateLabel()}
              </span>
              {hasDateNav && (
                <>
                  <IconButton size="icon-lg" label={t("nav_next")} onClick={onNext} className="touch-manipulation">
                    <ChevronRight />
                  </IconButton>
                  <Button variant="ghost" size="xs" onClick={onToday} className="touch-manipulation ms-0.5">
                    {t("views.today")}
                  </Button>
                </>
              )}
              {/* The shell's phone ⋮ (notifications, palette, account) with the calendar's own entries on top. */}
              <PhoneHeaderActions below="md" menuItems={phoneMenuItems} />
            </div>
            )}

            {/* Row 2: View switcher pills + calendar toggle */}
            {/* Each pill is as wide as its label plus an even share of the rest, so a
                long label ("جدول الأعمال", "Aufgaben") neither wraps nor touches the edge. */}
            <div className="flex items-center gap-1.5">
              {/* Past the row's room (Finnish, a large text size) the pills scroll rather than slide under the buttons. */}
              <div className="flex flex-1 min-w-0 border border-border rounded-md overflow-x-auto scroll-hidden">
                {views.map((v) => (
                  <button
                    key={v}
                    onClick={() => onViewModeChange(v)}
                    className={cn(
                      "flex-auto shrink-0 whitespace-nowrap min-h-11 px-1.5 text-[0.6875rem] font-medium transition-colors touch-manipulation",
                      v === viewMode
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground active:bg-muted"
                    )}
                  >
                    {t(`views.${v}`)}
                  </button>
                ))}
              </div>

              {/* Beside the calendar filter: the date row has no room left. */}
              {onOpenSearch && (
                <IconButton size="icon-lg" variant="outline" label={t("search.title")} onClick={onOpenSearch} className="touch-manipulation">
                  <Search />
                </IconButton>
              )}
              {/* On the smallest phones the view names need its room; the drawer lists the calendars too. */}
              {calendars && selectedCalendarIds && onToggleVisibility && (
                <div className="relative max-[22.5rem]:hidden" ref={dropdownRef}>
                  <IconButton
                    size="icon-lg"
                    variant="outline"
                    label={t("my_calendars")}
                    aria-expanded={showCalendarDropdown}
                    onClick={() => setShowCalendarDropdown((v) => !v)}
                    className={cn("touch-manipulation", showCalendarDropdown && "bg-muted")}
                  >
                    <CalendarDays />
                  </IconButton>
                  {showCalendarDropdown && (
                    <div className="absolute top-full end-0 mt-1 z-50 bg-popover border border-border rounded-lg shadow-lg p-2 min-w-[180px]">
                      <h3 className="text-xs font-medium text-muted-foreground mb-2 px-1">
                        {t("my_calendars")}
                      </h3>
                      <div className="space-y-0.5">
                        {calendars.filter(c => !c.isShared).map((cal) => {
                          const isVisible = selectedCalendarIds.includes(cal.id);
                          const color = paint(cal.color || "#3b82f6");
                          return (
                            <button
                              key={cal.id}
                              onClick={() => onToggleVisibility(cal.id)}
                              className={cn(
                                "flex items-center gap-2 w-full px-2 min-h-11 rounded-md text-sm transition-colors duration-150 touch-manipulation",
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
                              <span className={cn("truncate", !isVisible && "text-muted-foreground")} title={shownName.calendar(cal)}>
                                {shownName.calendar(cal)}
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
                            <h3 className="text-xs font-medium text-muted-foreground mb-1 px-1">
                              {group.accountName}
                            </h3>
                            <div className="space-y-0.5">
                              {group.cals.map((cal) => {
                                const isVisible = selectedCalendarIds.includes(cal.id);
                                const color = paint(cal.color || "#3b82f6");
                                return (
                                  <button
                                    key={cal.id}
                                    onClick={() => onToggleVisibility(cal.id)}
                                    className={cn(
                                      "flex items-center gap-2 w-full px-2 min-h-11 rounded-md text-sm transition-colors duration-150 touch-manipulation",
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
                                    <span className={cn("truncate", !isVisible && "text-muted-foreground")} title={shownName.calendar(cal)}>
                                      {shownName.calendar(cal)}
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
    <div className="flex items-center gap-1 px-3 h-14 box-content border-b border-border flex-shrink-0">
      {onMenuClick && (
        <ToolbarButton
          label={menuTogglesSidebar ? t(sidebarOpen ? "nav_hide_sidebar" : "nav_show_sidebar") : t("nav_open_menu")}
          onClick={onMenuClick}
          className="me-1"
          aria-expanded={sidebarOpen}
        >
          <Menu />
        </ToolbarButton>
      )}
      {showCreateButton && (
        <ToolbarButton
          label={createLabel ?? t("events.create")}
          onClick={onCreateEvent}
          data-tour="create-event-button"
        >
          <Plus />
        </ToolbarButton>
      )}
      {hasDateNav && (
        <>
          <Button
            variant="outline"
            size="xs"
            onClick={onToday}
            className="me-1"
            title={formatFullDate(displayNow())}
          >
            {t("views.today")}
          </Button>
          <ToolbarButton label={t("nav_prev")} onClick={onPrev}>
            <ChevronLeft />
          </ToolbarButton>
          <ToolbarButton label={t("nav_next")} onClick={onNext}>
            <ChevronRight />
          </ToolbarButton>
        </>
      )}
      <h1 className="ms-2 text-base font-semibold truncate select-none" title={getDateLabel()}>
        {getDateLabel()}
      </h1>

      <div className="flex-1" />

      {searchField}

      {moreButton}

      <div className="relative ms-1">
        <Button
          variant="outline"
          size="xs"
          className="gap-1"
          onClick={(e) => openViewMenuFrom(e.currentTarget, true, "end")}
          aria-haspopup="menu"
          aria-expanded={viewMenu.isOpen}
          aria-label={t("toolbar.select_view", { view: currentViewLabel })}
          data-testid="calendar-view-menu"
        >
          {currentViewLabel}
          <ChevronDown className="w-3 h-3" />
        </Button>
        <ContextMenu ref={viewMenuRef} isOpen={viewMenu.isOpen} position={viewMenu.position} onClose={closeViewMenu}>
          {menuViews.map((v) => (
            <button
              key={v}
              type="button"
              role="menuitemradio"
              aria-checked={v === viewMode}
              onClick={() => { closeViewMenu(); onViewModeChange(v); }}
              className={cn(
                "flex items-center justify-between gap-6 w-full px-3 py-2 rounded-md text-sm transition-colors outline-none focus-visible:bg-accent",
                v === viewMode ? "bg-accent text-accent-foreground font-medium" : "hover:bg-muted text-foreground",
              )}
            >
              <span data-menu-label="">{t(`views.${v}`)}</span>
              {/* The key, on devices with a keyboard (R8). */}
              <MenuShortcut keys={VIEW_SHORTCUTS[v]} />
            </button>
          ))}
        </ContextMenu>
      </div>

      {/* The row is px-3; the margin puts the button where the reader has it (px-4, lg:px-6). */}
      {panelToggle && <div className="flex items-center ms-1 me-1 lg:me-3" data-panel-toggle-slot="">{panelToggle}</div>}
    </div>
  );
}
