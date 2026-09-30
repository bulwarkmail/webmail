"use client";

import { useTranslations } from "next-intl";
import { FilterRuleModal } from "@/components/filters/filter-rule-modal";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import { useQuickRuleText } from "@/components/email/rules-menu";
import { useQuickRuleStore } from "@/stores/quick-rule-store";
import { createFolderAndRunPreset, saveEditorRule } from "@/lib/filters/quick-rule-flow";

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
