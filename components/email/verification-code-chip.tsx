"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Key } from "@/components/icons";
import { cn } from "@/lib/utils";
import type { Email } from "@/lib/jmap/types";
import { listVerificationCode } from "@/lib/verification-code";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "@/stores/toast-store";
import { CHIP_BOX_CLASS, CHIP_ICON_CLASS } from "./attachment-chips";

/** The code a list row offers: found in the subject and preview of a fresh mail. */
export function useListVerificationCode(email: Email): string | null {
  const enabled = useSettingsStore((state) => state.showVerificationCodes);
  const { subject, preview, receivedAt } = email;
  return useMemo(
    () => (enabled ? listVerificationCode({ subject, preview, receivedAt }) : null),
    [enabled, subject, preview, receivedAt],
  );
}

interface VerificationCodeChipProps {
  code: string;
  className?: string;
}

/** The one-time code of a sign-in mail (lib/verification-code.ts); a click copies it. */
export function VerificationCodeChip({ code, className }: VerificationCodeChipProps) {
  const t = useTranslations("email_viewer.verification_code");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copy_failed"));
    }
  };

  const Icon = copied ? Check : Key;
  return (
    <button
      type="button"
      // In a list row the row itself opens the message; the chip must not do both.
      onClick={(e) => { e.stopPropagation(); void copy(); }}
      onDoubleClick={(e) => e.stopPropagation()}
      title={t("copy", { code })}
      aria-label={t("copy", { code })}
      data-testid="verification-code-chip"
      className={cn(CHIP_BOX_CLASS, "flex-shrink-0 bg-background/60 font-medium text-foreground hover:bg-muted", className)}
    >
      <Icon className={cn(CHIP_ICON_CLASS, copied ? "text-success" : "text-amber-600 dark:text-amber-400")} />
      <span className="font-mono tracking-wide">{code}</span>
    </button>
  );
}
