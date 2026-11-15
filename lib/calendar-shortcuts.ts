import { shortcutKey } from "@/lib/keyboard";

// The calendar's single-key shortcuts. A key held with Ctrl, ⌘, Alt or
// Shift is left to the browser (Ctrl+A selects, Alt+← goes back). Letters
// are the ones the key types, or its US place on a non-Latin layout (R8).

export type CalendarShortcutAction =
  | "prev"
  | "next"
  | "today"
  | "month"
  | "week"
  | "day"
  | "agenda"
  | "tasks"
  | "new"
  | "search";

const LETTERS: Record<string, CalendarShortcutAction> = {
  t: "today",
  m: "month",
  w: "week",
  d: "day",
  a: "agenda",
  k: "tasks",
  n: "new",
  c: "new",
};

/**
 * The action a key press asks for, or null when it isn't a calendar shortcut.
 * With `singleKeys` false (single-key shortcuts turned off, WCAG 2.1.4) only
 * the arrows are left.
 */
export function calendarShortcutAction(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  singleKeys = true,
): CalendarShortcutAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  const key = shortcutKey(event);
  // `/` focuses the search, as in Mail (R8). AZERTY types it with Shift.
  if (singleKeys && key === "/") return "search";
  if (event.shiftKey) return null;
  if (event.key === "ArrowLeft") return "prev";
  if (event.key === "ArrowRight") return "next";
  if (!singleKeys) return null;
  return LETTERS[key] ?? null;
}
