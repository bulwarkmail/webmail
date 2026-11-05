"use client";

import { useState, useRef, useCallback, useId } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useCalendarStore, type ICalSubscription } from "@/stores/calendar-store";
import { CalendarColorPicker } from "@/components/settings/calendar-management-settings";
import { toast } from "@/stores/toast-store";

interface ICalSubscriptionModalProps {
  client: IJMAPClient;
  onClose: () => void;
  editSubscription?: ICalSubscription;
  initialUrl?: string;
  initialName?: string;
}

export function ICalSubscriptionModal({ client, onClose, editSubscription, initialUrl, initialName }: ICalSubscriptionModalProps) {
  const t = useTranslations("calendar.subscription");
  const tWords = useTranslations("uxp3_desktop");
  const tCommon = useTranslations("common");
  const addICalSubscription = useCalendarStore((s) => s.addICalSubscription);
  const updateICalSubscription = useCalendarStore((s) => s.updateICalSubscription);

  const isEdit = !!editSubscription;

  const [url, setUrl] = useState(editSubscription?.url || initialUrl || "");
  const [name, setName] = useState(editSubscription?.name || initialName || "");
  const [color, setColor] = useState(editSubscription?.color || "#3b82f6");
  const [refreshInterval, setRefreshInterval] = useState(editSubscription?.refreshInterval || 60);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const id = useId();

  const isValid = url.trim().length > 0 && name.trim().length > 0;

  const handleSubmit = useCallback(async () => {
    let trimmedUrl = url.trim();
    if (!trimmedUrl || !name.trim()) return;

    // Convert webcal:// to https://
    if (trimmedUrl.startsWith("webcal://")) {
      trimmedUrl = trimmedUrl.replace(/^webcal:\/\//, "https://");
    }

    try {
      new URL(trimmedUrl);
    } catch {
      setError(t("invalid_url"));
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      if (isEdit && editSubscription) {
        const updates: { url?: string; name?: string; color?: string; refreshInterval?: number } = {};
        if (trimmedUrl !== editSubscription.url) updates.url = trimmedUrl;
        if (name.trim() !== editSubscription.name) updates.name = name.trim();
        if (color !== editSubscription.color) updates.color = color;
        if (refreshInterval !== editSubscription.refreshInterval) updates.refreshInterval = refreshInterval;
        await updateICalSubscription(client, editSubscription.id, updates);
        toast.success(t("updated", { name: name.trim() }));
        onClose();
      } else {
        const subscription = await addICalSubscription(client, trimmedUrl, name.trim(), color, refreshInterval);
        if (subscription) {
          toast.success(t("success", { name: name.trim() }));
          onClose();
        } else {
          setError(t("error"));
        }
      }
    } catch (err) {
      // The store rethrows the proxy's error text ("… larger than the 25 MB
      // limit", "Remote server returned 404") - show it when there is one. (#692)
      const message = err instanceof Error && err.message ? err.message : '';
      setError(message || (isEdit ? t("update_error") : t("error")));
    } finally {
      setIsSubmitting(false);
    }
  }, [url, name, color, refreshInterval, client, isEdit, editSubscription, addICalSubscription, updateICalSubscription, onClose, t]);

  // Nothing closes it while the feed is being fetched.
  const close = useCallback(() => {
    if (!isSubmitting) onClose();
  }, [isSubmitting, onClose]);
  const changed = isEdit
    ? url !== editSubscription!.url || name !== editSubscription!.name || color !== editSubscription!.color || refreshInterval !== editSubscription!.refreshInterval
    : url.trim().length > 0 || name.trim().length > 0;

  const fieldClass = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-hidden";

  return (
    <Dialog
      isOpen
      onClose={close}
      title={isEdit ? t("edit_title") : t("title")}
      description={t("description")}
      dirty={changed}
      // A link handed over from webcal:// already fills the address.
      initialFocus={url ? nameRef : urlRef}
      footer={
        <>
          <Button variant="outline" onClick={close} disabled={isSubmitting}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid || isSubmitting}>
            {isSubmitting ? (
              <>
                <Spinner size="sm" className="me-2 text-current" />
                {isEdit ? t("saving") : t("subscribing")}
              </>
            ) : (
              isEdit ? t("save") : t("subscribe")
            )}
          </Button>
        </>
      }
    >
      <div className="space-y-4 pt-4">
        <div>
          <label htmlFor={`${id}-url`} className="text-xs font-medium text-muted-foreground mb-1 block">
            {/* "Web address", not "Calendar URL" (desktop-p3-16). */}
            {tWords("web_address")}
          </label>
          <input
            id={`${id}-url`}
            ref={urlRef}
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t("url_placeholder")}
            className={fieldClass}
            disabled={isSubmitting}
            onKeyDown={(e) => { if (e.key === "Enter" && isValid) handleSubmit(); }}
          />
        </div>

        <div>
          <label htmlFor={`${id}-name`} className="text-xs font-medium text-muted-foreground mb-1 block">
            {t("name_label")}
          </label>
          <input
            id={`${id}-name`}
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("name_placeholder")}
            className={fieldClass}
            disabled={isSubmitting}
            onKeyDown={(e) => { if (e.key === "Enter" && isValid) handleSubmit(); }}
          />
        </div>

        <div role="group" aria-labelledby={`${id}-color`}>
          <span id={`${id}-color`} className="text-xs font-medium text-muted-foreground mb-1 block">
            {t("color_label")}
          </span>
          <CalendarColorPicker value={color} onChange={setColor} allowCustom />
        </div>

        <div>
          <label htmlFor={`${id}-interval`} className="text-xs font-medium text-muted-foreground mb-1 block">
            {t("refresh_interval")}
          </label>
          <select
            id={`${id}-interval`}
            value={refreshInterval}
            onChange={(e) => setRefreshInterval(Number(e.target.value))}
            className={fieldClass}
            disabled={isSubmitting}
          >
            <option value={15}>{t("interval_15")}</option>
            <option value={30}>{t("interval_30")}</option>
            <option value={60}>{t("interval_60")}</option>
            <option value={360}>{t("interval_360")}</option>
            <option value={1440}>{t("interval_1440")}</option>
          </select>
        </div>

        {error && (
          <div role="alert" className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
