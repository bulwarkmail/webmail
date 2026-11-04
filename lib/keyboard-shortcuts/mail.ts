import type { ShortcutSection } from "./types";

// Mail's keys (hooks/use-keyboard-shortcuts.ts handles them).
export const MAIL_SHORTCUTS = {
  navigation: [
    { key: "j / ↓", description: "shortcuts.navigation.next_email" },
    { key: "k / ↑", description: "shortcuts.navigation.previous_email" },
    { key: "Enter / o", description: "shortcuts.navigation.open_email" },
    { key: "Esc", description: "shortcuts.navigation.close_email" },
    { key: "n", description: "shortcuts.navigation.next_unread" },
    { key: "g → i / s / t / d / a", description: "shortcuts.navigation.go_to_folder", layout: "mountain-view" },
  ],
  actions: [
    { key: "r", description: "shortcuts.actions.reply", desktopKey: "Mod + R" },
    { key: "R / a", description: "shortcuts.actions.reply_all", desktopKey: "Mod + Shift + R" },
    // Ctrl+F forwards with a message selected (Outlook) and searches elsewhere; Ctrl+Shift+F still works.
    { key: "f", description: "shortcuts.actions.forward", desktopKey: "Mod + Shift + F", desktopPcKey: "Ctrl + F / Ctrl + Shift + F" },
    { key: "s", description: "shortcuts.actions.star" },
    { key: "e", description: "shortcuts.actions.archive", feature: "archiveActionEnabled" },
    { key: "# / Del", description: "shortcuts.actions.delete" },
    { key: "u", description: "shortcuts.actions.mark_unread", desktopPcKey: "Ctrl + U" },
    { key: "Shift + I", description: "shortcuts.actions.mark_read", desktopWindowsKey: "Ctrl + Q" },
    { key: "!", description: "shortcuts.actions.toggle_spam" },
    // hooks/use-undo-shortcut.ts; `z` only with single-key shortcuts on.
    { key: "Mod + Z / z", description: "shortcuts.actions.undo" },
  ],
  // Shown under "Global" together with GENERAL_SHORTCUTS (./index.ts).
  global: [
    { key: "c", description: "shortcuts.global.compose", desktopKey: "Mod + N", desktopPcKey: "Ctrl + N / Ctrl + Shift + M" },
    { key: "/", description: "shortcuts.global.search", desktopPcKey: "Ctrl + E" },
    { key: "Shift + G", description: "shortcuts.global.refresh", desktopPcKey: "F9 / F5" },
    { key: "", description: "desktopMenus.shortcut_apps", desktopPcKey: "Ctrl + 1 / Ctrl + 2 / Ctrl + 3 / Ctrl + 4" },
    { key: "Mod + A", description: "shortcuts.global.select_all" },
    { key: "Shift + ↓ / Shift + ↑", description: "shortcuts.global.extend_selection" },
  ],
  threads: [
    { key: "x", description: "shortcuts.threads.expand_collapse", layout: "default" },
    { key: "x", description: "shortcuts.threads.select_mountain_view", layout: "mountain-view" },
  ],
  composer: [
    { key: "Mod + Enter", description: "shortcuts.composer.send" },
    { key: "Mod + Shift + Enter", description: "shortcuts.composer.schedule_send" },
    // "t" opens templates only outside a text field, so it isn't listed: in the composer it types a t.
    { key: "Mod + S", description: "compose_ux.shortcut_save_draft" },
    { key: "Mod + K", description: "compose_ux.shortcut_insert_link" },
    { key: "Mod + Shift + C", description: "compose_ux.shortcut_show_cc" },
    { key: "Mod + Shift + B", description: "compose_ux.shortcut_show_bcc" },
    // Proofreading (components/email/proofreading); shown even without a checker.
    { key: "Mod + '", description: "proofreading.shortcuts.next_issue" },
    { key: "Mod + ;", description: "proofreading.shortcuts.previous_issue" },
  ],
} as const;

export const MAIL_SECTIONS: readonly ShortcutSection[] = [
  { id: "navigation", title: "shortcuts.sections.navigation", entries: MAIL_SHORTCUTS.navigation },
  { id: "actions", title: "shortcuts.sections.actions", entries: MAIL_SHORTCUTS.actions },
  { id: "global", title: "shortcuts.sections.global", entries: MAIL_SHORTCUTS.global, wide: true },
  { id: "threads", title: "shortcuts.sections.threads", entries: MAIL_SHORTCUTS.threads, wide: true },
  { id: "composer", title: "shortcuts.sections.composer", entries: MAIL_SHORTCUTS.composer, wide: true },
];
