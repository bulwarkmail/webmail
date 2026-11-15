/**
 * The Tasks app (/tasks, #1698) as a skeleton: the sidebar with its filters
 * and task lists, the toolbar and the task list. Class lists mirror the real
 * components (components/calendar/calendar-app.tsx in its tasks surface,
 * calendar-sidebar-header.tsx, tasks-sidebar-filters.tsx,
 * calendar-sidebar-panel.tsx, calendar-toolbar.tsx, task-list-view.tsx).
 */
import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, ChevronDown, Circle as CircleIcon, ListTodo, Menu, MoreVertical, Plus } from "@/components/icons";
import { cn } from "@/lib/cn";
import { Bar, Block, Circle, repeat, textWidth } from "./kit";
import { AppShellSkeleton, type RailLabels } from "./shell";

export interface TasksSkeletonText {
  /** sidebar.tasks: the app's name, in the sidebar and the toolbar. */
  title?: string;
  /** calendar.tasks.filter_all, _pending, _overdue, _completed (the sidebar's order). */
  filters?: [string, string, string, string];
  /** calendar.tasks.quick_add_placeholder */
  quickAdd?: string;
}

export interface TasksSkeletonProps {
  /** common.loading */
  label?: string;
  labels?: RailLabels;
  text?: TasksSkeletonText;
}

const FILTER_ICONS = [ListTodo, CircleIcon, AlertCircle, CheckCircle2];

/** The skeleton's words from translators for the "calendar" and "sidebar" namespaces. */
export function tasksSkeletonText(t: (key: string) => string, tSidebar: (key: string) => string): TasksSkeletonText {
  return {
    title: tSidebar("tasks"),
    filters: [t("tasks.filter_all"), t("tasks.filter_pending"), t("tasks.filter_overdue"), t("tasks.filter_completed")],
    quickAdd: t("tasks.quick_add_placeholder"),
  };
}

function Word({ text, w }: { text?: string; w: string }) {
  return text ? <span className="truncate">{text}</span> : <Bar className="h-2.5" w={w} />;
}

function ToolbarIcon({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("flex items-center justify-center h-8 w-8 shrink-0 rounded-md text-muted-foreground [&_svg]:size-4", className)}>
      {children}
    </span>
  );
}

function PhoneIcon({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("flex items-center justify-center h-11 w-11 shrink-0 rounded-md [&_svg]:size-5", className)}>
      {children}
    </span>
  );
}

/** The inline sidebar of a desktop: header, filters and one section of task lists. */
function SidebarSkeleton({ text }: { text?: TasksSkeletonText }) {
  const row = "flex items-center gap-2 px-3 min-h-8 pointer-coarse:min-h-11 text-sm";
  const pad = { paddingBlock: "var(--density-sidebar-py, 4px)" };
  return (
    <div
      className="hidden lg:flex lg:boot-cal-collapsed:hidden flex-col border-e border-border bg-secondary overflow-hidden flex-shrink-0"
      style={{ width: "var(--boot-cal-sidebar-w, 256px)" }}
    >
      <div className="px-3 h-14 box-content border-b border-border flex items-center justify-between flex-shrink-0">
        {text?.title ? <span className="text-sm font-semibold truncate">{text.title}</span> : <Bar className="h-3" w="4rem" />}
        <span className="flex items-center justify-center h-8 w-8 shrink-0">
          <Plus className="w-4 h-4" />
        </span>
      </div>
      <div className="flex-1 overflow-hidden py-1">
        {/* The filter starts at "all" on every load (stores/task-store.ts). */}
        <div className="mb-3">
          {FILTER_ICONS.map((Icon, i) => (
            <div key={i} className={cn(row, i === 0 && "bg-accent text-accent-foreground font-medium")} style={pad}>
              <Icon className="w-4 h-4 flex-shrink-0" />
              <Word text={text?.filters?.[i]} w="3.5rem" />
            </div>
          ))}
        </div>
        <div className="mt-4">
          <div className="flex items-center gap-1 px-3 h-8 text-muted-foreground">
            <ChevronDown className="w-3 h-3 flex-shrink-0" />
            <Bar className="h-2" w="4rem" />
          </div>
          {repeat(3, (i) => (
            <div className="flex items-center gap-2 ps-5 pe-3 min-h-8 pointer-coarse:min-h-11" style={pad}>
              <Block className="w-3.5 h-3.5 rounded-sm flex-shrink-0" />
              <Bar className="h-2.5" w={textWidth(i, 30, 35)} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** CalendarToolbar with a title and no dates or views; the phone's has one row. */
function ToolbarSkeleton({ text }: { text?: TasksSkeletonText }) {
  return (
    <>
      <div data-window-row-right="" className="hidden desk:flex items-center gap-1 px-3 h-14 box-content border-b border-border flex-shrink-0">
        <ToolbarIcon className="me-1">
          <Menu />
        </ToolbarIcon>
        <ToolbarIcon className="lg:hidden lg:boot-cal-collapsed:flex">
          <Plus />
        </ToolbarIcon>
        <span className="flex items-center ms-2 h-6 min-w-0 text-base font-semibold">
          <Word text={text?.title} w="5rem" />
        </span>
        <div className="flex-1" />
        <ToolbarIcon>
          <MoreVertical />
        </ToolbarIcon>
      </div>
      <div className="desk:hidden border-b border-border">
        <div className="flex flex-wrap items-center gap-1 px-2 py-2">
          <PhoneIcon className="-ms-1">
            <Menu />
          </PhoneIcon>
          <span className="flex flex-1 items-center justify-center h-5 min-w-0 text-sm font-semibold">
            <Word text={text?.title} w="4rem" />
          </span>
          <div className="flex items-center gap-1 flex-shrink-0 ms-auto">
            <PhoneIcon>
              <MoreVertical />
            </PhoneIcon>
            <span className="flex items-center justify-center w-10 h-10 pointer-coarse:w-11 pointer-coarse:h-11">
              <Circle className="w-8 h-8" />
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

/** TaskListView, with the phone's TaskToolbar (filters) above it. */
function ListSkeleton({ text }: { text?: TasksSkeletonText }) {
  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="desk:hidden flex items-center gap-2 px-4 min-h-14 box-content border-b border-border">
        <div className="flex border border-border rounded-md overflow-hidden">
          {repeat(4, (i) => (
            <span className={cn("flex items-center h-7 px-3 text-xs font-medium", i === 0 ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>
              <Bar className="h-2" w="2rem" />
            </span>
          ))}
        </div>
      </div>
      <div className="px-4 py-2 border-b border-border">
        <div className="flex items-center gap-2 h-5">
          <Plus className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          {text?.quickAdd ? <span className="text-sm text-muted-foreground truncate">{text.quickAdd}</span> : <Bar className="h-2.5" w="10rem" />}
        </div>
      </div>
      <div className="divide-y divide-border">
        {repeat(8, (i) => (
          <div className="flex items-start gap-3 px-4 py-3">
            <span className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full border-2 border-muted-foreground/40" />
            <div className="flex-1 min-w-0">
              <span className="flex items-center h-5"><Bar className="h-3" w={textWidth(i, 25, 35)} /></span>
              <span className="flex items-center h-4 mt-0.5"><Bar className="h-2" w="6rem" /></span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The list area alone, for the loaded page while its task lists load. */
export function TasksListSkeleton({ label, text }: { label?: string; text?: TasksSkeletonText }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden" aria-busy="true">
      {label ? <span role="status" className="sr-only">{label}</span> : null}
      <div aria-hidden="true" className="flex flex-1 min-h-0">
        <ListSkeleton text={text} />
      </div>
    </div>
  );
}

/** The Tasks page's own content: everything in the row next to the rail. */
export function TasksSkeletonBody({ embedded = false, text }: { embedded?: boolean; text?: TasksSkeletonText }) {
  return (
    <div aria-hidden="true" className="flex flex-col flex-1 min-w-0 min-h-0" data-embedded={embedded ? "" : undefined}>
      <div className="flex flex-1 min-w-0 min-h-0">
        <SidebarSkeleton text={text} />
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          <ToolbarSkeleton text={text} />
          <div className="relative flex flex-1 overflow-hidden isolate">
            <ListSkeleton text={text} />
            <span className="desk:hidden absolute bottom-4 end-4 z-40 flex items-center justify-center h-14 w-14 rounded-full shadow-lg bg-primary text-primary-foreground">
              <Plus className="h-6 w-6" />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Skeleton of the Tasks page. */
export function TasksSkeleton({ label, labels, text }: TasksSkeletonProps) {
  return (
    <AppShellSkeleton
      surface="tasks"
      label={label}
      labels={labels}
      active="tasks"
      mvMenu={false}
      rowClassName="desk:mv:mb-4 desk:mv:mx-4 desk:mv:rounded-[var(--mv-card-radius)] desk:mv:bg-background"
    >
      <TasksSkeletonBody text={text} />
    </AppShellSkeleton>
  );
}
