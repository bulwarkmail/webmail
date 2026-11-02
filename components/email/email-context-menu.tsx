"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { useSettingsStore } from "@/stores/settings-store";
import { useEmailStore, removalFolder, canRemoveFromFolder } from "@/stores/email-store";
import { useEmailTagScope, type TagScope } from "@/hooks/use-account-tags";
import { Email, Mailbox } from "@/lib/jmap/types";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSubMenu,
  ContextMenuHeader,
} from "@/components/ui/context-menu";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import { PluginActions, useMessageActionTarget, usePluginActions } from "@/components/plugins/plugin-actions";
import {
  Mail,
  MailOpen,
  Trash2,
  Archive,
  FolderInput,
  FolderX,
  Tag,
  ShieldAlert,
  ShieldCheck,
  Paperclip,
  Copy,
  Fish,
} from "@/components/icons";
import { useMessageActionList, type MessageActionEntry, type MessageActionKey } from "./message-actions";
import { buildMailboxTree, MailboxNode } from "@/lib/utils";
import { buildMoveTargets, resolveMoveOwnerAccountId } from "@/lib/move-targets";
import { localizeMailboxName } from "@/lib/mailbox-label";
import { moveMailboxIcon } from "./move-target-list";
import { getEmailTagIds } from "@/lib/thread-utils";
import { TagPicker } from "./tag-picker";
import { RulesContextSubMenu } from "./rules-menu";
import { useArchiveActionEnabled } from "@/lib/archive-gate";
import { usePhishingReport } from "@/hooks/use-phishing-report";

interface Position {
  x: number;
  y: number;
}

/** Another connected account the "Copy to" entry can copy into. */
export interface CopyTargetAccount {
  /** The login (AccountEntry.id). */
  accountId: string;
  label: string;
  /** That account's own folders, as its client returns them. */
  mailboxes: Mailbox[];
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
  /**
   * The messages whose senders the Rules entry makes rules for: the whole
   * selection, or for a single row the message to take the sender from.
   * Without it, the menu's own message.
   */
  ruleEmails?: Email[];
  // Single email actions
  onReply?: () => void;
  onReplyAll?: () => void;
  onForward?: () => void;
  onForwardAsAttachment?: () => void;
  /** Mountain View: search for the mail this sender has sent. */
  onFindFromSender?: () => void;
  onMarkAsRead?: (read: boolean) => void;
  onToggleStar?: () => void;
  onTogglePinned?: () => void;
  onDelete?: () => void;
  onArchive?: () => void;
  onSetTag?: (tagId: string | null) => void;
  onMoveToMailbox?: (mailboxId: string) => void;
  /**
   * Take the message out of the open folder only (#615). Offered when the
   * message is also in another folder and the list shows a single folder.
   */
  onRemoveFromFolder?: () => void;
  onMarkAsSpam?: () => void;
  onUndoSpam?: () => void;
  onEditDraft?: () => void;
  onCancelScheduledForEdit?: () => void;
  onCancelScheduledSend?: () => void;
  onRescheduleScheduled?: () => void;
  // Batch actions
  onBatchMarkAsRead?: (read: boolean) => void;
  /** Tags every selected message carries, and those only some of them do. */
  batchTagIds?: string[];
  batchPartialTagIds?: string[];
  /**
   * The account of the whole selection (commonTagScope): its tags are
   * offered. Null when the selection mixes accounts: the user's own tags.
   */
  batchTagScope?: TagScope | null;
  /** Takes the tag off when the whole selection has it, else puts it on all. */
  onBatchToggleTag?: (tagId: string) => void;
  onBatchDelete?: () => void;
  onBatchArchive?: () => void;
  onBatchMoveToMailbox?: (mailboxId: string) => void;
  /** The selected messages, for the batch "Remove from this folder". */
  batchEmails?: Email[];
  onBatchRemoveFromFolder?: () => void;
  onBatchMarkAsSpam?: () => void;
  onBatchUndoSpam?: () => void;
  /**
   * Other connected accounts to offer under "Copy to". Copies the selection
   * (or the single message) and keeps the originals. Hidden when empty.
   */
  copyTargets?: CopyTargetAccount[];
  onCopyToAccount?: (accountId: string, mailboxId: string) => void;
  onBatchForwardAsAttachment?: () => void;
  /** Save the message as .eml, print it, show its source (single message). */
  onExport?: () => void;
  onPrint?: () => void;
  onViewSource?: () => void;
  /** Entries the host already shows elsewhere (the reader's toolbar). */
  omit?: ReadonlySet<MessageActionKey>;
  /** The host's own entries after the message's (the reader's view toggles). */
  extras?: MessageActionEntry[];
  /** The row's plugin entries (message-row-actions). Default true. */
  rowPlugins?: boolean;
  /** The menu's accessible name, e.g. "More actions" from the reader's ⋮. */
  label?: string;
}

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
  ruleEmails,
  onReply,
  onReplyAll,
  onForward,
  onForwardAsAttachment,
  onFindFromSender,
  onMarkAsRead,
  onToggleStar,
  onTogglePinned,
  onDelete,
  onArchive,
  onSetTag,
  onMoveToMailbox,
  onRemoveFromFolder,
  onMarkAsSpam,
  onUndoSpam,
  onBatchMarkAsRead,
  batchTagIds,
  batchPartialTagIds,
  batchTagScope = null,
  onBatchToggleTag,
  onBatchDelete,
  onBatchArchive,
  onBatchMoveToMailbox,
  batchEmails,
  onBatchRemoveFromFolder,
  onBatchMarkAsSpam,
  onBatchUndoSpam,
  onBatchForwardAsAttachment,
  onEditDraft,
  onCancelScheduledForEdit,
  onCancelScheduledSend,
  onRescheduleScheduled,
  copyTargets,
  onCopyToAccount,
  onExport,
  onPrint,
  onViewSource,
  omit,
  extras,
  rowPlugins = true,
  label,
}: EmailContextMenuProps) {
  const t = useTranslations("context_menu");
  const archiveActionEnabled = useArchiveActionEnabled();
  const mountainView = useSettingsStore((state) => state.interfaceLayout === "mountain-view");
  const tSidebar = useTranslations("sidebar");
  const isUnread = !email.keywords?.$seen;
  const currentTagIds = getEmailTagIds(email.keywords);
  // The row's account names its tags; a selection uses batchTagScope.
  const tagScope = useEmailTagScope(email);
  const showBatchActions = isMultiSelect && selectedCount > 1;
  const isInJunkFolder = currentMailboxRole === 'junk';
  // Marking your own outgoing mail as spam makes no sense - hide the action
  // in Sent, Drafts and Scheduled.
  const spamApplicable = !['sent', 'drafts', 'scheduled'].includes(currentMailboxRole || '');
  const isScheduled = email.isScheduled === true;
  // One report per selected message, behind one confirm (enterprise pack).
  const batchPhishing = usePhishingReport(showBatchActions ? (batchEmails ?? []) : [], currentMailboxRole);
  const tPhishing = useTranslations("phishing_report");
  // "Remove from this folder" needs one open folder and messages that are
  // also in another one; for a selection, every selected message must be.
  const folderToLeave = useEmailStore(removalFolder);
  const canRemove = showBatchActions
    ? !!onBatchRemoveFromFolder && !!batchEmails?.length && batchEmails.every((e) => canRemoveFromFolder(e, folderToLeave))
    : !!onRemoveFromFolder && canRemoveFromFolder(email, folderToLeave);

  // Move-to submenu: the message's own account first (#1149)
  const { tree: moveTree, targetIds: moveTargetIds } = buildMoveTargets(mailboxes, {
    currentMailboxId: selectedMailbox,
    ownerAccountId: resolveMoveOwnerAccountId(email, mailboxes, selectedMailbox),
    emails: showBatchActions ? batchEmails : [email],
  });

  // Filter tree to only include branches that contain valid targets
  const filterTree = (nodes: MailboxNode[], targetIds: Set<string>): MailboxNode[] => {
    return nodes.reduce<MailboxNode[]>((acc, node) => {
      const filteredChildren = filterTree(node.children, targetIds);
      if (targetIds.has(node.id) || filteredChildren.length > 0) {
        acc.push({ ...node, children: filteredChildren });
      }
      return acc;
    }, []);
  };

  // Folders of the other connected accounts a copy can land in.
  const copyTrees = (copyTargets ?? [])
    .map((target) => {
      const targetIds = new Set(
        target.mailboxes
          .filter((m) => !m.isShared && m.role !== "drafts" && m.myRights?.mayAddItems)
          .map((m) => m.id)
      );
      return { ...target, targetIds, tree: filterTree(buildMailboxTree(target.mailboxes), targetIds) };
    })
    .filter((target) => target.tree.length > 0);

  const renderMailboxNodes = (
    nodes: MailboxNode[],
    targetIds: Set<string>,
    testIdPrefix: string,
    onPick: (mailboxId: string) => void,
  ): React.ReactNode =>
    nodes.map((node) => {
      const Icon = moveMailboxIcon(node.role);
      const nodeLabel = localizeMailboxName(node.role, node.name, (k) => tSidebar(`mailboxes.${k}`));
      return (
        <div key={node.id}>
          {targetIds.has(node.id) ? (
            <ContextMenuItem
              icon={Icon}
              label={nodeLabel}
              testId={`${testIdPrefix}${node.id}`}
              onClick={() => handleAction(() => onPick(node.id))}
            />
          ) : (
            <div className="px-3 py-1.5 text-sm flex items-center gap-2 text-muted-foreground">
              <Icon className="w-4 h-4 flex-shrink-0" />
              <span>{nodeLabel}</span>
            </div>
          )}
          {node.children.length > 0 && (
            <div className="ps-4">
              {renderMailboxNodes(node.children, targetIds, testIdPrefix, onPick)}
            </div>
          )}
        </div>
      );
    });

  const handleAction = (action: () => void) => {
    action();
    onClose();
  };

  // One message: the shared action list (R6), the same the reader's ⋮ and
  // the phone panel show.
  const singleEntries = useMessageActionList({
    email,
    currentMailboxRole,
    canMove: moveTree.length > 0,
    canRemoveFromFolder: canRemove,
    canCopyToAccount: !!onCopyToAccount && copyTrees.length > 0,
    onReply,
    onReplyAll,
    onForward,
    onForwardAsAttachment,
    onEditDraft,
    onArchive,
    onDelete,
    onMarkAsRead,
    onToggleStar,
    onTogglePinned,
    onRemoveFromFolder,
    onMarkAsSpam,
    onUndoSpam,
    onFindFromSender,
    onRescheduleScheduled,
    onCancelScheduledForEdit,
    onCancelScheduledSend,
    onExport,
    onPrint,
    onViewSource,
    omit,
    extras,
  });

  // Stable, so the Rules entry does not re-resolve its account every render.
  const ruleSenderEmails = useMemo(() => ruleEmails ?? [email], [ruleEmails, email]);

  // The row's plugin buttons (message-row-actions). On phones the long press
  // opens this menu, so it is where those buttons live there. Below, the
  // selection's entries in the default layout's order or, under Mountain
  // View, in Gmail's.
  const rowPluginTarget = useMessageActionTarget(email);
  const hasRowPluginActions = usePluginActions("message-row-actions", {
    mailboxRole: currentMailboxRole ?? null,
    accountKind: rowPluginTarget.accountKind,
    keywords: rowPluginTarget.keywords,
  }).length > 0;
  const rowPluginContext = useMemo(() => ({ emailId: email.id }), [email.id]);
  const rowPluginBlock = !showBatchActions && hasRowPluginActions ? (
    <>
      <ContextMenuSeparator />
      <PluginActions
        surface="message-row-actions"
        variant="menu"
        context={rowPluginContext}
        target={rowPluginTarget}
        mailboxRole={currentMailboxRole ?? null}
        onRan={onClose}
      />
    </>
  ) : null;

  const archiveItem = archiveActionEnabled && (
    <>
        {/* Archive */}
        <ContextMenuItem
          icon={Archive}
          label={t("archive")}
          onClick={() => handleAction(onBatchArchive!)}
          disabled={!onBatchArchive}
        />
    </>
  );
  const deleteItem = (
    <>
        {/* Delete */}
        <ContextMenuItem
          icon={Trash2}
          label={t("delete")}
          testId="ctx-delete"
          onClick={() => handleAction(onBatchDelete!)}
          disabled={!onBatchDelete}
          destructive={!mountainView}
        />
    </>
  );
  const readItem = (
    <>
        {/* Mark as read/unread */}
        <ContextMenuItem
          icon={isUnread ? MailOpen : Mail}
          label={isUnread ? t("mark_read") : t("mark_unread")}
          testId={isUnread ? "ctx-mark-read" : "ctx-mark-unread"}
          onClick={() => handleAction(() => onBatchMarkAsRead?.(isUnread))}
        />
    </>
  );
  const moveItem = (
    <>
        {/* Move to submenu */}
        {moveTree.length > 0 && (
          <ContextMenuSubMenu icon={FolderInput} label={t("move_to")} testId="ctx-move-to">
            {renderMailboxNodes(moveTree, moveTargetIds, "move-to:", (mailboxId) => onBatchMoveToMailbox?.(mailboxId))}
          </ContextMenuSubMenu>
        )}
        {canRemove && (
          <ContextMenuItem
            icon={FolderX}
            label={t("remove_from_folder")}
            testId="ctx-remove-from-folder"
            onClick={() => handleAction(onBatchRemoveFromFolder!)}
          />
        )}
    </>
  );
  const copyTargetsContent = onCopyToAccount
    ? copyTrees.map((target) => (
        <div key={target.accountId}>
          <ContextMenuHeader>{target.label}</ContextMenuHeader>
          {renderMailboxNodes(target.tree, target.targetIds, `copy-to:${target.accountId}:`, (mailboxId) =>
            onCopyToAccount(target.accountId, mailboxId)
          )}
        </div>
      ))
    : null;
  const copyItem = (
    <>
        {/* Copy to another connected account, keeping the originals */}
        {onCopyToAccount && copyTrees.length > 0 && (
          <ContextMenuSubMenu icon={Copy} label={t("copy_to_account")} testId="ctx-copy-to">
            {copyTargetsContent}
          </ContextMenuSubMenu>
        )}
    </>
  );
  const rulesItem = (
    <>
        {/* Rules: filter rules made from the sender(s), saved as Sieve */}
        <RulesContextSubMenu anchor={email} senderEmails={ruleSenderEmails} onClose={onClose} />
    </>
  );
  const tagItem = (
    <>
        {/* Set tag submenu - the whole selection's tags (#1077) */}
        {onBatchToggleTag && (
          <ContextMenuSubMenu icon={Tag} label={t("tag")} testId="ctx-tag">
            <div className="w-56 max-w-[18rem]">
              <TagPicker
                selectedIds={batchTagIds ?? []}
                partialIds={batchPartialTagIds}
                onToggle={(tagId) => onBatchToggleTag?.(tagId)}
                scope={batchTagScope}
              />
            </div>
          </ContextMenuSubMenu>
        )}
    </>
  );
  const spamBlock = (
    <>
        {/* Spam - contextual based on folder; pointless on own outgoing mail */}
        {spamApplicable && (
          <>
            <ContextMenuSeparator />

            <ContextMenuItem
              icon={isInJunkFolder ? ShieldCheck : ShieldAlert}
              label={isInJunkFolder ? t("not_spam") : t("mark_as_spam")}
              testId={isInJunkFolder ? "ctx-not-spam" : "ctx-spam"}
              onClick={() => handleAction(isInJunkFolder ? onBatchUndoSpam! : onBatchMarkAsSpam!)}
              disabled={isInJunkFolder ? !onBatchUndoSpam : !onBatchMarkAsSpam}
              destructive={!isInJunkFolder && !mountainView}
            />
            {batchPhishing.available && (
              <ContextMenuItem
                icon={Fish}
                label={tPhishing("action")}
                testId="ctx-batch-report-phishing"
                onClick={() => handleAction(batchPhishing.report)}
              />
            )}
          </>
        )}
    </>
  );
  const renderSubmenu = (entry: Extract<MessageActionEntry, { kind: "submenu" }>) => {
    switch (entry.key) {
      case "move":
        return (
          <ContextMenuSubMenu key={entry.key} icon={entry.icon} label={entry.label} testId={entry.testId}>
            {renderMailboxNodes(moveTree, moveTargetIds, "move-to:", (mailboxId) => onMoveToMailbox?.(mailboxId))}
          </ContextMenuSubMenu>
        );
      case "copy_to_account":
        return (
          <ContextMenuSubMenu key={entry.key} icon={entry.icon} label={entry.label} testId={entry.testId}>
            {copyTargetsContent}
          </ContextMenuSubMenu>
        );
      case "tag":
        return (
          <ContextMenuSubMenu key={entry.key} icon={entry.icon} label={entry.label} testId={entry.testId}>
            <div className="w-56 max-w-[18rem]">
              <TagPicker selectedIds={currentTagIds} onToggle={(tagId) => onSetTag?.(tagId)} scope={tagScope} />
            </div>
          </ContextMenuSubMenu>
        );
      case "rules":
        return <RulesContextSubMenu key={entry.key} anchor={email} senderEmails={ruleSenderEmails} onClose={onClose} />;
    }
  };

  const singleMenu = singleEntries.map((entry, index) => {
    if (entry.kind === "separator") return <ContextMenuSeparator key={`sep-${index}`} />;
    if (entry.kind === "submenu") return renderSubmenu(entry);
    return (
      <ContextMenuItem
        key={entry.key}
        icon={entry.icon}
        label={entry.label}
        testId={entry.testId}
        disabled={entry.disabled}
        destructive={entry.destructive}
        onClick={() => handleAction(entry.run)}
      />
    );
  });

  return (
    <ContextMenu
      ref={menuRef}
      isOpen={isOpen}
      position={position}
      onClose={onClose}
      label={label}
    >
      {showBatchActions ? (
        <>
          <ContextMenuHeader>
            {t("items_selected", { count: selectedCount })}
          </ContextMenuHeader>

          {!isScheduled && (<>
          {/* Compose-style actions first, above the archive/delete group,
              mirroring the single menu's ordering. */}
          <ContextMenuItem
            icon={Paperclip}
            label={t("forward_as_attachments")}
            testId="ctx-batch-forward-as-attachment"
            onClick={() => handleAction(onBatchForwardAsAttachment!)}
            disabled={!onBatchForwardAsAttachment}
          />
          <ContextMenuSeparator />

          {mountainView ? (
            <>
              {archiveItem}
              {deleteItem}
              {readItem}
              <ContextMenuSeparator />
              {moveItem}
              {tagItem}
              {rulesItem}
              {copyItem}
              {spamBlock}
            </>
          ) : (
            <>
              {archiveItem}
              {deleteItem}
              <ContextMenuSeparator />
              {moveItem}
              {copyItem}
              {rulesItem}
              {tagItem}
              {spamBlock}
              <ContextMenuSeparator />
              {readItem}
            </>
          )}
          </>)}
        </>
      ) : (
        <>
          {singleMenu}
          {rowPlugins && rowPluginBlock}
        </>
      )}

      <PluginSlot name="context-menu-email" />
    </ContextMenu>
  );
}
