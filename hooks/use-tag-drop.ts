"use client";

import { useCallback, useState, DragEvent } from "react";
import { emailWriteSource, useEmailStore } from "@/stores/email-store";
import { emailKeyFor } from "@/lib/thread-utils";
import { useShallow } from "zustand/react/shallow";
import { useAuthStore } from "@/stores/auth-store";
import { useDragDropContext } from "@/contexts/drag-drop-context";
import { dragDropHooks } from "@/lib/plugin-hooks";


interface UseTagDropOptions {
  tagId: string;
  onSuccess?: (count: number, tagLabel: string) => void;
  onError?: (error: string) => void;
}

interface UseTagDropReturn {
  dropHandlers: {
    onDragOver: (e: DragEvent<HTMLDivElement>) => void;
    onDragEnter: (e: DragEvent<HTMLDivElement>) => void;
    onDragLeave: (e: DragEvent<HTMLDivElement>) => void;
    onDrop: (e: DragEvent<HTMLDivElement>) => void;
  };
  isDropTarget: boolean;
  isValidDropTarget: boolean;
}

export function useTagDrop({ tagId, onSuccess, onError }: UseTagDropOptions): UseTagDropReturn {
  const [isOver, setIsOver] = useState(false);
  const { client } = useAuthStore(useShallow((state) => ({ client: state.client })));
  // The open folder is read on the drop: subscribed to, every folder click drew
  // every tag row again.
  const { fetchEmails, fetchTagCounts } = useEmailStore(useShallow((state) => ({ fetchEmails: state.fetchEmails, fetchTagCounts: state.fetchTagCounts })));
  const { isDragging, draggedEmails, endDrag, markDropped } = useDragDropContext();

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (isDragging) {
      e.dataTransfer.dropEffect = "copy";
    } else {
      e.dataTransfer.dropEffect = "none";
    }
  }, [isDragging]);

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const relatedTarget = e.relatedTarget as Node | null;
    if (!e.currentTarget.contains(relatedTarget)) {
      setIsOver(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsOver(false);

    if (!client || !isDragging) {
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

      // The rows that were dragged, each tagged where it was listed from: its
      // login and account in a list that mixes accounts, else the login
      // browsed and the folder's account. The ids alone say neither: the same
      // id is another message in every other account. An id that came without
      // its row is left alone.
      const wanted = new Set(emailIds);
      const label = `$label:${tagId}`;
      // Emails that carry the tag afterwards; a plugin may stop some or all.
      const tagged: string[] = [];
      const seen = new Set<string>();
      for (const row of draggedEmails) {
        const key = emailKeyFor(row);
        if (!wanted.has(row.id) || seen.has(key)) continue;
        seen.add(key);
        // Read fresh state to avoid stale closures
        const emailState = useEmailStore.getState();
        const listed = emailState.emails.find((em) => emailKeyFor(em) === key) ?? row;
        if (listed.keywords?.[label]) {
          tagged.push(row.id);
          continue;
        }
        // Only this keyword is written, so tags set meanwhile stay. With the
        // row's login named the store writes through that login or refuses;
        // with no login known at all it routes by the listed row.
        const where = emailWriteSource(row, client);
        const source = where.clientAccountId
          ? { clientAccountId: where.clientAccountId, accountId: where.accountId, email: listed }
          : undefined;
        if (await emailState.patchEmailKeywords(client, row.id, { [label]: true }, key, source)) tagged.push(row.id);
      }
      if (tagged.length === 0) return;

      void dragDropHooks.onTagDrop.emit({ emailIds: tagged, keyword: `$label:${tagId}` });

      // Refresh the email list
      await fetchEmails(client, useEmailStore.getState().selectedMailbox);

      // Refresh tag counts
      fetchTagCounts(client);

      onSuccess?.(tagged.length, tagId);
    } catch (error) {
      console.error("Failed to tag emails:", error);
      onError?.(error instanceof Error ? error.message : "Unknown error");
    } finally {
      endDrag();
    }
  }, [client, isDragging, draggedEmails, tagId, fetchEmails, fetchTagCounts, endDrag, markDropped, onSuccess, onError]);

  return {
    dropHandlers: {
      onDragOver: handleDragOver,
      onDragEnter: handleDragEnter,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
    isDropTarget: isOver && isDragging,
    isValidDropTarget: isOver && isDragging,
  };
}
