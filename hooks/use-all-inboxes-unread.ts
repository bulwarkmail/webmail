"use client";

import { useShallow } from "zustand/react/shallow";
import { useEmailStore } from "@/stores/email-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { totalInboxUnread } from "@/lib/account-inbox-unread";

/**
 * Unread mail in the inboxes of the signed-in accounts that aren't on
 * screen, while "count every account" is on in Notifications (the default).
 * The other accounts' folder lists are what the account switcher reads
 * (useProMultiAccountMailboxes); one not loaded yet adds nothing.
 */
export function useOtherAccountsUnread(): number {
  const enabled = useSettingsStore((s) => s.unreadBadgeAllAccounts);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const otherIds = useAccountStore(
    useShallow((s) => (enabled ? s.accounts.filter((a) => a.isConnected && a.id !== activeAccountId).map((a) => a.id) : [])),
  );
  const accountMailboxes = useEmailStore((s) => s.accountMailboxes);
  return totalInboxUnread(otherIds, accountMailboxes);
}

/**
 * The number the app shows for new mail: the open account's own inbox plus,
 * by the same setting, every other account's. The favicon, the app badge,
 * the rail's Mail entry and the tab title all show this one number
 * (usability test 2026-11-04, mail-6).
 */
export function useAllInboxesUnread(): number {
  // `role === 'inbox'` alone is not enough: shared and group inboxes ship in
  // the same `mailboxes` array, so on a delegated setup the first match can
  // be somebody else's inbox.
  const own = useEmailStore((s) => s.mailboxes.find((m) => m.role === "inbox" && !m.isShared)?.unreadEmails ?? 0);
  return own + useOtherAccountsUnread();
}
