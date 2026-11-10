"use client";

import { useCallback, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { useCalendarStore } from "@/stores/calendar-store";
import { CalendarColorPicker } from "@/components/settings/calendar-management-settings";
import { CALENDAR_KIND_COMPONENTS, CalendarKindPicker, type CalendarKind } from "@/components/calendar/calendar-kind-picker";
import { toast } from "@/stores/toast-store";

interface CreateCalendarModalProps {
  client: IJMAPClient;
  onClose: () => void;
}

export function CreateCalendarModal({ client, onClose }: CreateCalendarModalProps) {
  const t = useTranslations("calendar.management");
  const tCommon = useTranslations("common");
  const createCalendar = useCalendarStore((s) => s.createCalendar);

  const [name, setName] = useState("");
  const [color, setColor] = useState("#3b82f6");
  const [kind, setKind] = useState<CalendarKind>("events");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const colorId = useId();

  const isValid = name.trim().length > 0;

  const handleSubmit = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setIsSubmitting(true);
    try {
      const created = await createCalendar(client, { name: trimmed, color }, { components: CALENDAR_KIND_COMPONENTS[kind] });
      if (created) {
        toast.success(t("calendar_created"));
        onClose();
      } else {
        toast.error(t("error_create"));
      }
    } catch {
      toast.error(t("error_create"));
    } finally {
      setIsSubmitting(false);
    }
  }, [name, color, kind, client, createCalendar, onClose, t]);

  // Nothing closes it while the calendar is being created.
  const close = useCallback(() => {
    if (!isSubmitting) onClose();
  }, [isSubmitting, onClose]);

  return (
    <Dialog
      isOpen
      onClose={close}
      title={t("add_calendar")}
      dirty={isValid}
      initialFocus={nameRef}
      footer={
        <>
          <Button variant="outline" onClick={close} disabled={isSubmitting}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid || isSubmitting}>
            {isSubmitting ? (
              <>
                <Spinner size="sm" className="me-2 text-current" />
                {tCommon("loading")}
              </>
            ) : (
              t("create")
            )}
          </Button>
        </>
      }
    >
      <div className="space-y-4 pt-4">
        <div>
          <label htmlFor={nameId} className="text-xs font-medium text-muted-foreground mb-1 block">
            {t("name")}
          </label>
          <input
            id={nameId}
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("name_placeholder")}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-hidden"
            disabled={isSubmitting}
            onKeyDown={(e) => { if (e.key === "Enter" && isValid) handleSubmit(); }}
          />
        </div>

        <div role="group" aria-labelledby={colorId}>
          <span id={colorId} className="text-xs font-medium text-muted-foreground mb-1 block">
            {t("color")}
          </span>
          <CalendarColorPicker value={color} onChange={setColor} allowCustom />
        </div>

        <CalendarKindPicker value={kind} onChange={setKind} disabled={isSubmitting} />
      </div>
    </Dialog>
  );
}
