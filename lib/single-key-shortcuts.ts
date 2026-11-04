import { isSingleCharacterKey } from "@/lib/keyboard";
import { useSettingsStore } from "@/stores/settings-store";

/**
 * True when the user turned single-key shortcuts off (Settings >
 * Accessibility) and this key press is one: a printable character without
 * Ctrl, Alt or ⌘. Read at the time of the key press, so a window listener
 * needs no re-subscribe when the setting changes.
 */
export function isSingleKeyShortcutOff(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  return isSingleCharacterKey(event) && useSettingsStore.getState().singleKeyShortcuts === false;
}

/**
 * A key hint as the help and menus write it ("r", "Shift + I", "#") that's a single-key
 * shortcut, so it does nothing while those are off. Arrows aren't characters.
 */
export function isSingleKeyHint(combo: string): boolean {
  const key = combo.replace(/^(shift\s*\+\s*)+/i, "").trim();
  return [...key].length === 1 && !/[←→↑↓]/.test(key);
}
