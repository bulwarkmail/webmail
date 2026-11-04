import { CALENDAR_SECTIONS } from "./calendar";
import { CONTACTS_SECTIONS } from "./contacts";
import { FILES_SECTIONS } from "./files";
import { MAIL_SECTIONS } from "./mail";
import { SETTINGS_SECTIONS } from "./settings";
import type { ShortcutAppId, ShortcutEntry, ShortcutHost, ShortcutSection } from "./types";

export type { ShortcutAppId, ShortcutEntry, ShortcutHost, ShortcutSection } from "./types";
export { MAIL_SHORTCUTS } from "./mail";

export interface ShortcutApp {
  readonly id: ShortcutAppId;
  /** Translation key of the tab. */
  readonly title: string;
  readonly sections: readonly ShortcutSection[];
}

/** Each app's keys, in rail order. Each app fills its own file next to this one. */
export const SHORTCUT_APPS: readonly ShortcutApp[] = [
  { id: "mail", title: "sidebar.mail", sections: MAIL_SECTIONS },
  { id: "calendar", title: "sidebar.calendar", sections: CALENDAR_SECTIONS },
  { id: "contacts", title: "sidebar.contacts", sections: CONTACTS_SECTIONS },
  { id: "files", title: "sidebar.files", sections: FILES_SECTIONS },
  { id: "settings", title: "sidebar.settings", sections: SETTINGS_SECTIONS },
];

/**
 * Keys that work in every app (the shell handles them). Listed under each
 * app's "global" section, or in a "Global" section of their own when the
 * app has none.
 */
export const GENERAL_SHORTCUTS: readonly ShortcutEntry[] = [
  { key: "Mod + K", description: "shortcuts.global.global_search", shell: "pro" },
  { key: "Mod + K", description: "command_palette.open", shell: "standard" },
  { key: "?", description: "shortcuts.global.help" },
  { key: "Alt + Shift + A", description: "shortcuts.global.accessibility_panel" },
  // components/ui/toast.tsx (isFocusToastShortcut)
  { key: "Alt + Shift + N", description: "shortcuts.global.focus_notification" },
];

/** An app's sections with the general keys added (see GENERAL_SHORTCUTS). */
/**
 * What a row lists where the help is shown: the desktop app's key first, then the
 * page's own. Null when there's nothing to press here.
 */
export function shortcutKeyFor(entry: ShortcutEntry, host: ShortcutHost): string | null {
  const desktop = host === "browser"
    ? undefined
    : (host === "windows" ? entry.desktopWindowsKey : undefined)
      ?? (host === "mac" ? undefined : entry.desktopPcKey)
      ?? entry.desktopKey;
  const keys = [desktop, entry.key].filter((key): key is string => !!key);
  return keys.length ? keys.join(" / ") : null;
}

export function sectionsWithGeneral(sections: readonly ShortcutSection[]): ShortcutSection[] {
  if (sections.some((s) => s.id === "global")) {
    return sections.map((s) => (s.id === "global" ? { ...s, entries: [...s.entries, ...GENERAL_SHORTCUTS] } : s));
  }
  return [...sections, { id: "global", title: "shortcuts.sections.global", entries: GENERAL_SHORTCUTS, wide: true }];
}

/** The app a path belongs to; everything that isn't another app is Mail. */
export function shortcutAppForPath(pathname: string): ShortcutAppId {
  const path = pathname.replace(/^\/[a-z]{2}(-[A-Z]{2})?(?=\/|$)/, "");
  for (const id of ["calendar", "contacts", "files", "settings"] as const) {
    if (path === `/${id}` || path.startsWith(`/${id}/`)) return id;
  }
  return "mail";
}
