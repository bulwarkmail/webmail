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
    { key: "r", description: "shortcuts.actions.reply" },
    { key: "R / a", description: "shortcuts.actions.reply_all" },
    { key: "f", description: "shortcuts.actions.forward" },
    { key: "s", description: "shortcuts.actions.star" },
    { key: "e", description: "shortcuts.actions.archive", feature: "archiveActionEnabled" },
    { key: "# / Del", description: "shortcuts.actions.delete" },
    { key: "u", description: "shortcuts.actions.mark_unread" },
    { key: "Shift + I", description: "shortcuts.actions.mark_read" },
    { key: "!", description: "shortcuts.actions.toggle_spam" },
    // hooks/use-undo-shortcut.ts; `z` only with single-key shortcuts on.
    { key: "Mod + Z / z", description: "shortcuts.actions.undo" },
  ],
  // Shown under "Global" together with GENERAL_SHORTCUTS (./index.ts).
  global: [
    { key: "c", description: "shortcuts.global.compose" },
    { key: "/", description: "shortcuts.global.search" },
    { key: "Shift + G", description: "shortcuts.global.refresh" },
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
    { key: "t", description: "shortcuts.composer.template_picker" },
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
