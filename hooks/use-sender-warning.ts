"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { getSenderVerification } from "@/lib/email-headers";
import type { Email } from "@/lib/jmap/types";

/**
 * The sender-check label for a message whose From the receiving server's
 * checks don't back, the same verdict as the notice in the message view.
 * Avatars show it instead of the claimed sender's favicon or photo (#1439).
 * Undefined when the check passed or there are no results to judge by.
 */
export function useSenderWarning(email: Pick<Email, "from" | "authenticationResults"> | undefined): string | undefined {
  const t = useTranslations("email_viewer.sender_check");
  const results = email?.authenticationResults;
  const sender = email?.from?.[0]?.email;
  // Every message row asks on every render; the headers only change with the message.
  const hasEmail = !!email;
  const verification = useMemo(() => (hasEmail ? getSenderVerification(results, sender) : null), [hasEmail, results, sender]);
  if (!verification) return undefined;
  return verification.status === "failed" ? t("failed_label") : t("unverified_label");
}
