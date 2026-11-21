"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { Calendar, CalendarEvent, CalendarParticipant, Principal } from "@/lib/jmap/types";
import { accountOwnerOf, resolveAnswerTargets, type AccountOwner, type AnswerTarget, type AnswerView } from "@/lib/calendar-delegate";
import { getUserParticipantId } from "@/lib/calendar-participants";
import { RsvpButtons } from "./rsvp-buttons";

type Status = CalendarParticipant["participationStatus"];

const owners = new WeakMap<IJMAPClient, Map<string, Promise<Principal | null>>>();

/** The principal behind a shared account, asked once per client. */
function loadAccountOwner(client: IJMAPClient, accountId: string): Promise<Principal | null> {
  let cache = owners.get(client);
  if (!cache) {
    cache = new Map();
    owners.set(client, cache);
  }
  let owner = cache.get(accountId);
  if (!owner) {
    owner = client.getAccountOwners
      ? client.getAccountOwners([accountId]).then((found) => found[accountId] ?? null).catch(() => null)
      : Promise.resolve(null);
    cache.set(accountId, owner);
  }
  return owner;
}

/**
 * The owner of a shared or group account (Principal/get, else the session's
 * account name), or null for none.
 */
export function useAccountOwner(client: IJMAPClient | null, accountId: string | null, accountName: string | undefined): AccountOwner | null {
  const [principal, setPrincipal] = useState<{ accountId: string; principal: Principal | null } | null>(null);
  useEffect(() => {
    if (!client || !accountId) return;
    let cancelled = false;
    void loadAccountOwner(client, accountId).then((found) => {
      if (!cancelled) setPrincipal({ accountId, principal: found });
    });
    return () => { cancelled = true; };
  }, [client, accountId]);
  return useMemo(
    () => (accountId ? accountOwnerOf(principal?.accountId === accountId ? principal.principal : null, accountName) : null),
    [accountId, accountName, principal],
  );
}

/**
 * The answer bars of an event: the user's own, and "Answer for <owner>" for
 * an invitation in a calendar shared with them by its owner
 * (lib/calendar-delegate.ts).
 */
export function useAnswerView(
  event: CalendarEvent | null,
  calendar: Calendar | null | undefined,
  userEmails: string[],
  canRsvpSelf: boolean,
): AnswerView {
  const client = useAuthStore((s) => s.client);
  const events = useCalendarStore((s) => s.events);
  const sharedAccountId = calendar?.isShared ? calendar.accountId ?? null : null;
  const owner = useAccountOwner(client, sharedAccountId, calendar?.accountName);

  return useMemo(
    () => (event ? answerViewFor({ event, calendar, userEmails, canRsvpSelf, owner, events, client }) : { targets: [], note: null, answeredBy: null }),
    [event, calendar, userEmails, canRsvpSelf, owner, events, client],
  );
}

/** The answer bars of an event, with the store's events and the client at hand (useAnswerView, the grid's answers). */
export function answerViewFor({ event, calendar, userEmails, canRsvpSelf, owner, events, client }: {
  event: CalendarEvent;
  calendar: Calendar | null | undefined;
  userEmails: string[];
  canRsvpSelf: boolean;
  owner: AccountOwner | null;
  events: CalendarEvent[];
  client: IJMAPClient | null;
}): AnswerView {
  const sharedAccountId = calendar?.isShared ? calendar.accountId ?? null : null;
  // The same occurrence in the user's own calendar: the store holds a
  // series as its expanded occurrences.
  const ownCopy = event.uid
    ? events.find((e) => e.uid === event.uid && !e.isShared && e.id !== event.id && (e.recurrenceId ?? null) === (event.recurrenceId ?? null)) ?? null
    : null;
  // Stalwart 1.0 lists principals:owner in every account; 0.16 never does.
  const server016 = !!client && !!sharedAccountId
    && !client.hasAccountCapability("urn:ietf:params:jmap:principals:owner", sharedAccountId);
  return resolveAnswerTargets({ event, calendar, userEmails, canRsvpSelf, owner, ownCopy, server016 });
}

/**
 * What the grid's menu and reply marker answer: the user's own invitation
 * in their own calendars, the owner's (and the user's, when invited too)
 * in a shared calendar whose owner is known, as the bars do (#1760).
 */
export function gridAnswerTargets(input: Parameters<typeof answerViewFor>[0]): AnswerTarget[] {
  if (input.owner && input.calendar?.isShared) return answerViewFor(input).targets;
  const { event, userEmails, canRsvpSelf } = input;
  if (!canRsvpSelf) return [];
  const participantId = getUserParticipantId(event, userEmails);
  return participantId
    ? [{ kind: "self", eventId: event.id, participantId, status: event.participants?.[participantId]?.participationStatus ?? null }]
    : [];
}

/**
 * The owners of the shared and group accounts among `calendars`, by account
 * id, for the grid (#1760). Each is asked once per client, as for the bars.
 */
export function useAccountOwners(client: IJMAPClient | null, calendars: readonly Calendar[]): ReadonlyMap<string, AccountOwner> {
  // Account id and name of each shared account, as one string so a new
  // calendars array with the same accounts changes nothing.
  const signature = useMemo(() => {
    const seen = new Map<string, string>();
    for (const calendar of calendars) {
      if (calendar.isShared && calendar.accountId && !seen.has(calendar.accountId)) seen.set(calendar.accountId, calendar.accountName ?? "");
    }
    return [...seen].map(([id, name]) => `${id}\t${name}`).sort().join("\n");
  }, [calendars]);
  const [principals, setPrincipals] = useState<{ client: IJMAPClient; found: Record<string, Principal | null> } | null>(null);
  useEffect(() => {
    if (!client || !signature) return;
    let cancelled = false;
    const ids = signature.split("\n").map((line) => line.split("\t")[0]);
    void Promise.all(ids.map((id) => loadAccountOwner(client, id).then((found) => [id, found] as const))).then((entries) => {
      if (!cancelled) setPrincipals({ client, found: Object.fromEntries(entries) });
    });
    return () => { cancelled = true; };
  }, [client, signature]);
  return useMemo(() => {
    const owners = new Map<string, AccountOwner>();
    if (!signature) return owners;
    const found = principals && principals.client === client ? principals.found : {};
    for (const line of signature.split("\n")) {
      const [id, name] = line.split("\t");
      const owner = accountOwnerOf(found[id] ?? null, name || undefined);
      if (owner) owners.set(id, owner);
    }
    return owners;
  }, [signature, principals, client]);
}

/**
 * The bars themselves: "Your response" and "Answer for <owner>", each with
 * accept, maybe and decline, and the line that says why there is no bar
 * for the owner, or who answered last for them.
 */
export function AnswerBars({ view, size, onRespond, className }: {
  view: AnswerView;
  size?: "xs";
  onRespond: (target: AnswerTarget, status: Status) => void;
  className?: string;
}) {
  const t = useTranslations("calendar");
  const tDelegate = useTranslations("calendar_delegate");
  if (view.targets.length === 0 && !view.note && !view.answeredBy) return null;
  return (
    <div className={className} data-testid="answer-bars">
      <div className="space-y-3">
        {view.targets.map((target) => {
          const label = target.kind === "owner"
            ? tDelegate("answer_for", { name: target.ownerName ?? "" })
            : t("participants.rsvp_label");
          return (
            <div
              key={`${target.kind}:${target.eventId}`}
              role="group"
              aria-label={label}
              className="flex flex-wrap items-center justify-between gap-2"
              data-testid={target.kind === "owner" ? "answer-for-owner" : "answer-self"}
            >
              <span className={size === "xs" ? "text-xs font-medium text-muted-foreground" : "text-sm font-medium"}>{label}</span>
              <RsvpButtons status={target.status} onRespond={(status) => onRespond(target, status)} size={size} />
            </div>
          );
        })}
      </div>
      {view.note && (
        <p className="mt-2 text-xs text-muted-foreground" role="note" data-testid={`answer-note-${view.note.kind}`}>
          {tDelegate(view.note.kind, { name: view.note.owner })}
        </p>
      )}
      {view.answeredBy && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="answered-by">
          {tDelegate("answered_by", { who: view.answeredBy })}
        </p>
      )}
    </div>
  );
}
