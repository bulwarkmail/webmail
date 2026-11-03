"use client";

import { useEffect, useCallback, useRef } from "react";
import { Email } from "@/lib/jmap/types";
import { isActivatableEventTarget, isAppShortcutBlocked, isEventInside, isSingleCharacterKey } from "@/lib/keyboard";
import { keyboardHooks } from "@/lib/plugin-hooks";

export interface KeyboardShortcutHandlers {
  // Navigation
  onNextEmail?: () => void;
  onPreviousEmail?: () => void;
  onOpenEmail?: () => void;
  onCloseEmail?: () => void;
  /** `n`: open the next unread message below the current one (#514). */
  onNextUnread?: () => void;

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
  /** Shift + ↓/j and Shift + ↑/k: grow or shrink the selection by one row. */
  onExtendSelection?: (direction: 1 | -1) => void;

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
  /**
   * False turns off every shortcut that is a single character without Ctrl,
   * Alt or ⌘ (WCAG 2.1.4): j, k, e, #, the `g` sequences. Delete, the arrows,
   * Enter, Escape and Ctrl+A keep working.
   */
  singleKeyShortcuts?: boolean;
  /**
   * Where the arrow keys move the selection: only while the focus is in the
   * message list, so they still scroll the reading pane or move a resize
   * handle elsewhere on the page.
   */
  listSelector?: string;
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
  singleKeyShortcuts = true,
  listSelector = "#message-list",
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
      // Nor while a dialog, menu or popup is open: Delete in the shortcuts
      // help deleted the message behind it.
      if (isAppShortcutBlocked(event)) return;
      if (!singleKeyShortcuts && isSingleCharacterKey(event)) {
        if (pendingGoTo.current !== null) {
          clearTimeout(pendingGoTo.current);
          pendingGoTo.current = null;
        }
        return;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !isEventInside(event, listSelector)) return;

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
            // Ctrl/Cmd + A: Select all. With nothing to select here (a Pro
            // message tab) it stays the browser's select-all.
            if (!h.onSelectAll) return;
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

      // A key without a handler here is left alone, default and all: this page
      // can stay mounted behind another Pro tab with only a few of its handlers,
      // and the Calendar and Contacts tabs skip a key someone already claimed.
      switch (key) {
        // Navigation
        case "j":
        case "arrowdown":
          if (!h.onNextEmail && !(event.shiftKey && h.onExtendSelection)) break;
          event.preventDefault();
          if (event.shiftKey && h.onExtendSelection) {
            const extend = h.onExtendSelection;
            run("extend-selection-down", () => extend(1));
          } else {
            run("next-email", h.onNextEmail);
          }
          break;

        case "k":
        case "arrowup":
          if (!h.onPreviousEmail && !(event.shiftKey && h.onExtendSelection)) break;
          event.preventDefault();
          if (event.shiftKey && h.onExtendSelection) {
            const extend = h.onExtendSelection;
            run("extend-selection-up", () => extend(-1));
          } else {
            run("previous-email", h.onPreviousEmail);
          }
          break;

        case "enter":
        case "o":
          // Enter on a focused link or button (the skip link) is the control's.
          if (key === "enter" && isActivatableEventTarget(event)) break;
          if (selectedEmailId) {
            event.preventDefault();
            run("open-email", h.onOpenEmail);
          }
          break;

        case "escape":
          if (!h.onCloseEmail && !h.onDeselectAll) break;
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
          if (!h.onCompose) break;
          event.preventDefault();
          run("compose", h.onCompose);
          break;

        case "/":
          if (!h.onFocusSearch) break;
          event.preventDefault();
          run("focus-search", h.onFocusSearch);
          break;

        case "?":
          if (!h.onShowHelp) break;
          event.preventDefault();
          run("show-help", h.onShowHelp);
          break;

        case "g":
          if (event.shiftKey) {
            if (!h.onRefresh) break;
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

        // Navigation: next unread, as in Thunderbird (#514)
        case "n":
          if (!event.shiftKey && h.onNextUnread) {
            event.preventDefault();
            run("next-unread", h.onNextUnread);
          }
          break;
      }
    },
    [selectedEmailId, selectionCount, mountainViewKeys, singleKeyShortcuts, listSelector]
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

// The help modal's rows live per app in lib/keyboard-shortcuts; Mail's are
// re-exported here under their old names.
export type { ShortcutEntry } from "@/lib/keyboard-shortcuts";
export { MAIL_SHORTCUTS as KEYBOARD_SHORTCUTS } from "@/lib/keyboard-shortcuts";
