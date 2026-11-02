"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "@/components/icons";
import { useAuthStore } from "@/stores/auth-store";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { BusyPeriod, Principal } from "@/lib/jmap/types";
import { loadPrincipalDirectory } from "@/lib/jmap/principal-directory";
import { checkAvailabilityAccess, knownAvailabilityAccess, lookUpAvailability, revokeAvailabilityAccess } from "@/lib/jmap/free-busy";
import { cn } from "@/lib/utils";

interface Attendee {
  name: string;
  email: string;
}

/**
 * `unknown`: the address is not a user in a complete directory listing.
 * `not_looked_up`: the server refused to list its users (directory queries
 * off), so the address could not be matched to anyone.
 * `no_busy_times`: the server returned no busy time for the attendee's day.
 * It says the same when the user may not see that person's free/busy.
 * `error`: the lookup failed or was rate-limited, so nothing is known.
 */
export type AvailabilityStatus = "free" | "busy" | "tentative" | "no_busy_times" | "unknown" | "not_looked_up" | "error" | "checking";

interface ParticipantAvailabilityProps {
  attendees: Attendee[];
  /** The event window; null while the form has no valid dates. */
  start: Date | null;
  end: Date | null;
}

/**
 * The status of one attendee for the window, given their busy periods:
 * any confirmed/unavailable overlap wins over a tentative one.
 */
export function availabilityFor(periods: BusyPeriod[], start: Date, end: Date): "free" | "busy" | "tentative" {
  let status: "free" | "busy" | "tentative" = "free";
  for (const p of periods) {
    const pStart = new Date(p.utcStart).getTime();
    const pEnd = new Date(p.utcEnd).getTime();
    if (pStart < end.getTime() && pEnd > start.getTime()) {
      if (p.busyStatus === "tentative") {
        if (status === "free") status = "tentative";
      } else {
        return "busy";
      }
    }
  }
  return status;
}

/** Who the attendees are on this server, as far as the directory tells. */
export interface AttendeeDirectory {
  byEmail: Map<string, Principal>;
  /** The listing names every user, so an address that isn't in it is not one. */
  complete: boolean;
  /** The server refused the listing because directory queries are off (Stalwart 1.0's default). */
  directoryQueriesOff: boolean;
}

/**
 * The principal directory by address. A refused listing still holds the
 * principals the user shares an account with (Principal/get answers for
 * those). Stalwart 1.0.1 looks up their free/busy with directory queries
 * off, so they are checked; the 1.0 builds that refuse the lookups as well
 * say so with `forbidden` on the lookup.
 */
export async function loadAttendeeDirectory(client: IJMAPClient): Promise<AttendeeDirectory> {
  const directory = await loadPrincipalDirectory(client);
  const byEmail = new Map<string, Principal>();
  for (const p of directory.principals) {
    if (p.email) byEmail.set(p.email.toLowerCase(), p);
  }
  return {
    byEmail,
    complete: directory.status === "ok",
    directoryQueriesOff: directory.status === "restricted" && !!directory.directoryQueriesOff,
  };
}

/**
 * The status of every address for the window, or null when the server won't
 * answer free/busy for this user: a lookup refused with `forbidden`.
 */
async function lookUpStatuses(
  client: IJMAPClient,
  emails: string[],
  start: Date,
  end: Date,
): Promise<Record<string, AvailabilityStatus> | null> {
  const { byEmail, complete, directoryQueriesOff } = await loadAttendeeDirectory(client);
  const principalIds = emails.flatMap((email) => byEmail.get(email)?.id ?? []);
  const answers = await lookUpAvailability(client, principalIds, start, end);
  const statuses: Record<string, AvailabilityStatus> = {};
  for (const email of emails) {
    const principal = byEmail.get(email);
    if (!principal) {
      // Only a complete listing shows that an address is not a user here.
      statuses[email] = complete ? "unknown" : directoryQueriesOff ? "not_looked_up" : "error";
      continue;
    }
    const answer = answers[principal.id];
    if ("error" in answer) {
      if (answer.error === "forbidden") return null;
      statuses[email] = "error";
    } else {
      // An empty answer is also what someone gets who may not see this
      // person's free/busy, so it doesn't mean "available".
      statuses[email] = answer.periods.length === 0 ? "no_busy_times" : availabilityFor(answer.periods, start, end);
    }
  }
  return statuses;
}

/**
 * Free/busy of the invited attendees for the event window
 * (Principal/getAvailability). Only attendees that are principals on this
 * server can be checked; external addresses show as unknown. When the server
 * won't answer free/busy for this user, one line says so; nothing is shown
 * when it doesn't offer free/busy at all.
 */
export function ParticipantAvailability({ attendees, start, end }: ParticipantAvailabilityProps) {
  const t = useTranslations("calendar.participants.availability");
  const tFind = useTranslations("find_time");
  const client = useAuthStore((s) => s.client);
  const supported = !!client?.supportsAvailability?.() && !!client.getPrincipalsAvailability;
  const [statuses, setStatuses] = useState<Record<string, AvailabilityStatus>>({});
  const [access, setAccess] = useState<{ client: IJMAPClient; allowed: boolean } | null>(null);
  const requestSeq = useRef(0);

  const emails = useMemo(
    () => Array.from(new Set(attendees.map((a) => a.email.trim().toLowerCase()).filter(Boolean))),
    [attendees],
  );
  const emailsKey = emails.join(",");
  const startMs = start?.getTime() ?? null;
  const endMs = end?.getTime() ?? null;
  const windowValid = startMs !== null && endMs !== null && endMs > startMs;
  const wanted = !!client && supported && emails.length > 0 && windowValid;
  // Undefined until the server has said whether it answers free/busy for
  // this user; the block stays hidden until then, so a server that refuses
  // never flashes a list of attendees being checked.
  const allowed = !client ? undefined : access?.client === client ? access.allowed : knownAvailabilityAccess(client);

  useEffect(() => {
    if (!wanted || allowed !== undefined) return;
    let cancelled = false;
    void checkAvailabilityAccess(client!).then((ok) => {
      if (!cancelled) setAccess({ client: client!, allowed: ok });
    });
    return () => { cancelled = true; };
  }, [client, wanted, allowed]);

  useEffect(() => {
    if (!wanted || allowed !== true) {
      setStatuses({});
      return;
    }
    const seq = ++requestSeq.current;
    setStatuses(Object.fromEntries(emails.map((e) => [e, "checking" as const])));
    // Debounce: typing a time or adding several people must not fire a
    // query per keystroke.
    const timer = setTimeout(async () => {
      const windowStart = new Date(startMs!);
      const windowEnd = new Date(endMs!);
      const results = await lookUpStatuses(client!, emails, windowStart, windowEnd);
      if (seq !== requestSeq.current) return;
      if (results === null) {
        revokeAvailabilityAccess(client!);
        setAccess({ client: client!, allowed: false });
        return;
      }
      setStatuses(results);
    }, 400);
    return () => clearTimeout(timer);
    // emailsKey stands in for the emails array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, wanted, allowed, emailsKey, startMs, endMs]);

  if (!wanted) return null;
  if (allowed === false) {
    // Stalwart 1.0 with directory queries off (its default), or a role without
    // the permission to look up free/busy: the lookups are refused, so explain
    // the gap instead of leaving the attendees without a word.
    return (
      <p className="mt-1.5 text-xs text-muted-foreground" role="status" data-testid="participant-availability-unavailable">
        {t("unavailable_on_server")}
      </p>
    );
  }
  if (allowed !== true) return null;

  const notLookedUp = Object.values(statuses).includes("not_looked_up");
  return (
    <>
      <ul className="mt-1.5 space-y-0.5" aria-label={t("title")} data-testid="participant-availability">
        {attendees.map((a) => {
          const status = statuses[a.email.trim().toLowerCase()] ?? "checking";
          return (
            <li key={a.email} className="flex items-center gap-2 text-xs">
              <span
                className={cn(
                  "inline-block h-2 w-2 shrink-0 rounded-full",
                  status === "free" && "bg-success",
                  status === "busy" && "bg-destructive",
                  status === "tentative" && "bg-warning",
                  (status === "no_busy_times" || status === "unknown" || status === "not_looked_up" || status === "error" || status === "checking") && "bg-muted-foreground/40",
                )}
                aria-hidden="true"
              />
              <span className="min-w-0 truncate text-foreground/90" title={a.email}>{a.name || a.email}</span>
              <span className="ms-auto flex shrink-0 items-center gap-1 text-muted-foreground">
                {status === "checking" && <Loader2 className="h-3 w-3 animate-spin" />}
                {status === "not_looked_up" ? tFind("not_looked_up") : t(status)}
              </span>
            </li>
          );
        })}
      </ul>
      {notLookedUp && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="participant-availability-directory-off">
          {tFind("directory_off")}
        </p>
      )}
    </>
  );
}
