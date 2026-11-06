"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog } from "@/components/ui/dialog";
import { MoveFolderList, useMoveMenu } from "@/components/email/move-target-list";
import { localizeMailboxName } from "@/lib/mailbox-label";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { toast } from "@/stores/toast-store";
import { importKeywords } from "@/lib/file-drop/import-keywords";

/**
 * "Import to a mail folder…" for a message saved in Files (pim-p2-7): the user's own folders
 * that take new mail, in the Move list's order with its filter, and Email/import into the one
 * picked, as a dropped .eml goes into the folder in view.
 */
export function ImportEmlDialog({ file, onClose }: { file: File | null; onClose: () => void }) {
  const t = useTranslations("ux_p2_pim_files");
  const tSidebar = useTranslations("sidebar");
  const all = useEmailStore((s) => s.mailboxes);
  const client = useAuthStore((s) => s.client);
  const [busy, setBusy] = useState(false);

  // Files may be the first screen opened: the folders aren't loaded yet.
  useEffect(() => {
    if (!file || !client || useEmailStore.getState().mailboxes.length > 0) return;
    void useEmailStore.getState().fetchMailboxes(client).catch(() => {});
  }, [file, client]);

  const mailboxes = useMemo(
    () => all.filter((mailbox) => !mailbox.isShared && mailbox.myRights?.mayAddItems !== false),
    [all],
  );
  const model = useMoveMenu(mailboxes, { currentMailboxId: null });

  const importInto = async (mailboxId: string) => {
    const mailbox = mailboxes.find((entry) => entry.id === mailboxId);
    if (!file || !client || !mailbox || busy) return;
    const folder = localizeMailboxName(mailbox.role, mailbox.name, (key) => tSidebar(`mailboxes.${key}`));
    setBusy(true);
    try {
      await client.importRawEmail(file, { [mailbox.id]: true }, importKeywords(mailbox.role), mailbox.accountId);
      toast.success(t("imported_to_mail", { folder }));
      onClose();
    } catch (error) {
      console.error("Importing a message from Files failed:", error);
      toast.error(t("import_to_mail_failed", { name: file.name }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog isOpen={!!file} onClose={onClose} title={t("import_to_mail_title")} bodyClassName="px-2" size="sm" testId="import-eml-dialog">
      <div role="menu" aria-label={t("import_to_mail_title")} className="max-h-[60vh] overflow-y-auto">
        <MoveFolderList variant="dialog" alwaysFilter noRecent model={model} testIdPrefix="import-eml:" onPick={(id) => void importInto(id)} />
      </div>
    </Dialog>
  );
}
