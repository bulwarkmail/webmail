"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CalendarSelect } from "@/components/calendar/calendar-select";
import { preferredTarget } from "@/lib/calendar-targets";
import { useAccountStore } from "@/stores/account-store";
import { useCalendarStore } from "@/stores/calendar-store";
import type { Calendar } from "@/lib/jmap/types";

/**
 * "Copy to calendar…" for an event the user can't change, such as one from a
 * subscription (#1513): which of their own calendars gets the copy. The
 * calendar a new event would go to is preselected.
 */
export function CopyToCalendarDialog({
  isOpen,
  calendars,
  onClose,
  onCopy,
}: {
  isOpen: boolean;
  /** The calendars the user can add events to. */
  calendars: Calendar[];
  onClose: () => void;
  onCopy: (calendar: Calendar) => void;
}) {
  const t = useTranslations("ux_p2_pim_cal");
  const tCal = useTranslations("calendar");
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const lastEventCalendarIds = useCalendarStore((s) => s.lastEventCalendarIds);
  const [calendarId, setCalendarId] = useState(
    () => preferredTarget(calendars, activeAccountId, lastEventCalendarIds)?.id ?? calendars[0]?.id ?? "",
  );
  const target = calendars.find((c) => c.id === calendarId);
  const copy = () => {
    if (!target) return;
    onCopy(target);
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      title={t("copy_to_calendar_title")}
      description={t("copy_to_calendar_hint")}
      testId="copy-to-calendar-dialog"
      onSubmit={(e) => { e.preventDefault(); copy(); }}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>{tCal("form.cancel")}</Button>
          <Button type="submit" disabled={!target}>{t("copy_button")}</Button>
        </>
      }
    >
      <label htmlFor="copy-to-calendar-select" className="text-sm font-medium mb-1 block">{tCal("form.calendar_select")}</label>
      <CalendarSelect
        id="copy-to-calendar-select"
        calendars={calendars}
        value={calendarId}
        onChange={setCalendarId}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-hidden"
      />
    </Dialog>
  );
}
