"use client";

import { Email, ThreadGroup } from "@/lib/jmap/types";
import { ThreadListItem } from "./thread-list-item";
import { EmailContextMenu } from "./email-context-menu";
import { cn } from "@/lib/utils";
import { Trash2, Mail, MailX, MailOpen, Loader2, SearchX, AlertTriangle } from "lucide-react";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useEmailStore } from "@/stores/email-store";
import { useAuthStore } from "@/stores/auth-store";
import { useSettingsStore } from "@/stores/settings-store";
import { groupEmailsByThread, sortThreadGroups } from "@/lib/thread-utils";
import { useContextMenu } from "@/hooks/use-context-menu";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useTranslations } from "next-intl";
import { useVirtualizer } from "@tanstack/react-virtual";
import { SearchChips } from "@/components/search/search-chips";
import { isFilterEmpty, DEFAULT_SEARCH_FILTERS } from "@/lib/jmap/search-utils";

interface EmailListProps {
  emails: Email[];
  selectedEmailId?: string;
  onEmailSelect?: (email: Email) => void;
  className?: string;
  isLoading?: boolean;
  onOpenConversation?: (thread: ThreadGroup) => void;
  onReply?: (email: Email) => void;
  onReplyAll?: (email: Email) => void;
  onForward?: (email: Email) => void;
  onMarkAsRead?: (email: Email, read: boolean) => void;
  onToggleStar?: (email: Email) => void;
  onDelete?: (email: Email) => void;
  onArchive?: (email: Email) => void;
  onSetColorTag?: (emailId: string, color: string | null) => void;
  onMoveToMailbox?: (emailId: string, mailboxId: string) => void;
  onMarkAsSpam?: (email: Email) => void;
  onUndoSpam?: (email: Email) => void;
  onEditDraft?: (email: Email) => void;
}

export function EmailList({
  emails,
  selectedEmailId,
  onEmailSelect,
  className,
  isLoading = false,
  onOpenConversation,
  onReply,
  onReplyAll,
  onForward,
  onMarkAsRead,
  onToggleStar,
  onDelete,
  onArchive,
  onSetColorTag,
  onMarkAsSpam,
  onUndoSpam,
  onMoveToMailbox,
  onEditDraft,
}: EmailListProps) {
  const t = useTranslations('email_list');
  const { client } = useAuthStore();
  const {
    selectedEmailIds,
    selectAllEmails: _selectAllEmails,
    clearSelection,
    batchMarkAsRead,
    batchDelete,
    batchMoveToMailbox,
    batchArchive,
    batchMarkAsSpam,
    batchUndoSpam,
    loadMoreEmails,
    hasMoreEmails,
    isLoadingMore,
    mailboxes,
    selectedMailbox,
    emptyMailbox,
    expandedThreadIds,
    threadEmailsCache,
    isLoadingThread,
    toggleThreadExpansion,
    fetchThreadEmails,
    searchFilters,
    setSearchFilters,
    clearSearchFilters,
    advancedSearch,
    searchQuery,
  } = useEmailStore();

  const disableThreading = useSettingsStore((state) => state.disableThreading);

  const threadGroups = useMemo(() => {
    const groups = groupEmailsByThread(emails, disableThreading);
    return sortThreadGroups(groups);
  }, [emails, disableThreading]);

  const { contextMenu, openContextMenu, closeContextMenu, menuRef } = useContextMenu<Email>();
  const { dialogProps: confirmDialogProps, confirm: confirmDialog } = useConfirmDialog();

  const [isProcessing, setIsProcessing] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);
  const density = useSettingsStore((state) => state.density);
  const showPreview = useSettingsStore((state) => state.showPreview);
  const mailLayout = useSettingsStore((state) => state.mailLayout);
  const isFocusedMailLayout = mailLayout === 'focus';

  const estimateSize = useCallback(() => {
    if (isFocusedMailLayout) {
      return { 'extra-compact': 32, compact: 40, regular: 46, comfortable: 54 }[density];
    }
    const base = { 'extra-compact': 32, compact: 60, regular: 84, comfortable: 104 }[density];
    return (showPreview && density !== 'extra-compact') ? base + 36 : base;
  }, [density, isFocusedMailLayout, showPreview]);

  const virtualizer = useVirtualizer({
    count: threadGroups.length,
    getScrollElement: () => parentRef.current,
    estimateSize,
    overscan: 5,
    getItemKey: (index) => threadGroups[index]?.threadId ?? String(index),
  });

  const LoadingSkeleton = () => (
    <div className="animate-in fade-in duration-200">
      {[...Array(8)].map((_, i) => (
        <div key={i} className="border-b border-border px-4 py-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 bg-muted/50 rounded-full" />
            <div className="flex-1">
              <div className="flex items-center justify-between mb-2">
                <div className="h-4 bg-muted/50 rounded w-32" />
                <div className="h-3 bg-muted/50 rounded w-16" />
              </div>
              <div className="h-4 bg-muted/50 rounded w-3/4 mb-2" />
              <div className="h-3 bg-muted/50 rounded w-full" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  const hasSelection = selectedEmailIds.size > 0;

  const handleBatchMarkAsRead = async (read: boolean) => {
    if (!client || isProcessing) return;
    setIsProcessing(true);
    try {
      await batchMarkAsRead(client, read);
    } finally {
      setTimeout(() => setIsProcessing(false), 500);
    }
  };

  const handleBatchDelete = async () => {
    if (!client || isProcessing) return;

    const currentMailbox = mailboxes.find(m => m.id === selectedMailbox);
    const isInTrash = currentMailbox?.role === 'trash';

    const confirmed = await confirmDialog({
      title: isInTrash
        ? t('permanent_delete_confirm_title')
        : t('batch_actions.delete_confirm_title'),
      message: isInTrash
        ? t('permanent_delete_confirm_batch_message', { count: selectedEmailIds.size })
        : t('batch_actions.delete_confirm_message', { count: selectedEmailIds.size }),
      confirmText: isInTrash
        ? t('permanent_delete')
        : t('batch_actions.delete'),
      variant: "destructive",
    });
    if (!confirmed) return;

    setIsProcessing(true);
    try {
      await batchDelete(client, isInTrash);
      const storeError = useEmailStore.getState().error;
      if (storeError) {
        const { toast } = await import('sonner');
        toast.error(storeError);
      }
    } catch (err) {
      const { toast } = await import('sonner');
      toast.error(err instanceof Error ? err.message : 'Failed to delete emails');
    } finally {
      setTimeout(() => setIsProcessing(false), 500);
    }
  };

  const currentMailbox = mailboxes.find(m => m.id === selectedMailbox);
  const isEmptyableFolder = currentMailbox?.role === 'trash' || currentMailbox?.role === 'junk';

  const handleEmptyFolder = async () => {
    if (!client || isProcessing || !currentMailbox) return;

    const confirmed = await confirmDialog({
      title: t('empty_folder.confirm_title'),
      message: t('empty_folder.confirm_message'),
      confirmText: t('empty_folder.confirm_button'),
      variant: "destructive",
    });
    if (!confirmed) return;

    setIsProcessing(true);
    try {
      await emptyMailbox(client, currentMailbox.id);
    } finally {
      setTimeout(() => setIsProcessing(false), 500);
    }
  };

  const handleLoadMore = useCallback(() => {
    if (client && hasMoreEmails && !isLoadingMore && !isLoading) {
      loadMoreEmails(client);
    }
  }, [client, hasMoreEmails, isLoadingMore, isLoading, loadMoreEmails]);

  const handleToggleThreadExpansion = useCallback(async (threadId: string) => {
    const isExpanded = expandedThreadIds.has(threadId);

    if (!isExpanded && client) {
      toggleThreadExpansion(threadId);
      await fetchThreadEmails(client, threadId);
    } else {
      toggleThreadExpansion(threadId);
    }
  }, [client, expandedThreadIds, toggleThreadExpansion, fetchThreadEmails]);

  // Range-based load more: trigger when last visible item is near the end.
  // Debounce to prevent rapid cascade when thread grouping reduces item
  // count below the viewport size (e.g. 2400 emails → fewer thread groups).
  const virtualItems = virtualizer.getVirtualItems();
  const lastVirtualItemIndex = virtualItems[virtualItems.length - 1]?.index;
  const loadMoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (lastVirtualItemIndex === undefined) return;
    if (lastVirtualItemIndex >= threadGroups.length - 5) {
      // Clear any pending timer so we don't stack calls
      if (loadMoreTimerRef.current) clearTimeout(loadMoreTimerRef.current);
      loadMoreTimerRef.current = setTimeout(() => {
        handleLoadMore();
        loadMoreTimerRef.current = null;
      }, 150);
    }
    return () => {
      if (loadMoreTimerRef.current) clearTimeout(loadMoreTimerRef.current);
    };
  }, [lastVirtualItemIndex, threadGroups.length, handleLoadMore]);

  // Scroll to the thread group containing the selected email
  useEffect(() => {
    if (!selectedEmailId) return;
    const index = threadGroups.findIndex(thread =>
      thread.latestEmail.id === selectedEmailId ||
      thread.emails.some(e => e.id === selectedEmailId)
    );
    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: 'auto' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmailId]);

  // Re-measure all items when density or preview settings change
  useEffect(() => {
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [density, isFocusedMailLayout, showPreview]);

  return (
    <div className={cn("flex flex-col min-h-0", className)}>
      {/* Batch Actions Toolbar */}
      <div
        className={cn(
          "transition-all duration-300 ease-in-out overflow-hidden",
          hasSelection ? "max-h-16 opacity-100" : "max-h-0 opacity-0"
        )}
      >
        <div className="px-4 py-2 border-b bg-accent/30 border-border flex items-center justify-between">
          <div className="flex items-center gap-2 animate-in fade-in slide-in-from-left-3 duration-300">
            <span className="text-sm font-medium text-foreground">
              {t('batch_actions.selected_messages', { count: selectedEmailIds.size })}
            </span>
          </div>
          <div className="flex items-center gap-1 animate-in fade-in slide-in-from-right-3 duration-300">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleBatchMarkAsRead(true)}
              title={t('batch_actions.mark_read')}
              disabled={isProcessing}
              className="hover:bg-accent transition-colors disabled:opacity-50"
            >
              {isProcessing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <MailOpen className="w-4 h-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleBatchMarkAsRead(false)}
              title={t('batch_actions.mark_unread')}
              disabled={isProcessing}
              className="hover:bg-accent transition-colors disabled:opacity-50"
            >
              {isProcessing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Mail className="w-4 h-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleBatchDelete}
              title={t('batch_actions.delete')}
              disabled={isProcessing}
              className="text-red-600 dark:text-red-400 hover:bg-red-100/50 dark:hover:bg-red-950/30 transition-colors disabled:opacity-50"
            >
              {isProcessing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
            </Button>
            <div className="w-px h-6 bg-border mx-1" />
            <Button
              variant="ghost"
              size="sm"
              onClick={clearSelection}
              title={t('batch_actions.clear_selection')}
              disabled={isProcessing}
              className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              {t('batch_actions.clear_selection')}
            </Button>
          </div>
        </div>
      </div>

      {/* Advanced Search Filter Chips */}
      {!isFilterEmpty(searchFilters) && (
        <SearchChips
          filters={searchFilters}
          onRemoveFilter={(key) => {
            const resetValue = DEFAULT_SEARCH_FILTERS[key];
            setSearchFilters({ [key]: resetValue });
            if (client) advancedSearch(client);
          }}
          onClearAll={() => {
            clearSearchFilters();
            if (client) advancedSearch(client);
          }}
        />
      )}

      {/* Empty Folder Banner for Junk/Trash */}
      {isEmptyableFolder && emails.length > 0 && !hasSelection && (
        <div className="px-4 py-2 border-b border-border bg-muted/30 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="w-4 h-4" />
            <span>{currentMailbox?.role === 'junk' ? t('empty_folder.junk_hint') : t('empty_folder.trash_hint')}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleEmptyFolder}
            disabled={isProcessing}
            className="text-destructive border-destructive/30 hover:bg-destructive/10 text-xs"
          >
            {isProcessing ? (
              <Loader2 className="w-3 h-3 animate-spin mr-1" />
            ) : (
              <Trash2 className="w-3 h-3 mr-1" />
            )}
            {t('empty_folder.button')}
          </Button>
        </div>
      )}

      {/* Email List */}
      <div ref={parentRef} className="flex-1 overflow-y-auto bg-background relative" data-tour="email-list">
        {/* Loading overlay */}
        {isLoading && emails.length > 0 && (
          <div className="absolute inset-0 bg-background/50 z-10 flex items-center justify-center animate-in fade-in duration-150">
            <div className="flex items-center gap-2 text-sm text-muted-foreground bg-background/90 px-4 py-2 rounded-full shadow-sm border border-border">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>{t('loading')}</span>
            </div>
          </div>
        )}

        {isLoading && emails.length === 0 ? (
          <LoadingSkeleton />
        ) : emails.length === 0 && !isLoading ? (
          <div className="flex flex-col items-center justify-center h-full py-12">
            <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-muted shadow-lg flex items-center justify-center">
              {searchQuery || !isFilterEmpty(searchFilters) ? (
                <SearchX className="w-10 h-10 text-muted-foreground" />
              ) : (
                <MailX className="w-10 h-10 text-muted-foreground" />
              )}
            </div>
            <p className="text-base font-medium text-foreground">
              {searchQuery || !isFilterEmpty(searchFilters) ? t('no_search_results') : t('no_emails')}
            </p>
            <p className="text-sm mt-1 text-muted-foreground">
              {searchQuery || !isFilterEmpty(searchFilters) ? t('no_search_results_description') : t('no_emails_description')}
            </p>
          </div>
        ) : (
          <>
            <div
              className={cn("transition-opacity duration-200", isLoading && "opacity-50")}
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((virtualItem) => {
                const thread = threadGroups[virtualItem.index];
                return (
                  <div
                    key={virtualItem.key}
                    data-index={virtualItem.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualItem.start}px)`,
                    }}
                  >
                    <ThreadListItem
                      thread={thread}
                      isExpanded={expandedThreadIds.has(thread.threadId)}
                      selectedEmailId={selectedEmailId}
                      isLoading={isLoadingThread === thread.threadId}
                      expandedEmails={threadEmailsCache.get(thread.threadId)}
                      onToggleExpand={() => handleToggleThreadExpansion(thread.threadId)}
                      onEmailSelect={(email) => onEmailSelect?.(email)}
                      onContextMenu={openContextMenu}
                      onOpenConversation={onOpenConversation}
                      onToggleStar={onToggleStar ? (email) => onToggleStar(email) : undefined}
                      onMarkAsRead={onMarkAsRead ? (email, read) => onMarkAsRead(email, read) : undefined}
                      onDelete={onDelete ? (email) => onDelete(email) : undefined}
                      onArchive={onArchive ? (email) => onArchive(email) : undefined}
                      onSetColorTag={onSetColorTag}
                      onMarkAsSpam={onMarkAsSpam ? (email) => onMarkAsSpam(email) : undefined}
                    />
                  </div>
                );
              })}
            </div>

            <div className="py-4 flex justify-center">
              {isLoadingMore && hasMoreEmails && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{t('loading_more')}</span>
                </div>
              )}
              {!hasMoreEmails && emails.length > 0 && (
                <div className="text-sm text-muted-foreground border-t border-border pt-6">
                  {t('no_more_emails')}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu.data && (
        <EmailContextMenu
          email={contextMenu.data}
          position={contextMenu.position}
          isOpen={contextMenu.isOpen}
          onClose={closeContextMenu}
          menuRef={menuRef}
          mailboxes={mailboxes}
          selectedMailbox={selectedMailbox}
          currentMailboxRole={mailboxes.find(m => m.id === selectedMailbox)?.role}
          isMultiSelect={selectedEmailIds.has(contextMenu.data.id)}
          selectedCount={selectedEmailIds.size}
          onReply={() => onReply?.(contextMenu.data!)}
          onReplyAll={() => onReplyAll?.(contextMenu.data!)}
          onForward={() => onForward?.(contextMenu.data!)}
          onMarkAsRead={(read) => onMarkAsRead?.(contextMenu.data!, read)}
          onToggleStar={() => onToggleStar?.(contextMenu.data!)}
          onDelete={() => onDelete?.(contextMenu.data!)}
          onArchive={() => onArchive?.(contextMenu.data!)}
          onSetColorTag={(color) => onSetColorTag?.(contextMenu.data!.id, color)}
          onMoveToMailbox={(mailboxId) => onMoveToMailbox?.(contextMenu.data!.id, mailboxId)}
          onMarkAsSpam={() => onMarkAsSpam?.(contextMenu.data!)}
          onUndoSpam={() => onUndoSpam?.(contextMenu.data!)}
          onEditDraft={() => onEditDraft?.(contextMenu.data!)}
          onBatchMarkAsRead={(read) => client && batchMarkAsRead(client, read)}
          onBatchDelete={() => client && batchDelete(client)}
          onBatchArchive={async () => {
            if (!client) return;
            try {
              await batchArchive(client);
            } catch (error) {
              console.error('Failed to batch archive:', error);
            }
          }}
          onBatchMoveToMailbox={(mailboxId) => client && batchMoveToMailbox(client, mailboxId)}
          onBatchMarkAsSpam={async () => {
            if (client) {
              const emailIds = Array.from(selectedEmailIds);
              try {
                await batchMarkAsSpam(client, emailIds);
                const { toast } = await import('sonner');
                toast.success(
                  t('../email_viewer.spam.toast_batch', { count: emailIds.length })
                );
              } catch {
                const { toast } = await import('sonner');
                toast.error(t('../email_viewer.spam.error'));
              }
            }
          }}
          onBatchUndoSpam={async () => {
            if (client) {
              const emailIds = Array.from(selectedEmailIds);
              try {
                await batchUndoSpam(client, emailIds);
                const { toast } = await import('sonner');
                toast.success(
                  t('../email_viewer.spam.toast_not_spam_batch', { count: emailIds.length })
                );
              } catch {
                const { toast } = await import('sonner');
                toast.error(t('../email_viewer.spam.error_not_spam'));
              }
            }
          }}
        />
      )}

      <ConfirmDialog {...confirmDialogProps} />
    </div>
  );
}
