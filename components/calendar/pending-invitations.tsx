"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Check, ChevronDown, ChevronRight, HelpCircle, X } from "@/components/icons";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { useSettingsStore } from "@/stores/settings-store";
import { resolveTimeZone } from "@/lib/timezone";
import { formatEventSummary, formatInvitationSchedule } from "@/lib/calendar-invitation";
import { eventOrganizer, getUserParticipantId } from "@/lib/calendar-participants";
import { fetchUpcomingEvents, pendingInvitations } from "@/lib/calendar-pending-invitations";
import type { RsvpStatus } from "@/lib/calendar-rsvp";
import type { CalendarEvent } from "@/lib/jmap/types";
import { cn } from "@/lib/utils";

interface PendingInvitationsProps {
  /** The user's addresses for the account an event is in. */
  userEmailsFor: (event: CalendarEvent) => string[];
  /** Open the event, as a click on it in the grid does. */
  onOpen: (event: CalendarEvent) => void;
  /** Answer the invitation; resolves to whether the answer went out. */
  onRespond: (event: CalendarEvent, participantId: string, status: RsvpStatus) => Promise<boolean>;
}

// A change to the calendar (an answer here or anywhere else, a new
// invitation by push) reads the list again after this long.
const REFRESH_DELAY_MS = 1500;

/**
 * The invitations the user hasn't answered (#1669), above the calendars in
 * the sidebar, each with Accept, Maybe and Decline. Hidden while there are
 * none.
 */
export function PendingInvitations({ userEmailsFor, onOpen, onRespond }: PendingInvitationsProps) {
  const t = useTranslations("calendar_invitations");
  const tCalendar = useTranslations("calendar");
  const locale = useLocale();
  const client = useAuthStore((s) => s.client);
  const storeEvents = useCalendarStore((s) => s.events);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const timeZone = resolveTimeZone(useSettingsStore((s) => s.timeZone));
  const [upcoming, setUpcoming] = useState<CalendarEvent[]>([]);
  // Answered here: out of the list until the next read has the answer.
  const [answered, setAnswered] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState(true);
  const firstLoad = useRef(true);

  useEffect(() => {
    if (!client) {
      setUpcoming([]);
      return;
    }
    const controller = new AbortController();
    const delay = firstLoad.current ? 0 : REFRESH_DELAY_MS;
    firstLoad.current = false;
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => fetchUpcomingEvents(client, new Date(), controller.signal))
        .then((events) => {
          if (controller.signal.aborted) return;
          setUpcoming(events);
          setAnswered(new Set());
        })
        .catch(() => { /* the list stays as it was */ });
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, storeEvents]);

  const pending = pendingInvitations(upcoming, userEmailsFor).filter((event) => !answered.has(event.uid || event.id));
  if (pending.length === 0) return null;

  const respond = async (event: CalendarEvent, status: RsvpStatus) => {
    const participantId = getUserParticipantId(event, userEmailsFor(event));
    if (!participantId) return;
    const key = event.uid || event.id;
    setAnswered((s) => new Set(s).add(key));
    const sent = await onRespond(event, participantId, status).catch(() => false);
    if (sent) return;
    // Not sent (refused, or a plugin stopped it): it is still to answer.
    setAnswered((s) => {
      const next = new Set(s);
      next.delete(key);
      return next;
    });
  };

  const answerButton = (event: CalendarEvent, status: RsvpStatus) => {
    const Icon = status === "accepted" ? Check : status === "tentative" ? HelpCircle : X;
    const label = tCalendar(status === "accepted" ? "participants.accept" : status === "tentative" ? "participants.maybe" : "participants.decline");
    return (
      <button
        type="button"
        onClick={() => { void respond(event, status); }}
        aria-label={`${label}: ${event.title || tCalendar("events.no_title")}`}
        title={label}
        data-testid={`pending-invitation-${status}`}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors min-h-[28px] pointer-coarse:min-h-[36px]",
          status === "accepted" && "hover:text-success hover:border-success/30 hover:bg-success/10",
          status === "tentative" && "hover:text-warning hover:border-warning/30 hover:bg-warning/10",
          status === "declined" && "hover:text-destructive hover:border-destructive/30 hover:bg-destructive/10",
        )}
      >
        <Icon className="w-3 h-3" />
        {label}
      </button>
    );
  };

  return (
    <section className="mb-3" data-testid="pending-invitations" aria-label={t("title")}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-1 ps-3 pe-3 py-1 text-start"
      >
        {expanded
          ? <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />
          : <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />}
        <span className="text-xs font-medium text-muted-foreground truncate">{t("title")}</span>
        <span className="ms-auto rounded-full bg-primary px-1.5 text-[0.625rem] font-semibold leading-4 text-primary-foreground tabular-nums" data-testid="pending-invitations-count">
          {pending.length}
        </span>
      </button>
      {expanded && (
        <ul className="mt-1 space-y-1 px-2 max-h-80 overflow-y-auto">
          {pending.map((event) => {
            const summary = formatEventSummary(event);
            const organizer = eventOrganizer(event);
            return (
              <li key={event.uid || event.id} className="rounded-md px-1 py-1.5 hover:bg-muted/50" data-testid="pending-invitation">
                <button type="button" onClick={() => onOpen(event)} className="block w-full min-w-0 text-start">
                  <span className="block truncate text-sm font-medium text-foreground">{event.title || tCalendar("events.no_title")}</span>
                  {summary.start && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {formatInvitationSchedule(summary, { locale, timeZone, hour12: timeFormat === "12h" })}
                    </span>
                  )}
                  {organizer && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {t("from", { name: organizer.name || organizer.email })}
                    </span>
                  )}
                </button>
                <div className="mt-1 flex flex-wrap gap-1">
                  {answerButton(event, "accepted")}
                  {answerButton(event, "tentative")}
                  {answerButton(event, "declined")}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
