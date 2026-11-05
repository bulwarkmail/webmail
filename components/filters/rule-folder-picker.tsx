"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown } from "@/components/icons";
import { ContextMenu } from "@/components/ui/context-menu";
import { MoveFolderList, moveMailboxIcon, useMoveMenu } from "@/components/email/move-target-list";
import { useContextMenu } from "@/hooks/use-context-menu";
import { localizeMailboxName } from "@/lib/mailbox-label";
import type { Mailbox } from "@/lib/jmap/types";
import { cn } from "@/lib/utils";

interface RuleFolderPickerProps {
  /** The account's folders; the shared ones and Scheduled are left out here. */
  mailboxes: Mailbox[];
  /** The chosen folder's id, or "" for none yet. */
  value: string;
  /** What the rule says when its folder is gone (the saved path). */
  missingLabel?: string;
  onPick: (mailboxId: string) => void;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
}

/**
 * The folder field of a rule's Move/Copy action: a button that opens the same
 * Move list every other folder choice uses (mail-p3-9): Recent, system folders
 * first, nesting, and the filter once the list is long. Not a native select
 * with spaces for nesting.
 */
export function RuleFolderPicker({ mailboxes, value, missingLabel, onPick, invalid, describedBy, className }: RuleFolderPickerProps) {
  const t = useTranslations("settings.filters");
  const tSidebar = useTranslations("sidebar");
  const menu = useContextMenu<null>();

  const targets = useMemo(
    () => mailboxes.filter((m) => !m.isShared && (m.role as string | null | undefined) !== "scheduled"),
    [mailboxes],
  );
  // No folder is "the open one" here: a rule may file into the Inbox too.
  const model = useMoveMenu(targets, { currentMailboxId: null });

  const byId = useMemo(() => new Map(mailboxes.map((m) => [m.id, m])), [mailboxes]);
  const chosen = value ? byId.get(value) : undefined;
  // The whole path, so two "2026" folders under different parents differ.
  const parts: string[] = [];
  const seen = new Set<string>();
  for (let current = chosen; current && !seen.has(current.id); current = current.parentId ? byId.get(current.parentId) : undefined) {
    seen.add(current.id);
    parts.unshift(localizeMailboxName(current.role, current.name, (k) => tSidebar(`mailboxes.${k}`)));
  }
  const label = chosen ? parts.join(" / ") : value ? (missingLabel ?? "") : "";
  const Icon = moveMailboxIcon(chosen?.role);

  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu.contextMenu.isOpen}
        aria-label={t("move_to_folder")}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        data-rule-error={invalid}
        data-testid="rule-folder-picker"
        data-value={value}
        title={label || undefined}
        onClick={(e) => menu.openContextMenuFrom(e.currentTarget, null, "start")}
        className={cn(
          "flex items-center gap-2 px-2.5 py-1.5 text-sm text-start rounded-md bg-muted border border-border text-foreground transition-colors duration-150 cursor-pointer hover:border-muted-foreground",
          invalid && "border-destructive",
          className,
        )}
      >
        {label && <Icon className="w-4 h-4 flex-shrink-0 text-muted-foreground" />}
        <span className={cn("min-w-0 flex-1 truncate", !label && "text-muted-foreground")} dir="auto">
          {label || t("move_to_folder")}
        </span>
        <ChevronDown className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
      </button>
      <ContextMenu
        ref={menu.menuRef}
        isOpen={menu.contextMenu.isOpen}
        position={menu.contextMenu.position}
        onClose={menu.closeContextMenu}
        label={t("move_to_folder")}
        overDialog
      >
        <div className="w-64 max-w-full">
          <MoveFolderList
            model={model}
            testIdPrefix="rule-folder:"
            onPick={(id) => { menu.closeContextMenu(); onPick(id); }}
          />
        </div>
      </ContextMenu>
    </>
  );
}
