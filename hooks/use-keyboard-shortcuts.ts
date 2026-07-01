"use client";

import { useEffect, useCallback, useRef } from "react";
import { Email } from "@/lib/jmap/types";

export interface KeyboardShortcutHandlers {
  // Navigation
  onNextEmail?: () => void;
  onPreviousEmail?: () => void;
  onOpenEmail?: () => void;
  onCloseEmail?: () => void;

  // Email actions
  onReply?: () => void;
  onReplyAll?: () => void;
  onForward?: () => void;
  onToggleStar?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  onMarkAsUnread?: () => void;
  onMarkAsRead?: () => void;
  onToggleSpam?: () => void;

  // Global actions
  onCompose?: () => void;
  onFocusSearch?: () => void;
  onShowHelp?: () => void;
  onRefresh?: () => void;

  // Selection
  onSelectAll?: () => void;
  onDeselectAll?: () => void;

  // Thread actions
  onToggleThreadExpansion?: () => void;
}

export interface UseKeyboardShortcutsOptions {
  enabled?: boolean;
  emails: Email[];
  selectedEmailId?: string;
  selectionCount?: number;
  handlers: KeyboardShortcutHandlers;
}

// Check if user is typing in an input field
function isInputFocused(): boolean {
  const activeElement = document.activeElement;
  if (!activeElement) return false;

  const tagName = activeElement.tagName.toLowerCase();
  const isInput = tagName === "input" || tagName === "textarea" || tagName === "select";
  const isContentEditable = activeElement.getAttribute("contenteditable") === "true";

  return isInput || isContentEditable;
}

// Latin letter shortcuts must fire regardless of the active keyboard layout
// (e.g. Cyrillic, Greek): derive the physical letter from event.code
// (KeyA..KeyZ) instead of the layout-dependent event.key. Non-letter keys keep
// event.key, which is either layout-independent (arrows, Enter, Escape) or
// intentionally symbol-based (#, !, ?, /).
function physicalShortcutKey(event: KeyboardEvent): string {
  const code = event.code;
  if (code && code.length === 4 && code.startsWith("Key")) {
    return code.charAt(3).toLowerCase();
  }
  return event.key.toLowerCase();
}

export function useKeyboardShortcuts({
  enabled = true,
  emails,
  selectedEmailId,
  selectionCount = 0,
  handlers,
}: UseKeyboardShortcutsOptions) {
  const handlersRef = useRef(handlers);

  // Keep handlers ref updated
  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs
      if (isInputFocused()) return;

      const h = handlersRef.current;
      const key = physicalShortcutKey(event);
      const hasModifier = event.ctrlKey || event.metaKey || event.altKey;

      // Shortcuts that work with modifiers
      if (event.ctrlKey || event.metaKey) {
        switch (key) {
          case "a":
            // Ctrl/Cmd + A: Select all
            event.preventDefault();
            h.onSelectAll?.();
            return;
        }
      }

      // Shortcuts that should NOT work with modifiers
      if (hasModifier) return;

      const hasBatchTarget = !!selectedEmailId || selectionCount > 0;

      switch (key) {
        // Navigation
        case "j":
        case "arrowdown":
          event.preventDefault();
          h.onNextEmail?.();
          break;

        case "k":
        case "arrowup":
          event.preventDefault();
          h.onPreviousEmail?.();
          break;

        case "enter":
        case "o":
          if (selectedEmailId) {
            event.preventDefault();
            h.onOpenEmail?.();
          }
          break;

        case "escape":
          event.preventDefault();
          h.onCloseEmail?.();
          h.onDeselectAll?.();
          break;

        // Email actions (only when email is selected)
        case "r":
          if (selectedEmailId) {
            event.preventDefault();
            if (event.shiftKey) {
              h.onReplyAll?.();
            } else {
              h.onReply?.();
            }
          }
          break;

        case "a":
          if (selectedEmailId) {
            event.preventDefault();
            h.onReplyAll?.();
          }
          break;

        case "f":
          if (selectedEmailId) {
            event.preventDefault();
            h.onForward?.();
          }
          break;

        case "s":
          if (selectedEmailId) {
            event.preventDefault();
            h.onToggleStar?.();
          }
          break;

        case "e":
          if (hasBatchTarget) {
            event.preventDefault();
            h.onArchive?.();
          }
          break;

        case "#":
        case "delete":
        case "backspace":
          if (hasBatchTarget) {
            event.preventDefault();
            h.onDelete?.();
          }
          break;

        case "u":
          if (hasBatchTarget) {
            event.preventDefault();
            h.onMarkAsUnread?.();
          }
          break;

        case "i":
          if (hasBatchTarget && event.shiftKey) {
            event.preventDefault();
            h.onMarkAsRead?.();
          }
          break;

        case "!":
          if (hasBatchTarget) {
            event.preventDefault();
            h.onToggleSpam?.();
          }
          break;

        // Global actions
        case "c":
          event.preventDefault();
          h.onCompose?.();
          break;

        case "/":
          event.preventDefault();
          h.onFocusSearch?.();
          break;

        case "?":
          event.preventDefault();
          h.onShowHelp?.();
          break;

        case "g":
          if (event.shiftKey) {
            event.preventDefault();
            h.onRefresh?.();
          }
          break;

        // Thread actions
        case "x":
          if (selectedEmailId) {
            event.preventDefault();
            h.onToggleThreadExpansion?.();
          }
          break;
      }
    },
    [selectedEmailId, selectionCount]
  );

  useEffect(() => {
    if (!enabled) return;

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, handleKeyDown]);

  // Helper to get next/previous email
  const getAdjacentEmailIndex = useCallback(
    (direction: "next" | "previous"): number => {
      if (emails.length === 0) return -1;

      if (!selectedEmailId) {
        // If no email selected, select first (for next) or last (for previous)
        return direction === "next" ? 0 : emails.length - 1;
      }

      const currentIndex = emails.findIndex((e) => e.id === selectedEmailId);
      if (currentIndex === -1) return direction === "next" ? 0 : emails.length - 1;

      if (direction === "next") {
        return currentIndex < emails.length - 1 ? currentIndex + 1 : currentIndex;
      } else {
        return currentIndex > 0 ? currentIndex - 1 : currentIndex;
      }
    },
    [emails, selectedEmailId]
  );

  return { getAdjacentEmailIndex };
}

// Shortcut definitions for the help modal
export const KEYBOARD_SHORTCUTS = {
  navigation: [
    { key: "j / ↓", description: "shortcuts.navigation.next_email" },
    { key: "k / ↑", description: "shortcuts.navigation.previous_email" },
    { key: "Enter / o", description: "shortcuts.navigation.open_email" },
    { key: "Esc", description: "shortcuts.navigation.close_email" },
  ],
  actions: [
    { key: "r", description: "shortcuts.actions.reply" },
    { key: "R / a", description: "shortcuts.actions.reply_all" },
    { key: "f", description: "shortcuts.actions.forward" },
    { key: "s", description: "shortcuts.actions.star" },
    { key: "e", description: "shortcuts.actions.archive" },
    { key: "# / Del", description: "shortcuts.actions.delete" },
    { key: "u", description: "shortcuts.actions.mark_unread" },
    { key: "Shift + I", description: "shortcuts.actions.mark_read" },
    { key: "!", description: "shortcuts.actions.toggle_spam" },
  ],
  global: [
    { key: "c", description: "shortcuts.global.compose" },
    { key: "/", description: "shortcuts.global.search" },
    { key: "?", description: "shortcuts.global.help" },
    { key: "Shift + G", description: "shortcuts.global.refresh" },
    { key: "Ctrl + A", description: "shortcuts.global.select_all" },
  ],
  threads: [
    { key: "x", description: "shortcuts.threads.expand_collapse" },
  ],
  composer: [
    { key: "Ctrl + Enter", description: "shortcuts.composer.send" },
    { key: "Ctrl + Shift + Enter", description: "shortcuts.composer.schedule_send" },
    { key: "t", description: "shortcuts.composer.template_picker" },
    { key: "Ctrl/Cmd + Enter", description: "shortcuts.composer.send" },
  ],
} as const;
