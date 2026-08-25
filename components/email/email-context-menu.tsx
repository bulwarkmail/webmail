"use client";

import { useTranslations } from "next-intl";
import { Email, Mailbox } from "@/lib/jmap/types";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSubMenu,
  ContextMenuHeader,
} from "@/components/ui/context-menu";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import {
  Reply,
  ReplyAll,
  Forward,
  Mail,
  MailOpen,
  Star,
  Pin,
  PinOff,
  Trash2,
  Archive,
  FolderInput,
  Tag,
  Inbox,
  Send,
  File,
  Folder,
  ShieldAlert,
  ShieldCheck,
  EditIcon,
  CalendarClock,
  Paperclip,
  Link as LinkIcon,
  MessagesSquare,
} from "lucide-react";
import { buildMailPath } from "@/lib/deep-links";
import { useCopyLink } from "@/hooks/use-copy-link";
import { buildMailboxTree, MailboxNode } from "@/lib/utils";
import { localizeMailboxName } from "@/lib/mailbox-label";
import { getEmailTagIds } from "@/lib/thread-utils";
import { TagPicker } from "./tag-picker";

interface Position {
  x: number;
  y: number;
}

interface EmailContextMenuProps {
  email: Email;
  position: Position;
  isOpen: boolean;
  onClose: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
  mailboxes: Mailbox[];
  selectedMailbox: string;
  currentMailboxRole?: string;
  isMultiSelect?: boolean;
  selectedCount?: number;
  // Single email actions
  onReply?: () => void;
  onReplyAll?: () => void;
  onForward?: () => void;
  onForwardAsAttachment?: () => void;
  onMarkAsRead?: (read: boolean) => void;
  onToggleStar?: () => void;
  onTogglePinned?: () => void;
  onDelete?: () => void;
  onArchive?: () => void;
  onSetTag?: (tagId: string | null) => void;
  onMoveToMailbox?: (mailboxId: string) => void;
  onMarkAsSpam?: () => void;
  onUndoSpam?: () => void;
  onEditDraft?: () => void;
  onCancelScheduledForEdit?: () => void;
  onRescheduleScheduled?: () => void;
  // Batch actions
  onBatchMarkAsRead?: (read: boolean) => void;
  onBatchDelete?: () => void;
  onBatchArchive?: () => void;
  onBatchMoveToMailbox?: (mailboxId: string) => void;
  onBatchMarkAsSpam?: () => void;
  onBatchUndoSpam?: () => void;
}

// Get mailbox icon based on role
const getMailboxIcon = (role?: string) => {
  switch (role) {
    case "inbox":
      return Inbox;
    case "sent":
      return Send;
    case "drafts":
      return File;
    case "trash":
      return Trash2;
    case "archive":
      return Archive;
    default:
      return Folder;
  }
};

export function EmailContextMenu({
  email,
  position,
  isOpen,
  onClose,
  menuRef,
  mailboxes,
  selectedMailbox,
  currentMailboxRole,
  isMultiSelect = false,
  selectedCount = 1,
  onReply,
  onReplyAll,
  onForward,
  onForwardAsAttachment,
  onMarkAsRead,
  onToggleStar,
  onTogglePinned,
  onDelete,
  onArchive,
  onSetTag,
  onMoveToMailbox,
  onMarkAsSpam,
  onUndoSpam,
  onBatchMarkAsRead,
  onBatchDelete,
  onBatchArchive,
  onBatchMoveToMailbox,
  onBatchMarkAsSpam,
  onBatchUndoSpam,
  onEditDraft,
  onCancelScheduledForEdit,
  onRescheduleScheduled,
}: EmailContextMenuProps) {
  const t = useTranslations("context_menu");
  const tSidebar = useTranslations("sidebar");
  const tEmailViewer = useTranslations("email_viewer");
  const tDeepLink = useTranslations("deep_link");
  const copyLink = useCopyLink();
  const isUnread = !email.keywords?.$seen;
  const isStarred = email.keywords?.$flagged;
  const isPinned = email.keywords?.['$pinned'] === true;
  const isDraft = email.keywords?.['$draft'] === true;
  const currentTagIds = getEmailTagIds(email.keywords);
  const showBatchActions = isMultiSelect && selectedCount > 1;
  const isInJunkFolder = currentMailboxRole === 'junk';
  // Marking your own outgoing mail as spam makes no sense - hide the action
  // in Sent, Drafts and Scheduled.
  const spamApplicable = !['sent', 'drafts', 'scheduled'].includes(currentMailboxRole || '');
  const isScheduled = email.isScheduled === true;
  const canCancelScheduled = isScheduled && email.scheduledUndoStatus === 'pending';

  // Build mailbox tree for move-to submenu with proper hierarchy
  const moveTargetIds = new Set(
    mailboxes
      .filter(
        (m) =>
          m.id !== selectedMailbox &&
          m.role !== "drafts" &&
          !m.id.startsWith("shared-") &&
          m.myRights?.mayAddItems
      )
      .map((m) => m.id)
  );
  const mailboxTree = buildMailboxTree(mailboxes);

  // Filter tree to only include branches that contain valid move targets
  const filterTree = (nodes: MailboxNode[]): MailboxNode[] => {
    return nodes.reduce<MailboxNode[]>((acc, node) => {
      const filteredChildren = filterTree(node.children);
      if (moveTargetIds.has(node.id) || filteredChildren.length > 0) {
        acc.push({ ...node, children: filteredChildren });
      }
      return acc;
    }, []);
  };
  const moveTree = filterTree(mailboxTree);

  const handleAction = (action: () => void) => {
    action();
    onClose();
  };

  return (
    <ContextMenu
      ref={menuRef}
      isOpen={isOpen}
      position={position}
      onClose={onClose}
    >
      {/* Batch header */}
      {showBatchActions && (
        <ContextMenuHeader>
          {t("items_selected", { count: selectedCount })}
        </ContextMenuHeader>
      )}

      {isScheduled && !showBatchActions && canCancelScheduled && (
        <>
          <ContextMenuItem
            icon={CalendarClock}
            label={t("reschedule_send")}
            onClick={() => handleAction(onRescheduleScheduled!)}
            disabled={!onRescheduleScheduled}
          />
          <ContextMenuItem
            icon={EditIcon}
            label={email.isSmimeScheduled ? t("cancel_and_compose_again") : t("cancel_and_edit")}
            onClick={() => handleAction(onCancelScheduledForEdit!)}
            disabled={!onCancelScheduledForEdit}
          />
        </>
      )}

      {canCancelScheduled && <ContextMenuSeparator />}

      {!isScheduled && (
        <>

      {/* Edit Draft - only for single draft emails */}
      {!isScheduled && !showBatchActions && isDraft && onEditDraft && (
        <>
          <ContextMenuItem
            icon={EditIcon}
            label={t("edit_draft")}
            onClick={() => handleAction(onEditDraft)}
          />
          <ContextMenuSeparator />
        </>
      )}

      {/* Single email actions - Reply, Reply All, Forward */}
      {!isScheduled && !showBatchActions && (
        <>
          <ContextMenuItem
            icon={Reply}
            label={t("reply")}
            onClick={() => handleAction(onReply!)}
            disabled={!onReply}
          />
          <ContextMenuItem
            icon={ReplyAll}
            label={t("reply_all")}
            onClick={() => handleAction(onReplyAll!)}
            disabled={!onReplyAll}
          />
          <ContextMenuItem
            icon={Forward}
            label={t("forward")}
            onClick={() => handleAction(onForward!)}
            disabled={!onForward}
          />
          <ContextMenuItem
            icon={Paperclip}
            label={tEmailViewer("forward_as_attachment")}
            onClick={() => handleAction(onForwardAsAttachment!)}
            disabled={!onForwardAsAttachment || !email.blobId}
          />
          <ContextMenuSeparator />
        </>
      )}

      {/* Permalinks (#733). The conversation entry only appears when the
          message actually belongs to a thread worth linking to. */}
      {!showBatchActions && (
        <>
          <ContextMenuItem
            icon={LinkIcon}
            label={tDeepLink("copy_message")}
            onClick={() => handleAction(() => {
              void copyLink(buildMailPath({ mailboxId: null, emailId: email.id, threadId: null }));
            })}
          />
          {email.threadId && (
            <ContextMenuItem
              icon={MessagesSquare}
              label={tDeepLink("copy_conversation")}
              onClick={() => handleAction(() => {
                void copyLink(buildMailPath({ mailboxId: null, emailId: null, threadId: email.threadId! }));
              })}
            />
          )}
          <ContextMenuSeparator />
        </>
      )}

      {/* Archive */}
      <ContextMenuItem
        icon={Archive}
        label={t("archive")}
        onClick={() =>
          handleAction(showBatchActions ? onBatchArchive! : onArchive!)
        }
        disabled={showBatchActions ? !onBatchArchive : !onArchive}
      />

      {/* Delete */}
      <ContextMenuItem
        icon={Trash2}
        label={t("delete")}
        testId="ctx-delete"
        onClick={() =>
          handleAction(showBatchActions ? onBatchDelete! : onDelete!)
        }
        disabled={showBatchActions ? !onBatchDelete : !onDelete}
        destructive
      />

      <ContextMenuSeparator />

      {/* Move to submenu */}
      {moveTree.length > 0 && (
        <ContextMenuSubMenu icon={FolderInput} label={t("move_to")} testId="ctx-move-to">
          {(() => {
            const renderNodes = (nodes: MailboxNode[]) => {
              return nodes.map((node) => {
                const Icon = getMailboxIcon(node.role);
                const isTarget = moveTargetIds.has(node.id);
                const nodeLabel = localizeMailboxName(node.role, node.name, (k) => tSidebar(`mailboxes.${k}`));
                return (
                  <div key={node.id}>
                    {isTarget ? (
                      <ContextMenuItem
                        icon={Icon}
                        label={nodeLabel}
                        testId={`move-to:${node.id}`}
                        onClick={() =>
                          handleAction(() =>
                            showBatchActions
                              ? onBatchMoveToMailbox?.(node.id)
                              : onMoveToMailbox?.(node.id)
                          )
                        }
                      />
                    ) : (
                      <div className="px-3 py-1.5 text-sm flex items-center gap-2 text-muted-foreground">
                        <Icon className="w-4 h-4 flex-shrink-0" />
                        <span>{nodeLabel}</span>
                      </div>
                    )}
                    {node.children.length > 0 && (
                      <div className="ps-4">
                        {renderNodes(node.children)}
                      </div>
                    )}
                  </div>
                );
              });
            };
            return renderNodes(moveTree);
          })()}
        </ContextMenuSubMenu>
      )}

      {/* Star/Unstar - only for single email */}
      {!showBatchActions && (
        <ContextMenuItem
          icon={Star}
          label={isStarred ? t("unstar") : t("star")}
          onClick={() => handleAction(onToggleStar!)}
          disabled={!onToggleStar}
          testId={isStarred ? "ctx-unstar" : "ctx-star"}
        />
      )}

      {/* Pin/Unpin - only for single email; pinned mails float to the top of the list */}
      {!showBatchActions && onTogglePinned && (
        <ContextMenuItem
          icon={isPinned ? PinOff : Pin}
          label={isPinned ? t("unpin") : t("pin")}
          onClick={() => handleAction(onTogglePinned)}
        />
      )}

      {/* Set tag submenu - only for single email */}
      {!showBatchActions && (
        <ContextMenuSubMenu icon={Tag} label={t("tag")}>
          <div className="w-56 max-w-[18rem]">
            <TagPicker
              selectedIds={currentTagIds}
              onToggle={(tagId) => onSetTag?.(tagId)}
            />
          </div>
        </ContextMenuSubMenu>
      )}

      {/* Spam - contextual based on folder; pointless on own outgoing mail */}
      {spamApplicable && (
        <>
          <ContextMenuSeparator />

          <ContextMenuItem
            icon={isInJunkFolder ? ShieldCheck : ShieldAlert}
            label={isInJunkFolder ? t("not_spam") : t("mark_as_spam")}
            testId={isInJunkFolder ? "ctx-not-spam" : "ctx-spam"}
            onClick={() =>
              handleAction(
                showBatchActions
                  ? (isInJunkFolder ? onBatchUndoSpam! : onBatchMarkAsSpam!)
                  : (isInJunkFolder ? onUndoSpam! : onMarkAsSpam!)
              )
            }
            disabled={showBatchActions ? (isInJunkFolder ? !onBatchUndoSpam : !onBatchMarkAsSpam) : (isInJunkFolder ? !onUndoSpam : !onMarkAsSpam)}
            destructive={!isInJunkFolder}
          />
        </>
      )}

      <ContextMenuSeparator />

      {/* Mark as read/unread */}
      <ContextMenuItem
        icon={isUnread ? MailOpen : Mail}
        label={isUnread ? t("mark_read") : t("mark_unread")}
        testId={isUnread ? "ctx-mark-read" : "ctx-mark-unread"}
        onClick={() =>
          handleAction(() =>
            showBatchActions
              ? onBatchMarkAsRead?.(isUnread)
              : onMarkAsRead?.(isUnread)
          )
        }
      />
        </>
      )}

      <PluginSlot name="context-menu-email" />
    </ContextMenu>
  );
}
