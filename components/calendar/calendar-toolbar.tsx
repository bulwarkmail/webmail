"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ToolbarButton } from "@/components/ui/toolbar";
import { Check, ChevronLeft, ChevronRight, Plus, Upload, CalendarDays, Globe, ChevronDown, ArrowLeft, Menu, MoreVertical, RefreshCw, Search, Printer } from "@/components/icons";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { startOfWeek } from "date-fns";
import { PhoneHeaderActions } from "@/components/layout/phone-header-actions";
import { cn } from "@/lib/utils";
import type { CalendarViewMode } from "@/stores/calendar-store";
import type { Calendar } from "@/lib/jmap/types";
import { useCalendarLocale } from "@/hooks/use-calendar-locale";
import { displayNow } from "@/lib/timezone";
import { useCvdColor } from "@/hooks/use-cvd-color";

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
}: CalendarToolbarProps) {
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const hadMobileSearch = useRef(false);
  useLayoutEffect(() => {
    const wasOpen = hadMobileSearch.current;
    hadMobileSearch.current = !!mobileSearchField;
    if (isMobile && wasOpen && !mobileSearchField && document.activeElement === document.body) {
      searchTrigger.current?.focus();
    }
  }, [isMobile, mobileSearchField]);
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
  const calendarMenu = useContextMenu<true>();
  const renderCalendarToggle = (cal: Calendar) => {
    const isVisible = selectedCalendarIds?.includes(cal.id) ?? false;
    return (
      <button key={cal.id} type="button" role="menuitemcheckbox" aria-checked={isVisible}
        data-menu-label={cal.name} title={cal.name}
        onClick={() => onToggleVisibility?.(cal.id)}
        className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none">
        <span aria-hidden className={cn("h-3.5 w-3.5 shrink-0 rounded-sm border-2", !isVisible && "border-muted-foreground/40")}
          style={isVisible ? {backgroundColor: paint(cal.color || "#3b82f6"), borderColor: paint(cal.color || "#3b82f6")} : undefined}/>
        <span className={cn("min-w-0 flex-1 truncate", !isVisible && "text-muted-foreground")}>{cal.name}</span>
        {isVisible && <Check className="h-4 w-4 shrink-0" aria-hidden/>}
      </button>
    );
  };

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
      <ContextMenu label={t("toolbar.more")} ref={moreMenuRef} isOpen={moreMenu.isOpen} position={moreMenu.position} onClose={closeMoreMenu}>
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
      <div data-memail-calendar-toolbar="" className="min-w-0 shrink-0 border-b border-border">
        <div className="flex flex-col gap-1.5 px-2 py-2">
          {mobileSearchField ? (
            <div className="flex items-center gap-1">
              <IconButton size="icon-lg" label={t("search.close")} onClick={onCloseSearch} className="-ms-1 touch-manipulation"><ArrowLeft/></IconButton>
              <div className="min-w-0 flex-1">{mobileSearchField}</div>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              {onMenuClick && !onNavigateBack && (
                <IconButton size="icon-lg" label={t("nav_open_menu")} onClick={onMenuClick} className="-ms-1 touch-manipulation"><Menu/></IconButton>
              )}
              {onNavigateBack && (
                <IconButton size="icon-lg" label={t("back_to_month")} onClick={onNavigateBack} className="-ms-1 touch-manipulation"><ArrowLeft/></IconButton>
              )}
              <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold"
                title={viewMode === "day" ? formatFullDate(titleDate) : getDateLabel()}>{getDateLabel()}</h2>
              <PhoneHeaderActions below="md" menuItems={phoneMenuItems}/>
            </div>
          )}
          {!mobileSearchField && (
          <div className="flex min-w-0 items-center gap-1">
            {hasDateNav && <>
              <IconButton size="icon-lg" label={t("nav_prev")} onClick={onPrev} className="touch-manipulation"><ChevronLeft/></IconButton>
              <Button variant="outline" size="xs" onClick={onToday} className="min-h-11 touch-manipulation" title={formatFullDate(displayNow())}>{t("views.today")}</Button>
              <IconButton size="icon-lg" label={t("nav_next")} onClick={onNext} className="touch-manipulation"><ChevronRight/></IconButton>
            </>}
            <div className="flex-1"/>
              {onOpenSearch && (
                <IconButton ref={searchTrigger} size="icon-lg" variant="outline" label={t("search.title")} onClick={onOpenSearch} className="touch-manipulation">
                  <Search />
                </IconButton>
              )}
              {calendars && selectedCalendarIds && onToggleVisibility && (
                <>
                  <IconButton size="icon-lg" variant="outline" label={t("my_calendars")}
                    aria-haspopup="menu" aria-expanded={calendarMenu.contextMenu.isOpen}
                    onClick={(event) => calendarMenu.openContextMenuFrom(event.currentTarget, true, "end")}
                    className={cn("touch-manipulation", calendarMenu.contextMenu.isOpen && "bg-muted")}>
                    <CalendarDays />
                  </IconButton>
                  <ContextMenu label={t("my_calendars")} ref={calendarMenu.menuRef}
                    isOpen={calendarMenu.contextMenu.isOpen} position={calendarMenu.contextMenu.position}
                    onClose={calendarMenu.closeContextMenu}>
                    {calendars.filter(cal => !cal.isShared).map(renderCalendarToggle)}
                    {(() => {
                      const groups = new Map<string, {label: string; calendars: Calendar[]}>();
                      for (const cal of calendars.filter(cal => cal.isShared)) {
                        const key = cal.accountId || cal.accountName || cal.id;
                        if (!groups.has(key)) groups.set(key, {label: cal.accountName || key, calendars: []});
                        groups.get(key)!.calendars.push(cal);
                      }
                      return Array.from(groups, ([key, group]) => (
                        <div key={key}>
                          <div className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground" title={group.label}>{group.label}</div>
                          {group.calendars.map(renderCalendarToggle)}
                        </div>
                      ));
                    })()}
                  </ContextMenu>
                </>
              )}
          </div>
          )}
              <div role="radiogroup" aria-label={t("toolbar.select_view", { view: t(`views.${viewMode}`) })}
                className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto rounded-lg border border-border bg-muted/30 p-0.5"
                onKeyDown={(event) => {
                  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
                  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
                  const current = buttons.indexOf(event.target as HTMLButtonElement);
                  if (current < 0) return;
                  const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
                  let next = -1;
                  if (event.key === "Home") next = 0;
                  else if (event.key === "End") next = buttons.length - 1;
                  else if (event.key === "ArrowDown" || event.key === (rtl ? "ArrowLeft" : "ArrowRight")) next = (current + 1) % buttons.length;
                  else if (event.key === "ArrowUp" || event.key === (rtl ? "ArrowRight" : "ArrowLeft")) next = (current - 1 + buttons.length) % buttons.length;
                  if (next < 0) return;
                  event.preventDefault();
                  event.stopPropagation();
                  onViewModeChange(views[next]);
                  buttons[next].focus();
                  buttons[next].scrollIntoView?.({block: "nearest", inline: "nearest"});
                }}>
                {views.map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={v === viewMode}
                    tabIndex={v === viewMode ? 0 : -1}
                    onClick={() => onViewModeChange(v)}
                    className={cn(
                      "flex-auto shrink-0 min-h-11 rounded-md px-2 text-[0.6875rem] font-medium transition-colors touch-manipulation",
                      v === viewMode
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground active:bg-muted"
                    )}
                  >
                    {t(`views.${v}`)}
                  </button>
                ))}
              </div>
        </div>
      </div>
    );
  }

  const currentViewLabel = t(`views.${viewMode}`);

  return (
    <div data-memail-calendar-header="" className="min-w-0 shrink-0">
    <div data-memail-calendar-toolbar="" className="flex min-w-0 items-center gap-1 px-3 h-14 box-content border-b border-border">
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

      {searchField && <div data-memail-calendar-search="" className="min-w-0">{searchField}</div>}

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
        <ContextMenu label={t("toolbar.select_view", { view: currentViewLabel })} ref={viewMenuRef} isOpen={viewMenu.isOpen} position={viewMenu.position} onClose={closeViewMenu}>
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
              <span>{t(`views.${v}`)}</span>
              {/* The key, on devices with a keyboard (R8). */}
              <kbd className="font-sans text-xs text-muted-foreground pointer-coarse:hidden">{VIEW_SHORTCUTS[v]}</kbd>
            </button>
          ))}
        </ContextMenu>
      </div>
    </div>
    </div>
  );
}
