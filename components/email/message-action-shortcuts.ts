"use client";

import { useCallback } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import type { MessageActionKey } from "./message-actions";
import { formatShortcutCombo } from "@/lib/shortcut-keys";

/**
 * The keys the mail list runs a message's actions with (hooks/use-keyboard-shortcuts.ts),
 * as the message menus show them next to the entries. The native Message menu shows the
 * same ones. A single key goes when the user turned single-key shortcuts off, since it
 * does nothing then.
 */
const KEYS: Partial<Record<MessageActionKey, { key: string; single: boolean }>> = {
  reply: { key: "R", single: true },
  reply_all: { key: "Shift + R", single: true },
  forward: { key: "F", single: true },
  archive: { key: "E", single: true },
  delete: { key: "Del", single: false },
  star: { key: "S", single: true },
  spam: { key: "!", single: true },
};

export function messageActionShortcut(
  key: MessageActionKey,
  options: { unread?: boolean; singleKeys: boolean },
): string | undefined {
  const entry = key === "read"
    ? { key: options.unread ? "Shift + I" : "U", single: true }
    : KEYS[key];
  if (!entry) return undefined;
  if (entry.single && !options.singleKeys) return undefined;
  return entry.key;
}

/**
 * `messageActionShortcut` with the user's single-key setting, in the app's language as
 * Windows writes the keys ("Umschalt + I" in German), for menus and tooltips.
 */
export function useMessageActionShortcut(): (key: MessageActionKey, unread?: boolean) => string | undefined {
  const singleKeys = useSettingsStore((state) => state.singleKeyShortcuts !== false);
  return useCallback((key, unread) => {
    const hint = messageActionShortcut(key, { unread, singleKeys });
    return hint && formatShortcutCombo(hint);
  }, [singleKeys]);
}
