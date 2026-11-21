"use client";

import { useTranslations } from "next-intl";
import { FolderInput, X } from "@/components/icons";
import { ComposerToolbarMenu, ComposerToolbarMenuItem } from "@/components/email/composer-toolbar-menu";
import { MoveFolderList, useMoveMenu } from "@/components/email/move-target-list";
import type { Mailbox } from "@/lib/jmap/types";
import { getMailboxPath } from "@/lib/utils";

interface ComposerFileInMenuProps {
  /** The folders of the original's account it can be filed in (fileWithOriginalTargets). */
  folders: Mailbox[];
  /** The folder picked, if any. */
  value: string | undefined;
  onChange: (mailboxId: string | null) => void;
}

/**
 * "File in folder" for a reply or forward: the message and the one it
 * answers go to the picked folder once it is sent.
 */
export function ComposerFileInMenu({ folders, value, onChange }: ComposerFileInMenuProps) {
  const t = useTranslations("email_composer");
  // No folder is "the open one" here: the Inbox is a choice too.
  const model = useMoveMenu(folders, { currentMailboxId: null });
  const chosen = value ? folders.find((m) => m.id === value) : undefined;
  const label = chosen ? t("file_in_chosen", { folder: getMailboxPath(chosen, folders) }) : t("file_in");

  return (
    <ComposerToolbarMenu icon={FolderInput} label={label} activeCount={chosen ? 1 : 0} testId="composer-file-in">
      {(close) => <>
        <div className="px-3 pt-1.5 pb-1 text-xs text-muted-foreground">{t("file_in_hint")}</div>
        {chosen && (
          <>
            <ComposerToolbarMenuItem icon={X} onSelect={() => { close(); onChange(null); }} testId="composer-file-in-none">
              {t("file_in_none")}
            </ComposerToolbarMenuItem>
            <div role="separator" className="my-1 h-px bg-border" />
          </>
        )}
        <div className="w-64 max-w-full">
          <MoveFolderList
            model={model}
            testIdPrefix="composer-file-in:"
            noRecent
            onPick={(id) => { close(); onChange(id); }}
          />
        </div>
      </>}
    </ComposerToolbarMenu>
  );
}
