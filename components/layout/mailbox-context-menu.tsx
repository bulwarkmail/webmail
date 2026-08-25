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
  ChevronRight,
  MailOpen,
  Mails,
  MoreHorizontal,
  Trash2,
  FolderPlus,
  Pencil,
  FolderX,
  RefreshCw,
  Upload,
} from "lucide-react";

interface Position {
  x: number;
  y: number;
}

export type MailboxContextTarget =
  | { kind: "mailbox"; mailbox: Mailbox; hasChildren: boolean }
  | { kind: "folders-section"; accountId?: string };

const PATH_SEPARATOR = " › ";
const MAX_PATH_LENGTH = 40;
const MAX_SEGMENT_LENGTH = 16;

function truncateSegment(name: string): string {
  return name.length > MAX_SEGMENT_LENGTH
    ? `${name.slice(0, MAX_SEGMENT_LENGTH - 1)}…`
    : name;
}

function renderPathSegments(segments: string[]): React.ReactNode {
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {segments.map((seg, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <ChevronRight className="w-3.5 h-3.5 opacity-60" />}
          {seg === "…" ? <MoreHorizontal className="w-3.5 h-3.5" /> : <span>{seg}</span>}
        </span>
      ))}
    </span>
  );
}

function renderShortenedPath(fullPath: string): React.ReactNode {
  const segments = fullPath.split(PATH_SEPARATOR);
  if (fullPath.length <= MAX_PATH_LENGTH) {
    return renderPathSegments(segments);
  }
  if (segments.length <= 2) {
    return renderPathSegments(segments.map(truncateSegment));
  }
  return renderPathSegments([
    truncateSegment(segments[0]),
    "…",
    truncateSegment(segments[segments.length - 1]),
  ]);
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
  onCreateFolder?: (accountId?: string) => void;
  onRenameFolder?: (mailboxId: string) => void;
  onDeleteFolder?: (mailboxId: string) => void;
  onImportEmail?: (mailboxId: string) => void;
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
  onImportEmail,
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
        {!target.accountId && (
          <>
            <ContextMenuItem
              icon={CheckCheck}
              label={t("mark_all_folders_read")}
              onClick={() => handleAction(onMarkAllFoldersRead!)}
              disabled={!onMarkAllFoldersRead}
            />
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem
          icon={FolderPlus}
          label={t("new_folder")}
          onClick={() => handleAction(() => onCreateFolder?.(target.accountId))}
          disabled={!onCreateFolder}
          testId="mailbox-new-folder"
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
  const canAddItems = mailbox.myRights?.mayAddItems !== false;

  const fullPath = getMailboxPath(mailbox, mailboxes);

  return (
    <ContextMenu ref={menuRef} isOpen={isOpen} position={position} onClose={onClose}>
      <ContextMenuHeader>
        <span title={fullPath}>{renderShortenedPath(fullPath)}</span>
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
        testId="mailbox-new-subfolder"
      />
      <ContextMenuItem
        icon={Pencil}
        label={t("rename")}
        onClick={() => handleAction(() => onRenameFolder?.(mailbox.id))}
        disabled={!onRenameFolder || !canRename}
        testId="mailbox-rename"
      />

      <ContextMenuSeparator />

      <ContextMenuItem
        icon={Upload}
        label={t("import_email")}
        onClick={() => handleAction(() => onImportEmail?.(mailbox.id))}
        disabled={!onImportEmail || !canAddItems}
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
        testId="mailbox-delete"
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
