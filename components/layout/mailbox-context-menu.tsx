"use client";

import { useTranslations } from "next-intl";
import { Mailbox } from "@/lib/jmap/types";
import { getMailboxPath } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuHeader,
} from "@/components/ui/context-menu";
import {
  CheckCheck,
  MailOpen,
  Mails,
  Trash2,
  FolderPlus,
  Pencil,
  FolderX,
  RefreshCw,
} from "lucide-react";

interface Position {
  x: number;
  y: number;
}

export type MailboxContextTarget =
  | { kind: "mailbox"; mailbox: Mailbox; hasChildren: boolean }
  | { kind: "folders-section" };

const PATH_SEPARATOR = " › ";
const MAX_PATH_LENGTH = 40;
const MAX_SEGMENT_LENGTH = 16;

function truncateSegment(name: string): string {
  return name.length > MAX_SEGMENT_LENGTH
    ? `${name.slice(0, MAX_SEGMENT_LENGTH - 1)}…`
    : name;
}

function shortenPath(fullPath: string): string {
  if (fullPath.length <= MAX_PATH_LENGTH) return fullPath;
  const segments = fullPath.split(PATH_SEPARATOR);
  if (segments.length <= 2) return segments.map(truncateSegment).join(PATH_SEPARATOR);
  const first = truncateSegment(segments[0]);
  const last = truncateSegment(segments[segments.length - 1]);
  return `${first}${PATH_SEPARATOR}…${PATH_SEPARATOR}${last}`;
}

interface MailboxContextMenuProps {
  target: MailboxContextTarget | null;
  position: Position;
  isOpen: boolean;
  onClose: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
  mailboxes: Mailbox[];
  onMarkFolderRead?: (mailboxId: string) => void;
  onMarkFolderTreeRead?: (mailboxId: string) => void;
  onMarkAllFoldersRead?: () => void;
  onEmptyFolder?: (mailboxId: string) => void;
  onCreateSubfolder?: (parentId: string) => void;
  onCreateFolder?: () => void;
  onRenameFolder?: (mailboxId: string) => void;
  onDeleteFolder?: (mailboxId: string) => void;
  onRefresh?: () => void;
}

export function MailboxContextMenu({
  target,
  position,
  isOpen,
  onClose,
  menuRef,
  mailboxes,
  onMarkFolderRead,
  onMarkFolderTreeRead,
  onMarkAllFoldersRead,
  onEmptyFolder,
  onCreateSubfolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onRefresh,
}: MailboxContextMenuProps) {
  const t = useTranslations("mailbox_context_menu");

  const handleAction = (action: () => void) => {
    action();
    onClose();
  };

  if (!target) return null;

  if (target.kind === "folders-section") {
    return (
      <ContextMenu ref={menuRef} isOpen={isOpen} position={position} onClose={onClose}>
        <ContextMenuItem
          icon={CheckCheck}
          label={t("mark_all_folders_read")}
          onClick={() => handleAction(onMarkAllFoldersRead!)}
          disabled={!onMarkAllFoldersRead}
        />
        <ContextMenuSeparator />
        <ContextMenuItem
          icon={FolderPlus}
          label={t("new_folder")}
          onClick={() => handleAction(onCreateFolder!)}
          disabled={!onCreateFolder}
        />
        <ContextMenuItem
          icon={RefreshCw}
          label={t("refresh")}
          onClick={() => handleAction(onRefresh!)}
          disabled={!onRefresh}
        />
      </ContextMenu>
    );
  }

  const mailbox = target.mailbox;
  const isTrashOrJunk = mailbox.role === "trash" || mailbox.role === "junk";
  const isSystem =
    !!mailbox.role &&
    ["inbox", "sent", "drafts", "trash", "junk", "archive"].includes(mailbox.role);
  const canRename = mailbox.myRights?.mayRename !== false && !isSystem;
  const canDelete = mailbox.myRights?.mayDelete !== false && !isSystem;
  const canCreateChild = mailbox.myRights?.mayCreateChild !== false;
  const canSetSeen = mailbox.myRights?.maySetSeen !== false;
  const canRemoveItems = mailbox.myRights?.mayRemoveItems !== false;

  const fullPath = getMailboxPath(mailbox, mailboxes);
  const displayPath = shortenPath(fullPath);

  return (
    <ContextMenu ref={menuRef} isOpen={isOpen} position={position} onClose={onClose}>
      <ContextMenuHeader>
        <span title={fullPath}>{displayPath}</span>
      </ContextMenuHeader>

      <ContextMenuItem
        icon={MailOpen}
        label={t("mark_folder_read")}
        onClick={() => handleAction(() => onMarkFolderRead?.(mailbox.id))}
        disabled={!onMarkFolderRead || !canSetSeen}
      />
      {target.hasChildren && (
        <ContextMenuItem
          icon={Mails}
          label={t("mark_folder_tree_read")}
          onClick={() => handleAction(() => onMarkFolderTreeRead?.(mailbox.id))}
          disabled={!onMarkFolderTreeRead || !canSetSeen}
        />
      )}

      <ContextMenuSeparator />

      <ContextMenuItem
        icon={FolderPlus}
        label={t("new_subfolder")}
        onClick={() => handleAction(() => onCreateSubfolder?.(mailbox.id))}
        disabled={!onCreateSubfolder || !canCreateChild}
      />
      <ContextMenuItem
        icon={Pencil}
        label={t("rename")}
        onClick={() => handleAction(() => onRenameFolder?.(mailbox.id))}
        disabled={!onRenameFolder || !canRename}
      />

      <ContextMenuSeparator />

      <ContextMenuItem
        icon={FolderX}
        label={isTrashOrJunk ? t("empty_folder") : t("empty_folder_generic")}
        onClick={() => handleAction(() => onEmptyFolder?.(mailbox.id))}
        disabled={!onEmptyFolder || mailbox.totalEmails === 0 || !canRemoveItems}
        destructive
      />
      <ContextMenuItem
        icon={Trash2}
        label={t("delete_folder")}
        onClick={() => handleAction(() => onDeleteFolder?.(mailbox.id))}
        disabled={!onDeleteFolder || !canDelete}
        destructive
      />

      <ContextMenuSeparator />

      <ContextMenuItem
        icon={RefreshCw}
        label={t("refresh")}
        onClick={() => handleAction(onRefresh!)}
        disabled={!onRefresh}
      />
    </ContextMenu>
  );
}
