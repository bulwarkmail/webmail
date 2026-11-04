"use client";

import { useMemo, type ChangeEvent } from "react";
import { useTranslations } from "next-intl";
import { useCollectionNames } from "@/hooks/use-collection-names";
import { groupCalendarsByAccount } from "@/lib/calendar-targets";
import type { Calendar } from "@/lib/jmap/types";
import { useAccountStore } from "@/stores/account-store";

/**
 * The options of any calendar or address book select, under each account's
 * address when several accounts are signed in (pim-p2-3), the account on
 * screen first. Goes inside the caller's own <select>.
 */
export function AccountGroupedOptions<T extends { id: string; localAccountId?: string }>({ items, label }: {
  items: T[];
  label: (item: T) => string;
}) {
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const groups = useMemo(() => groupCalendarsByAccount(items, accounts, activeAccountId), [items, accounts, activeAccountId]);
  const options = (list: T[]) => list.map((item) => <option key={item.id} value={item.id}>{label(item)}</option>);
  return (
    <>
      {groups.map((group) => group.label === null
        ? options(group.calendars)
        : <optgroup key={group.key} label={group.label}>{options(group.calendars)}</optgroup>)}
    </>
  );
}

interface CalendarSelectProps {
  id?: string;
  calendars: Calendar[];
  value: string;
  onChange: (calendarId: string) => void;
  className?: string;
  "aria-label"?: string;
  title?: string;
  /** For events: a task list that is listed only because the event already sits there gets a note. */
  kind?: "event" | "task";
}

/** Every calendar and task list chooser: grouped by account, names as Settings shows them. */
export function CalendarSelect({ id, calendars, value, onChange, className, title, kind = "event", ...rest }: CalendarSelectProps) {
  const shownName = useCollectionNames();
  const t = useTranslations("ux_p2_pim_cal");
  const label = (cal: Calendar) => {
    const name = shownName.calendar(cal);
    return kind === "event" && cal.isTasksOnly ? t("task_list_not_in_calendar", { name }) : name;
  };
  return (
    <select
      id={id}
      value={value}
      onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
      aria-label={rest["aria-label"]}
      title={title}
      className={className}
      data-testid="calendar-select"
    >
      <AccountGroupedOptions items={calendars} label={label} />
    </select>
  );
}
