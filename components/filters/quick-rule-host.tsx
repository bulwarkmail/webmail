"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { FilterRuleModal } from "@/components/filters/filter-rule-modal";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import { useQuickRuleText } from "@/components/email/rules-menu";
import { useQuickRuleStore } from "@/stores/quick-rule-store";
import { readAccountFilters } from "@/lib/filters/account-filters";
import { forwardsAround, inRunOrder } from "@/lib/filters/forward-limit";
import { createFolderAndRunPreset, saveEditorRule } from "@/lib/filters/quick-rule-flow";
import { supportsPeriods } from "@/lib/sieve/period";

/**
 * Draws what a rule made from a message opens: the rule editor ("Create
 * rule…", or "Edit rule" from a toast) and the folder-name prompt of "New
 * folder…". The menus that start these are gone by then, so this stays
 * mounted with the app.
 */
export function QuickRuleHost() {
  const text = useQuickRuleText();
  const tFolderMenu = useTranslations("mailbox_context_menu");
  const editor = useQuickRuleStore((s) => s.editor);
  const newFolder = useQuickRuleStore((s) => s.newFolder);
  const closeEditor = useQuickRuleStore((s) => s.closeEditor);
  const closeNewFolder = useQuickRuleStore((s) => s.closeNewFolder);

  // Where the rule runs among the account's rules, for the server's redirect
  // limit: "Create rule…" puts it first, an edit keeps it in place (one no
  // longer there goes first again), and the out of office forwarding runs
  // ahead of them all. See lib/filters/forward-limit.ts.
  const [forwards, setForwards] = useState({ before: 0, after: 0 });
  useEffect(() => {
    setForwards({ before: 0, after: 0 });
    if (!editor) return;
    let current = true;
    readAccountFilters(editor.target.client, editor.target.sieveAccountId)
      .then(({ parsed }) => {
        if (!current || parsed.isOpaque) return;
        const runOrder = inRunOrder(parsed.rules, parsed.vacationForward);
        const index = editor.mode === "edit" ? parsed.rules.findIndex((r) => r.id === editor.rule.id) : -1;
        setForwards(forwardsAround(runOrder, runOrder.length - parsed.rules.length + Math.max(index, 0), index >= 0));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [editor]);

  return (
    <>
      {editor && (
        <FilterRuleModal
          key={`${editor.mode}:${editor.rule.id}`}
          rule={editor.mode === "edit" ? editor.rule : undefined}
          initialRule={editor.mode === "prefill" ? editor.rule : undefined}
          suggestions={editor.suggestions}
          offerApplyToExisting={editor.mode === "prefill" && !!editor.sourceMailboxId}
          mailboxes={editor.target.mailboxes}
          maxRedirects={editor.target.client.getSieveCapabilities(editor.target.sieveAccountId)?.maxNumberRedirects}
          forwardsBefore={forwards.before}
          forwardsAfter={forwards.after}
          periodsSupported={supportsPeriods(editor.target.client.getSieveCapabilities(editor.target.sieveAccountId)?.sieveExtensions)}
          onSave={(rule, options) => {
            closeEditor();
            void saveEditorRule(editor, rule, options?.applyToExisting ?? false, text);
          }}
          onClose={closeEditor}
        />
      )}
      <PromptDialog
        isOpen={!!newFolder}
        onClose={closeNewFolder}
        onSubmit={(name) => {
          const request = newFolder;
          closeNewFolder();
          if (request && name.trim()) void createFolderAndRunPreset(request, name, text);
        }}
        title={tFolderMenu("new_folder")}
        message={tFolderMenu("prompt_new_folder")}
        placeholder={tFolderMenu("placeholder_folder_name")}
      />
    </>
  );
}
