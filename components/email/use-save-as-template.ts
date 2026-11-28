"use client";

import { useCallback } from "react";
import { useAccountPolicy } from "@/hooks/use-account-policy";
import type { Email } from "@/lib/jmap/types";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useSaveAsTemplateStore } from "@/stores/save-as-template-store";

/**
 * "Save as template…" on a message: its subject and body become one of the
 * user's templates (components/templates/save-as-template-host.tsx). Null
 * where the admin left the message's account no personal templates.
 */
export function useSaveAsTemplate(email: Pick<Email, "sourceClientAccountId">): ((email: Email) => void) | null {
  const viewingAccountId = useEmailStore((s) => s.viewingAccountId);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const policy = useAccountPolicy(email.sourceClientAccountId ?? viewingAccountId ?? activeAccountId);
  const save = useCallback((message: Email) => useSaveAsTemplateStore.getState().ask(message), []);
  return policy.restrictions?.personalTemplates?.hidden === true ? null : save;
}
