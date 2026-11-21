"use client";

import { lazyComponent } from "@/lib/lazy-component";
import { useQuickRuleStore } from "@/stores/quick-rule-store";

const QuickRuleDialogs = lazyComponent(() => import("./quick-rule-dialogs").then((m) => m.QuickRuleDialogs));

/**
 * Where a rule made from a message opens: the rule editor ("Create rule…", or
 * "Edit rule" from a toast), the folder-name prompt of "New folder…", and
 * the Trash question before a rule that discards runs on a folder. The
 * menus that start these are gone by then, so this stays mounted with the app.
 * The editor's code comes with the first one that opens, not with the page.
 */
export function QuickRuleHost() {
  const open = useQuickRuleStore((s) => !!s.editor || !!s.newFolder || !!s.trashQuestion);
  return open ? <QuickRuleDialogs /> : null;
}
