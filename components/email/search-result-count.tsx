"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import type { Email } from "@/lib/jmap/types";
import { groupEmailsByThread } from "@/lib/thread-utils";
import { useSettingsStore } from "@/stores/settings-store";

/**
 * The line above search results. The list shows one row per conversation, so
 * "10 results found" above three rows reads wrong: it counts the rows and the
 * messages in them (mail-16).
 */
export function SearchResultCount({ emails, hasMore }: { emails: Email[]; hasMore: boolean }) {
  const t = useTranslations();
  const disableThreading = useSettingsStore((state) => state.disableThreading);
  const conversations = useMemo(
    () => (disableThreading ? emails.length : groupEmailsByThread(emails).length),
    [emails, disableThreading],
  );
  if (hasMore) return <>{t("advanced_search.results_found_more", { count: emails.length })}</>;
  if (conversations === emails.length) return <>{t("advanced_search.results_found", { count: emails.length })}</>;
  return <>{t("mail_list_extra.search_count", { conversations, messages: emails.length })}</>;
}
