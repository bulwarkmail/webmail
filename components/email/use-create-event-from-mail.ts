"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { usePolicyStore } from "@/stores/policy-store";
import { emailLinkSource } from "@/stores/email-store";
import { appUrl, buildMailPath } from "@/lib/deep-links";
import { eventDraftFromEmail, savePendingEventDraft } from "@/lib/event-from-mail";
import type { Email } from "@/lib/jmap/types";

/**
 * "Create event…" on a message (#1579): the calendar's editor opens on a new
 * event filled in from it. Null where there is no calendar to put it in.
 */
export function useCreateEventFromMail(): ((email: Email) => void) | null {
  const t = useTranslations("event_from_mail");
  const router = useRouter();
  const supportsCalendar = useCalendarStore((s) => s.supportsCalendar);
  const calendarEnabled = usePolicyStore((s) => s.isFeatureEnabled("calendarEnabled"));
  const primaryIdentity = useAuthStore((s) => s.primaryIdentity);
  const identities = useAuthStore((s) => s.identities);

  const create = useCallback((email: Email) => {
    const ownEmails = [primaryIdentity?.email, ...identities.map((i) => i.email)].filter((a): a is string => Boolean(a));
    const link = appUrl(buildMailPath({ mailboxId: null, emailId: email.id, threadId: null, ...emailLinkSource(email) }));
    savePendingEventDraft(eventDraftFromEmail(email, {
      ownEmails,
      link,
      linkLine: (value) => t("link_line", { link: value }),
    }));
    router.push("/calendar");
  }, [primaryIdentity, identities, router, t]);

  return supportsCalendar && calendarEnabled ? create : null;
}
