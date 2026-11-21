"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { Check, User } from "@/components/icons";
import { TAG_LOZENGE_CLASS } from "@/components/email/tag-badge";
import { assigneesOf, isDone, type Keywords } from "@/lib/team-mailboxes/keywords";
import { shortName, type TeamPeople } from "@/lib/team-mailboxes/names";
import { cn } from "@/lib/utils";

/** What the chip needs of the team's people (hooks/use-team-people.ts). */
export type ChipPeople = Pick<TeamPeople, "selfId" | "byId"> & { lookUp?: (ids: readonly string[]) => void };

export interface AssigneeChipProps {
  /** The message's keywords. */
  keywords: Keywords;
  people: ChipPeople;
  className?: string;
}

const CHIP_CLASS = cn(TAG_LOZENGE_CLASS, "max-w-[8rem] gap-0.5 border");

/**
 * Who a team message is assigned to, on its row: "Me", the assignee's first
 * name, or "Assigned" while their name isn't known (and asked for); "+N"
 * when several people have it, the user first. The full sentence
 * is the title and what a screen reader hears. Nothing when unassigned.
 */
export function AssigneeChip({ keywords, people, className }: AssigneeChipProps) {
  const t = useTranslations("team_assign");
  const { selfId, byId, lookUp } = people;
  const ids = assigneesOf(keywords).sort((a, b) => Number(b === selfId) - Number(a === selfId));
  const known = (id: string) => {
    const p = byId(id);
    return p && (p.name || p.email) ? p : null;
  };
  const unknown = ids.filter((id) => id !== selfId && !known(id));
  const unknownKey = unknown.join(" ");

  useEffect(() => {
    if (unknown.length > 0) lookUp?.(unknown);
    // Asked again only when the ids change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unknownKey, lookUp]);

  if (ids.length === 0) return null;
  const first = ids[0];
  const mine = first === selfId;
  const firstPerson = known(first);
  const name = mine ? t("chip_me") : firstPerson ? shortName(firstPerson) : t("chip_assigned");
  const label = ids.length > 1 ? t("chip_more", { name, count: ids.length - 1 }) : name;

  let title: string;
  if (ids.length > 1) {
    const names = ids.map((id) => known(id)?.name || known(id)?.email).filter((n): n is string => !!n);
    title = names.length > 0 ? t("assigned_to", { name: names.join(", ") }) : t("assigned_unknown");
  } else if (mine) {
    title = t("assigned_to_you");
  } else {
    title = firstPerson ? t("assigned_to", { name: firstPerson.name || firstPerson.email }) : t("assigned_unknown");
  }

  return (
    <span
      title={title}
      data-testid="team-assignee-chip"
      className={cn(CHIP_CLASS, "border-border bg-muted text-muted-foreground", className)}
    >
      <User className="w-3 h-3 flex-shrink-0" aria-hidden />
      <span className="truncate" aria-hidden="true">{label}</span>
      <span className="sr-only">{title}</span>
    </span>
  );
}

/** The Done mark on a team message's row, in the success colour. Nothing when the message is open. */
export function DoneMark({ keywords, className }: { keywords: Keywords; className?: string }) {
  const t = useTranslations("team_assign");
  if (!isDone(keywords)) return null;
  const title = t("marked_done");
  return (
    <span
      title={title}
      data-testid="team-done-mark"
      // The success hue, dark enough for small text on both themes (text-success alone is under 4.5:1).
      className={cn(CHIP_CLASS, "border-success/40 bg-success/10 text-green-700 dark:text-green-400", className)}
    >
      <Check className="w-3 h-3 flex-shrink-0" aria-hidden />
      <span className="truncate" aria-hidden="true">{t("done")}</span>
      <span className="sr-only">{title}</span>
    </span>
  );
}
