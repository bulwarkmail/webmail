"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  CheckSquare,
  Folder,
  FolderInput,
  Loader2,
  Mail,
  MailOpen,
  MoreVertical,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Square,
  Tag,
  Trash2,
} from "@/components/icons";
import { useTranslations } from "next-intl";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore, ArchiveMailboxNotFoundError } from "@/stores/email-store";
import { runBatchEmailAction } from "@/lib/email-action-toast";
import { toast } from "@/stores/toast-store";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useMenuNavigation } from "@/hooks/use-menu-navigation";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TagPicker } from "@/components/email/tag-picker";
import { localizeMailboxName } from "@/lib/mailbox-label";
import { buildMoveTargets, resolveMoveOwnerAccountId } from "@/lib/move-targets";
import { getEmailTagIds } from "@/lib/thread-utils";
import { cn, type MailboxNode } from "@/lib/utils";

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
  disabled = false,
}: MvListToolbarProps) {
  const t = useTranslations("email_list");
  const tBatch = useTranslations("email_list.batch_actions");
  const tActions = useTranslations("settings.email_behavior.hover_actions");
  const tFolder = useTranslations("mailbox_context_menu");
  const tMenu = useTranslations("context_menu");
  const tSidebar = useTranslations("sidebar");
  const tCommon = useTranslations("common");
  const tViewer = useTranslations("email_viewer");
  const tNotifications = useTranslations("notifications");
  const tSpam = useTranslations("email_viewer.spam");

  const client = useAuthStore((s) => s.client);
  const {
    emails,
    mailboxes,
    selectedMailbox,
    selectedEmailIds,
    selectAllEmails,
    clearSelection,
    batchArchive,
    batchDelete,
    batchMarkAsRead,
    batchMarkAsSpam,
    batchUndoSpam,
    batchMoveToMailbox,
    batchSetTag,
    isUnifiedView,
    unifiedRole,
  } = useEmailStore();

  const [isProcessing, setIsProcessing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const { menuRef, onKeyDown: onMenuKeyDown } = useMenuNavigation<HTMLDivElement>({
    open: menuOpen,
    onClose: closeMenu,
    triggerRef: menuButtonRef,
  });
  const [moveOpen, setMoveOpen] = useState(false);
  const moveButtonRef = useRef<HTMLButtonElement>(null);
  const closeMove = useCallback(() => setMoveOpen(false), []);
  const { menuRef: moveRef, onKeyDown: onMoveKeyDown } = useMenuNavigation<HTMLDivElement>({
    open: moveOpen,
    onClose: closeMove,
    triggerRef: moveButtonRef,
  });

  const [tagOpen, setTagOpen] = useState(false);
  const tagButtonRef = useRef<HTMLButtonElement>(null);
  const closeTag = useCallback(() => setTagOpen(false), []);
  const { menuRef: tagRef, onKeyDown: onTagKeyDown } = useMenuNavigation<HTMLDivElement>({
    open: tagOpen,
    onClose: closeTag,
    triggerRef: tagButtonRef,
  });

  const { dialogProps: confirmDialogProps, confirm: confirmDialog } = useConfirmDialog();

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (
        menuButtonRef.current?.contains(e.target as Node) ||
        menuRef.current?.contains(e.target as Node)
      ) return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [menuOpen, menuRef]);

  useEffect(() => {
    if (!moveOpen && !tagOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      const inside = (button: HTMLElement | null, menu: HTMLElement | null) =>
        button?.contains(e.target as Node) || menu?.contains(e.target as Node);
      if (!inside(moveButtonRef.current, moveRef.current)) setMoveOpen(false);
      if (!inside(tagButtonRef.current, tagRef.current)) setTagOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [moveOpen, tagOpen, moveRef, tagRef]);

  const selectionCount = selectedEmailIds.size;
  const hasSelection = selectionCount > 0;
  const allSelected = hasSelection && selectionCount === emails.length;
  // Optimistic updates and demo fixtures can briefly leave the server total
  // behind the rows already loaded. Never render an impossible "23 of 22".
  const displayedTotal = Math.max(totalCount ?? loadedCount, loadedCount);

  const currentRole = mailboxes.find((mb) => mb.id === selectedMailbox)?.role
    ?? (isUnifiedView ? (unifiedRole ?? undefined) : undefined);
  const isInJunk = currentRole === "junk";
  const isInTrash = currentRole === "trash";
  // Marking your own drafts or sent mail as spam is meaningless.
  const spamApplicable = !["sent", "drafts", "scheduled"].includes(currentRole ?? "");

  // Every action reports its outcome the way the default toolbar does: a
  // rejected promise or a store error turns into an error toast instead of
  // an unhandled rejection with nothing on screen.
  const run = async (
    action: () => Promise<void>,
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
      setTimeout(() => setIsProcessing(false), 400);
    }
  };

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
      const confirmed = await confirmDialog({
        title: isInTrash ? t("permanent_delete_confirm_title") : tBatch("delete_confirm_title"),
        message: isInTrash
          ? t("permanent_delete_confirm_batch_message", { count: selectionCount })
          : tBatch("delete_confirm_message", { count: selectionCount }),
        confirmText: isInTrash ? t("permanent_delete") : tBatch("delete"),
        variant: "destructive",
      });
      if (!confirmed) return;
      await runBatchEmailAction(() => batchDelete(client, isInTrash), {
        success: tNotifications("emails_deleted", { count: selectionCount }),
        error: tNotifications("error_deleting"),
      });
    });

  const selectedEmails = emails.filter((email) => selectedEmailIds.has(email.id));

  // The same targets the row's own context menu offers, with the account of
  // the selection leading (#1149).
  const { tree: moveTree, targetIds: moveTargetIds } = buildMoveTargets(mailboxes, {
    currentMailboxId: selectedMailbox,
    ownerAccountId: resolveMoveOwnerAccountId(selectedEmails[0], mailboxes, selectedMailbox),
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
              className="w-full flex items-center gap-2 pe-3 py-2 text-start text-sm hover:bg-muted"
            >
              <Folder className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
              <span className="truncate">{label}</span>
            </button>
          ) : (
            <div
              style={{ paddingInlineStart: `${12 + depth * 16}px` }}
              className="flex items-center gap-2 pe-3 py-2 text-sm text-muted-foreground"
            >
              <Folder className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">{label}</span>
            </div>
          )}
          {node.children.length > 0 && renderMoveNodes(node.children, depth + 1)}
        </div>
      );
    });

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
    setMoveOpen(false);
    const count = selectionCount;
    void run(async () => {
      if (client) await batchMoveToMailbox(client, mailboxId);
    }, {
      success: tNotifications("emails_moved", { count }),
      error: tNotifications("move_failed"),
    });
  };

  // A tag the whole selection carries comes off; any other goes onto all of
  // it, as in the default toolbar.
  const handleToggleTag = (tagId: string) => {
    const add = !appliedTags.includes(tagId);
    void run(async () => {
      if (client) await batchSetTag(client, tagId, add);
    });
  };

  const handleSpam = () =>
    run(async () => {
      if (!client) return;
      const ids = Array.from(selectedEmailIds);
      try {
        if (isInJunk) {
          await batchUndoSpam(client, ids);
          toast.success(tSpam("toast_not_spam_batch", { count: ids.length }));
        } else {
          await batchMarkAsSpam(client, ids);
          toast.success(tSpam("toast_batch", { count: ids.length }));
        }
      } catch {
        toast.error(isInJunk ? tSpam("error_not_spam") : tSpam("error"));
      }
    });

  return (
    <div className="flex items-center gap-1 h-12 px-2 shrink-0">
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
        icon={RotateCcw}
        label={tCommon("refresh")}
        onClick={onRefresh}
        disabled={!client || isRefreshing}
        busy={isRefreshing}
      />

      <div className="relative shrink-0">
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
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
        {menuOpen && (
          <div
            ref={menuRef}
            onKeyDown={onMenuKeyDown}
            role="menu"
            className="absolute start-0 top-full mt-1 z-50 min-w-56 rounded-lg border border-border bg-popover py-1 shadow-xl"
          >
            <button
              type="button"
              role="menuitem"
              disabled={!onMarkFolderRead}
              onClick={() => {
                setMenuOpen(false);
                onMarkFolderRead?.();
              }}
              className="w-full px-3 py-2 text-start text-sm hover:bg-muted disabled:opacity-50"
            >
              {tFolder("mark_folder_read")}
            </button>
            {onMarkAllFoldersRead && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onMarkAllFoldersRead();
                }}
                className="w-full px-3 py-2 text-start text-sm hover:bg-muted"
              >
                {tFolder("mark_all_folders_read")}
              </button>
            )}
            {/* Offered only where emptying a folder is the usual thing to
                do: spam and the bin. */}
            {onEmptyFolder && (isInJunk || isInTrash) && (
              <>
                <div className="my-1 h-px bg-border" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onEmptyFolder();
                  }}
                  className="w-full px-3 py-2 text-start text-sm text-destructive hover:bg-muted"
                >
                  {tFolder("empty_folder")}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {hasSelection && !disabled && (
        <>
          <div className="w-px h-6 bg-border mx-1 shrink-0" />
          <ToolbarButton
            icon={Archive}
            label={tActions("archive")}
            onClick={() => run(async () => { if (client) await batchArchive(client); }, {
              success: tNotifications("emails_archived", { count: selectionCount }),
              error: tNotifications("error_archiving"),
              describeError: (error) => error instanceof ArchiveMailboxNotFoundError
                ? tViewer("archive_mailbox_not_found")
                : undefined,
            })}
            disabled={isProcessing}
            busy={isProcessing}
          />
          {spamApplicable && (
            <ToolbarButton
              icon={isInJunk ? ShieldCheck : ShieldAlert}
              label={isInJunk ? tActions("not_spam") : tActions("spam")}
              onClick={handleSpam}
              disabled={isProcessing}
            />
          )}
          <ToolbarButton
            icon={Trash2}
            label={tBatch("delete")}
            onClick={handleDelete}
            disabled={isProcessing}
            className="hover:text-red-600 dark:hover:text-red-400"
          />
          <div className="w-px h-6 bg-border mx-1 shrink-0" />
          {moveTree.length > 0 && (
            <div className="relative shrink-0">
              <button
                ref={moveButtonRef}
                type="button"
                onClick={() => { setTagOpen(false); setMoveOpen((v) => !v); }}
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
              {moveOpen && (
                <div
                  ref={moveRef}
                  onKeyDown={onMoveKeyDown}
                  role="menu"
                  aria-label={tMenu("move_to")}
                  className="absolute start-0 top-full mt-1 z-50 min-w-64 max-h-80 overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-xl"
                >
                  {renderMoveNodes(moveTree)}
                </div>
              )}
            </div>
          )}
          <div className="relative shrink-0">
            <button
              ref={tagButtonRef}
              type="button"
              onClick={() => { setMoveOpen(false); setTagOpen((v) => !v); }}
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
            {tagOpen && (
              <div
                ref={tagRef}
                onKeyDown={onTagKeyDown}
                role="menu"
                aria-label={tMenu("tag")}
                className="absolute start-0 top-full mt-1 z-50 min-w-64 rounded-lg border border-border bg-popover py-1 shadow-xl"
              >
                <TagPicker selectedIds={appliedTags} partialIds={partialTags} onToggle={handleToggleTag} />
              </div>
            )}
          </div>
          <div className="w-px h-6 bg-border mx-1 shrink-0" />
          <ToolbarButton
            icon={MailOpen}
            label={tBatch("mark_read")}
            onClick={() => run(async () => { if (client) await batchMarkAsRead(client, true); })}
            disabled={isProcessing}
          />
          <ToolbarButton
            icon={Mail}
            label={tBatch("mark_unread")}
            onClick={() => run(async () => { if (client) await batchMarkAsRead(client, false); })}
            disabled={isProcessing}
          />
          <span className="ms-2 text-sm text-muted-foreground truncate">
            {tBatch("selected_messages", { count: selectionCount })}
          </span>
        </>
      )}

      <div className="flex-1 min-w-0" />

      {loadedCount > 0 && (
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
