"use client";

import { useEffect, useState } from "react";
import {
  Archive,
  CheckSquare,
  Folder,
  FolderInput,
  FolderX,
  Loader2,
  Mail,
  MailOpen,
  MoreVertical,
  Search,
  ShieldAlert,
  ShieldCheck,
  Square,
  Tag,
  Trash2,
  RefreshCw,
  Fish,
} from "@/components/icons";
import { usePhishingReport } from "@/hooks/use-phishing-report";
import { useTranslations } from "next-intl";
import { useAuthStore } from "@/stores/auth-store";
import { useShallow } from "zustand/react/shallow";
import { useEmailStore, ArchiveMailboxNotFoundError, resolveSelectedEmails, bulkDeleteIsPermanent, shouldConfirmBulkDelete, removalFolder, canRemoveFromFolder, restoreBatchesForSelection , type CrossAccountMoveReceipt } from "@/stores/email-store";
import { useRemoveFromFolder } from "@/hooks/use-remove-from-folder";
import { confirmMailRemoval } from "@/lib/mail-removal-confirm";
import { markSelectionReadWithUndo, runBatchEmailAction, setSelectionTagWithUndo, toastWithUndo, undoLabels, undoMoveAction } from "@/lib/email-action-toast";
import { toast } from "@/stores/toast-store";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useContextMenu } from "@/hooks/use-context-menu";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator, ContextMenuHeader, CONTEXT_MENU_ITEM_CLASS } from "@/components/ui/context-menu";
import { useArchiveActionEnabled } from "@/lib/archive-gate";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TagPicker } from "@/components/email/tag-picker";
import { localizeMailboxName } from "@/lib/mailbox-label";
import { buildMoveTargets, resolveMoveOwnerAccountId } from "@/lib/move-targets";
import { getEmailTagIds } from "@/lib/thread-utils";
import { cn, type MailboxNode } from "@/lib/utils";
import { PluginActions } from "@/components/plugins/plugin-actions";
import { useUnreadFirstSection } from "@/hooks/use-unread-first-section";
import { useTimeoutWhileMounted } from "@/hooks/use-timeout-while-mounted";
import { commonTagScope } from "@/hooks/use-account-tags";

interface MvListToolbarProps {
  /** Loaded conversation count, for the right-hand range readout. */
  loadedCount: number;
  /** Total in the folder, when the server has told us. */
  totalCount?: number;
  onRefresh: () => void;
  isRefreshing?: boolean;
  onMarkFolderRead?: () => void;
  onMarkAllFoldersRead?: () => void;
  /** Only offered where emptying is the usual thing to do: spam and the bin. */
  onEmptyFolder?: () => void;
  /** Opens the new-folder dialog from the bottom of the Move to menu. */
  onCreateFolder?: () => void;
  /** Scheduled view: only the per-message scheduling actions make sense. */
  disabled?: boolean;
}

function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  busy,
  className,
}: {
  icon: typeof Archive;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "grid place-items-center w-10 h-10 rounded-full transition-colors shrink-0",
        "text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
        disabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
        className
      )}
    >
      {busy ? <Loader2 className="w-[18px] h-[18px] animate-spin" /> : <Icon className="w-[18px] h-[18px]" />}
    </button>
  );
}

/**
 * Mountain View's single list toolbar: one row above the list that morphs.
 * With nothing selected it offers select-all, refresh and an overflow menu;
 * as soon as a conversation is ticked the batch verbs appear in the same row,
 * rather than in a second bar that pushes the list down.
 */
export function MvListToolbar({
  loadedCount,
  totalCount,
  onRefresh,
  isRefreshing = false,
  onMarkFolderRead,
  onMarkAllFoldersRead,
  onEmptyFolder,
  onCreateFolder,
  disabled = false,
}: MvListToolbarProps) {
  const t = useTranslations("email_list");
  const tBatch = useTranslations("email_list.batch_actions");
  const archiveActionEnabled = useArchiveActionEnabled();
  const tFolder = useTranslations("mailbox_context_menu");
  const tMenu = useTranslations("context_menu");
  const tSidebar = useTranslations("sidebar");
  const tCommon = useTranslations("common");
  const tViewer = useTranslations("email_viewer");
  const tNotifications = useTranslations("notifications");
  const tSpam = useTranslations("email_viewer.spam");
  const undo = undoLabels(tNotifications);
  const tRemove = useTranslations("email_list.confirm_remove");

  const client = useAuthStore((s) => s.client);
  const {
    emails,
    mailboxes,
    selectedMailbox,
    selectedEmailKeys,
    selectAllEmails,
    clearSelection,
    batchArchive,
    batchDelete,
    batchMarkAsSpam,
    batchUndoSpam,
    batchMoveToMailbox,
    isUnifiedView,
    unifiedRole,
    queryTotal,
  } = useEmailStore(useShallow((state) => ({
    emails: state.emails,
    mailboxes: state.mailboxes,
    selectedMailbox: state.selectedMailbox,
    selectedEmailKeys: state.selectedEmailKeys,
    // Read at render by resolveSelectedEmails (Move menu owner account).
    threadEmailsCache: state.threadEmailsCache,
    selectAllEmails: state.selectAllEmails,
    clearSelection: state.clearSelection,
    batchArchive: state.batchArchive,
    batchDelete: state.batchDelete,
    batchMarkAsSpam: state.batchMarkAsSpam,
    batchUndoSpam: state.batchUndoSpam,
    batchMoveToMailbox: state.batchMoveToMailbox,
    isUnifiedView: state.isUnifiedView,
    unifiedRole: state.unifiedRole,
    queryTotal: state.totalEmails,
  })));

  const [isProcessing, setIsProcessing] = useState(false);
  const later = useTimeoutWhileMounted();
  // The ⋮, Move to and Tag menus are the ContextMenu, as every menu (R6).
  const overflowMenu = useContextMenu<null>();
  const menuOpen = overflowMenu.contextMenu.isOpen;
  const closeMenu = overflowMenu.closeContextMenu;
  const moveMenu = useContextMenu<null>();
  const moveOpen = moveMenu.contextMenu.isOpen;
  const closeMove = moveMenu.closeContextMenu;
  // Gmail's "Move to" menu opens on a search field that narrows the folders.
  const [moveQuery, setMoveQuery] = useState("");
  useEffect(() => { if (!moveOpen) setMoveQuery(""); }, [moveOpen]);
  const tagMenu = useContextMenu<null>();
  const tagOpen = tagMenu.contextMenu.isOpen;
  const closeTag = tagMenu.closeContextMenu;
  /** A trigger's press while its menu is open closes it, instead of reading as a click outside. */
  const toggleFrom = (menu: typeof overflowMenu) => ({
    onMouseDown: (e: React.MouseEvent) => { if (menu.contextMenu.isOpen) e.stopPropagation(); },
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      if (menu.contextMenu.isOpen) menu.closeContextMenu();
      else menu.openContextMenuFrom(e.currentTarget, null, "start");
    },
  });

  const { dialogProps: confirmDialogProps, confirm: confirmDialog } = useConfirmDialog();

  const selectionCount = selectedEmailKeys.size;
  const hasSelection = selectionCount > 0;
  const allSelected = hasSelection && selectionCount === emails.length;
  // Optimistic updates and demo fixtures can briefly leave the server total
  // behind the rows already loaded. Never render an impossible "23 of 22".
  // A unified or cross-account view is no single folder, so it has no folder
  // count: its total is what the accounts' queries reported (#1471).
  const knownTotal = totalCount ?? (isUnifiedView ? queryTotal : undefined);
  const displayedTotal = Math.max(knownTotal ?? loadedCount, loadedCount);
  // The "Unread first" inbox gives each section its own readout instead.
  const sectioned = !!useUnreadFirstSection();

  const currentRole = mailboxes.find((mb) => mb.id === selectedMailbox)?.role
    ?? (isUnifiedView ? (unifiedRole ?? undefined) : undefined);
  const isInJunk = currentRole === "junk";
  const isInTrash = currentRole === "trash";
  // Marking your own drafts or sent mail as spam is meaningless.
  const spamApplicable = !["sent", "drafts", "scheduled"].includes(currentRole ?? "");
  // Report phishing for the selection, one report per message (enterprise pack).
  const selectionForPhishing = useEmailStore(useShallow((state) => resolveSelectedEmails(state)));
  const phishing = usePhishingReport(selectionForPhishing, currentRole);
  const tPhishing = useTranslations("phishing_report");

  // Every action reports its outcome the way the default toolbar does: a
  // rejected promise or a store error turns into an error toast instead of
  // an unhandled rejection with nothing on screen.
  const run = async (
    action: () => Promise<boolean | void>,
    messages?: Parameters<typeof runBatchEmailAction>[1],
  ) => {
    if (!client || isProcessing) return;
    setIsProcessing(true);
    try {
      if (messages) {
        await runBatchEmailAction(action, messages);
      } else {
        try {
          await action();
        } catch (error) {
          console.error("Mountain View toolbar action failed:", error);
          toast.error(tNotifications("error_updating"));
        }
      }
    } finally {
      later(() => setIsProcessing(false), 400);
    }
  };

  // With a toast that offers Undo (and Ctrl+Z), as in the default toolbar.
  const markSelectionRead = (activeClient: NonNullable<typeof client>, read: boolean) =>
    markSelectionReadWithUndo(activeClient, read, {
      success: tNotifications(read ? "emails_marked_read" : "emails_marked_unread", { count: selectionCount }),
      error: tNotifications("error_updating"),
      labels: undo,
    });

  const handleSelectAllToggle = () => {
    if (disabled) return;
    if (hasSelection) {
      if (allSelected) clearSelection();
      else selectAllEmails();
      return;
    }
    if (emails.length > 0) selectAllEmails();
  };

  const handleDelete = () =>
    run(async () => {
      if (!client) return;
      const target = { role: currentRole };
      const permanent = bulkDeleteIsPermanent(target);
      if (shouldConfirmBulkDelete(target)) {
        const confirmed = await confirmDialog({
          title: permanent ? t("permanent_delete_confirm_batch_title") : tBatch("delete_confirm_title"),
          message: permanent
            ? t("permanent_delete_confirm_batch_message", { count: selectionCount })
            : tBatch("delete_confirm_message", { count: selectionCount }),
          confirmText: permanent ? t("permanent_delete") : tBatch("delete"),
          variant: "destructive",
        });
        if (!confirmed) return;
      } else if (!(await confirmMailRemoval("delete", selectionCount, confirmDialog, tRemove))) {
        return;
      }
      const restore = permanent ? null : restoreBatchesForSelection(client);
      await runBatchEmailAction(() => batchDelete(client, permanent), {
        success: tNotifications("emails_deleted", { count: selectionCount }),
        error: tNotifications("error_deleting"),
        undo: undoMoveAction(client, restore, undo),
      });
    });

  const selectedEmails = resolveSelectedEmails(useEmailStore.getState());
  // "Remove from this folder" (#615), when every selected message is also in
  // another folder.
  const removeFromFolder = useRemoveFromFolder();
  const folderToLeave = useEmailStore(removalFolder);
  const selectionCanLeaveFolder = selectedEmails.length > 0
    && selectedEmails.every((email) => canRemoveFromFolder(email, folderToLeave));

  // The same targets the row's own context menu offers, with the account of
  // the selection leading (#1149).
  const { tree: moveTree, targetIds: moveTargetIds } = buildMoveTargets(mailboxes, {
    currentMailboxId: selectedMailbox,
    ownerAccountId: resolveMoveOwnerAccountId(selectedEmails[0], mailboxes, selectedMailbox),
    emails: selectedEmails,
  });

  const renderMoveNodes = (nodes: MailboxNode[], depth = 0): React.ReactNode =>
    nodes.map((node) => {
      const label = localizeMailboxName(node.role, node.name, (key) => tSidebar(`mailboxes.${key}`));
      const isTarget = moveTargetIds.has(node.id);
      return (
        <div key={node.id}>
          {isTarget ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => handleMove(node.id)}
              style={{ paddingInlineStart: `${12 + depth * 16}px` }}
              className={CONTEXT_MENU_ITEM_CLASS}
            >
              <Folder className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          ) : (
            <div
              style={{ paddingInlineStart: `${12 + depth * 16}px` }}
              className="flex items-center gap-2 pe-3 py-1.5 text-sm text-muted-foreground"
            >
              <Folder className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">{label}</span>
            </div>
          )}
          {node.children.length > 0 && renderMoveNodes(node.children, depth + 1)}
        </div>
      );
    });

  // While a search narrows the move menu it is a flat list of the matches.
  const moveMatches = (() => {
    const q = moveQuery.trim().toLowerCase();
    if (!q) return null;
    const out: MailboxNode[] = [];
    const walk = (nodes: MailboxNode[]) => {
      for (const node of nodes) {
        const label = localizeMailboxName(node.role, node.name, (key) => tSidebar(`mailboxes.${key}`));
        if (moveTargetIds.has(node.id) && label.toLowerCase().includes(q)) out.push({ ...node, children: [] });
        walk(node.children);
      }
    };
    walk(moveTree);
    return out;
  })();

  // What the tag picker shows: a tag every selected message carries is
  // checked, one only some of them carry is drawn as partial.
  const tagCounts = new Map<string, number>();
  for (const email of selectedEmails) {
    for (const tagId of getEmailTagIds(email.keywords)) tagCounts.set(tagId, (tagCounts.get(tagId) ?? 0) + 1);
  }
  const appliedTags: string[] = [];
  const partialTags: string[] = [];
  for (const [tagId, count] of tagCounts) (count === selectedEmails.length ? appliedTags : partialTags).push(tagId);

  const handleMove = (mailboxId: string) => {
    closeMove();
    const count = selectionCount;
    const restore = client ? restoreBatchesForSelection(client) : null;
    // What a mixed-account list moves to another account moves back that way.
    const receipts: CrossAccountMoveReceipt[] = [];
    void run(async () => (client ? batchMoveToMailbox(client, mailboxId, undefined, receipts) : false), {
      success: tNotifications("emails_moved", { count }),
      error: tNotifications("move_failed"),
      undo: undoMoveAction(client, restore, undo, receipts),
    });
  };

  // A tag the whole selection carries comes off; any other goes onto all of
  // it, as in the default toolbar.
  const handleToggleTag = (tagId: string) => {
    const add = !appliedTags.includes(tagId);
    void run(async () => {
      if (client) {
        await setSelectionTagWithUndo(client, tagId, add, {
          describe: (count) => tNotifications(add ? "emails_tagged" : "tag_removed_count", { count }),
          labels: undo,
        });
      }
    });
  };

  const handleSpam = () =>
    run(async () => {
      if (!client) return;
      const ids = resolveSelectedEmails(useEmailStore.getState()).map((email) => email.id);
      const restore = restoreBatchesForSelection(client);
      try {
        if (isInJunk) {
          if (await batchUndoSpam(client, ids)) toastWithUndo(tSpam("toast_not_spam_batch", { count: ids.length }), undoMoveAction(client, restore, undo));
        } else {
          if (await batchMarkAsSpam(client, ids)) toastWithUndo(tSpam("toast_batch", { count: ids.length }), undoMoveAction(client, restore, undo));
        }
      } catch {
        toast.error(isInJunk ? tSpam("error_not_spam") : tSpam("error"));
      }
    });

  return (
    // 5px in, so select-all's box sits over the rows' boxes: a row draws its
    // 18px box 16px in (12px row padding + 4px), centred at 25px (#1473).
    <div className="flex items-center gap-1 h-12 ps-[5px] pe-2 shrink-0">
      <button
        type="button"
        role="checkbox"
        aria-checked={allSelected ? true : hasSelection ? "mixed" : false}
        onClick={handleSelectAllToggle}
        disabled={disabled}
        title={
          hasSelection
            ? allSelected
              ? tBatch("clear_selection")
              : tBatch("select_all")
            : tBatch("select")
        }
        className={cn(
          "grid place-items-center w-10 h-10 rounded-full transition-colors shrink-0",
          "text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
          hasSelection && "text-primary",
          disabled && "opacity-50 cursor-not-allowed hover:bg-transparent"
        )}
      >
        {hasSelection ? (
          <CheckSquare className="w-[18px] h-[18px]" />
        ) : (
          <Square className="w-[18px] h-[18px]" />
        )}
      </button>

      <ToolbarButton
        icon={RefreshCw}
        label={tCommon("refresh")}
        onClick={onRefresh}
        disabled={!client || isRefreshing}
        busy={isRefreshing}
      />

      <div className="relative shrink-0">
        <button
          type="button"
          {...toggleFrom(overflowMenu)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={tViewer("more_actions")}
          aria-label={tViewer("more_actions")}
          className={cn(
            "grid place-items-center w-10 h-10 rounded-full transition-colors",
            menuOpen
              ? "bg-foreground/10 text-foreground"
              : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          )}
        >
          <MoreVertical className="w-[18px] h-[18px]" />
        </button>
        <ContextMenu ref={overflowMenu.menuRef} isOpen={menuOpen} position={overflowMenu.contextMenu.position} onClose={closeMenu}>
          <div className="min-w-56" data-mv-overflow-menu="">
            <ContextMenuItem
              icon={MailOpen}
              label={tFolder("mark_folder_read")}
              disabled={!onMarkFolderRead}
              onClick={() => {
                closeMenu();
                onMarkFolderRead?.();
              }}
            />
            {onMarkAllFoldersRead && (
              <ContextMenuItem
                icon={MailOpen}
                label={tFolder("mark_all_folders_read")}
                onClick={() => {
                  closeMenu();
                  onMarkAllFoldersRead();
                }}
              />
            )}
            {/* Offered only where emptying a folder is the usual thing to
                do: spam and the bin. */}
            {onEmptyFolder && (isInJunk || isInTrash) && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  icon={FolderX}
                  label={tFolder("empty_folder")}
                  destructive
                  onClick={() => {
                    closeMenu();
                    onEmptyFolder();
                  }}
                />
              </>
            )}
          </div>
        </ContextMenu>
      </div>

      {hasSelection && !disabled && (
        <>
          <div className="w-px h-6 bg-border mx-1 shrink-0" />
          {archiveActionEnabled && (
            <ToolbarButton
              icon={Archive}
              label={tMenu("archive")}
              onClick={() => run(async () => (
                client && await confirmMailRemoval("archive", selectionCount, confirmDialog, tRemove)
                  ? batchArchive(client)
                  : false
              ), {
                success: tNotifications("emails_archived", { count: selectionCount }),
                error: tNotifications("error_archiving"),
                describeError: (error) => error instanceof ArchiveMailboxNotFoundError
                  ? tViewer("archive_mailbox_not_found")
                  : undefined,
                undo: undoMoveAction(client, client ? restoreBatchesForSelection(client) : null, undo),
              })}
              disabled={isProcessing}
              busy={isProcessing}
            />
          )}
          {spamApplicable && (
            <ToolbarButton
              icon={isInJunk ? ShieldCheck : ShieldAlert}
              label={isInJunk ? tMenu("not_spam") : tMenu("mark_as_spam")}
              onClick={handleSpam}
              disabled={isProcessing}
            />
          )}
          {phishing.available && (
            <ToolbarButton
              icon={Fish}
              label={tPhishing("action")}
              onClick={phishing.report}
              disabled={isProcessing}
            />
          )}
          {selectionCanLeaveFolder && (
            <ToolbarButton
              icon={FolderX}
              label={tMenu("remove_from_folder")}
              onClick={() => run(() => removeFromFolder(resolveSelectedEmails(useEmailStore.getState())))}
              disabled={isProcessing}
            />
          )}
          <ToolbarButton
            icon={Trash2}
            label={tBatch("delete")}
            onClick={handleDelete}
            disabled={isProcessing}
            className="hover:text-destructive"
          />
          {/* Gmail's order: what to do with it, how it reads, where it goes. */}
          <div className="w-px h-6 bg-border mx-1 shrink-0" />
          <ToolbarButton
            icon={MailOpen}
            label={tBatch("mark_read")}
            onClick={() => run(async () => { if (client) await markSelectionRead(client, true); })}
            disabled={isProcessing}
          />
          <ToolbarButton
            icon={Mail}
            label={tBatch("mark_unread")}
            onClick={() => run(async () => { if (client) await markSelectionRead(client, false); })}
            disabled={isProcessing}
          />
          <div className="w-px h-6 bg-border mx-1 shrink-0" />
          {moveTree.length > 0 && (
            <div className="relative shrink-0">
              <button
                type="button"
                {...toggleFrom(moveMenu)}
                aria-haspopup="menu"
                aria-expanded={moveOpen}
                title={tMenu("move_to")}
                aria-label={tMenu("move_to")}
                className={cn(
                  "grid place-items-center w-10 h-10 rounded-full transition-colors",
                  moveOpen
                    ? "bg-foreground/10 text-foreground"
                    : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                )}
              >
                <FolderInput className="w-[18px] h-[18px]" />
              </button>
              <ContextMenu ref={moveMenu.menuRef} isOpen={moveOpen} position={moveMenu.contextMenu.position} onClose={closeMove}>
                <div className="min-w-64" data-mv-move-menu="">
                  <ContextMenuHeader>{tMenu("move_to")}</ContextMenuHeader>
                  <label className="mx-3 my-1 flex items-center gap-2 border-b border-border">
                    <input
                      value={moveQuery}
                      onChange={(e) => setMoveQuery(e.target.value)}
                      className="h-8 min-w-0 flex-1 bg-transparent text-sm focus:outline-none"
                      aria-label={tMenu("move_to")}
                    />
                    <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </label>
                  <div className="max-h-72 overflow-y-auto">
                    {moveMatches ? renderMoveNodes(moveMatches) : renderMoveNodes(moveTree)}
                  </div>
                  {onCreateFolder && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        label={tSidebar("create_label")}
                        onClick={() => { closeMove(); onCreateFolder(); }}
                      />
                    </>
                  )}
                </div>
              </ContextMenu>
            </div>
          )}
          <div className="relative shrink-0">
            <button
              type="button"
              {...toggleFrom(tagMenu)}
              aria-haspopup="menu"
              aria-expanded={tagOpen}
              title={tMenu("tag")}
              aria-label={tMenu("tag")}
              className={cn(
                "grid place-items-center w-10 h-10 rounded-full transition-colors",
                tagOpen
                  ? "bg-foreground/10 text-foreground"
                  : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              )}
            >
              <Tag className="w-[18px] h-[18px]" />
            </button>
            <ContextMenu ref={tagMenu.menuRef} isOpen={tagOpen} position={tagMenu.contextMenu.position} onClose={closeTag}>
              <div className="w-64">
                <TagPicker selectedIds={appliedTags} partialIds={partialTags} onToggle={handleToggleTag} scope={commonTagScope(selectedEmails)} />
              </div>
            </ContextMenu>
          </div>
          <PluginActions
            surface="message-bulk-actions"
            context={{ emailIds: selectedEmails.map((email) => email.id) }}
            mailboxRole={currentRole ?? null}
            compact
            className="shrink-0"
          />
          <span className="ms-2 text-sm text-muted-foreground truncate">
            {tBatch("selected_messages", { count: selectionCount })}
          </span>
        </>
      )}

      <div className="flex-1 min-w-0" />

      {loadedCount > 0 && !sectioned && (
        <span className="text-xs text-muted-foreground tabular-nums pe-2 shrink-0">
          {/* The range readout. The list grows as it scrolls rather than
              paging, so there are no previous/next arrows to go with it. */}
          {t("conversations_range", { from: 1, to: loadedCount, total: displayedTotal })}
        </span>
      )}

      <ConfirmDialog {...confirmDialogProps} />
    </div>
  );
}
