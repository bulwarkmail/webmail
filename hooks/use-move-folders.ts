"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { useShallow } from "zustand/react/shallow";
import type { Email } from "@/lib/jmap/types";
import { useAuthStore } from "@/stores/auth-store";
import { moveFoldersFor, useEmailStore, type MoveFolders, type MoveUnavailableReason } from "@/stores/email-store";

/**
 * moveFoldersFor for a Move picker on screen: the folders of the login the
 * messages are in, worked out again when a folder list, the login browsed or
 * the connected logins change.
 */
export function useMoveFolders(emails: ReadonlyArray<Pick<Email, "sourceClientAccountId">>): MoveFolders {
  const lists = useEmailStore(useShallow((state) => ({
    mailboxes: state.mailboxes,
    accountMailboxes: state.accountMailboxes,
    viewingAccountId: state.viewingAccountId,
  })));
  const activeAccountId = useAuthStore((state) => state.activeAccountId);
  const revision = useAuthStore((state) => state.connectedAccountsRevision);
  const client = useAuthStore((state) => state.client);
  const logins = emails.map((email) => email.sourceClientAccountId ?? "").join("\n");
  return useMemo(
    () => moveFoldersFor(emails, lists),
    // By the logins the messages name: a new array of the same messages asks the same.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [logins, emails.length, lists, activeAccountId, revision, client],
  );
}

/** Why Move is not offered, in the user's words: the existing sentences. */
export function useMoveUnavailableHint(): (reason: MoveUnavailableReason | undefined) => string | undefined {
  const tMenu = useTranslations("context_menu");
  const tNotifications = useTranslations("notifications");
  return (reason) => (reason === "several_logins"
    ? tMenu("rules.cross_account")
    : reason === "not_connected" ? tNotifications("not_connected") : undefined);
}
