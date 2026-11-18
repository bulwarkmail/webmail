"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, LayoutGrid, Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { useSettingsStore } from "@/stores/settings-store";
import { getEffectiveTimeZone } from "@/lib/timezone";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { BusyPeriod } from "@/lib/jmap/types";
import { checkAvailabilityAccess, lookUpAvailability } from "@/lib/jmap/free-busy";
import { searchHours, workingDaySet } from "@/lib/find-a-time";
import {
  DAY_MINUTES,
  SNAP_MINUTES,
  addDays,
  busySpans,
  combineSpans,
  dayBounds,
  dayOf,
  freeSpans,
  instantAt,
  moveSlotTo,
  outsideWorkingSpans,
  resizeSlotTo,
  spanOnDay,
  workingSpan,
  type BusySpan,
  type GridDay,
  type GridSpan,
} from "@/lib/scheduling-assistant";
import { cn } from "@/lib/utils";
import { loadAttendeeDirectory } from "./participant-availability";
import { visibleCalendarOwners, type NotCheckedReason } from "./find-a-time";
import { FreeBusyShareButton } from "./free-busy-share-button";

export interface SchedulingAttendee {
  name: string;
  email: string;
  /** JSCalendar roles; an `optional` attendee is drawn lighter and left out of "All attendees". */
  roles?: Partial<Record<string, boolean>>;
}

type Slot = { start: Date; end: Date };

export type RowState =
  | { kind: "known"; periods: BusyPeriod[] }
  | { kind: "not_checked"; reason: NotCheckedReason };

export interface ScheduleRow {
  email: string;
  name: string;
  you: boolean;
  optional: boolean;
  state: RowState;
}

export type ScheduleOutcome =
  | { kind: "ok"; rows: ScheduleRow[]; directoryQueriesOff: boolean; rateLimited: boolean }
  | { kind: "unavailable" };

/**
 * Everyone's busy time over `start`-`end`, the organiser first. The same
 * lookups and the same rules as Suggest times: one batched availability call
 * (cached for a few minutes), and an empty answer counts as free only for
 * someone whose calendar the user can see.
 */
export async function loadScheduleRows(
  client: IJMAPClient,
  input: { attendees: SchedulingAttendee[]; start: Date; end: Date; visibleOwners: Set<string> },
): Promise<ScheduleOutcome> {
  const directory = await loadAttendeeDirectory(client);
  const own = client.getUsername()?.trim().toLowerCase() ?? "";
  const ownId = directory.byEmail.get(own)?.id ?? client.getAccountId();
  const seen = new Set<string>([own]);
  const people: Array<{ email: string; name: string; optional: boolean; id?: string; reason?: NotCheckedReason }> = [];
  let directoryQueriesOff = false;
  for (const a of input.attendees) {
    const email = a.email.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const optional = !!a.roles?.optional;
    const principal = directory.byEmail.get(email);
    if (principal) people.push({ email, name: a.name, optional, id: principal.id });
    else if (directory.complete) people.push({ email, name: a.name, optional, reason: "external" });
    else {
      if (directory.directoryQueriesOff) directoryQueriesOff = true;
      people.push({ email, name: a.name, optional, reason: "not_found" });
    }
  }

  const ids = [ownId, ...people.flatMap((p) => (p.id ? [p.id] : []))];
  const answers = await lookUpAvailability(client, ids, input.start, input.end);
  if (Object.values(answers).some((a) => "error" in a && a.error === "forbidden")) return { kind: "unavailable" };
  const rateLimited = Object.values(answers).some((a) => "error" in a && a.error === "rateLimit");

  const mine = answers[ownId];
  const rows: ScheduleRow[] = [{
    email: own,
    name: "",
    you: true,
    optional: false,
    state: mine && "periods" in mine ? { kind: "known", periods: mine.periods } : { kind: "not_checked", reason: "error" },
  }];
  for (const p of people) {
    let state: RowState;
    if (!p.id) state = { kind: "not_checked", reason: p.reason! };
    else {
      const answer = answers[p.id];
      if (!answer || "error" in answer) state = { kind: "not_checked", reason: "error" };
      // Stalwart answers no busy time both for an empty calendar and for one
      // the user may not see.
      else if (answer.periods.length === 0 && !input.visibleOwners.has(p.email)) state = { kind: "not_checked", reason: "unknown" };
      else state = { kind: "known", periods: answer.periods };
    }
    rows.push({ email: p.email, name: p.name, you: false, optional: p.optional, state });
  }
  return { kind: "ok", rows, directoryQueriesOff, rateLimited };
}

interface SchedulingAssistantProps {
  attendees: SchedulingAttendee[];
  /** The event window as instants. */
  start: Date | null;
  end: Date | null;
  /** Moves the event to the chosen time. */
  onPick: (slot: Slot) => void;
  /** An existing event's saved window, left out of everyone's busy time. */
  savedWindow?: { start: Date; end: Date } | null;
}

/**
 * "Availability…" in the event editor: a day of everyone's busy time side by
 * side, one row per person and one for all of them, with the event on top to
 * click, drag or move with the arrow keys. Shown where Suggest times is: for
 * the organiser of a timed event with attendees, on a server that answers
 * free/busy.
 */
export function SchedulingAssistant({ attendees, start, end, onPick, savedWindow }: SchedulingAssistantProps) {
  const t = useTranslations("scheduling_assistant");
  const client = useAuthStore((s) => s.client);
  const [open, setOpen] = useState(false);
  const supported = !!client?.supportsAvailability?.() && !!client.getPrincipalsAvailability;
  const valid = !!start && !!end && end.getTime() > start.getTime();
  if (!supported || attendees.length === 0 || !valid) return null;

  return (
    <div className="mt-2">
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={() => setOpen(true)}
        className="gap-1.5"
        data-testid="scheduling-assistant-button"
      >
        <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
        {t("open")}
      </Button>
      {open && (
        <SchedulingDialog
          client={client!}
          attendees={attendees}
          initial={{ start: start!, end: end! }}
          savedWindow={savedWindow ?? null}
          onClose={() => setOpen(false)}
          onPick={(slot) => {
            onPick(slot);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

const pct = (minutes: number) => `${(minutes / DAY_MINUTES) * 100}%`;
const placed = (span: GridSpan): CSSProperties => ({ insetInlineStart: pct(span.from), width: pct(span.to - span.from) });
const STRIPES = "repeating-linear-gradient(135deg, transparent 0 4px, rgb(255 255 255 / 0.45) 4px 7px)";
const HATCH = "repeating-linear-gradient(135deg, currentColor 0 1px, transparent 1px 7px)";
const HOURS = Array.from({ length: 24 }, (_, h) => h);

type Loaded = { day: string; outcome: ScheduleOutcome } | null;

function SchedulingDialog({
  client,
  attendees,
  initial,
  savedWindow,
  onClose,
  onPick,
}: {
  client: IJMAPClient;
  attendees: SchedulingAttendee[];
  initial: Slot;
  savedWindow: Slot | null;
  onClose: () => void;
  onPick: (slot: Slot) => void;
}) {
  const t = useTranslations("scheduling_assistant");
  const tFind = useTranslations("find_time");
  const tAvail = useTranslations("calendar.participants.availability");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const calendars = useCalendarStore((s) => s.calendars);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const workingDaysSetting = useSettingsStore((s) => s.calendarWorkingDays);
  const dayStartHour = useSettingsStore((s) => s.calendarDayStartHour);
  const dayEndHour = useSettingsStore((s) => s.calendarDayEndHour);
  const zone = getEffectiveTimeZone();
  const hour12 = timeFormat === "12h";
  const hintId = useId();

  const [draft, setDraft] = useState<Slot>(initial);
  const [day, setDay] = useState<GridDay>(() => dayOf(initial.start, zone));
  const dayKey = `${day.year}-${day.month}-${day.day}`;
  const [loaded, setLoaded] = useState<Loaded>(null);
  const visibleOwners = useMemo(() => visibleCalendarOwners(calendars), [calendars]);
  const attendeesKey = attendees.map((a) => `${a.email.toLowerCase()}:${a.roles?.optional ? 1 : 0}`).join(",");

  // One batched lookup per day shown, after a short pause so that paging
  // through the days doesn't spend a call per person on each day passed.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const bounds = dayBounds(day, zone);
      const allowed = await checkAvailabilityAccess(client);
      const outcome: ScheduleOutcome = allowed
        ? await loadScheduleRows(client, { attendees, start: bounds.start, end: bounds.end, visibleOwners })
          .catch((): ScheduleOutcome => ({ kind: "unavailable" }))
        : { kind: "unavailable" };
      if (!cancelled) setLoaded({ day: dayKey, outcome });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // attendeesKey stands in for the attendees array; day for dayKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, dayKey, attendeesKey, zone, visibleOwners]);

  const outcome = loaded?.day === dayKey ? loaded.outcome : null;
  const rows = outcome?.kind === "ok" ? outcome.rows : null;
  // Until the day's answers are in: the same people, without busy time.
  const shownRows: Array<Omit<ScheduleRow, "state"> & { state: RowState | null }> = rows ?? [
    { email: "", name: "", you: true, optional: false, state: null },
    ...attendees
      .filter((a) => a.email.trim().toLowerCase() !== (client.getUsername()?.trim().toLowerCase() ?? ""))
      .map((a) => ({ email: a.email.trim().toLowerCase(), name: a.name, you: false, optional: !!a.roles?.optional, state: null })),
  ];
  const working = workingSpan(day, workingDaySet(workingDaysSetting), searchHours(dayStartHour, dayEndHour));
  const shaded = outsideWorkingSpans(working);
  const rowSpans = useMemo(
    () => rows?.map((r) => (r.state.kind === "known" ? busySpans(r.state.periods, day, zone, savedWindow) : null)) ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, dayKey, zone, savedWindow],
  );
  const combined = useMemo(() => {
    if (!rows || !rowSpans) return null;
    const required = rowSpans.filter((spans, i): spans is BusySpan[] => !!spans && !rows[i].optional);
    return combineSpans(required);
  }, [rows, rowSpans]);
  const everyoneFree = combined && working ? freeSpans(combined, working) : [];

  const slotSpan = spanOnDay(draft.start, draft.end, day, zone);
  const endsLater = draft.end.getTime() > dayBounds(day, zone).end.getTime();

  // ── The pointer, as a minute of the day ──────────────────────────────────
  const timelineRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isRtl = () => !!timelineRef.current && getComputedStyle(timelineRef.current).direction === "rtl";
  const minuteAt = (clientX: number) => {
    const el = timelineRef.current;
    if (!el) return 0;
    const box = el.getBoundingClientRect();
    if (!box.width) return 0;
    const x = isRtl() ? box.right - clientX : clientX - box.left;
    return Math.max(0, Math.min(DAY_MINUTES, (x / box.width) * DAY_MINUTES));
  };

  const drag = useRef<{ mode: "move" | "resize"; offset: number } | null>(null);
  const onSlotPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !slotSpan) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const resize = !!(e.target as Element).closest("[data-slot-resize]");
    drag.current = { mode: resize ? "resize" : "move", offset: resize ? 0 : minuteAt(e.clientX) - slotSpan.from };
  };
  const onSlotPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const minute = minuteAt(e.clientX);
    setDraft((prev) => (d.mode === "move" ? moveSlotTo(prev, day, minute - d.offset, zone) : resizeSlotTo(prev, day, minute, zone)));
  };
  const endDrag = () => {
    drag.current = null;
  };
  // A click (or tap) on the grid puts the event's start there; the slot
  // itself is moved by dragging, so a click on it changes nothing.
  const onGridClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest("[data-slot-block]")) return;
    const minute = Math.floor(minuteAt(e.clientX) / SNAP_MINUTES) * SNAP_MINUTES;
    setDraft((prev) => moveSlotTo(prev, day, minute, zone));
  };
  const onSlotKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!slotSpan || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    // The arrow that points later on the screen: right, or left in RTL.
    const step = ((e.key === "ArrowRight") !== isRtl() ? 1 : -1) * SNAP_MINUTES;
    if (e.shiftKey) setDraft((prev) => resizeSlotTo(prev, day, (endsLater ? DAY_MINUTES : slotSpan.to) + step, zone));
    else setDraft((prev) => moveSlotTo(prev, day, slotSpan.from + step, zone));
  };

  // Open on the event, or on the working hours when the event is elsewhere.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const timeline = timelineRef.current;
    if (!el || !timeline) return;
    const from = Math.max(0, Math.min(slotSpan?.from ?? DAY_MINUTES, working?.from ?? DAY_MINUTES, 8 * 60) - 60);
    const x = (from / DAY_MINUTES) * timeline.scrollWidth;
    el.scrollLeft = isRtl() ? -x : x;
    // Only when the day changes, not with each step of a drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey]);

  // ── Labels ────────────────────────────────────────────────────────────────
  const dayLabel = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: zone })
    .format(instantAt(day, 12 * 60, zone));
  const hourFormat = new Intl.DateTimeFormat(locale, { hour: "numeric", hour12, timeZone: zone });
  const timeFormatter = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", hour12, timeZone: zone });
  const shortDay = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: zone });
  const chosen = tFind("slot", { day: shortDay.format(draft.start), start: timeFormatter.format(draft.start), end: timeFormatter.format(draft.end) });
  const unknownBusy = rows?.some((r) => r.state.kind === "not_checked" && r.state.reason === "unknown") ?? false;

  const busyBlock = (span: BusySpan, key: number) => (
    <div
      key={key}
      className={cn("absolute inset-y-1 rounded-sm", span.kind === "busy" ? "bg-destructive/70" : "bg-warning/70")}
      style={{ ...placed(span), backgroundImage: span.kind === "tentative" ? STRIPES : undefined }}
      data-busy={span.kind}
    />
  );

  const rowName = (r: (typeof shownRows)[number]) => (r.you ? t("you") : r.name || r.email);
  const rowNote = (r: (typeof shownRows)[number]) =>
    r.state?.kind === "not_checked" ? tFind(`reason_${r.state.reason}`) : r.optional ? t("optional") : null;

  return (
    <Dialog
      isOpen
      onClose={onClose}
      title={t("title")}
      description={t("description")}
      size="full-on-phone"
      className="sm:max-w-5xl"
      testId="scheduling-assistant"
      footer={
        <>
          <p className="me-auto text-sm text-foreground" role="status" aria-live="polite" data-testid="scheduling-assistant-chosen">
            {chosen}
          </p>
          <Button type="button" variant="outline" onClick={onClose}>{tCommon("cancel")}</Button>
          <Button type="button" onClick={() => onPick(draft)} data-testid="scheduling-assistant-use">{t("use_time")}</Button>
        </>
      }
    >
      <div
        className="mt-4"
        onKeyDown={(e) => {
          // Ctrl+Enter here takes the time; the editor behind would save the
          // event with the old one.
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            onPick(draft);
          }
        }}
      >
        <div className="mb-3 flex items-center gap-1">
          <IconButton label={t("previous_day")} onClick={() => setDay((d) => addDays(d, -1))} data-testid="scheduling-assistant-previous">
            <ChevronLeft />
          </IconButton>
          <IconButton label={t("next_day")} onClick={() => setDay((d) => addDays(d, 1))} data-testid="scheduling-assistant-next">
            <ChevronRight />
          </IconButton>
          <h3 className="ms-1 text-sm font-medium" data-testid="scheduling-assistant-day">{dayLabel}</h3>
          {!outcome && (
            <span role="status" className="ms-2 flex items-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span className="sr-only">{t("loading")}</span>
            </span>
          )}
        </div>

        {outcome?.kind === "unavailable" ? (
          <p className="text-sm text-muted-foreground" role="status">{tAvail("unavailable_on_server")}</p>
        ) : (
          <div ref={scrollRef} className="overflow-x-auto rounded-md border border-border" data-testid="scheduling-assistant-grid">
            <div className="flex min-w-max">
              {/* Names: stay in view while the hours scroll. */}
              <div className="sticky start-0 z-20 w-28 shrink-0 border-e border-border bg-background sm:w-44">
                <div className="h-6 border-b border-border" />
                {shownRows.map((r) => {
                  const note = rowNote(r);
                  return (
                    <div
                      key={r.you ? "" : r.email}
                      className={cn("flex h-10 flex-col justify-center border-b border-border px-2 text-xs", r.optional && "opacity-60")}
                      title={r.email || undefined}
                    >
                      <span className="truncate text-foreground">{rowName(r)}</span>
                      {note && <span className="truncate text-muted-foreground">{note}</span>}
                    </div>
                  );
                })}
                <div className="flex h-10 items-center px-2 text-xs font-medium text-foreground">{t("everyone")}</div>
              </div>

              {/* The day, 48px an hour. */}
              <div
                ref={timelineRef}
                className="relative w-[72rem] shrink-0 cursor-pointer select-none"
                onClick={onGridClick}
                data-testid="scheduling-assistant-timeline"
              >
                <div className="pointer-events-none absolute inset-0" aria-hidden="true">
                  {shaded.map((s, i) => <div key={i} className="absolute inset-y-0 bg-muted/60" style={placed(s)} data-outside-hours="" />)}
                  {HOURS.map((h) => (
                    <div key={h} className="absolute inset-y-0 border-s border-border/50" style={{ insetInlineStart: pct(h * 60) }} />
                  ))}
                </div>
                <div className="relative flex h-6 border-b border-border" aria-hidden="true">
                  {HOURS.map((h) => (
                    <span key={h} className="w-12 shrink-0 ps-1 text-xs leading-6 text-muted-foreground">
                      {hourFormat.format(instantAt(day, h * 60, zone))}
                    </span>
                  ))}
                </div>
                {shownRows.map((row, i) => {
                  const spans = rowSpans?.[i] ?? null;
                  return (
                    <div
                      key={row.you ? "" : row.email}
                      className={cn("relative h-10 border-b border-border", row.optional && "opacity-50")}
                      data-row={row.you ? "you" : row.email}
                      data-row-state={row.state?.kind ?? "loading"}
                    >
                      {!row.state && <div className="absolute inset-1 animate-pulse rounded-sm bg-muted" />}
                      {row.state?.kind === "not_checked" && (
                        <div className="absolute inset-1 rounded-sm text-muted-foreground/40" style={{ backgroundImage: HATCH }} />
                      )}
                      {spans?.map(busyBlock)}
                    </div>
                  );
                })}
                <div className="relative h-10" data-row="everyone">
                  {everyoneFree.map((s, i) => (
                    <div key={`f${i}`} className="absolute inset-y-1 rounded-sm bg-success/25" style={placed(s)} data-everyone-free="" />
                  ))}
                  {combined?.map(busyBlock)}
                </div>

                {slotSpan && slotSpan.to > slotSpan.from && (
                  <div
                    className="absolute bottom-0 top-6 z-10 cursor-grab touch-none rounded-sm border-2 border-primary bg-primary/15 outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                    style={placed(slotSpan)}
                    tabIndex={0}
                    aria-label={t("event", { time: chosen })}
                    aria-describedby={hintId}
                    data-slot-block=""
                    data-slot-start={draft.start.toISOString()}
                    data-slot-end={draft.end.toISOString()}
                    onPointerDown={onSlotPointerDown}
                    onPointerMove={onSlotPointerMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onKeyDown={onSlotKeyDown}
                  >
                    {!endsLater && (
                      <div className="absolute inset-y-0 end-0 w-2 cursor-ew-resize" data-slot-resize="" aria-hidden="true" />
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        <p id={hintId} className="sr-only">{t("keyboard_hint")}</p>

        {outcome?.kind === "ok" && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="scheduling-assistant-legend">
            <Swatch className="bg-destructive/70">{tAvail("busy")}</Swatch>
            <Swatch className="bg-warning/70" style={{ backgroundImage: STRIPES }}>{tAvail("tentative")}</Swatch>
            <Swatch className="bg-success/25">{t("everyone_free")}</Swatch>
            <Swatch className="bg-muted">{t("outside_hours")}</Swatch>
            <Swatch className="border border-border text-muted-foreground/40" style={{ backgroundImage: HATCH }}>{t("not_checked")}</Swatch>
          </div>
        )}
        {outcome?.kind === "ok" && (outcome.rateLimited || unknownBusy || outcome.directoryQueriesOff) && (
          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
            {outcome.rateLimited && <p role="status">{tFind("rate_limited")}</p>}
            {unknownBusy && <p>{tFind("unknown_note")}</p>}
            {outcome.directoryQueriesOff && <p>{tFind("directory_off")}</p>}
            {unknownBusy && <FreeBusyShareButton className="mt-2" />}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function Swatch({ className, style, children }: { className: string; style?: CSSProperties; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("inline-block h-3 w-4 rounded-sm", className)} style={style} aria-hidden="true" />
      {children}
    </span>
  );
}
