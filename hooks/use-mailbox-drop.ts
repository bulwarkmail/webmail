"use client";

import { useCallback, useState, DragEvent } from "react";
import { useTranslations } from "next-intl";
import { Mailbox, Email } from "@/lib/jmap/types";
import { useEmailStore, isAggregateListView, restoreBatchesFor, type EmailRestoreBatch, type CrossAccountMoveReceipt } from "@/stores/email-store";
import { useShallow } from "zustand/react/shallow";
import { emailKeyFor } from "@/lib/thread-utils";
import { useAuthStore } from "@/stores/auth-store";
import { useDragDropContext } from "@/contexts/drag-drop-context";
import { dragDropHooks } from "@/lib/plugin-hooks";
import { toast } from "@/stores/toast-store";
import { getMailboxPath } from "@/lib/utils";
import { batchToastTitle, selectionRowCount } from "@/lib/selection-toast";
import { useSettingsStore } from "@/stores/settings-store";

/**
 * Returns the source accountId for an email being dragged. In unified view
 * each email carries its own `accountId`; otherwise everything in the view
 * belongs to whichever account is currently being viewed (Pro shell's
 * Thunderbird-style sidebar) or the globally-active account.
 */
function resolveSourceAccountId(email: Email | undefined): string | null {
  if (email?.accountId) return email.accountId;
  const viewingId = useEmailStore.getState().viewingAccountId;
  if (viewingId) return viewingId;
  return useAuthStore.getState().activeAccountId;
}

interface UseMailboxDropOptions {
  mailbox: Mailbox;
  /**
   * The local account ("user@host") whose folder list `mailbox` is listed
   * in: the multi-account sidebar lists every login's folders. Absent, the
   * active account's. `mailbox.accountId` can't tell: JMAP account ids are
   * only unique per server, and Stalwart numbers the accounts of every
   * install alike.
   */
  accountId?: string;
  onDropComplete?: () => void;
  // Translation callbacks for toast messages. `restore` says where the
  // messages were, for the toast's Undo; null when the move went to another
  // account, which Undo can't take back.
  /** `restore` and `receipts` are what Undo needs (undoMoveAction). */
  onSuccess?: (count: number, mailboxName: string, restore: EmailRestoreBatch[] | null, receipts: CrossAccountMoveReceipt[]) => void;
  onError?: (error: string) => void;
}

interface UseMailboxDropReturn {
  dropHandlers: {
    onDragOver: (e: DragEvent<HTMLDivElement>) => void;
    onDragEnter: (e: DragEvent<HTMLDivElement>) => void;
    onDragLeave: (e: DragEvent<HTMLDivElement>) => void;
    onDrop: (e: DragEvent<HTMLDivElement>) => void;
  };
  isDropTarget: boolean;
  isValidDropTarget: boolean;
  isInvalidDropTarget: boolean;
}

export function useMailboxDrop({ mailbox, accountId, onDropComplete, onSuccess, onError }: UseMailboxDropOptions): UseMailboxDropReturn {
  const tListExtra = useTranslations("mail_list_extra");
  const tRoot = useTranslations();
  const [isOver, setIsOver] = useState(false);
  const { client } = useAuthStore(useShallow((state) => ({ client: state.client })));
  // The selection is read when something is dropped, not subscribed to: a new
  // selection (every folder switch makes one) drew every folder row again.
  const { moveEmailsToMailbox, crossAccountMoveEmails, clearSelection, refreshCurrentMailbox, mailboxes } = useEmailStore(useShallow((state) => ({
    moveEmailsToMailbox: state.moveEmailsToMailbox,
    crossAccountMoveEmails: state.crossAccountMoveEmails,
    clearSelection: state.clearSelection,
    refreshCurrentMailbox: state.refreshCurrentMailbox,
    mailboxes: state.mailboxes,
  })));
  const { isDragging, sourceMailboxId, draggedEmails, endDrag, markDropped } = useDragDropContext();

  // Determine if this is a valid drop target
  const isValidTarget = useCallback(() => {
    if (!isDragging) return false;

    // Cannot drop on same mailbox
    if (mailbox.id === sourceMailboxId) return false;

    // Check if mailbox accepts items
    if (!mailbox.myRights?.mayAddItems) return false;

    // Virtual nodes (shared folder headers) cannot be drop targets
    if (mailbox.id.startsWith("shared-")) return false;

    // Drafts holds what's being written: no Move list offers it either.
    if (mailbox.role === "drafts") return false;

    return true;
  }, [isDragging, mailbox, sourceMailboxId]);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (isValidTarget()) {
      e.dataTransfer.dropEffect = "move";
    } else {
      e.dataTransfer.dropEffect = "none";
    }
  }, [isValidTarget]);

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    // Only leave if actually leaving the element (not entering a child)
    const relatedTarget = e.relatedTarget as Node | null;
    if (!e.currentTarget.contains(relatedTarget)) {
      setIsOver(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsOver(false);

    if (!client || !isValidTarget()) {
      endDrag();
      return;
    }

    try {
      const emailIdsJson = e.dataTransfer.getData("application/x-email-ids");
      if (!emailIdsJson) {
        endDrag();
        return;
      }

      const emailIds: string[] = JSON.parse(emailIdsJson);
      markDropped();

      // The local account the folder belongs to: the one whose list it is in.
      const destAccountId = accountId ?? useAuthStore.getState().activeAccountId;

      let isCrossAccount = false;
      let moved: boolean;
      let restore: EmailRestoreBatch[] | null = null;
      // The messages taken to another account, so Undo can move them back.
      const receipts: CrossAccountMoveReceipt[] = [];
      if (isAggregateListView()) {
        restore = restoreBatchesFor(draggedEmails, client);
        // A list that mixes accounts (unified, tag and "All folders" views)
        // stamps every row with its login and account. The store moves each
        // of those groups apart - in place only in the folder's own account,
        // across accounts for the others. It gets the dragged rows: their
        // ids alone can name other accounts' rows too.
        moved = await moveEmailsToMailbox(client, emailIds, mailbox.id, destAccountId, draggedEmails, receipts);
      } else {
        // Group dragged emails by source account. In single-account flows this
        // collapses to one bucket; in the Pro multi-account sidebar a single
        // drag can mix sources.
        const idToEmail = new Map(draggedEmails.map((em) => [em.id, em]));
        const bySource = new Map<string, string[]>();
        for (const id of emailIds) {
          const srcAccountId = resolveSourceAccountId(idToEmail.get(id));
          if (!srcAccountId) continue;
          if (!bySource.has(srcAccountId)) bySource.set(srcAccountId, []);
          bySource.get(srcAccountId)!.push(id);
        }

        // Decide whether to route via the cross-account (blob copy + import)
        // pipeline. Two cases require it:
        //   1. Destination is a delegated/shared mailbox whose owner JMAP
        //      account differs from the source mailbox's JMAP account. There's
        //      no atomic Email/set across accounts, even via the same client.
        //   2. Destination is a primary mailbox on a different connected local
        //      account than the source — the historical multi-account case.
        const sourceMb = useEmailStore.getState().mailboxes.find(mb => mb.id === sourceMailboxId);
        const sourceJmapAccountId = sourceMb?.accountId;
        const destJmapAccountId = mailbox.accountId;
        const sourceAccountIds = Array.from(bySource.keys());

        const isJmapCrossAccount =
          !!sourceJmapAccountId &&
          !!destJmapAccountId &&
          sourceJmapAccountId !== destJmapAccountId;
        const isLocalCrossAccount =
          !mailbox.isShared &&
          !!destAccountId &&
          sourceAccountIds.some((src) => src !== destAccountId);
        isCrossAccount = isJmapCrossAccount || isLocalCrossAccount;

        if (isCrossAccount) {
          if (!destAccountId) {
            throw new Error('Could not resolve destination account');
          }
          // For a shared destination there is no separately-connected client
          // for the owner; we reuse the viewing user's client but tell the
          // import call to target the owner's JMAP account.
          const jmapDestId = mailbox.originalId || mailbox.id;
          const destJmapOverride = mailbox.isShared ? mailbox.accountId : undefined;
          // Mirror image for the source: a shared group mailbox is accessed
          // through the viewing user's client, but the email/blob live in the
          // owner's JMAP account, so the copy/delete must target it.
          const sourceJmapOverride = sourceMb?.isShared ? sourceMb.accountId : undefined;
          restore = restoreBatchesFor(draggedEmails.filter(em => emailIds.includes(em.id)), client);
          moved = await crossAccountMoveEmails(bySource, destAccountId, jmapDestId, destJmapOverride, sourceJmapOverride, { receipts });
        } else {
          // Single-account or same-account-shared move: bulk JMAP request.
          restore = restoreBatchesFor(draggedEmails.filter(em => emailIds.includes(em.id)), client);
          moved = await moveEmailsToMailbox(client, emailIds, mailbox.id);
        }
      }
      // Nothing moved: a plugin stopped it (and said why), so no drop
      // event and no "moved" message.
      if (!moved) {
        onDropComplete?.();
        return;
      }
      void dragDropHooks.onEmailDrop.emit({ emailIds, targetMailboxId: mailbox.id });

      // Clear selection if any selected emails were moved. The selection is
      // keyed by owning account, so compare the dragged emails, not their ids.
      const { selectedEmailKeys } = useEmailStore.getState();
      if (draggedEmails.some(em => selectedEmailKeys.has(emailKeyFor(em)))) {
        clearSelection();
      }

      // Refresh the current mailbox view (honors active search/filters).
      // Skip for cross-account moves: the store already dropped the moved
      // rows from the in-memory list and refreshed both accounts' folder
      // caches in the background.
      if (!isCrossAccount) {
        await refreshCurrentMailbox(client);
      }

      const mailboxPath = getMailboxPath(mailbox, mailboxes);
      // Counted as the list shows them: conversations when it groups (mail-p3-7).
      const disableThreading = useSettingsStore.getState().disableThreading;
      const rows = emailIds.length === 1 ? 1 : selectionRowCount(draggedEmails.filter((em) => emailIds.includes(em.id)), emailIds.length, disableThreading);

      if (onSuccess) {
        onSuccess(rows, mailboxPath, restore, receipts);
      } else {
        if (emailIds.length === 1) {
          toast.success(tListExtra("moved_to", { mailbox: mailboxPath }));
        } else {
          toast.success(batchToastTitle(tRoot, "move", rows, disableThreading, mailboxPath));
        }
      }

      onDropComplete?.();
    } catch (error) {
      console.error("Failed to move emails:", error);

      // Call error callback if provided, otherwise use fallback
      if (onError) {
        onError(error instanceof Error ? error.message : 'Unknown error');
      } else {
        // Fallback for backward compatibility
        toast.error("Move failed", "Could not move emails to the selected folder");
      }
    } finally {
      endDrag();
    }
  }, [client, mailbox, accountId, mailboxes, isValidTarget, moveEmailsToMailbox, crossAccountMoveEmails, draggedEmails, sourceMailboxId, clearSelection, refreshCurrentMailbox, endDrag, markDropped, onDropComplete, onSuccess, onError, tListExtra, tRoot]);

  const valid = isValidTarget();

  return {
    dropHandlers: {
      onDragOver: handleDragOver,
      onDragEnter: handleDragEnter,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
    isDropTarget: isOver && isDragging,
    isValidDropTarget: isOver && valid,
    isInvalidDropTarget: isOver && isDragging && !valid,
  };
}
