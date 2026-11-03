/**
 * The calendar page as a skeleton: sidebar with the mini month, toolbar and
 * the grid of the view the URL or the last visit picked
 * (`data-boot-calendar-view`). Class lists mirror the real components
 * (components/calendar/calendar-app.tsx, calendar-toolbar.tsx,
 * mini-calendar.tsx, calendar-sidebar-panel.tsx and the views), and the
 * sizes the views measure at run time (hour rows, week rows, columns) come
 * from the `.sk-cal-*` rules in app/boot-skeleton.css.
 *
 * Dates, weekday names, hour labels and the title depend on the time zone,
 * the first day of the week, the time format and the language, so they are
 * placeholders; the icons are drawn for real.
 */
import type { ReactNode } from "react";
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ListTodo,
  Menu,
  MoreVertical,
  Plus,
  Search,
  UnfoldVertical,
} from "@/components/icons";
import type { CalendarViewMode } from "@/stores/calendar-store";
import { cn } from "@/lib/cn";
import { Bar, Block, Circle, repeat, textWidth } from "./kit";
import { AppShellSkeleton, type RailLabels } from "./shell";

export interface CalendarSkeletonProps {
  /** common.loading */
  label?: string;
  /** Rail labels for the phone bottom bar (sidebar.*). */
  labels?: RailLabels;
  /** The calendar's own words, translated by the caller. */
  text?: CalendarSkeletonText;
}

/**
 * Words of the calendar's chrome that are the same before and after the app
 * loads (they depend on the language only). Placeholders where one is missing.
 */
export interface CalendarSkeletonText {
  /** calendar.title: the sidebar's heading. */
  title?: string;
  /** calendar.views.today */
  today?: string;
  /** calendar.search.title: the search field's placeholder. */
  search?: string;
  /** calendar.views.<view>: the view menu button and the phone's pills. */
  views?: Record<CalendarViewMode, string>;
  /** calendar.tasks.label: the sidebar's tasks entry. */
  tasks?: string;
  /** calendar.tasks.filter_all, _pending, _completed, _overdue */
  taskFilters?: [string, string, string, string];
  /** calendar.tasks.create */
  newTask?: string;
  /** calendar.tasks.quick_add_placeholder */
  quickAdd?: string;
}

const MODES: CalendarViewMode[] = ["month", "week", "day", "agenda", "tasks"];

/** The skeleton's words from a translator for the "calendar" namespace. */
export function calendarSkeletonText(t: (key: string) => string): CalendarSkeletonText {
  return {
    title: t("title"),
    today: t("views.today"),
    search: t("search.title"),
    views: {
      month: t("views.month"),
      week: t("views.week"),
      day: t("views.day"),
      agenda: t("views.agenda"),
      tasks: t("views.tasks"),
    },
    tasks: t("tasks.label"),
    taskFilters: [t("tasks.filter_all"), t("tasks.filter_pending"), t("tasks.filter_completed"), t("tasks.filter_overdue")],
    newTask: t("tasks.create"),
    quickAdd: t("tasks.quick_add_placeholder"),
  };
}

/** Shown for the view on <html>. */
const VIEW_SHOWN: Record<CalendarViewMode, string> = {
  month: "hidden boot-cal-month:flex",
  week: "hidden boot-cal-week:flex",
  day: "hidden boot-cal-day:flex",
  agenda: "hidden boot-cal-agenda:flex",
  tasks: "hidden boot-cal-tasks:flex",
};

/** The view menu button's label for the view on <html>. */
const VIEW_LABEL: Record<CalendarViewMode, string> = {
  month: "hidden boot-cal-month:inline",
  week: "hidden boot-cal-week:inline",
  day: "hidden boot-cal-day:inline",
  agenda: "hidden boot-cal-agenda:inline",
  tasks: "hidden boot-cal-tasks:inline",
};

/** The phone's view pill drawn as current. */
const PILL_ON: Record<CalendarViewMode, string> = {
  month: "boot-cal-month:bg-primary boot-cal-month:text-primary-foreground",
  week: "boot-cal-week:bg-primary boot-cal-week:text-primary-foreground",
  day: "boot-cal-day:bg-primary boot-cal-day:text-primary-foreground",
  agenda: "boot-cal-agenda:bg-primary boot-cal-agenda:text-primary-foreground",
  // Only there when tasks are on.
  tasks: "hidden boot-cal-tasks-on:flex boot-cal-tasks:bg-primary boot-cal-tasks:text-primary-foreground",
};

/** Tasks have no dates to step through and no events to search. */
const NOT_TASKS = "boot-cal-tasks:hidden";

/** ToolbarButton (components/ui/toolbar.tsx): a 32px muted icon button. */
function ToolbarIcon({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("flex items-center justify-center h-8 w-8 shrink-0 rounded-md text-muted-foreground [&_svg]:size-4", className)}>
      {children}
    </span>
  );
}

/** IconButton size icon-lg: the phone toolbar's 44px buttons. */
function PhoneIcon({ outline, className, children }: { outline?: boolean; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "flex items-center justify-center h-11 w-11 shrink-0 rounded-md [&_svg]:size-5",
        outline && "border border-input bg-background",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** An outline xs button (Today, the view menu). */
function OutlineButton({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <span className={cn("flex items-center gap-1 h-8 px-2.5 shrink-0 rounded-md border border-input bg-background text-sm font-medium", className)}>
      {children}
    </span>
  );
}

/** A word when the caller has it, else a placeholder as wide as a short one. */
function Word({ text, w }: { text?: string; w: string }) {
  return text ? <span className="whitespace-nowrap">{text}</span> : <Bar className="h-2.5" w={w} />;
}

/** A placeholder bar in a line box of the given height class. */
function Line({ className, bar, w }: { className: string; bar: string; w: string }) {
  return (
    <span className={cn("flex items-center", className)}>
      <Bar className={bar} w={w} />
    </span>
  );
}

/** The toolbar's title: a date range (a placeholder), or "Tasks" in the tasks view. */
function Title({ tasks, w }: { tasks?: string; w: string }) {
  return (
    <>
      <Bar className={cn("h-3", tasks && "boot-cal-tasks:hidden")} w={w} />
      {tasks ? <span className="hidden boot-cal-tasks:inline truncate">{tasks}</span> : null}
    </>
  );
}

/** CalendarToolbar: the 57px desktop and tablet row, the two-row phone header. */
function ToolbarSkeleton({ text }: { text?: CalendarSkeletonText }) {
  const views = text?.views;
  return (
    <>
      <div data-window-row-right="" className="hidden md:flex items-center gap-1 px-3 h-14 box-content border-b border-border flex-shrink-0">
        <ToolbarIcon className="me-1">
          <Menu />
        </ToolbarIcon>
        {/* The sidebar's "+" stands in for this one while the sidebar shows. */}
        <ToolbarIcon className="lg:hidden lg:boot-cal-collapsed:flex">
          <Plus />
        </ToolbarIcon>
        <OutlineButton className={cn("me-1", NOT_TASKS)}>
          <Word text={text?.today} w="2.5rem" />
        </OutlineButton>
        <ToolbarIcon className={NOT_TASKS}>
          <ChevronLeft />
        </ToolbarIcon>
        <ToolbarIcon className={NOT_TASKS}>
          <ChevronRight />
        </ToolbarIcon>
        <span className="flex items-center ms-2 h-6 min-w-0 text-base font-semibold">
          <Title tasks={views?.tasks} w="9rem" />
        </span>
        <div className="flex-1" />
        <span
          className={cn(
            "relative flex items-center w-40 lg:w-56 xl:w-64 me-1 h-8 ps-8 pe-8 shrink-0 rounded-md border border-input bg-background",
            NOT_TASKS,
          )}
        >
          <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          {text?.search ? (
            <span className="text-sm text-muted-foreground truncate">{text.search}</span>
          ) : (
            <Bar className="h-2.5" w="6rem" />
          )}
          <span className="absolute end-1 top-1/2 -translate-y-1/2 mx-1 rounded border border-border px-1.5 font-sans text-[0.6875rem] leading-4 text-muted-foreground pointer-coarse:hidden">
            /
          </span>
        </span>
        <ToolbarIcon>
          <MoreVertical />
        </ToolbarIcon>
        <OutlineButton className="ms-1">
          {views ? MODES.map((v) => <span key={v} className={VIEW_LABEL[v]}>{views[v]}</span>) : <Bar className="h-2.5" w="2.25rem" />}
          <ChevronDown className="w-3 h-3" />
        </OutlineButton>
      </div>

      <div className="md:hidden border-b border-border">
        <div className="flex flex-col gap-1 px-2 py-2">
          <div className="flex flex-wrap items-center gap-1">
            <PhoneIcon className="-ms-1">
              <Menu />
            </PhoneIcon>
            <PhoneIcon className={NOT_TASKS}>
              <ChevronLeft />
            </PhoneIcon>
            {/* Below 400px the title takes a line of its own. */}
            <span className="flex flex-1 items-center justify-center h-5 min-w-0 text-sm font-semibold max-[25rem]:order-first max-[25rem]:basis-full max-[25rem]:ps-1 max-[25rem]:justify-start">
              <Title tasks={views?.tasks} w="5rem" />
            </span>
            <PhoneIcon className={NOT_TASKS}>
              <ChevronRight />
            </PhoneIcon>
            <span className={cn("flex items-center h-8 px-2.5 ms-0.5 shrink-0 text-sm font-medium", NOT_TASKS)}>
              <Word text={text?.today} w="2.25rem" />
            </span>
            {/* PhoneHeaderActions: the shell's ⋮ and the account avatar. */}
            <div className="flex items-center gap-1 flex-shrink-0 ms-auto">
              <PhoneIcon>
                <MoreVertical />
              </PhoneIcon>
              <span className="flex items-center justify-center w-10 h-10 pointer-coarse:w-11 pointer-coarse:h-11">
                <Circle className="w-8 h-8" />
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="flex flex-1 border border-border rounded-md overflow-hidden">
              {MODES.map((v) => (
                <span
                  key={v}
                  className={cn("flex flex-auto items-center justify-center min-h-11 px-1.5 text-[0.6875rem] font-medium text-muted-foreground", PILL_ON[v])}
                >
                  {views ? views[v] : <Bar className="h-2" w="2rem" />}
                </span>
              ))}
            </div>
            <PhoneIcon outline className={NOT_TASKS}>
              <Search />
            </PhoneIcon>
            <PhoneIcon outline>
              <CalendarDays />
            </PhoneIcon>
          </div>
        </div>
      </div>
    </>
  );
}

/** The inline sidebar of a desktop: header, mini month and calendar list. */
function SidebarSkeleton({ text }: { text?: CalendarSkeletonText }) {
  const weekNumberCell = <span className="hidden boot-cal-weeknums:block" />;
  const columns = "grid grid-cols-7 boot-cal-weeknums:grid-cols-[1.25rem_repeat(7,minmax(0,1fr))]";
  const chevron = "flex items-center justify-center h-8 w-8 [&_svg]:size-4";
  return (
    <div
      className="hidden lg:flex lg:boot-cal-collapsed:hidden flex-col border-e border-border bg-secondary overflow-hidden flex-shrink-0"
      style={{ width: "var(--boot-cal-sidebar-w, 256px)" }}
    >
      {/* CalendarSidebarHeader */}
      <div className="px-3 h-14 box-content border-b border-border flex items-center justify-between flex-shrink-0">
        {text?.title ? (
          <span className="text-sm font-semibold truncate">{text.title}</span>
        ) : (
          <Bar className="h-3" w="4.5rem" />
        )}
        <span className="flex items-center justify-center h-8 w-8 shrink-0">
          <Plus className="w-4 h-4" />
        </span>
      </div>
      <div className="flex-1 overflow-hidden py-3">
        {/* MiniCalendar */}
        <div className="px-3">
          <div className="flex items-center justify-between mb-2 text-muted-foreground">
            <span className={chevron}>
              <ChevronLeft />
            </span>
            <span className="inline-flex items-center gap-1 h-7 px-2">
              <Bar className="h-3" w="6.5rem" />
              <ChevronDown className="w-3.5 h-3.5" />
            </span>
            <span className={chevron}>
              <ChevronRight />
            </span>
          </div>
          <div className={columns}>
            {weekNumberCell}
            {repeat(7, () => (
              <Line className="justify-center h-[0.9375rem] my-1" bar="h-1.5" w="0.875rem" />
            ))}
          </div>
          {/* 4 to 6 weeks: as many as the month has (--boot-cal-mini-rows). */}
          <div className={cn(columns, "sk-cal-mini-days overflow-hidden auto-rows-[1.75rem] pointer-coarse:auto-rows-[2.75rem] items-center justify-items-center")}>
            {repeat(6, () => (
              <>
                {weekNumberCell}
                {repeat(7, () => <Bar className="h-2" w="0.75rem" />)}
              </>
            ))}
          </div>
        </div>
        {/* CalendarSidebarPanel: one section of calendars. */}
        <div className="mt-4">
          {/* The tasks entry, when tasks are on. */}
          <div
            className="hidden boot-cal-tasks-on:flex items-center gap-2 px-3 mb-2 min-h-8 pointer-coarse:min-h-11 text-sm"
            style={{ paddingBlock: "var(--density-sidebar-py, 4px)" }}
          >
            <ListTodo className="w-4 h-4 text-muted-foreground" />
            <Word text={text?.tasks} w="3rem" />
          </div>
          {/* A section header, its add button taking the row to 32px. */}
          <div className="flex items-center gap-1 px-3 h-8 text-muted-foreground">
            <ChevronDown className="w-3 h-3 flex-shrink-0" />
            <Bar className="h-2" w="4rem" />
          </div>
          {repeat(4, (i) => (
            <div
              className="flex items-center gap-2 ps-5 pe-3 min-h-8 pointer-coarse:min-h-11"
              style={{ paddingBlock: "var(--density-sidebar-py, 4px)" }}
            >
              <Block className="w-3.5 h-3.5 rounded-sm flex-shrink-0" />
              <Bar className="h-2.5" w={textWidth(i, 30, 35)} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The hour labels down the gutter, one per hour row. Each sits centred on
 * its row's top line; a range that starts later than midnight labels its
 * first hour inside the row instead (calendar-week-view.tsx). The gutter
 * stops short of the last line, which has no label.
 */
function HourGutter({ className, labelW }: { className: string; labelW: string }) {
  return (
    <div className={cn("relative flex-shrink-0 h-[calc(100%-5px)] overflow-hidden bg-background", className)}>
      {repeat(24, (i) => (
        <div className="sk-cal-hour relative">
          <Bar
            className={cn("absolute end-2 h-2", i === 0 ? "sk-cal-first-label top-1.5" : "top-0 -translate-y-1/2")}
            w={labelW}
          />
        </div>
      ))}
    </div>
  );
}

/** The all-hours toggle in the gutter's header cell, while the hours are limited. */
function HoursToggle({ className }: { className: string }) {
  return (
    <div className={cn("flex items-end justify-center pb-1 flex-shrink-0", className)}>
      <span className="sk-cal-hours-toggle flex items-center justify-center rounded p-1 text-muted-foreground">
        <UnfoldVertical className="h-3.5 w-3.5" />
      </span>
    </div>
  );
}

/** The weekday and date of a column header. */
function DayHead({ className, date }: { className?: string; date: string }) {
  return (
    <>
      <Line className={cn("h-[1.03125rem]", className)} bar="h-2" w="1.5rem" />
      <Line className={cn("justify-center", date)} bar="h-3.5" w="1.125rem" />
    </>
  );
}

/** CalendarWeekView: gutter, one column per day, hour rows that fill the pane. */
function WeekSkeleton({ className }: { className: string }) {
  return (
    <div aria-hidden="true" className={cn("sk-cal-view sk-cal-week flex-col flex-1 min-h-0 min-w-0 overflow-hidden", className)}>
      <div className="relative z-10 flex flex-shrink-0 border-b border-border bg-background">
        <HoursToggle className="w-14 max-md:w-10" />
        <div className="sk-cal-cols grid border-s border-border">
          {repeat(8, () => (
            <div className="flex flex-col items-center gap-0.5 pt-2 pb-1.5 border-e border-border">
              <DayHead date="w-10 h-10 max-md:w-8 max-md:h-8" />
            </div>
          ))}
        </div>
      </div>
      <div className="sk-cal-hours flex flex-shrink-0">
        <HourGutter className="w-14 max-md:w-10" labelW="1.5rem" />
        <div className="sk-cal-cols relative grid h-full border-s border-border">
          {repeat(8, () => <div className="sk-cal-slots border-e border-border" />)}
        </div>
      </div>
    </div>
  );
}

/** CalendarDayView: the same grid with one wide column. */
function DaySkeleton({ className }: { className: string }) {
  return (
    <div aria-hidden="true" className={cn("sk-cal-view sk-cal-day flex-col flex-1 min-h-0 min-w-0 overflow-hidden", className)}>
      <div className="relative z-10 flex flex-shrink-0 border-b border-border bg-background">
        <HoursToggle className="w-16 max-md:w-10" />
        <div className="flex flex-col flex-1 min-w-0 items-start gap-0.5 px-3 max-md:px-2 pt-2 pb-1.5 border-e border-border">
          <DayHead className="w-10 justify-center" date="w-10 h-10" />
        </div>
      </div>
      <div className="sk-cal-hours flex flex-shrink-0">
        <HourGutter className="w-16 max-md:w-10" labelW="1.75rem" />
        <div className="sk-cal-slots relative flex-1 h-full border-e border-border" />
      </div>
    </div>
  );
}

/** CalendarMonthView: weekday header and six week rows filling the pane. */
function MonthSkeleton({ className }: { className: string }) {
  const cell = "border-e border-border last:border-e-0";
  return (
    <div aria-hidden="true" className={cn("sk-cal-view sk-cal-month flex-col flex-1 min-h-0 min-w-0 overflow-hidden", className)}>
      <div className="grid grid-cols-7 flex-shrink-0 border-b border-border">
        {repeat(7, () => (
          <div className={cn(cell, "flex justify-center py-2 max-md:py-1.5")}>
            <Line className="h-4 max-md:h-[1.03125rem]" bar="h-2" w="1.5rem" />
          </div>
        ))}
      </div>
      {repeat(6, () => (
        <div className="sk-cal-month-week grid grid-cols-7 flex-shrink-0 border-b border-border">
          {repeat(7, () => (
            <div className={cn(cell, "p-1")}>
              <Line className="justify-center h-6 max-md:h-7" bar="h-2.5" w="0.875rem" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** CalendarAgendaView: the range line, then day rows with their events. */
function AgendaSkeleton({ className }: { className: string }) {
  return (
    <div aria-hidden="true" className={cn("flex-col flex-1 min-h-0 overflow-hidden", className)}>
      <div className="flex justify-center px-4 py-2">
        <Line className="h-6" bar="h-2.5" w="7rem" />
      </div>
      {repeat(6, (i) => (
        <div className="flex items-start gap-2 px-2 sm:px-4 py-1.5 border-b border-border">
          <div className="flex items-center gap-2 w-24 sm:w-32 flex-shrink-0 py-1.5">
            <Line className="justify-center w-9 h-9 flex-shrink-0" bar="h-3.5" w="1.125rem" />
            <Bar className="h-2" w="2.5rem" />
          </div>
          <div className="flex-1 min-w-0 py-0.5">
            {repeat(1 + (i % 2), (j) => (
              <div className="flex items-start gap-3 px-2" style={{ paddingBlock: "var(--density-item-py)" }}>
                <Line className="w-28 sm:w-32 h-5 flex-shrink-0" bar="h-2.5" w="5.5rem" />
                <Circle className="w-[9px] h-[9px] mt-[5.5px]" />
                <Line className="flex-1 min-w-0 h-5" bar="h-3" w={textWidth(i * 2 + j, 30, 40)} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The tasks view: TaskToolbar and TaskListView. */
function TasksSkeleton({ className, text }: ViewProps) {
  const filters = text?.taskFilters;
  return (
    <div aria-hidden="true" className={cn("flex-col flex-1 min-h-0 overflow-hidden", className)}>
      <div className="flex items-center gap-2 px-4 min-h-14 box-content border-b border-border flex-wrap">
        {/* The filter starts at "all" on every load (stores/task-store.ts). */}
        <div className="flex border border-border rounded-md overflow-hidden">
          {repeat(4, (i) => (
            <span
              className={cn(
                "flex items-center h-7 px-3 text-xs font-medium",
                i === 0 ? "bg-primary text-primary-foreground" : "text-muted-foreground",
              )}
            >
              {filters ? filters[i] : <Bar className="h-2" w="2.5rem" />}
            </span>
          ))}
        </div>
        <div className="flex-1" />
        {text?.newTask ? (
          <span className="flex items-center h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium shadow-sm">
            <Plus className="w-4 h-4 me-1" />
            {text.newTask}
          </span>
        ) : (
          <Block className="h-9" w="6.5rem" />
        )}
      </div>
      <div className="px-4 py-2 border-b border-border">
        <div className="flex items-center gap-2 h-5">
          <Plus className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          {text?.quickAdd ? (
            <span className="text-sm text-muted-foreground truncate">{text.quickAdd}</span>
          ) : (
            <Bar className="h-2.5" w="10rem" />
          )}
        </div>
      </div>
      <div className="divide-y divide-border">
        {repeat(8, (i) => (
          <div className="flex items-start gap-3 px-4 py-3">
            <span className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full border-2 border-muted-foreground/40" />
            <div className="flex-1 min-w-0">
              <Line className="h-5" bar="h-3" w={textWidth(i, 25, 35)} />
              <Line className="h-4 mt-0.5" bar="h-2" w="6rem" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ViewProps {
  className: string;
  text?: CalendarSkeletonText;
}

const VIEWS: Record<CalendarViewMode, (props: ViewProps) => ReactNode> = {
  month: MonthSkeleton,
  week: WeekSkeleton,
  day: DaySkeleton,
  agenda: AgendaSkeleton,
  tasks: TasksSkeleton,
};

/**
 * The grid of a calendar view where calendar-app's renderView() puts it.
 * With `view` it draws that one (the loaded page while its calendars load,
 * with `label` as its status); without, the one `data-boot-calendar-view`
 * names.
 */
export function CalendarViewSkeleton({
  view,
  label,
  text,
}: {
  view?: CalendarViewMode;
  label?: string;
  text?: CalendarSkeletonText;
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden" data-calendar-view-skeleton={view ?? ""} aria-busy="true">
      {label ? <span role="status" className="sr-only">{label}</span> : null}
      {view
        ? VIEWS[view]({ className: "flex", text })
        : (Object.keys(VIEWS) as CalendarViewMode[]).map((v) => {
            const View = VIEWS[v];
            return <View key={v} className={VIEW_SHOWN[v]} text={text} />;
          })}
    </div>
  );
}

/**
 * The calendar page's own content: everything in the row next to the rail.
 * `embedded` is the variant drawn inside a Pro pane (useIsEmbedded()), which
 * has no rail, no Mountain View shell and fills its pane (h-full). Pro runs
 * on desktops only, so the breakpoints pick the desktop layout there too.
 */
export function CalendarSkeletonBody({ embedded = false, text }: { embedded?: boolean; text?: CalendarSkeletonText }) {
  return (
    <div aria-hidden="true" className="flex flex-col flex-1 min-w-0 min-h-0" data-embedded={embedded ? "" : undefined}>
      <div className="flex flex-1 min-w-0 min-h-0">
        <SidebarSkeleton text={text} />
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          <ToolbarSkeleton text={text} />
          <div className="relative flex flex-1 overflow-hidden isolate">
            <div className="flex flex-1 min-w-0">
              <CalendarViewSkeleton text={text} />
            </div>
            {/* The floating create button of a phone. */}
            <span className="md:hidden absolute bottom-4 end-4 z-40 flex items-center justify-center h-14 w-14 rounded-full shadow-lg bg-primary text-primary-foreground">
              <Plus className="h-6 w-6" />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Skeleton of the calendar page. */
export function CalendarSkeleton({ label, labels, text }: CalendarSkeletonProps) {
  return (
    <AppShellSkeleton
      surface="calendar"
      label={label}
      labels={labels}
      railBelow="md"
      active="calendar"
      mvMenu={false}
      rowClassName="lg:mv:mb-4 lg:mv:mx-4 lg:mv:rounded-[var(--mv-card-radius)] lg:mv:bg-background"
    >
      <CalendarSkeletonBody text={text} />
    </AppShellSkeleton>
  );
}
