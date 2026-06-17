"use client";

import { useCallback, useState, DragEvent } from "react";
import { Mailbox, Email } from "@/lib/jmap/types";
import { useEmailStore } from "@/stores/email-store";
import { useAuthStore } from "@/stores/auth-store";
import { useDragDropContext } from "@/contexts/drag-drop-context";
import { toast } from "@/stores/toast-store";
import { getMailboxPath } from "@/lib/utils";

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

/**
 * Returns the local accountId ("user@host") that owns the destination
 * mailbox. `mailbox.accountId` is the JMAP server's opaque account id, but
 * `clients`, `activeAccountId`, and `email.accountId` all live in the local
 * namespace. We map back by matching the JMAP id against each connected
 * client's `getAccountId()`. Falls back to the viewing/active account so
 * single-account flows (no connected clients map entry yet, in-memory edits,
 * etc.) still resolve correctly.
 */
function resolveDestAccountId(mailbox: Mailbox): string | null {
  const jmapId = mailbox.accountId;
  if (jmapId) {
    const clients = useAuthStore.getState().getAllConnectedClients();
    for (const [localId, client] of clients) {
      if (client.getAccountId() === jmapId) return localId;
    }
  }
  return useEmailStore.getState().viewingAccountId
    ?? useAuthStore.getState().activeAccountId;
}

interface UseMailboxDropOptions {
  mailbox: Mailbox;
  onDropComplete?: () => void;
  // Translation callbacks for toast messages
  onSuccess?: (count: number, mailboxName: string) => void;
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

export function useMailboxDrop({ mailbox, onDropComplete, onSuccess, onError }: UseMailboxDropOptions): UseMailboxDropReturn {
  const [isOver, setIsOver] = useState(false);
  const { client } = useAuthStore();
  const { moveEmailsToMailbox, crossAccountMoveEmails, selectedEmailIds, clearSelection, refreshCurrentMailbox, mailboxes } = useEmailStore();
  const { isDragging, sourceMailboxId, draggedEmails, endDrag } = useDragDropContext();

  // Determine if this is a valid drop target
  const isValidTarget = useCallback(() => {
    if (!isDragging) return false;

    // Cannot drop on same mailbox
    if (mailbox.id === sourceMailboxId) return false;

    // Check if mailbox accepts items
    if (!mailbox.myRights?.mayAddItems) return false;

    // Virtual nodes (shared folder headers) cannot be drop targets
    if (mailbox.id.startsWith("shared-")) return false;

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

      // Group dragged emails by source account. In single-account flows this
      // collapses to one bucket; in unified view or the Pro multi-account
      // sidebar a single drag can mix sources.
      const destAccountId = resolveDestAccountId(mailbox);
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
      const isCrossAccount = isJmapCrossAccount || isLocalCrossAccount;

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
        await crossAccountMoveEmails(bySource, destAccountId, jmapDestId, destJmapOverride, sourceJmapOverride);
      } else {
        // Single-account or same-account-shared move: bulk JMAP request.
        await moveEmailsToMailbox(client, emailIds, mailbox.id);
      }

      // Clear selection if any selected emails were moved
      if (emailIds.some(id => selectedEmailIds.has(id))) {
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

      if (onSuccess) {
        onSuccess(emailIds.length, mailboxPath);
      } else {
        if (emailIds.length === 1) {
          toast.success("Email moved", `Moved to ${mailboxPath}`);
        } else {
          toast.success("Emails moved", `${emailIds.length} emails moved to ${mailboxPath}`);
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
  }, [client, mailbox, mailboxes, isValidTarget, moveEmailsToMailbox, crossAccountMoveEmails, draggedEmails, sourceMailboxId, selectedEmailIds, clearSelection, refreshCurrentMailbox, endDrag, onDropComplete, onSuccess, onError]);

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
