"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "@/components/icons";
import { useAuthStore } from "@/stores/auth-store";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { BusyPeriod, Principal } from "@/lib/jmap/types";
import { cn } from "@/lib/utils";

interface Attendee {
  name: string;
  email: string;
}

export type AvailabilityStatus = "free" | "busy" | "tentative" | "unknown" | "checking";

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
export function availabilityFor(periods: BusyPeriod[], start: Date, end: Date): Exclude<AvailabilityStatus, "unknown" | "checking"> {
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

const principalCache = new WeakMap<IJMAPClient, Promise<Principal[]>>();

function principalsOf(client: IJMAPClient): Promise<Principal[]> {
  let cached = principalCache.get(client);
  if (!cached) {
    cached = client.getPrincipals().catch(() => [] as Principal[]);
    principalCache.set(client, cached);
  }
  return cached;
}

/**
 * Free/busy of the invited attendees for the event window
 * (Principal/getAvailability). Only attendees that are principals on this
 * server can be checked; external addresses show as unknown.
 */
export function ParticipantAvailability({ attendees, start, end }: ParticipantAvailabilityProps) {
  const t = useTranslations("calendar.participants.availability");
  const client = useAuthStore((s) => s.client);
  const supported = !!client?.supportsAvailability?.() && !!client.getPrincipalAvailability;
  const [statuses, setStatuses] = useState<Record<string, AvailabilityStatus>>({});
  const requestSeq = useRef(0);

  const emails = useMemo(
    () => Array.from(new Set(attendees.map((a) => a.email.trim().toLowerCase()).filter(Boolean))),
    [attendees],
  );
  const emailsKey = emails.join(",");
  const startMs = start?.getTime() ?? null;
  const endMs = end?.getTime() ?? null;
  const windowValid = startMs !== null && endMs !== null && endMs > startMs;

  useEffect(() => {
    if (!client || !supported || emails.length === 0 || !windowValid) {
      setStatuses({});
      return;
    }
    const seq = ++requestSeq.current;
    setStatuses(Object.fromEntries(emails.map((e) => [e, "checking" as const])));
    // Debounce: typing a time or adding several people must not fire a
    // query per keystroke.
    const timer = setTimeout(async () => {
      const principals = await principalsOf(client);
      const byEmail = new Map<string, Principal>();
      for (const p of principals) {
        if (p.email) byEmail.set(p.email.toLowerCase(), p);
      }
      const windowStart = new Date(startMs!);
      const windowEnd = new Date(endMs!);
      const results = await Promise.all(
        emails.map(async (email): Promise<[string, AvailabilityStatus]> => {
          const principal = byEmail.get(email);
          if (!principal) return [email, "unknown"];
          try {
            const periods = await client.getPrincipalAvailability!(principal.id, windowStart, windowEnd);
            return [email, availabilityFor(periods, windowStart, windowEnd)];
          } catch {
            return [email, "unknown"];
          }
        }),
      );
      if (seq === requestSeq.current) setStatuses(Object.fromEntries(results));
    }, 400);
    return () => clearTimeout(timer);
    // emailsKey stands in for the emails array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, supported, emailsKey, startMs, endMs, windowValid]);

  if (!supported || emails.length === 0 || !windowValid) return null;

  return (
    <ul className="mt-1.5 space-y-0.5" aria-label={t("title")} data-testid="participant-availability">
      {attendees.map((a) => {
        const status = statuses[a.email.trim().toLowerCase()] ?? "checking";
        return (
          <li key={a.email} className="flex items-center gap-2 text-xs">
            <span
              className={cn(
                "inline-block h-2 w-2 shrink-0 rounded-full",
                status === "free" && "bg-emerald-500",
                status === "busy" && "bg-red-500",
                status === "tentative" && "bg-amber-500",
                (status === "unknown" || status === "checking") && "bg-muted-foreground/40",
              )}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate text-foreground/90">{a.name || a.email}</span>
            <span className="ms-auto flex shrink-0 items-center gap-1 text-muted-foreground">
              {status === "checking" && <Loader2 className="h-3 w-3 animate-spin" />}
              {t(status)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
