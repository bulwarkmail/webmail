"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { addDays, endOfDay, format, isSameDay, startOfDay } from "date-fns";
import {
  CalendarEvent as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ListTodo,
  Plus,
  Search,
  Users,
  X,
} from "@/components/icons";
import { Link } from "@/i18n/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { useContactStore, getContactDisplayName, getContactPrimaryEmail } from "@/stores/contact-store";
import { usePolicyStore } from "@/stores/policy-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTaskStore } from "@/stores/task-store";
import { getTimedEventBoundsForDay } from "@/lib/calendar-utils";
import { requestInternalMailto } from "@/lib/protocol-handlers/mailto";
import { formatDateTime, cn } from "@/lib/utils";
import { readableTextOn } from "@/lib/color-transform";
import { Avatar } from "@/components/ui/avatar";
import type { CalendarEvent } from "@/lib/jmap/types";
import { useCvdColor } from "@/hooks/use-cvd-color";
import { useCloseBesideControls } from "@/hooks/use-close-beside-controls";
import { PluginSidePanelBody, SidePanelButton, usePluginSidePanel } from "@/components/plugins/plugin-side-panels";

export type MvSidePanelId = "calendar" | "tasks" | "contacts";

const HOUR_PX = 48;

/**
 * Mountain View's side panel: the strip of app icons down the right edge
 * that Gmail has, each opening a narrow panel next to the mail - today's
 * calendar, the task list, the address book - without leaving the inbox.
 * `pluginsOnly` leaves the apps' panels out (a plugin page: they act on
 * the mail view, which isn't there) and keeps the plugins' side panels.
 */
export function MvSidePanel({ pluginsOnly = false }: { pluginsOnly?: boolean } = {}) {
  const t = useTranslations("sidebar");
  const client = useAuthStore((s) => s.client);
  const supportsCalendar = useCalendarStore((s) => s.supportsCalendar);
  const calendarEnabled = usePolicyStore((s) => s.isFeatureEnabled("calendarEnabled"));
  const contactsEnabled = usePolicyStore((s) => s.isFeatureEnabled("contactsEnabled"));
  const tasksEnabled = useSettingsStore((s) => s.enableCalendarTasks);
  const [open, setOpen] = useState<MvSidePanelId | null>(null);
  // Plugins' panels (the side-panel slot), their buttons below the apps'.
  // A plugin's panel opening (a click, or the plugin's openPanel) shuts the app's, and the other way round.
  const plugins = usePluginSidePanel(() => setOpen(null));
  const pluginOpen = plugins.entries.find((e) => e.pluginId === plugins.open) ?? null;
  const openApp = (id: MvSidePanelId | null) => {
    if (id) plugins.choose(null);
    setOpen(id);
  };
  const openPlugin = (pluginId: string | null) => {
    if (pluginId) setOpen(null);
    plugins.choose(pluginId);
  };

  const showCalendar = !pluginsOnly && supportsCalendar && calendarEnabled;
  const showContacts = !pluginsOnly && (client?.supportsContacts() ?? false) && contactsEnabled;
  const showTasks = showCalendar && tasksEnabled;

  const buttons: Array<{ id: MvSidePanelId; label: string; icon: typeof CalendarIcon; color: string }> = [
    ...(showCalendar ? [{ id: "calendar" as const, label: t("calendar"), icon: CalendarIcon, color: "text-[#1a73e8]" }] : []),
    ...(showTasks ? [{ id: "tasks" as const, label: t("mv_tasks"), icon: ListTodo, color: "text-[#1a73e8]" }] : []),
    ...(showContacts ? [{ id: "contacts" as const, label: t("contacts"), icon: Users, color: "text-[#1a73e8]" }] : []),
  ];

  if (buttons.length === 0 && plugins.entries.length === 0) return null;
  // A plugin's panel without a rail button (setSidePanel's rail: false) opens on its request only.
  const pluginButtons = plugins.entries.filter((e) => e.inRail);
  // A panel whose app went away (policy change, account switch) stays shut.
  const active = open && !pluginOpen && buttons.some((b) => b.id === open) ? open : null;

  return (
    <>
      {active && (
        <aside
          data-simple-hide=""
          data-mv-side-panel={active}
          className="mb-4 me-2 flex w-[300px] shrink-0 flex-col overflow-hidden rounded-2xl bg-background"
          aria-label={buttons.find((b) => b.id === active)?.label}
        >
          {active === "calendar" && <CalendarPanel onClose={() => setOpen(null)} />}
          {active === "tasks" && <TasksPanel onClose={() => setOpen(null)} />}
          {active === "contacts" && <ContactsPanel onClose={() => setOpen(null)} />}
        </aside>
      )}
      {pluginOpen && (
        <aside
          data-simple-hide=""
          data-plugin-side-panel={pluginOpen.pluginId}
          className="mb-4 me-2 flex w-[300px] shrink-0 flex-col overflow-hidden rounded-2xl bg-background"
          aria-label={pluginOpen.title}
        >
          <PluginSidePanelBody entry={pluginOpen} focusRequest={plugins.focusRequest} onClose={() => plugins.choose(null)} />
        </aside>
      )}
      {(buttons.length > 0 || pluginButtons.length > 0) && <nav
        data-mv-side-rail=""
        className="flex w-14 shrink-0 flex-col items-center gap-2 pt-3"
        aria-label={t("mv_side_panel")}
      >
        {buttons.map(({ id, label, icon: Icon, color }) => (
          <button
            key={id}
            type="button"
            onClick={() => openApp(active === id ? null : id)}
            className={cn(
              "relative grid h-10 w-10 place-items-center rounded-full transition-colors hover:bg-[var(--mv-nav-hover)]",
              active === id && "bg-[var(--mv-nav-selected)]",
            )}
            title={label}
            aria-label={label}
            aria-pressed={active === id}
          >
            <Icon className={cn("h-5 w-5", color)} />
          </button>
        ))}
        {pluginButtons.map((entry) => (
          <SidePanelButton
            key={entry.pluginId}
            entry={entry}
            pressed={pluginOpen?.pluginId === entry.pluginId}
            onClick={() => openPlugin(pluginOpen?.pluginId === entry.pluginId ? null : entry.pluginId)}
            className="h-10 w-10 rounded-full hover:bg-[var(--mv-nav-hover)]"
            pressedClassName="bg-[var(--mv-nav-selected)] text-foreground"
          />
        ))}
        <div className="my-1 h-px w-5 bg-border" aria-hidden />
      </nav>}
    </>
  );
}

function PanelHeader({ title, subtitle, href, onClose, children }: {
  title: string;
  subtitle?: React.ReactNode;
  href: string;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  const t = useTranslations("sidebar");
  const tCommon = useTranslations("common");
  // Right under the window's own close, at the window's end: this one goes to the start.
  const [head, setHead] = useState<HTMLDivElement | null>(null);
  const closeFirst = useCloseBesideControls(head);
  const close = (
    <button
      type="button"
      onClick={onClose}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      title={tCommon("close")}
      aria-label={tCommon("close")}
    >
      <X className="h-[18px] w-[18px]" />
    </button>
  );
  return (
    <div ref={setHead} data-window-pane-head="" className={cn("flex items-start gap-1 pt-4 pb-2", closeFirst ? "ps-2 pe-4" : "px-4")}>
      {closeFirst && close}
      <div className="min-w-0 flex-1">
        <div className={cn(subtitle ? "text-[0.6875rem] font-medium text-muted-foreground" : "text-[1.375rem] leading-7")}>{title}</div>
        {subtitle && <div className="text-sm font-medium text-primary">{subtitle}</div>}
      </div>
      {children}
      <Link
        href={href}
        className="grid h-9 w-9 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        title={t("mv_open_full")}
        aria-label={t("mv_open_full")}
      >
        <ExternalLink className="h-[18px] w-[18px]" />
      </Link>
      {!closeFirst && close}
    </div>
  );
}

/** A day of the calendar on an hour grid, with a line at the current time. */
function CalendarPanel({ onClose }: { onClose: () => void }) {
  const t = useTranslations("sidebar");
  const tCal = useTranslations("calendar");
  const client = useAuthStore((s) => s.client);
  const calendars = useCalendarStore((s) => s.calendars);
  const events = useCalendarStore((s) => s.events);
  const selectedCalendarIds = useCalendarStore((s) => s.selectedCalendarIds);
  const fetchCalendars = useCalendarStore((s) => s.fetchCalendars);
  const fetchEvents = useCalendarStore((s) => s.fetchEvents);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const [day, setDay] = useState(() => startOfDay(new Date()));
  const [now, setNow] = useState(() => new Date());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (client && calendars.length === 0) void fetchCalendars(client);
  }, [client, calendars.length, fetchCalendars]);

  useEffect(() => {
    if (!client || calendars.length === 0) return;
    void fetchEvents(client, format(day, "yyyy-MM-dd'T'00:00:00"), format(endOfDay(day), "yyyy-MM-dd'T'23:59:59"), { silent: true });
  }, [client, calendars.length, day, fetchEvents]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Open on the working part of the day: an hour before now, or 8:00.
  useEffect(() => {
    const hour = isSameDay(day, new Date()) ? Math.max(0, new Date().getHours() - 1) : 8;
    if (scrollRef.current) scrollRef.current.scrollTop = hour * HOUR_PX;
  }, [day]);

  const paint = useCvdColor();
  const colorOf = (event: CalendarEvent) => {
    const calId = Object.keys(event.calendarIds ?? {})[0];
    return paint(event.color || calendars.find((c) => c.id === calId)?.color || "var(--color-primary)");
  };

  const visible = events.filter((e) => {
    const ids = Object.keys(e.calendarIds ?? {});
    return selectedCalendarIds.length === 0 || ids.some((id) => selectedCalendarIds.includes(id));
  });
  const timed = visible
    .map((e) => ({ e, b: getTimedEventBoundsForDay(e, day) }))
    .filter((x): x is { e: CalendarEvent; b: NonNullable<typeof x.b> } => x.b !== null);
  const allDay = visible.filter((e) => {
    if (!e.showWithoutTime) return false;
    const start = startOfDay(new Date(e.start));
    return start <= day && day < addDays(start, Math.max(1, Math.round(durationDays(e.duration))));
  });

  return (
    <>
      <PanelHeader title={t("calendar")} subtitle={formatDateTime(day, timeFormat, { weekday: "short", month: "short", day: "numeric", dateOnly: true })} href="/calendar" onClose={onClose} />
      <div className="flex items-center gap-1 px-3 pb-2">
        <button
          type="button"
          onClick={() => setDay(startOfDay(new Date()))}
          className="h-9 rounded-full border border-border px-4 text-sm font-medium hover:bg-muted"
        >
          {tCal("views.today")}
        </button>
        <button type="button" onClick={() => setDay((d) => addDays(d, -1))} className="grid h-9 w-9 place-items-center rounded-full hover:bg-muted" aria-label={t("mv_previous_day")} title={t("mv_previous_day")}>
          <ChevronLeft className="h-5 w-5" />
        </button>
        <button type="button" onClick={() => setDay((d) => addDays(d, 1))} className="grid h-9 w-9 place-items-center rounded-full hover:bg-muted" aria-label={t("mv_next_day")} title={t("mv_next_day")}>
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
      {allDay.length > 0 && (
        <div className="space-y-1 border-b border-border px-3 pb-2">
          {allDay.map((e) => (
            <div key={e.id} className="truncate rounded px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: colorOf(e), color: readableTextOn(colorOf(e)) }}>
              {e.title || tCal("tasks.no_title")}
            </div>
          ))}
        </div>
      )}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto" data-mv-day-grid="">
        <div className="relative" style={{ height: 24 * HOUR_PX }}>
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="absolute inset-x-0 flex" style={{ top: h * HOUR_PX }}>
              <span className="w-14 shrink-0 -translate-y-2 pe-2 text-end text-[0.625rem] text-muted-foreground">
                {h === 0 ? "" : new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric", hour12: timeFormat === "12h" })}
              </span>
              <span className="flex-1 border-t border-border" />
            </div>
          ))}
          {timed.map(({ e, b }) => (
            <div
              key={e.id}
              data-mv-panel-event=""
              className="absolute end-2 overflow-hidden rounded px-1.5 py-0.5 text-xs leading-tight"
              style={{
                top: (b.startMinutes / 60) * HOUR_PX,
                height: Math.max(18, ((b.endMinutes - b.startMinutes) / 60) * HOUR_PX - 2),
                insetInlineStart: 56,
                backgroundColor: colorOf(e),
                color: readableTextOn(colorOf(e)),
              }}
              title={e.title}
            >
              <div className="truncate font-medium">{e.title || tCal("tasks.no_title")}</div>
            </div>
          ))}
          {isSameDay(day, now) && (
            <div
              className="pointer-events-none absolute end-0 h-0.5 bg-red-500"
              style={{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX, insetInlineStart: 56 }}
              aria-hidden
            />
          )}
        </div>
        {timed.length === 0 && allDay.length === 0 && (
          <p className="sr-only">{tCal("events.no_events")}</p>
        )}
      </div>
    </>
  );
}

/** Whole days in an ISO-8601 duration such as "P1D" or "P2DT0H". */
function durationDays(duration: string | undefined): number {
  if (!duration) return 1;
  const m = /P(?:(\d+)W)?(?:(\d+)D)?/.exec(duration);
  if (!m) return 1;
  return (Number(m[1] ?? 0) * 7) + Number(m[2] ?? 0) || 1;
}

/** The task list: what is still open, a box to tick it off, and a line to add one. */
function TasksPanel({ onClose }: { onClose: () => void }) {
  const t = useTranslations("sidebar");
  const tCal = useTranslations("calendar");
  const client = useAuthStore((s) => s.client);
  const calendars = useCalendarStore((s) => s.calendars);
  const fetchCalendars = useCalendarStore((s) => s.fetchCalendars);
  const tasks = useTaskStore((s) => s.tasks);
  const fetchTasks = useTaskStore((s) => s.fetchTasks);
  const createTask = useTaskStore((s) => s.createTask);
  const toggleTaskComplete = useTaskStore((s) => s.toggleTaskComplete);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!client) return;
    if (calendars.length === 0) void fetchCalendars(client);
    void fetchTasks(client);
  }, [client, calendars.length, fetchCalendars, fetchTasks]);

  const pending = tasks.filter((task) => task.progress !== "completed" && task.progress !== "cancelled");
  const taskCalendar = calendars.find((c) => c.isTasksOnly) ?? calendars[0];

  return (
    <>
      <PanelHeader title={t("mv_tasks")} href="/calendar" onClose={onClose} />
      {client && taskCalendar && (
        <form
          className="px-4 pb-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const title = draft.trim();
            if (!title) return;
            setDraft("");
            // null: a plugin stopped it; give the user their text back.
            const created = await createTask(client, { "@type": "Task", title, progress: "needs-action", calendarIds: { [taskCalendar.id]: true } });
            if (!created) setDraft(title);
          }}
        >
          <label className="flex items-center gap-3 rounded-full px-1 py-1.5 text-sm text-primary hover:bg-muted/60">
            <Plus className="h-5 w-5 shrink-0" />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={tCal("tasks.create")}
              className="min-w-0 flex-1 bg-transparent text-foreground placeholder:text-primary focus:outline-none"
            />
          </label>
        </form>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {pending.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted-foreground">{tCal("tasks.no_tasks")}</p>}
        {pending.map((task) => (
          <div key={task.id} className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-muted/50" data-mv-panel-task="">
            <button
              type="button"
              onClick={() => client && void toggleTaskComplete(client, task)}
              className="mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 border-muted-foreground/60 hover:border-primary"
              aria-label={tCal("tasks.mark_complete")}
              title={tCal("tasks.mark_complete")}
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm">{task.title || tCal("tasks.no_title")}</div>
              {task.due && <div className="text-xs text-muted-foreground">{format(new Date(task.due), "PP")}</div>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** The address book, searchable; a contact opens a new message to them. */
function ContactsPanel({ onClose }: { onClose: () => void }) {
  const t = useTranslations("sidebar");
  const tContacts = useTranslations("contacts");
  const client = useAuthStore((s) => s.client);
  const contacts = useContactStore((s) => s.contacts);
  const fetchContacts = useContactStore((s) => s.fetchContacts);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (client && contacts.length === 0) void fetchContacts(client);
  }, [client, contacts.length, fetchContacts]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contacts
      .filter((c) => c.kind !== "group")
      .map((c) => ({ c, name: getContactDisplayName(c), email: getContactPrimaryEmail(c) }))
      .filter((r) => r.name || r.email)
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q))
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  }, [contacts, query]);

  return (
    <>
      <PanelHeader title={t("contacts")} href="/contacts" onClose={onClose}>
        <button
          type="button"
          onClick={() => setSearching((v) => !v)}
          className="grid h-9 w-9 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={tContacts("search_placeholder")}
          title={tContacts("search_placeholder")}
        >
          <Search className="h-[18px] w-[18px]" />
        </button>
      </PanelHeader>
      {searching && (
        <div className="px-4 pb-2">
          <input
            aria-label={tContacts("search_placeholder")}
            autoFocus
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tContacts("search_placeholder")}
            className="h-9 w-full rounded-full bg-[var(--mv-search-bg)] px-4 text-sm focus:outline-none"
          />
        </div>
      )}
      <Link href="/contacts" className="mx-4 mb-2 flex items-center gap-3 rounded-full py-1.5 text-sm font-medium text-primary hover:bg-muted/60">
        <Plus className="h-5 w-5" />
        {tContacts("create_new")}
      </Link>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {rows.map(({ c, name, email }) => (
          <button
            key={c.id}
            type="button"
            disabled={!email}
            onClick={() => email && requestInternalMailto(`mailto:${email}`)}
            className="flex w-full items-center gap-3 px-4 py-2 text-start hover:bg-muted/50 disabled:cursor-default"
            title={email || undefined}
            data-mv-panel-contact=""
          >
            <Avatar name={name} email={email} size="md" className="h-9 w-9 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{name || email}</span>
              {name && email && <span className="block truncate text-xs text-muted-foreground">{email}</span>}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
