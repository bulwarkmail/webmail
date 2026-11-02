"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { Email, Mailbox } from "@/lib/jmap/types";
import { IconButton } from "@/components/ui/icon-button";
import { ContextMenu } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { useCopyToAccount, useEmailExport } from "@/hooks/use-message-file-actions";
import { useArchiveActionEnabled } from "@/lib/archive-gate";
import { buildMoveTargets, resolveMoveOwnerAccountId } from "@/lib/move-targets";
import { resolveEmailBlobContext } from "@/stores/email-store";
import { useAuthStore } from "@/stores/auth-store";
import { Archive, FolderInput, MoreVertical, Trash2 } from "@/components/icons";
import { EmailContextMenu } from "./email-context-menu";
import { MoveTargetList } from "./move-target-list";
import { ViewSourceDialog } from "./view-source-dialog";
import { canExport } from "@/lib/device-policy";
import type { MessageActionKey } from "./message-actions";

/**
 * What the phone conversation header does with the conversation's newest
 * message, as the list row's menu does. Archive, Delete, Move and anything
 * that takes the message out of the folder go back to the list first.
 */
export interface ConversationActions {
  mailboxes: Mailbox[];
  selectedMailbox: string;
  currentMailboxRole?: string;
  onArchive?: () => void;
  onDelete?: () => void;
  onMoveToMailbox?: (mailboxId: string) => void;
  onForwardAsAttachment?: () => void;
  onMarkAsRead?: (read: boolean) => void;
  onToggleStar?: () => void;
  onTogglePinned?: () => void;
  onSetTag?: (tagId: string | null) => void;
  onMarkAsSpam?: () => void;
  onUndoSpam?: () => void;
}

// The header shows these itself; each message's card has Reply, Reply all
// and Forward.
const OMIT: ReadonlySet<MessageActionKey> = new Set<MessageActionKey>(["archive", "delete", "move", "reply", "reply_all", "forward"]);

/** Archive, Delete, Move and ⋮ (the message's action list, R6) for the phone conversation header. */
export function ConversationHeaderActions({ email, actions }: { email: Email; actions: ConversationActions }) {
  const t = useTranslations();
  const client = useAuthStore((s) => s.client);
  const archiveEnabled = useArchiveActionEnabled();
  const moveMenu = useContextMenu<null>();
  const moreMenu = useContextMenu<null>();
  const { copyTargets, copyToAccount } = useCopyToAccount(email, moreMenu.contextMenu.isOpen);
  const exportEmail = useEmailExport();
  const [showSource, setShowSource] = useState(false);
  const { mailboxes, selectedMailbox, onArchive, onDelete, onMoveToMailbox } = actions;

  const ownerAccountId = resolveMoveOwnerAccountId(email, mailboxes, selectedMailbox);
  const { tree: moveTree, targetIds: moveTargetIds } = useMemo(
    () => buildMoveTargets(mailboxes, { currentMailboxId: selectedMailbox, ownerAccountId, emails: [email] }),
    [mailboxes, selectedMailbox, ownerAccountId, email],
  );
  const canMove = !!onMoveToMailbox && moveTree.length > 0;

  const exportFollowUp = { onArchive, onDelete, archiveEnabled };
  const source = resolveEmailBlobContext(email, client);

  return (
    <div className="flex items-center flex-shrink-0 -me-2" data-testid="conversation-actions">
      {onArchive && (
        <IconButton size="icon-lg" onClick={onArchive} label={t("context_menu.archive")}>
          <Archive />
        </IconButton>
      )}
      {onDelete && (
        <IconButton size="icon-lg" onClick={onDelete} label={t("context_menu.delete")}>
          <Trash2 />
        </IconButton>
      )}
      {canMove && (
        <IconButton
          size="icon-lg"
          label={t("email_viewer.move_to")}
          aria-haspopup="menu"
          aria-expanded={moveMenu.contextMenu.isOpen}
          onClick={(e) => moveMenu.openContextMenuFrom(e.currentTarget, null, "end")}
        >
          <FolderInput />
        </IconButton>
      )}
      <IconButton
        size="icon-lg"
        label={t("email_viewer.more_actions")}
        aria-haspopup="menu"
        aria-expanded={moreMenu.contextMenu.isOpen}
        data-testid="conversation-more"
        onClick={(e) => moreMenu.openContextMenuFrom(e.currentTarget, null, "end")}
      >
        <MoreVertical />
      </IconButton>

      {canMove && (
        <ContextMenu
          ref={moveMenu.menuRef}
          isOpen={moveMenu.contextMenu.isOpen}
          position={moveMenu.contextMenu.position}
          onClose={moveMenu.closeContextMenu}
          label={t("email_viewer.move_to")}
        >
          <div className="w-56 max-h-72 overflow-y-auto">
            <MoveTargetList
              tree={moveTree}
              targetIds={moveTargetIds}
              onPick={(mailboxId) => { moveMenu.closeContextMenu(); onMoveToMailbox!(mailboxId); }}
            />
          </div>
        </ContextMenu>
      )}
      {moreMenu.contextMenu.isOpen && (
        <EmailContextMenu
          email={email}
          position={moreMenu.contextMenu.position}
          isOpen
          onClose={moreMenu.closeContextMenu}
          menuRef={moreMenu.menuRef}
          label={t("email_viewer.more_actions")}
          mailboxes={mailboxes}
          selectedMailbox={selectedMailbox}
          currentMailboxRole={actions.currentMailboxRole}
          onForwardAsAttachment={actions.onForwardAsAttachment}
          onMarkAsRead={actions.onMarkAsRead}
          onToggleStar={actions.onToggleStar}
          onTogglePinned={actions.onTogglePinned}
          onSetTag={actions.onSetTag}
          onMarkAsSpam={actions.onMarkAsSpam}
          onUndoSpam={actions.onUndoSpam}
          copyTargets={copyTargets}
          onCopyToAccount={(accountId, mailboxId) => void copyToAccount([email], accountId, mailboxId)}
          // Not under the device policy "No export" of the message's account.
          onExport={canExport(email) ? () => void exportEmail(email, exportFollowUp, source) : undefined}
          onViewSource={canExport(email) ? () => setShowSource(true) : undefined}
          omit={OMIT}
          rowPlugins={false}
        />
      )}
      {showSource && (
        <ViewSourceDialog
          isOpen
          onClose={() => setShowSource(false)}
          blobId={email.blobId}
          client={source.client}
          accountId={source.accountId}
          onDownload={() => void exportEmail(email, exportFollowUp, source)}
        />
      )}
    </div>
  );
}
