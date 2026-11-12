"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useEmailStore, removalFolder, canRemoveFromFolder } from "@/stores/email-store";
import { archiveInboxTarget } from "@/lib/archive-inbox";
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
  MoreHorizontal,
} from "@/components/icons";
import { rowMenuSections, useMessageActionList, useSelectionActionList, type MessageActionEntry, type MessageActionKey } from "./message-actions";
import { restoreTarget, restoreTargetForAll } from "@/lib/trash-origin";
import { resolveMoveOwnerAccountId } from "@/lib/move-targets";
import { buildMoveMenu, type MoveMenuModel } from "@/lib/move-menu";
import { MoveFolderList, moveMenuIsEmpty, useMoveMenu } from "./move-target-list";
import { useChooseMoveFolder } from "./move-to-dialog";
import { useMessageActionShortcut } from "./message-action-shortcuts";
import { useConnectionState } from "@/hooks/use-connection-state";
import { getEmailTagIds } from "@/lib/thread-utils";
import { TagPicker } from "./tag-picker";
import { RulesContextList, RulesContextSubMenu } from "./rules-menu";

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
  /** The folders Move offers: those of the login the message (or the selection) is in (moveFoldersFor). */
  mailboxes: Mailbox[];
  /** Whose folders `mailboxes` are, when not the active login's: shown above them (moveFoldersFor's `owner`). */
  moveHeading?: string;
  /** Why Move is not offered, where those folders can't be had: Move shows, unavailable, with it. */
  moveUnavailableHint?: string;
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
  /** In Archive: what takes Archive's place, when the host knows better than the browsed folder (a message window). */
  onMoveToInbox?: () => void;
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
  /** Stars the whole selection, or takes the star off every message. */
  onBatchSetStarred?: (starred: boolean) => void;
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
  /**
   * "more": only what a selection's menu has under "More actions", for the
   * selection view's More actions button.
   */
  section?: "all" | "more" | "rules";
}

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
  moveHeading,
  moveUnavailableHint,
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
  onMoveToInbox,
  onSetTag,
  onMoveToMailbox,
  onRemoveFromFolder,
  onMarkAsSpam,
  onUndoSpam,
  onBatchMarkAsRead,
  onBatchSetStarred,
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
  section = "all",
}: EmailContextMenuProps) {
  const t = useTranslations("context_menu");
  const tViewer = useTranslations("email_viewer");
  const shortcutOf = useMessageActionShortcut();
  // Offline, a change to a message waits in the outbox only where the account keeps
  // its mail on this device; otherwise it would fail, so it's greyed out. Rules and
  // copies to another account always need the server.
  const { offline, canChangeMail } = useConnectionState();
  const tMenu = useTranslations("menuAudit");
  const isUnread = !email.keywords?.$seen;
  const currentTagIds = getEmailTagIds(email.keywords);
  // The row's account names its tags; a selection uses batchTagScope.
  const tagScope = useEmailTagScope(email);
  const showBatchActions = isMultiSelect && selectedCount > 1;
  const isScheduled = email.isScheduled === true;
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
    heading: moveHeading,
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
  // In Archive: back to the Inbox in Archive's place (mail-p3-4).
  const inboxTo = onMoveToMailbox ? archiveInboxTarget(mailboxes, selectedMailbox) : undefined;

  // One message: the shared action list (R6), the same the reader's ⋮ and
  // the phone panel show.
  const singleEntries = useMessageActionList({
    email,
    currentMailboxRole,
    canMove: canMoveAnywhere,
    moveUnavailableHint,
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
    onMoveToInbox: onMoveToInbox ?? (inboxTo ? () => onMoveToMailbox?.(inboxTo.id) : undefined),
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

  // Copy to another connected account, keeping the originals.
  const copyTargetsContent = onCopyToAccount
    ? copyTrees.map((target) => (
        <div key={target.accountId}>
          <ContextMenuHeader>{target.label}</ContextMenuHeader>
          {renderCopyList(target)}
        </div>
      ))
    : null;

  // A selection: the same structure as a row's menu, without what needs one
  // message (useSelectionActionList), shared with the reading pane's selection view.
  const selectionLists = useSelectionActionList({
    emails: showBatchActions ? (batchEmails?.length ? batchEmails : [email]) : [],
    currentMailboxRole,
    canMove: canMoveAnywhere,
    moveUnavailableHint,
    canRemoveFromFolder: canRemove,
    canCopyToAccount: !!onCopyToAccount && copyTrees.length > 0,
    canTag: !!onBatchToggleTag,
    onRestore: batchRestoreTo ? () => onBatchMoveToMailbox?.(batchRestoreTo) : undefined,
    onArchive: onBatchArchive,
    onDelete: onBatchDelete,
    onMarkAsRead: onBatchMarkAsRead,
    onSetStarred: onBatchSetStarred,
    onMarkAsSpam: onBatchMarkAsSpam,
    onUndoSpam: onBatchUndoSpam,
    onForwardAsAttachment: onBatchForwardAsAttachment,
    onRemoveFromFolder: onBatchRemoveFromFolder,
  });

  const renderSubmenu = (entry: Extract<MessageActionEntry, { kind: "submenu" }>, batch: boolean) => {
    switch (entry.key) {
      case "move":
        return (
          <ContextMenuSubMenu key={entry.key} icon={entry.icon} label={entry.label} testId={entry.testId} disabled={!canChangeMail || entry.disabled} hint={entry.hint}>
            {!entry.disabled && renderMoveList(batch ? onBatchMoveToMailbox : onMoveToMailbox)}
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
              {batch ? (
                <TagPicker
                  selectedIds={batchTagIds ?? []}
                  partialIds={batchPartialTagIds}
                  onToggle={(tagId) => onBatchToggleTag?.(tagId)}
                  scope={batchTagScope}
                />
              ) : (
                <TagPicker selectedIds={currentTagIds} onToggle={(tagId) => onSetTag?.(tagId)} scope={tagScope} />
              )}
            </div>
          </ContextMenuSubMenu>
        );
      case "rules":
        return <RulesContextSubMenu key={entry.key} anchor={email} senderEmails={ruleSenderEmails} onClose={onClose} disabled={offline} />;
    }
  };

  const renderEntries = (entries: MessageActionEntry[], keyPrefix = "", batch = false) => entries.map((entry, index) => {
    if (entry.kind === "separator") return <ContextMenuSeparator key={`${keyPrefix}sep-${index}`} />;
    if (entry.kind === "submenu") return renderSubmenu(entry, batch);
    // Mark as read shows Shift+I, Mark as unread U.
    const unread = entry.key === "read" ? entry.testId === "ctx-mark-read" : isUnread;
    return (
      <ContextMenuItem
        key={`${keyPrefix}${entry.key}-${entry.testId ?? index}`}
        icon={entry.icon}
        label={entry.label}
        testId={entry.testId}
        disabled={entry.disabled || (!canChangeMail && CHANGES_MAIL.has(entry.key))}
        destructive={entry.destructive}
        // S stars the open message only, not a selection.
        shortcut={batch && entry.key === "star" ? undefined : shortcutOf(entry.key, unread)}
        onClick={() => handleAction(entry.run)}
      />
    );
  });

  // Plugins' entries: under "More actions" in a row's or a selection's menu,
  // at the end of the reader's ⋮ (which is that "more" already).
  const pluginEntries = (
    <>
      {!showBatchActions && rowPlugins && rowPluginBlock}
      <PluginSlot name="context-menu-email" />
    </>
  );
  const moreMenu = (entries: MessageActionEntry[], batch: boolean) => (
    <>
      <ContextMenuSeparator />
      <ContextMenuSubMenu icon={MoreHorizontal} label={tViewer("more_actions")} testId="ctx-more">
        {renderEntries(entries, "more-", batch)}
        {pluginEntries}
      </ContextMenuSubMenu>
    </>
  );

  let body: React.ReactNode;
  if (showBatchActions) {
    body = isScheduled ? null : section === "rules" ? (
      <RulesContextList anchor={email} senderEmails={ruleSenderEmails} onClose={onClose} />
    ) : section === "more" ? (
      <>
        {renderEntries(selectionLists.more, "more-", true)}
        {pluginEntries}
      </>
    ) : (
      <>
        <ContextMenuHeader>{t("items_selected", { count: selectedCount })}</ContextMenuHeader>
        {renderEntries(selectionLists.top, "", true)}
        {moreMenu(selectionLists.more, true)}
      </>
    );
  } else if (rowMenu) {
    // A row's menu: the usual few, the rest one level down.
    const { top, more } = rowMenuSections(singleEntries);
    body = (
      <>
        {renderEntries(top)}
        {moreMenu(more, false)}
        {extraEntries}
      </>
    );
  } else {
    body = (
      <>
        {renderEntries(singleEntries)}
        {rowPlugins && rowPluginBlock}
        {extraEntries}
        <PluginSlot name="context-menu-email" />
      </>
    );
  }

  return (
    <ContextMenu
      ref={menuRef}
      isOpen={isOpen}
      position={position}
      onClose={onClose}
      label={label ?? (section === "more" ? tViewer("more_actions") : section === "rules" ? t("rules.title") : undefined)}
    >
      {offline && <ContextMenuHeader>{tMenu("offline_header")}</ContextMenuHeader>}
      {body}
    </ContextMenu>
  );
}
