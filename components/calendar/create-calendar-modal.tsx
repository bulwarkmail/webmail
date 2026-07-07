"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { X, Loader2, Calendar as CalendarIcon } from "lucide-react";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { useCalendarStore } from "@/stores/calendar-store";
import { CalendarColorPicker } from "@/components/settings/calendar-management-settings";
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  const isValid = name.trim().length > 0;

  const handleSubmit = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setIsSubmitting(true);
    try {
      const created = await createCalendar(client, { name: trimmed, color });
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
  }, [name, color, client, createCalendar, onClose, t]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isSubmitting) onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, isSubmitting]);

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    const focusableEls = modal.querySelectorAll<HTMLElement>(
      'input, select, textarea, button, [tabindex]:not([tabindex="-1"])'
    );
    const firstEl = focusableEls[0];
    const lastEl = focusableEls[focusableEls.length - 1];

    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl?.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl?.focus();
      }
    };
    modal.addEventListener("keydown", handler);
    firstEl?.focus();
    return () => modal.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[1px]"
        onClick={() => !isSubmitting && onClose()}
        aria-hidden="true"
      />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("add_calendar")}
        className="relative bg-background border border-border rounded-lg shadow-xl w-full max-w-md mx-4 animate-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <CalendarIcon className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">{t("add_calendar")}</h2>
          </div>
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="p-1.5 rounded-md hover:bg-muted transition-colors duration-150 text-muted-foreground hover:text-foreground disabled:opacity-50"
            aria-label={tCommon("close")}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("name")}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("name_placeholder")}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              disabled={isSubmitting}
              onKeyDown={(e) => { if (e.key === "Enter" && isValid) handleSubmit(); }}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              {t("color")}
            </label>
            <CalendarColorPicker value={color} onChange={setColor} allowCustom />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid || isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin me-2" />
                {tCommon("loading")}
              </>
            ) : (
              t("create")
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
