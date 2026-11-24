"use client";

import { useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { resolveMutationTarget, useCalendarStore } from "@/stores/calendar-store";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "@/stores/toast-store";
import { resolveTimeZone } from "@/lib/timezone";
import { buildInvitationForward, invitationForwardText } from "@/lib/calendar-forward";
import { requestInternalCompose } from "@/lib/protocol-handlers/mailto";
import { notifyPendingMailto, savePendingMailto } from "@/lib/protocol-handlers/session";
import type { CalendarEvent } from "@/lib/jmap/types";

/**
 * Forward a meeting (#1797): the composer opens with the invitation
 * attached, on the mail page. An occurrence forwards its whole series, read
 * from the server, so the invitation holds the series' rule.
 */
export function useForwardInvitation(): (event: CalendarEvent) => Promise<void> {
  const t = useTranslations("calendar_forward");
  const tComposer = useTranslations("email_composer");
  const locale = useLocale();
  const router = useRouter();
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const timeZoneSetting = useSettingsStore((s) => s.timeZone);

  return useCallback(async (event: CalendarEvent) => {
    const client = useAuthStore.getState().client;
    if (!client) return;
    try {
      const target = resolveMutationTarget(useCalendarStore.getState().events, event.id, "series");
      const series = target.realId !== event.id || event.recurrenceId
        ? await client.getCalendarEvent(target.realId, target.targetAccountId).catch(() => null)
        : null;
      const forwarded = series ?? event;
      const text = invitationForwardText(forwarded, {
        subjectPrefix: tComposer("prefix.forward"),
        heading: t("heading"),
        when: (value) => t("when", { value }),
        where: (value) => t("where", { value }),
        organizer: (value) => t("organizer", { value }),
      }, { locale, timeZone: resolveTimeZone(timeZoneSetting), hour12: timeFormat === "12h" });
      const draft = await buildInvitationForward(client, forwarded, text);
      if (requestInternalCompose(draft)) return;
      // The mail page opens it once it mounts, as Contacts' "Send email" does.
      savePendingMailto(draft);
      notifyPendingMailto();
      router.push("/");
    } catch {
      toast.error(t("failed"));
    }
  }, [t, tComposer, locale, router, timeFormat, timeZoneSetting]);
}
