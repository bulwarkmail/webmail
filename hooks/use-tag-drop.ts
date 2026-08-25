"use client";

import { useCallback, useState, DragEvent } from "react";
import { useEmailStore } from "@/stores/email-store";
import { useAuthStore } from "@/stores/auth-store";
import { useDragDropContext } from "@/contexts/drag-drop-context";


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
  const { client } = useAuthStore();
  const { fetchEmails, fetchTagCounts, selectedMailbox } = useEmailStore();
  const { isDragging, endDrag } = useDragDropContext();

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

      for (const emailId of emailIds) {
        // Read fresh state to avoid stale closures
        const emailState = useEmailStore.getState();
        const email = emailState.emails.find(em => em.id === emailId);
        const keywords = { ...(email?.keywords || {}) };

        // Add the tag without removing existing ones
        keywords[`$label:${tagId}`] = true;

        // Routes the write to the email's own account - the email's source in an
        // aggregate view, the selected folder's owner when a shared folder is
        // open directly. (#281)
        await emailState.setEmailKeywords(client, emailId, keywords);
      }

      // Refresh the email list
      await fetchEmails(client, selectedMailbox);

      // Refresh tag counts
      fetchTagCounts(client);

      onSuccess?.(emailIds.length, tagId);
    } catch (error) {
      console.error("Failed to tag emails:", error);
      onError?.(error instanceof Error ? error.message : "Unknown error");
    } finally {
      endDrag();
    }
  }, [client, isDragging, tagId, fetchEmails, fetchTagCounts, selectedMailbox, endDrag, onSuccess, onError]);

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
