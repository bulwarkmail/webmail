"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarClock, Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { useSettingsStore } from "@/stores/settings-store";
import { getEffectiveTimeZone } from "@/lib/timezone";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { BusyPeriod, Calendar } from "@/lib/jmap/types";
import { availabilityCallsLeft, checkAvailabilityAccess, lookUpAvailability } from "@/lib/jmap/free-busy";
import { findFreeSlots, searchWindow, type Slot } from "@/lib/find-a-time";
import { loadAttendeeDirectory } from "./participant-availability";
import { FreeBusyShareButton } from "./free-busy-share-button";

interface Attendee {
  name: string;
  email: string;
}

/** Why an attendee's calendar was left out of the search. */
export type NotCheckedReason = "external" | "unknown" | "not_found" | "error";

export interface SuggestionResult {
  slots: Slot[];
  notChecked: Array<{ email: string; name: string; reason: NotCheckedReason }>;
  /** Some attendees couldn't be looked up because directory queries are off. */
  directoryQueriesOff: boolean;
}

export type SuggestionOutcome =
  | { kind: "ok"; result: SuggestionResult }
  | { kind: "rate_limited" }
  | { kind: "unavailable" };

/**
 * The addresses of people whose calendar the user can see: an account shared
 * with them that holds a calendar they may read. For those, no busy time in
 * the answer means free. For everyone else it may only mean "not shared"
 * (Stalwart answers an empty list then too).
 */
export function visibleCalendarOwners(calendars: Pick<Calendar, "isShared" | "accountName" | "myRights">[]): Set<string> {
  const owners = new Set<string>();
  for (const c of calendars) {
    if (c.isShared && c.myRights?.mayReadItems && c.accountName?.includes("@")) owners.add(c.accountName.trim().toLowerCase());
  }
  return owners;
}

/**
 * Look up everyone Bulwark can and search the free slots. One availability
 * call per attendee it can resolve plus one for the organiser, over the whole
 * search window; refused up front when that would go over what is left of
 * Stalwart 1.0's 100 calls a minute.
 */
export async function suggestTimes(
  client: IJMAPClient,
  input: {
    attendees: Attendee[];
    durationMs: number;
    now: Date;
    timeZone: string;
    workingDays: unknown;
    dayStartHour: unknown;
    dayEndHour: unknown;
    visibleOwners: Set<string>;
    /**
     * The event being edited, as it is saved: its own time shows up as busy
     * for everyone who has it in their calendar, and must not hide itself.
     */
    ownWindow?: { start: Date; end: Date } | null;
  },
): Promise<SuggestionOutcome> {
  const directory = await loadAttendeeDirectory(client);
  const own = client.getUsername()?.trim().toLowerCase() ?? "";
  const ownId = directory.byEmail.get(own)?.id ?? client.getAccountId();
  const people = input.attendees.filter((a) => a.email.trim().toLowerCase() !== own);
  const notChecked: SuggestionResult["notChecked"] = [];
  const ids = new Map<string, string>();
  let directoryQueriesOff = false;
  for (const person of people) {
    const email = person.email.trim().toLowerCase();
    const principal = directory.byEmail.get(email);
    if (principal) {
      ids.set(email, principal.id);
    } else if (directory.complete) {
      notChecked.push({ email, name: person.name, reason: "external" });
    } else {
      if (directory.directoryQueriesOff) directoryQueriesOff = true;
      notChecked.push({ email, name: person.name, reason: "not_found" });
    }
  }
  const principalIds = [ownId, ...ids.values()];
  if (availabilityCallsLeft(client) < principalIds.length) return { kind: "rate_limited" };

  const window = searchWindow(input);
  const answers = await lookUpAvailability(client, principalIds, window.start, window.end);
  const busy: BusyPeriod[] = [];
  const own_ = answers[ownId];
  if (own_ && "periods" in own_) busy.push(...own_.periods);
  else if (own_ && "error" in own_ && own_.error === "forbidden") return { kind: "unavailable" };
  if (Object.values(answers).some((a) => "error" in a && a.error === "rateLimit")) return { kind: "rate_limited" };

  for (const [email, id] of ids) {
    const person = people.find((p) => p.email.trim().toLowerCase() === email)!;
    const answer = answers[id];
    if (!answer || "error" in answer) {
      if (answer && "error" in answer && answer.error === "forbidden") return { kind: "unavailable" };
      notChecked.push({ email, name: person.name, reason: "error" });
      continue;
    }
    // Stalwart answers the same empty list for someone with nothing on and
    // for someone whose calendar the user may not see: only a calendar the
    // user can see makes "no busy time" mean free.
    if (answer.periods.length === 0 && !input.visibleOwners.has(email)) {
      notChecked.push({ email, name: person.name, reason: "unknown" });
      continue;
    }
    busy.push(...answer.periods);
  }

  const saved = input.ownWindow;
  const others = saved
    ? busy.filter((p) => !(Date.parse(p.utcStart) === saved.start.getTime() && Date.parse(p.utcEnd) === saved.end.getTime()))
    : busy;
  const slots = findFreeSlots({ ...input, busy: others });
  return { kind: "ok", result: { slots, notChecked, directoryQueriesOff } };
}

function formatSlot(slot: Slot, locale: string, timeZone: string, hour12: boolean): { day: string; start: string; end: string } {
  const day = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone }).format(slot.start);
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", hour12, timeZone });
  return { day, start: time.format(slot.start), end: time.format(slot.end) };
}

interface FindATimeProps {
  attendees: Attendee[];
  /** The event window as instants; its length is the meeting's. */
  start: Date | null;
  end: Date | null;
  /** Moves the event to the picked slot. */
  onPick: (slot: Slot) => void;
  /** An existing event's saved window, left out of everyone's busy time. */
  savedWindow?: { start: Date; end: Date } | null;
}

/**
 * "Suggest times" next to the attendees' availability in the event editor:
 * up to five slots in the next ten working days that are free for everyone
 * whose calendar Bulwark could check, and who it couldn't check and why.
 * The list opens in place under the button (the editor is a full-screen
 * sheet on phones already); Escape closes it and gives the focus back.
 */
export function FindATime({ attendees, start, end, onPick, savedWindow }: FindATimeProps) {
  const t = useTranslations("find_time");
  const locale = useLocale();
  const client = useAuthStore((s) => s.client);
  const calendars = useCalendarStore((s) => s.calendars);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const workingDays = useSettingsStore((s) => s.calendarWorkingDays);
  const dayStartHour = useSettingsStore((s) => s.calendarDayStartHour);
  const dayEndHour = useSettingsStore((s) => s.calendarDayEndHour);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SuggestionOutcome | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const seq = useRef(0);

  const supported = !!client?.supportsAvailability?.() && !!client.getPrincipalsAvailability;
  const durationMs = start && end ? end.getTime() - start.getTime() : 0;
  const attendeesKey = attendees.map((a) => a.email.toLowerCase()).join(",");
  // A new set of people or a new length is a new question.
  useEffect(() => {
    seq.current++;
    setOutcome(null);
    setBusy(false);
  }, [attendeesKey, durationMs]);

  const visibleOwners = useMemo(() => visibleCalendarOwners(calendars), [calendars]);

  if (!supported || attendees.length === 0 || !(durationMs > 0)) return null;

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const search = async () => {
    if (!client) return;
    const mine = ++seq.current;
    setOpen(true);
    setBusy(true);
    setPicked(null);
    const allowed = await checkAvailabilityAccess(client);
    const result: SuggestionOutcome = allowed
      ? await suggestTimes(client, {
          attendees,
          durationMs,
          now: new Date(),
          timeZone: getEffectiveTimeZone(),
          workingDays,
          dayStartHour,
          dayEndHour,
          visibleOwners,
          ownWindow: savedWindow ?? null,
        }).catch((): SuggestionOutcome => ({ kind: "unavailable" }))
      : { kind: "unavailable" };
    if (mine !== seq.current) return;
    setOutcome(result);
    setBusy(false);
  };

  const zone = getEffectiveTimeZone();
  const hour12 = timeFormat === "12h";
  const label = (slot: Slot) => {
    const f = formatSlot(slot, locale, zone, hour12);
    return t("slot", { day: f.day, start: f.start, end: f.end });
  };
  const result = outcome?.kind === "ok" ? outcome.result : null;
  const unknownBusy = result?.notChecked.some((n) => n.reason === "unknown") ?? false;

  return (
    <div
      className="mt-2"
      onKeyDown={(e) => {
        // Escape closes the list, from the button too: the editor closes on
        // Escape as well, and this one is the list's.
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          e.preventDefault();
          close();
        }
      }}
    >
      <Button
        ref={buttonRef}
        type="button"
        size="xs"
        variant="outline"
        onClick={() => (open && !busy ? close() : void search())}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-testid="find-a-time-button"
      >
        <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
        {t("suggest")}
      </Button>
      {open && (
        <div
          id={panelId}
          className="mt-2 rounded-md border border-border bg-muted/30 p-3 text-xs"
          data-testid="find-a-time-panel"
        >
          <div role="status" aria-live="polite" className="text-muted-foreground">
            {busy && (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                {t("searching")}
              </span>
            )}
            {!busy && outcome?.kind === "rate_limited" && t("rate_limited")}
            {!busy && outcome?.kind === "unavailable" && t("unavailable")}
            {!busy && result && result.slots.length === 0 && t("none")}
            {!busy && result && result.slots.length > 0 && !picked && <span className="sr-only">{t("found", { count: result.slots.length })}</span>}
            {!busy && picked && t("picked", { slot: picked })}
          </div>
          {!busy && result && result.slots.length > 0 && (
            <>
              <p className="mb-1.5 font-medium text-foreground">{t("slots_title")}</p>
              <ul className="space-y-1" aria-label={t("slots_title")} data-testid="find-a-time-slots">
                {result.slots.map((slot) => {
                  const text = label(slot);
                  return (
                    <li key={slot.start.toISOString()}>
                      <button
                        type="button"
                        className="flex min-h-9 w-full items-center rounded-md px-2 py-1.5 text-start text-sm text-foreground hover:bg-accent focus-visible:bg-accent"
                        onClick={() => {
                          onPick(slot);
                          setPicked(text);
                        }}
                        data-slot-start={slot.start.toISOString()}
                      >
                        {text}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {!busy && result && result.notChecked.length > 0 && (
            <div className="mt-2 text-muted-foreground" data-testid="find-a-time-not-checked">
              <p>{t("not_checked")}</p>
              <ul className="mt-0.5 list-disc ps-4">
                {result.notChecked.map((n) => (
                  <li key={n.email} className="break-words">
                    {t("not_checked_item", { who: n.name ? `${n.name} (${n.email})` : n.email, reason: t(`reason_${n.reason}`) })}
                  </li>
                ))}
              </ul>
              {unknownBusy && <p className="mt-1">{t("unknown_note")}</p>}
              {result.directoryQueriesOff && <p className="mt-1">{t("directory_off")}</p>}
            </div>
          )}
          {!busy && result && unknownBusy && <FreeBusyShareButton className="mt-2" />}
        </div>
      )}
    </div>
  );
}
