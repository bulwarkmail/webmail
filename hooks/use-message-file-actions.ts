"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import { create } from "zustand";
import { useAuthStore } from "@/stores/auth-store";
import { useAccountStore } from "@/stores/account-store";
import { useEmailStore, resolveEmailBlobContext, type EmailBlobContext } from "@/stores/email-store";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "@/stores/toast-store";
import { emailExportFilename, DEFAULT_EMAIL_TEMPLATE } from "@/lib/download-filename";
import { runBatchEmailAction } from "@/lib/email-action-toast";
import type { Email } from "@/lib/jmap/types";
import type { CopyTargetAccount } from "@/components/email/email-context-menu";
import { DOWNLOAD_BLOCKED_EVENT, downloadAllowed } from "@/lib/download-guard";
import { canCopyBetween, canPrint, deviceSubjectOf, type DeviceSubject } from "@/lib/device-policy";
import { usePolicyStore } from "@/stores/policy-store";
import { saveMessagesNatively } from "@/lib/desktop/save-as";

/** What follows an export, by the "After export" setting. */
export interface ExportFollowUp {
  onArchive?: () => void;
  onDelete?: () => void;
  /** The Archive action is offered at all; with it off a stored 'archive' keeps the message. */
  archiveEnabled?: boolean;
}

/** The .eml name of a message, by the user's file name settings. */
function exportName(email: Email): string {
  const s = useSettingsStore.getState();
  return emailExportFilename(email, {
    template: s.emailDownloadTemplate || DEFAULT_EMAIL_TEMPLATE,
    spaceReplacement: s.filenameSpaceReplacement,
    lowercase: s.filenameLowercase,
    stripDiacritics: s.filenameStripDiacritics,
    collapseSeparators: s.filenameCollapseSeparators,
  });
}

/**
 * Saves messages as .eml files: in the desktop app through the OS's Save dialog (one
 * message) or into a folder the user picks (several), each named by the file name
 * settings; in a browser as downloads. A single message is then archived or deleted as
 * the "After export" setting says. Nothing is saved when the device policy of any of the
 * messages' accounts forbids exporting.
 */
export function useSaveEmails(): (emails: Email[], followUp?: ExportFollowUp, source?: EmailBlobContext) => Promise<void> {
  const tNotifications = useTranslations("notifications");
  const tSave = useTranslations("desktopSaveOpen");
  return useCallback(async (emails, followUp = {}, source) => {
    const client = useAuthStore.getState().client;
    const items = emails
      .map((email) => ({ email, context: emails.length === 1 && source ? source : resolveEmailBlobContext(email, client) }))
      .filter(({ email, context }) => !!email.blobId && !!context.client);
    if (items.length === 0) return;
    // The device policy of each message's account (Organisation > Devices); refused,
    // nothing is saved, and the message is not archived or deleted either.
    if (items.some(({ email }) => !downloadAllowed("export", email))) return;
    const native = await saveMessagesNatively(items.map(({ email, context }) => ({
      name: exportName(email),
      load: () => context.client!.fetchBlob(email.blobId!, exportName(email), "message/rfc822", context.accountId),
    }))).catch(() => ({ status: "saved" as const, saved: 0, failed: items.length }));
    if (native) {
      if (native.status !== "saved") return;
      if (native.failed > 0) {
        toast.error(items.length === 1 ? tNotifications("export_email_error") : tSave("save_failed", { count: native.failed }));
        return;
      }
      if (items.length > 1) toast.success(tSave("saved_many", { count: native.saved }));
    } else {
      try {
        for (const { email, context } of items) {
          await context.client!.downloadBlob(email.blobId!, exportName(email), "message/rfc822", context.accountId, { kind: "export" });
        }
      } catch {
        toast.error(tNotifications("export_email_error"));
        return;
      }
    }
    if (items.length !== 1) return;
    const action = useSettingsStore.getState().postExportAction;
    if (action === "archive" && followUp.archiveEnabled !== false) followUp.onArchive?.();
    else if (action === "trash") followUp.onDelete?.();
  }, [tNotifications, tSave]);
}

/**
 * Saves a message as .eml, from the reader or straight from its row in the
 * list (R6), then archives or deletes it as the "After export" setting says.
 * In the desktop app this is Save as…, with the OS's Save dialog.
 */
export function useEmailExport(): (email: Email, followUp?: ExportFollowUp, source?: EmailBlobContext) => Promise<void> {
  const saveEmails = useSaveEmails();
  return useCallback((email, followUp, source) => saveEmails([email], followUp, source), [saveEmails]);
}

// ── Print from the list ─────────────────────────────────────────────────

interface PrintRequest {
  /** emailKeyFor of the message to print. */
  key: string;
  /** Opened in the click, so no popup blocker stands in the way; filled by the reader. */
  win: Window;
}

/**
 * A print asked for from a row's menu. The list opens the message and the
 * print window in the click; the reader prints into that window once the
 * message's body is there (it alone knows how the body is shown).
 */
export const usePrintRequestStore = create<{
  request: PrintRequest | null;
  setRequest: (request: PrintRequest | null) => void;
}>((set) => ({
  request: null,
  setRequest: (request) => set({ request }),
}));

/** Opens the print window now (in the click) and asks the reader to fill it. */
export function requestPrint(key: string, subject?: DeviceSubject): boolean {
  // Not under the device policy "No printing".
  if (!canPrint(subject)) return false;
  const win = window.open("", "_blank");
  if (!win) return false;
  // See the reader's print: no opener for a document the sender shaped.
  win.opener = null;
  const previous = usePrintRequestStore.getState().request;
  if (previous && previous.win !== win && !previous.win.closed) previous.win.close();
  usePrintRequestStore.getState().setRequest({ key, win });
  return true;
}

// ── Copy to another account ─────────────────────────────────────────────

/**
 * "Copy to" another connected account: the targets (only with more than one
 * account connected; the message's own login is left out) and the copy.
 * The targets' folders load once `enabled` turns on (a menu opened).
 */
export function useCopyToAccount(source: Pick<Email, "sourceClientAccountId"> | null, enabled: boolean) {
  const tNotifications = useTranslations("notifications");
  const accounts = useAccountStore((state) => state.accounts);
  const accountMailboxes = useEmailStore((state) => state.accountMailboxes);
  const fetchAccountMailboxes = useEmailStore((state) => state.fetchAccountMailboxes);
  const copyEmailsToAccount = useEmailStore((state) => state.copyEmailsToAccount);
  const viewingAccountId = useEmailStore((state) => state.viewingAccountId);
  const activeAccountId = useAuthStore((state) => state.activeAccountId);
  const sourceLogin = source ? source.sourceClientAccountId ?? viewingAccountId ?? activeAccountId : null;
  // Re-checked when the policy changes: the device policies decide where a copy may go.
  const policyVersion = usePolicyStore((state) => state.rawPolicy);

  const copyAccounts = useMemo(() => {
    if (!enabled || !source) return [];
    const connected = useAuthStore.getState().getAllConnectedClients();
    if (connected.size < 2) return [];
    // Never from an account under a device policy into one that lets the copy out.
    return accounts.filter((account) => account.id !== sourceLogin && connected.has(account.id)
      && canCopyBetween(sourceLogin, account.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, source, accounts, sourceLogin, policyVersion]);

  useEffect(() => {
    for (const account of copyAccounts) {
      if (accountMailboxes[account.id]) continue;
      const accountClient = useAuthStore.getState().getClientForAccount(account.id);
      if (accountClient) void fetchAccountMailboxes(accountClient, account.id);
    }
  }, [copyAccounts, accountMailboxes, fetchAccountMailboxes]);

  const copyTargets = useMemo<CopyTargetAccount[]>(
    () => copyAccounts
      .filter((account) => accountMailboxes[account.id])
      .map((account) => ({ accountId: account.id, label: account.label || account.email || account.id, mailboxes: accountMailboxes[account.id] })),
    [copyAccounts, accountMailboxes],
  );

  const copyToAccount = useCallback(async (emails: Email[], accountId: string, mailboxId: string) => {
    // Pass the emails, not their ids: an id alone cannot say which
    // account's namesake to copy.
    const target = useEmailStore.getState().accountMailboxes[accountId]?.find((mb) => mb.id === mailboxId);
    // Backstop for the filter above (a menu opened before the policy changed).
    if (emails.some((email) => !canCopyBetween(deviceSubjectOf(email) ?? useAuthStore.getState().activeAccountId, accountId))) {
      // DevicePolicyHost says why: exporting mail is turned off.
      window.dispatchEvent(new CustomEvent(DOWNLOAD_BLOCKED_EVENT, { detail: { kind: "export" } }));
      return;
    }
    await runBatchEmailAction(() => copyEmailsToAccount(emails, accountId, target?.originalId ?? mailboxId), {
      success: tNotifications("emails_copied", { count: emails.length }),
      error: tNotifications("copy_failed"),
    });
  }, [copyEmailsToAccount, tNotifications]);

  return { copyTargets, copyToAccount };
}
