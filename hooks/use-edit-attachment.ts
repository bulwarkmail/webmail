"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { canEditFile, editAllowed, startAttachmentEdit, type EditStartResult, type StartEditInput } from "@/lib/desktop/edit-attachments";
import { deviceSubjectOf } from "@/lib/device-policy";
import { useDevicePolicy } from "@/hooks/use-device-policy";
import { useAuthStore } from "@/stores/auth-store";
import { toast } from "@/stores/toast-store";

const FAILURE_KEYS: Partial<Record<Exclude<EditStartResult, { ok: true }>["reason"], string>> = {
  policy: "blocked_policy",
  "no-app": "no_app",
  type: "blocked_type",
  "too-large": "too_large",
  full: "too_many",
};

/** The local account a message or a draft belongs to, where a copy of its file is filed. */
export function editAccountOf(email: { sourceClientAccountId?: string | null } | null | undefined): string {
  return deviceSubjectOf(email) ?? useAuthStore.getState().activeAccountId ?? "";
}

/**
 * Edit, for whatever shows an attachment: whether to offer it, and starting it with the app's
 * words for how it went. `account` is the local account the attachment belongs to; the
 * hook follows that account's policy, so the item goes as soon as the answer turns to no.
 */
export function useEditAttachment(account: string) {
  const t = useTranslations("desktopEdit");
  const devices = useDevicePolicy(account || null);
  const offered = !devices.noDownloads && !devices.noExport;
  const canEdit = useCallback((name: string | null | undefined) => (
    offered && !!account && canEditFile(name) && editAllowed(account)
  ), [offered, account]);
  const edit = useCallback(async (input: StartEditInput): Promise<EditStartResult> => {
    let result: EditStartResult;
    try {
      result = await startAttachmentEdit(input);
    } catch (error) {
      console.error("Could not open an attachment for editing:", error);
      result = { ok: false, reason: "failed" };
    }
    if (result.ok) toast.success(t("opened", { name: input.name }));
    // Locked: the lock screen is what's saying it.
    else if (result.reason !== "locked") toast.error(t(FAILURE_KEYS[result.reason] ?? "failed"));
    return result;
  }, [t]);
  return { canEdit, edit };
}
