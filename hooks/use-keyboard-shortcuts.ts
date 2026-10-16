"use client";

import { useEffect, useCallback, useRef } from "react";
import { Email } from "@/lib/jmap/types";
import { isEditableEventTarget } from "@/lib/keyboard";
import { keyboardHooks } from "@/lib/plugin-hooks";
import type { InterfaceLayout } from "@/stores/settings-store";
import type { FeatureGates } from "@/lib/admin/types";

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

  /** Mountain View's `x`: put the focused conversation in or out of the selection. */
  onToggleSelection?: () => void;
  /** Mountain View's `g` sequences: `g` then i / s / t / d / a. */
  onGoToMailbox?: (target: GoToMailboxTarget) => void;
}

export type GoToMailboxTarget = 'inbox' | 'starred' | 'sent' | 'drafts' | 'all';

/** The letter each `g` sequence ends on. */
const GO_TO_KEYS: Record<string, GoToMailboxTarget> = {
  i: 'inbox',
  s: 'starred',
  t: 'sent',
  d: 'drafts',
  a: 'all',
};

/** How long a pending `g` waits for its second key before lapsing. */
const GO_TO_SEQUENCE_MS = 1500;

export interface UseKeyboardShortcutsOptions {
  enabled?: boolean;
  /**
   * Mountain View assigns `x` to selection rather than to thread expansion,
   * and enables the `g` sequences.
   */
  mountainViewKeys?: boolean;
  emails: Email[];
  selectedEmailId?: string;
  selectionCount?: number;
  handlers: KeyboardShortcutHandlers;
}

// Shortcuts must fire regardless of the active keyboard layout (e.g. Cyrillic,
// Greek). Derive the key from the PHYSICAL key (event.code) instead of the
// layout-dependent event.key: letters from KeyA..KeyZ, and the symbol shortcuts
// (/, ?, #, !) from their US-QWERTY positions so they stay reachable on non-Latin
// layouts. Arrows/Enter/Escape keep event.key, which is already layout-neutral.
function physicalShortcutKey(event: KeyboardEvent): string {
  const code = event.code;
  if (code && code.length === 4 && code.startsWith("Key")) {
    return code.charAt(3).toLowerCase();
  }
  switch (code) {
    case "Slash":
      return event.shiftKey ? "?" : "/";
    case "Digit1":
      if (event.shiftKey) return "!";
      break;
    case "Digit3":
      if (event.shiftKey) return "#";
      break;
  }
  return event.key.toLowerCase();
}

export function useKeyboardShortcuts({
  enabled = true,
  mountainViewKeys = false,
  emails,
  selectedEmailId,
  selectionCount = 0,
  handlers,
}: UseKeyboardShortcutsOptions) {
  const handlersRef = useRef(handlers);
  // A `g` waiting for the letter that completes it. Held in a ref so the
  // listener stays stable; cleared on timeout, on completion, and on any key
  // that isn't part of a sequence.
  const pendingGoTo = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep handlers ref updated
  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs. Must be event-based
      // (composedPath), not document.activeElement: the QuotedHtml island's
      // shadow root retargets activeElement to its plain-div host (#654).
      if (isEditableEventTarget(event)) return;

      const h = handlersRef.current;
      const key = physicalShortcutKey(event);
      const keyName = `${event.ctrlKey || event.metaKey ? "mod+" : ""}${event.shiftKey && key.length === 1 && /[a-z]/.test(key) ? "shift+" : ""}${key}`;
      // Runs a shortcut's action. Plugins may stop it first (onBeforeShortcut)
      // and hear about it after; with no plugin listening it runs at once.
      const run = (action: string, fn: (() => void) | undefined) => {
        if (!fn) return;
        const payload = { key: keyName, action };
        const done = () => {
          fn();
          void keyboardHooks.onAfterShortcut.emit(payload);
        };
        if (keyboardHooks.onBeforeShortcut.size === 0) {
          done();
          return;
        }
        void keyboardHooks.onBeforeShortcut.intercept(payload).then((ok) => { if (ok) done(); });
      };
      const hasModifier = event.ctrlKey || event.metaKey || event.altKey;

      // Shortcuts that work with modifiers
      if (event.ctrlKey || event.metaKey) {
        switch (key) {
          case "a":
            // Ctrl/Cmd + A: Select all
            event.preventDefault();
            run("select-all", h.onSelectAll);
            return;
        }
      }

      // Shortcuts that should NOT work with modifiers
      if (hasModifier) return;

      const hasBatchTarget = !!selectedEmailId || selectionCount > 0;

      // Second half of a `g` sequence. Checked before the switch so `s`, `t`,
      // `a` and `d` reach the folder jump instead of star / reply-all.
      if (mountainViewKeys && pendingGoTo.current !== null) {
        clearTimeout(pendingGoTo.current);
        pendingGoTo.current = null;
        const target = GO_TO_KEYS[key];
        if (target && h.onGoToMailbox) {
          event.preventDefault();
          const goTo = h.onGoToMailbox;
          run(`go-to-${target}`, () => goTo(target));
          return;
        }
      }

      switch (key) {
        // Navigation
        case "j":
        case "arrowdown":
          event.preventDefault();
          run("next-email", h.onNextEmail);
          break;

        case "k":
        case "arrowup":
          event.preventDefault();
          run("previous-email", h.onPreviousEmail);
          break;

        case "enter":
        case "o":
          if (selectedEmailId) {
            event.preventDefault();
            run("open-email", h.onOpenEmail);
          }
          break;

        case "escape":
          event.preventDefault();
          run("close", h.onCloseEmail || h.onDeselectAll ? () => { h.onCloseEmail?.(); h.onDeselectAll?.(); } : undefined);
          break;

        // Email actions (only when email is selected)
        case "r":
          if (selectedEmailId) {
            event.preventDefault();
            if (event.shiftKey) {
              run("reply-all", h.onReplyAll);
            } else {
              run("reply", h.onReply);
            }
          }
          break;

        case "a":
          if (selectedEmailId) {
            event.preventDefault();
            run("reply-all", h.onReplyAll);
          }
          break;

        case "f":
          if (selectedEmailId) {
            event.preventDefault();
            run("forward", h.onForward);
          }
          break;

        case "s":
          if (selectedEmailId) {
            event.preventDefault();
            run("toggle-star", h.onToggleStar);
          }
          break;

        case "e":
          if (hasBatchTarget) {
            event.preventDefault();
            run("archive", h.onArchive);
          }
          break;

        case "#":
        case "delete":
        case "backspace":
          if (hasBatchTarget) {
            event.preventDefault();
            run("delete", h.onDelete);
          }
          break;

        case "u":
          if (hasBatchTarget) {
            event.preventDefault();
            run("mark-as-unread", h.onMarkAsUnread);
          }
          break;

        case "i":
          if (hasBatchTarget && event.shiftKey) {
            event.preventDefault();
            run("mark-as-read", h.onMarkAsRead);
          }
          break;

        case "!":
          if (hasBatchTarget) {
            event.preventDefault();
            run("toggle-spam", h.onToggleSpam);
          }
          break;

        // Global actions
        case "c":
          event.preventDefault();
          run("compose", h.onCompose);
          break;

        case "/":
          event.preventDefault();
          run("focus-search", h.onFocusSearch);
          break;

        case "?":
          event.preventDefault();
          run("show-help", h.onShowHelp);
          break;

        case "g":
          if (event.shiftKey) {
            event.preventDefault();
            run("refresh", h.onRefresh);
          } else if (mountainViewKeys && h.onGoToMailbox) {
            // Arm the sequence; the next key either completes it or lapses.
            event.preventDefault();
            pendingGoTo.current = setTimeout(() => {
              pendingGoTo.current = null;
            }, GO_TO_SEQUENCE_MS);
          }
          break;

        // Thread actions
        case "x":
          if (mountainViewKeys) {
            if (selectedEmailId) {
              event.preventDefault();
              run("toggle-selection", h.onToggleSelection);
            }
          } else if (selectedEmailId) {
            event.preventDefault();
            run("toggle-thread-expansion", h.onToggleThreadExpansion);
          }
          break;
      }
    },
    [selectedEmailId, selectionCount, mountainViewKeys]
  );

  // A pending sequence must not outlive the hook.
  useEffect(() => () => {
    if (pendingGoTo.current !== null) clearTimeout(pendingGoTo.current);
  }, []);

  useEffect(() => {
    if (!mountainViewKeys && pendingGoTo.current !== null) {
      clearTimeout(pendingGoTo.current);
      pendingGoTo.current = null;
    }
  }, [mountainViewKeys]);

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

/**
 * One row of the help modal. `layout` limits a row to one interface layout:
 * Mountain View adds the `g` sequences and gives `x` to selection.
 */
export interface ShortcutEntry {
  readonly key: string;
  readonly description: string;
  readonly layout?: InterfaceLayout;
  /** Listed only in the Pro shell, or only outside it. */
  readonly shell?: "pro" | "standard";
  /** Listed only while this admin policy feature gate is on. */
  readonly feature?: keyof FeatureGates;
}

// Shortcut definitions for the help modal
export const KEYBOARD_SHORTCUTS = {
  navigation: [
    { key: "j / ↓", description: "shortcuts.navigation.next_email" },
    { key: "k / ↑", description: "shortcuts.navigation.previous_email" },
    { key: "Enter / o", description: "shortcuts.navigation.open_email" },
    { key: "Esc", description: "shortcuts.navigation.close_email" },
    { key: "g → i / s / t / d / a", description: "shortcuts.navigation.go_to_folder", layout: "mountain-view" },
  ],
  actions: [
    { key: "r", description: "shortcuts.actions.reply" },
    { key: "R / a", description: "shortcuts.actions.reply_all" },
    { key: "f", description: "shortcuts.actions.forward" },
    { key: "s", description: "shortcuts.actions.star" },
    { key: "e", description: "shortcuts.actions.archive", feature: "archiveActionEnabled" },
    { key: "# / Del", description: "shortcuts.actions.delete" },
    { key: "u", description: "shortcuts.actions.mark_unread" },
    { key: "Shift + I", description: "shortcuts.actions.mark_read" },
    { key: "!", description: "shortcuts.actions.toggle_spam" },
  ],
  global: [
    { key: "c", description: "shortcuts.global.compose" },
    { key: "/", description: "shortcuts.global.search" },
    { key: "Ctrl/⌘ + K", description: "shortcuts.global.global_search", shell: "pro" },
    { key: "Ctrl/⌘ + K", description: "command_palette.open", shell: "standard" },
    { key: "?", description: "shortcuts.global.help" },
    { key: "Shift + G", description: "shortcuts.global.refresh" },
    { key: "Ctrl + A", description: "shortcuts.global.select_all" },
  ],
  threads: [
    { key: "x", description: "shortcuts.threads.expand_collapse", layout: "default" },
    { key: "x", description: "shortcuts.threads.select_mountain_view", layout: "mountain-view" },
  ],
  composer: [
    { key: "Ctrl/Cmd + Enter", description: "shortcuts.composer.send" },
    { key: "Ctrl/Cmd + Shift + Enter", description: "shortcuts.composer.schedule_send" },
    { key: "t", description: "shortcuts.composer.template_picker" },
  ],
} as const;
