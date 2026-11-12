"use client";

import { useTranslations } from "next-intl";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import { splitAttachmentName } from "@/lib/attachment-name";
import { plainFileNameProblem } from "@/lib/file-name-rules";

interface RenameAttachmentDialogProps {
  isOpen: boolean;
  /** The name as it is now; its extension stays as it is. */
  name: string;
  onClose: () => void;
  /** Called with the new name, extension included; not when it is unchanged. */
  onRename: (name: string) => void;
  /** Where the dialog's text comes from: the composer's or the reader's. */
  namespace: "email_composer" | "email_viewer";
}

/**
 * Renames an attachment in the composer or the reader. Only the part before
 * the extension can be edited, so the file keeps its type.
 */
export function RenameAttachmentDialog({ isOpen, name, onClose, onRename, namespace }: RenameAttachmentDialogProps) {
  const t = useTranslations(namespace);
  const [stem, ext] = splitAttachmentName(name);
  return (
    <PromptDialog
      isOpen={isOpen}
      onClose={onClose}
      title={t("rename_title")}
      defaultValue={stem}
      suffix={ext}
      confirmText={t("rename")}
      validate={(value) => {
        const problem = plainFileNameProblem(value);
        if (!problem) return null;
        return problem.kind === "tooLong" ? t("rename_too_long") : t("rename_invalid_chars");
      }}
      onSubmit={(value) => {
        const next = value + ext;
        if (next !== name) onRename(next);
      }}
    />
  );
}
