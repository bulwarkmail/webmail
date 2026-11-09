"use client";

import { useTranslations } from "next-intl";
import { Clock } from "@/components/icons";
import { useAccountPolicy } from "@/hooks/use-account-policy";
import { useEmailStore } from "@/stores/email-store";
import type { Mailbox } from "@/lib/jmap/types";
import { TrashRecoveryLink } from "./trash-recovery-link";

/**
 * Days the admin says the server keeps mail in this folder (Organisation >
 * Notices > Trash and Junk, policy.json `organisation.retention`), or 0
 * when there is nothing to say. A normal user can't read Stalwart's own
 * value, so the admin's number is the only source.
 */
export function useRetentionDays(role: string | null | undefined, accountId?: string | null): number {
  // The folder's own signed-in account: another account's Trash opened from
  // the sidebar, or a Pro folder tab, follows that account's scopes.
  const viewing = useEmailStore((s) => s.viewingAccountId);
  const retention = useAccountPolicy(accountId ?? viewing).organisation?.retention;
  if (!retention) return 0;
  if (role === "trash") return retention.trashDays;
  if (role === "junk") return retention.junkDays;
  return 0;
}

/** The quiet line itself, for lists that have no Trash recovery link (the Pro folder tab). */
export function RetentionNotice({ role, accountId }: { role: string | null | undefined; accountId?: string | null }) {
  const t = useTranslations("retention_notice");
  const days = useRetentionDays(role, accountId);
  if (days <= 0) return null;
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-1.5 text-xs text-muted-foreground" data-testid="retention-notice">
      <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{t("line", { count: days })}</span>
    </div>
  );
}

/**
 * The header line of Trash and Junk: how long mail is kept there, and in
 * the account's own Trash the link to Recover deleted items, on one line
 * when both show.
 */
export function FolderRetentionLine({ mailbox }: { mailbox: Mailbox | undefined }) {
  const t = useTranslations("retention_notice");
  const days = useRetentionDays(mailbox?.role);
  const text = days > 0 ? t("line", { count: days }) : undefined;
  if (mailbox?.role === "trash") return <TrashRecoveryLink mailbox={mailbox} notice={text} />;
  if (mailbox?.role === "junk") return <RetentionNotice role="junk" />;
  return null;
}
