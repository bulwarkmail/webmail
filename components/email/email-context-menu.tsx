"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
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
import { PluginActions, useMessageActionTarget, usePluginActions, useRowActionTarget } from "@/components/plugins/plugin-actions";
import { usePluginRowBadges } from "@/components/email/plugin-row-badges";
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
  MoreHorizontal,
  Undo,
} from "@/components/icons";
import { tidySeparators, useMessageActionList, type MessageActionEntry, type MessageActionKey } from "./message-actions";
import { restoreTarget, restoreTargetForAll } from "@/lib/trash-origin";
import { resolveMoveOwnerAccountId } from "@/lib/move-targets";
import { buildMoveMenu, type MoveMenuModel } from "@/lib/move-menu";
import { MoveFolderList, moveMenuIsEmpty, useMoveMenu } from "./move-target-list";
import { useChooseMoveFolder } from "./move-to-dialog";
import { useMessageActionShortcut } from "./message-action-shortcuts";
import { useConnectionState } from "@/hooks/use-connection-state";
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
  /** Opens the message in its own window (single message). */
  onOpenInWindow?: () => void;
  /** Save the message as .eml, print it, show its source (single message). */
  onExport?: () => void;
  onPrint?: () => void;
  onViewSource?: () => void;
  /** Entries the host already shows elsewhere (the reader's toolbar). */
  omit?: ReadonlySet<MessageActionKey>;
  /** How the host shows the message (the reader's view toggles), before Export, Print and View source. */
  views?: MessageActionEntry[];
  /** The host's own entries after the message's. */
  extras?: MessageActionEntry[];
  /** The row's plugin entries (message-row-actions). Default true. */
  rowPlugins?: boolean;
  /** Entries a caller adds after the message's own, such as its toolbar's overflow. */
  extraEntries?: React.ReactNode;
  /** The menu's accessible name, e.g. "More actions" from the reader's ⋮. */
  label?: string;
  /**
   * A list row's right-click menu: what people use from a row, and the rest under
   * "More actions". The reader's ⋮ is that "more" already, so it shows them all.
   */
  rowMenu?: boolean;
}

/**
 * What a row's menu shows at its top level, as Outlook and Gmail have it. The rest
 * goes under "More actions".
 */
export const ROW_MENU_KEYS = new Set<MessageActionKey>([
  "reschedule", "cancel_and_edit", "cancel_send", "edit_draft",
  "reply", "reply_all", "forward",
  "restore", "archive", "delete", "move",
  "read", "star", "tag",
  "spam",
  "open_window",
]);

/** Entries that change the message on the server, or queue the change offline. */
const CHANGES_MAIL = new Set<MessageActionKey>([
  "archive", "delete", "read", "remove_from_folder", "star", "pin", "spam",
  "reschedule", "cancel_send", "cancel_and_edit", "restore",
]);

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
  onOpenInWindow,
  onExport,
  onPrint,
  onViewSource,
  omit,
  views,
  extras,
  rowPlugins = true,
  extraEntries,
  label,
  rowMenu = false,
}: EmailContextMenuProps) {
  const t = useTranslations("context_menu");
  const tViewer = useTranslations("email_viewer");
  const tRecover = useTranslations("recover_deleted");
  const shortcutOf = useMessageActionShortcut();
  // Offline, a change to a message waits in the outbox only where the account keeps
  // its mail on this device; otherwise it would fail, so it's greyed out. Rules and
  // copies to another account always need the server.
  const { offline, canChangeMail } = useConnectionState();
  const tMenu = useTranslations("menuAudit");
  const archiveActionEnabled = useArchiveActionEnabled();
  const mountainView = useSettingsStore((state) => state.interfaceLayout === "mountain-view");
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

  // Move-to submenu: the message's own account first (#1149), shared with
  // every other Move list (lib/move-menu.ts).
  const movedEmails = useMemo(
    () => (showBatchActions ? batchEmails ?? [] : [email]),
    [showBatchActions, batchEmails, email],
  );
  const moveModel = useMoveMenu(mailboxes, {
    currentMailboxId: selectedMailbox,
    ownerAccountId: resolveMoveOwnerAccountId(email, mailboxes, selectedMailbox),
    emails: movedEmails,
  });
  const canMoveAnywhere = !moveMenuIsEmpty(moveModel);
  const chooseMoveFolder = useChooseMoveFolder();

  // Folders of the other connected accounts a copy can land in.
  const locale = useLocale();
  const copyTrees = useMemo(
    () => (copyTargets ?? [])
      .map((target) => ({
        ...target,
        model: buildMoveMenu(target.mailboxes.filter((m) => !m.isShared), { locale }),
      }))
      .filter((target) => target.model.targetCount > 0),
    [copyTargets, locale],
  );

  const renderMoveList = (onPick?: (mailboxId: string) => void) => (
    <MoveFolderList
      model={moveModel}
      onPick={(mailboxId) => handleAction(() => onPick?.(mailboxId))}
      onChooseFolder={chooseMoveFolder && onPick
        ? () => handleAction(() => chooseMoveFolder({ emails: movedEmails, onMove: onPick }))
        : undefined}
    />
  );
  const renderCopyList = (target: { accountId: string; model: MoveMenuModel }) => (
    <MoveFolderList
      model={target.model}
      noRecent
      testIdPrefix={`copy-to:${target.accountId}:`}
      onPick={(mailboxId) => handleAction(() => onCopyToAccount?.(target.accountId, mailboxId))}
    />
  );

  const handleAction = (action: () => void) => {
    action();
    onClose();
  };

  // In Trash: back to the folder it came from, or its account's Inbox.
  const inTrash = currentMailboxRole === "trash";
  const restoreTo = inTrash && onMoveToMailbox ? restoreTarget(email, mailboxes, selectedMailbox) : undefined;
  const batchRestoreTo = inTrash && onBatchMoveToMailbox && showBatchActions
    ? restoreTargetForAll(batchEmails ?? [], mailboxes, selectedMailbox)
    : undefined;

  // One message: the shared action list (R6), the same the reader's ⋮ and
  // the phone panel show.
  const singleEntries = useMessageActionList({
    email,
    currentMailboxRole,
    canMove: canMoveAnywhere,
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
    onOpenInWindow,
    onExport,
    onPrint,
    onViewSource,
    onRestore: restoreTo ? () => onMoveToMailbox?.(restoreTo) : undefined,
    omit,
    views,
    extras,
  });

  // Stable, so the Rules entry does not re-resolve its account every render.
  const ruleSenderEmails = useMemo(() => ruleEmails ?? [email], [ruleEmails, email]);

  // The row's plugin buttons (message-row-actions). On phones the long press
  // opens this menu, so it is where those buttons live there. Below, the
  // selection's entries in the default layout's order or, under Mountain
  // View, in Gmail's.
  const rowPluginTarget = useRowActionTarget(useMessageActionTarget(email), usePluginRowBadges(email));
  const hasRowPluginActions = usePluginActions("message-row-actions", {
    mailboxRole: currentMailboxRole ?? null,
    accountKind: rowPluginTarget.accountKind,
    keywords: rowPluginTarget.keywords,
    badges: rowPluginTarget.badges,
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
          shortcut={shortcutOf("archive")}
          onClick={() => handleAction(onBatchArchive!)}
          disabled={!onBatchArchive || !canChangeMail}
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
          shortcut={shortcutOf("delete")}
          onClick={() => handleAction(onBatchDelete!)}
          disabled={!onBatchDelete || !canChangeMail}
          destructive={!mountainView}
        />
    </>
  );
  // A selection of read and unread mail gets both; otherwise the one that changes something.
  const selection = batchEmails?.length ? batchEmails : [email];
  const someUnread = selection.some((e) => !e.keywords?.$seen);
  const someRead = selection.some((e) => !!e.keywords?.$seen);
  const readItem = (
    <>
        {someUnread && (
          <ContextMenuItem
            icon={MailOpen}
            label={t("mark_read")}
            testId="ctx-mark-read"
            shortcut={shortcutOf("read", true)}
            disabled={!canChangeMail}
            onClick={() => handleAction(() => onBatchMarkAsRead?.(true))}
          />
        )}
        {someRead && (
          <ContextMenuItem
            icon={Mail}
            label={t("mark_unread")}
            testId="ctx-mark-unread"
            shortcut={shortcutOf("read", false)}
            disabled={!canChangeMail}
            onClick={() => handleAction(() => onBatchMarkAsRead?.(false))}
          />
        )}
    </>
  );
  const batchRestoreItem = batchRestoreTo ? (
    <>
      <ContextMenuItem
        icon={Undo}
        label={tRecover("restore")}
        testId="ctx-restore"
        disabled={!canChangeMail}
        onClick={() => handleAction(() => onBatchMoveToMailbox?.(batchRestoreTo))}
      />
      <ContextMenuSeparator />
    </>
  ) : null;
  const moveItem = (
    <>
        {/* Move to submenu */}
        {canMoveAnywhere && (
          <ContextMenuSubMenu icon={FolderInput} label={t("move_to")} testId="ctx-move-to" disabled={!canChangeMail}>
            {renderMoveList(onBatchMoveToMailbox)}
          </ContextMenuSubMenu>
        )}
        {canRemove && (
          <ContextMenuItem
            icon={FolderX}
            label={t("remove_from_folder")}
            testId="ctx-remove-from-folder"
            disabled={!canChangeMail}
            onClick={() => handleAction(onBatchRemoveFromFolder!)}
          />
        )}
    </>
  );
  const copyTargetsContent = onCopyToAccount
    ? copyTrees.map((target) => (
        <div key={target.accountId}>
          <ContextMenuHeader>{target.label}</ContextMenuHeader>
          {renderCopyList(target)}
        </div>
      ))
    : null;
  const copyItem = (
    <>
        {/* Copy to another connected account, keeping the originals */}
        {onCopyToAccount && copyTrees.length > 0 && (
          <ContextMenuSubMenu icon={Copy} label={t("copy_to_account")} testId="ctx-copy-to" disabled={offline}>
            {copyTargetsContent}
          </ContextMenuSubMenu>
        )}
    </>
  );
  const rulesItem = (
    <>
        {/* Rules: filter rules made from the sender(s), saved as Sieve */}
        <RulesContextSubMenu anchor={email} senderEmails={ruleSenderEmails} onClose={onClose} disabled={offline} />
    </>
  );
  const tagItem = (
    <>
        {/* Set tag submenu - the whole selection's tags (#1077) */}
        {onBatchToggleTag && (
          <ContextMenuSubMenu icon={Tag} label={t("tag")} testId="ctx-tag" disabled={!canChangeMail}>
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
              shortcut={shortcutOf("spam")}
              onClick={() => handleAction(isInJunkFolder ? onBatchUndoSpam! : onBatchMarkAsSpam!)}
              disabled={(isInJunkFolder ? !onBatchUndoSpam : !onBatchMarkAsSpam) || !canChangeMail}
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
          <ContextMenuSubMenu key={entry.key} icon={entry.icon} label={entry.label} testId={entry.testId} disabled={!canChangeMail}>
            {renderMoveList(onMoveToMailbox)}
          </ContextMenuSubMenu>
        );
      case "copy_to_account":
        return (
          <ContextMenuSubMenu key={entry.key} icon={entry.icon} label={entry.label} testId={entry.testId} disabled={offline}>
            {copyTargetsContent}
          </ContextMenuSubMenu>
        );
      case "tag":
        return (
          <ContextMenuSubMenu key={entry.key} icon={entry.icon} label={entry.label} testId={entry.testId} disabled={!canChangeMail}>
            <div className="w-56 max-w-[18rem]">
              <TagPicker selectedIds={currentTagIds} onToggle={(tagId) => onSetTag?.(tagId)} scope={tagScope} />
            </div>
          </ContextMenuSubMenu>
        );
      case "rules":
        return <RulesContextSubMenu key={entry.key} anchor={email} senderEmails={ruleSenderEmails} onClose={onClose} disabled={offline} />;
    }
  };

  const renderEntries = (entries: MessageActionEntry[], keyPrefix = "") => entries.map((entry, index) => {
    if (entry.kind === "separator") return <ContextMenuSeparator key={`${keyPrefix}sep-${index}`} />;
    if (entry.kind === "submenu") return renderSubmenu(entry);
    return (
      <ContextMenuItem
        key={entry.key}
        icon={entry.icon}
        label={entry.label}
        testId={entry.testId}
        disabled={entry.disabled || (!canChangeMail && CHANGES_MAIL.has(entry.key))}
        destructive={entry.destructive}
        shortcut={shortcutOf(entry.key, isUnread)}
        onClick={() => handleAction(entry.run)}
      />
    );
  });
  // A row's menu: the usual few, the rest one level down. Not Spam in Spam
  // and Restore in Trash stay at the top.
  const rowTop = rowMenu
    ? tidySeparators(singleEntries.filter((entry) => entry.kind === "separator" || ROW_MENU_KEYS.has(entry.key)))
    : singleEntries;
  const rowMore = rowMenu
    ? tidySeparators(singleEntries.filter((entry) => entry.kind === "separator" || !ROW_MENU_KEYS.has(entry.key)))
    : [];
  const singleMenu = (
    <>
      {renderEntries(rowTop)}
      {rowMore.length > 0 && (
        <>
          <ContextMenuSeparator />
          <ContextMenuSubMenu icon={MoreHorizontal} label={tViewer("more_actions")} testId="ctx-more">
            {renderEntries(rowMore, "more-")}
          </ContextMenuSubMenu>
        </>
      )}
    </>
  );

  return (
    <ContextMenu
      ref={menuRef}
      isOpen={isOpen}
      position={position}
      onClose={onClose}
      label={label}
    >
      {offline && <ContextMenuHeader>{tMenu("offline_header")}</ContextMenuHeader>}
      {showBatchActions ? (
        <>
          <ContextMenuHeader>
            {t("items_selected", { count: selectedCount })}
          </ContextMenuHeader>

          {!isScheduled && (<>
          {batchRestoreItem}
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
          {extraEntries}
        </>
      )}

      <PluginSlot name="context-menu-email" />
    </ContextMenu>
  );
}
