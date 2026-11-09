"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { ConflictAnswer, UploadConflict, UploadConflictChoice } from "@/lib/files-upload-conflicts";

export interface UploadConflictQuestion {
  conflict: UploadConflict;
  /** How many conflicts are left, this one included. */
  remaining: number;
  answer: (answer: ConflictAnswer) => void;
}

/**
 * "<name> already exists." Replace, Keep both or Skip, and with more than
 * one conflict left, "Do this for all n conflicts" (pim-10). Closing it
 * (Escape, Cancel) calls off the whole upload.
 */
export function UploadConflictDialog({ question }: { question: UploadConflictQuestion | null }) {
  const t = useTranslations("ux_pim_files");
  const tConfirm = useTranslations("confirm_dialog");
  const [applyToAll, setApplyToAll] = useState(false);
  const checkboxId = useId();
  const replaceRef = useRef<HTMLButtonElement>(null);
  // Each question starts unticked.
  useEffect(() => setApplyToAll(false), [question]);
  if (!question) return null;
  const { conflict, remaining, answer } = question;
  const choose = (choice: UploadConflictChoice) => answer({ choice, applyToAll: applyToAll && remaining > 1 });
  return (
    <Dialog
      isOpen
      onClose={() => answer(null)}
      role="alertdialog"
      title={t("conflict_title", { name: conflict.name })}
      description={conflict.kind === "folder" ? t("conflict_folder_hint") : t("conflict_file_hint")}
      showClose={false}
      initialFocus={replaceRef}
      testId="upload-conflict-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={() => answer(null)} className="sm:me-auto">{tConfirm("cancel")}</Button>
          <Button variant="outline" onClick={() => choose("skip")}>{t("skip")}</Button>
          <Button variant="outline" onClick={() => choose("keep")}>{t("keep_both")}</Button>
          <Button ref={replaceRef} onClick={() => choose("replace")}>{t("replace")}</Button>
        </>
      }
    >
      {remaining > 1 && (
        <label htmlFor={checkboxId} className="flex items-center gap-2 text-sm">
          <input
            id={checkboxId}
            type="checkbox"
            checked={applyToAll}
            onChange={(e) => setApplyToAll(e.target.checked)}
            className="h-4 w-4"
          />
          {t("apply_to_all", { count: remaining })}
        </label>
      )}
    </Dialog>
  );
}
