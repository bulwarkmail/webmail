"use client";

import { useCallback } from "react";
import { useAccountStore } from "@/stores/account-store";
import { collectUserCalendarAddresses } from "@/lib/calendar-participants";

/**
 * The user's addresses for one event. With several logins in the calendar
 * (pim-12), an event of another login is answered and edited as that login,
 * so its participant is found by that login's address, not the active
 * login's ones (`activeEmails`).
 */
export function eventUserEmails(
  event: { localAccountId?: string } | null | undefined,
  activeEmails: string[],
  activeLocalAccountId: string | null,
  accounts: ReadonlyArray<{ id: string; email?: string; username?: string }>,
): string[] {
  const owner = event?.localAccountId;
  if (!owner || owner === activeLocalAccountId) return activeEmails;
  const account = accounts.find((a) => a.id === owner);
  if (!account) return activeEmails;
  const own = collectUserCalendarAddresses([account.email, account.username?.includes("@") ? account.username : null]);
  return own.length > 0 ? own : activeEmails;
}

export function useEventUserEmails(activeEmails: string[]): (event: { localAccountId?: string } | null | undefined) => string[] {
  const accounts = useAccountStore((s) => s.accounts);
  const activeLocalAccountId = useAccountStore((s) => s.activeAccountId);
  return useCallback(
    (event) => eventUserEmails(event, activeEmails, activeLocalAccountId, accounts),
    [activeEmails, activeLocalAccountId, accounts],
  );
}
