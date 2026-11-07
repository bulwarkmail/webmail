"use client";

import { spamApplicableIn } from "@/lib/spam-applicable";
import { Email, ThreadGroup } from "@/lib/jmap/types";
import { MemoizedThreadListItem, type ListFolder } from "./thread-list-item";
import { useRowSlots } from "./list-row-slots";
import { ListColumnsHeader } from "./list-columns";
import { useListboxFocus } from "./list-a11y";
import { useStableHandlers } from "@/hooks/use-stable-handlers";
import type { Attachment } from "@/lib/jmap/types";
import type { LoadListAttachments } from "@/lib/list-attachments";
import { listRowShowsChips } from "./attachment-chips";
import { listVerificationCode } from "@/lib/verification-code";
import { EmailContextMenu } from "./email-context-menu";
import { SelectionView } from "./selection-view";
import { restoreTargetForAll } from "@/lib/trash-origin";
import { useSelectionActionList } from "./message-actions";
import { useMessageActionShortcut } from "./message-action-shortcuts";
import { ViewSourceDialog } from "./view-source-dialog";
import { useCopyToAccount, useEmailExport, requestPrint } from "@/hooks/use-message-file-actions";
import { BatchTagButton } from "./batch-tag-button";
import { cn, cleanPreview } from "@/lib/utils";
import { Trash2, Mail, MailX, MailOpen, Loader2, SearchX, AlertTriangle, CalendarClock, ShieldCheck, ShieldAlert, Archive, MoreVertical, X, FolderX, Fish, FolderInput } from "@/components/icons";
import { createPortal } from "react-dom";
import { ContextMenu } from "@/components/ui/context-menu";
import { MoveFolderList, moveMenuIsEmpty, useMoveMenu } from "./move-target-list";
import { useChooseMoveFolder } from "./move-to-dialog";
import { resolveMoveOwnerAccountId } from "@/lib/move-targets";
import { getMailboxPath } from "@/lib/utils";
import { emptyFolderLabelKey, emptyFolderPrompt } from "@/lib/empty-folder-text";
import { usePluginSlotOffers } from "@/hooks/use-plugin-slot-offers";
import { useAccountStore } from "@/stores/account-store";
import { usePhishingReport } from "@/hooks/use-phishing-report";
import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { batchToastTitle, selectionRowCount } from "@/lib/selection-toast";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { useArchiveActionEnabled } from "@/lib/archive-gate";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useEmailStore, resolveEmailBlobContext, ArchiveMailboxNotFoundError, resolveSelectedEmails, bulkDeleteIsPermanent, shouldConfirmBulkDelete, removalFolder, canRemoveFromFolder, restoreBatchesForSelection, type ListRow , type CrossAccountMoveReceipt } from "@/stores/email-store";
import { useRemoveFromFolder } from "@/hooks/use-remove-from-folder";
import { useShallow } from "zustand/react/shallow";
import { useAuthStore } from "@/stores/auth-store";
import { useOpenEmailInWindow } from "@/hooks/use-popouts-available";
import { useIsDesktop } from "@/hooks/use-media-query";
import { useIsEmbedded } from "@/hooks/use-is-embedded";
import { useSettingsStore } from "@/stores/settings-store";
import { useListRowShape } from "@/hooks/use-list-row-shape";
import { MailListRowsSkeleton, type MailRowShape } from "@/components/boot-skeleton/mail-skeleton";
import type { Density } from "@/lib/density";
import { useUIStore } from "@/stores/ui-store";
import { useMessageListTabsStore } from "@/stores/message-list-tabs-store";
import { emailKeyFor, groupEmailsByThread, sortThreadGroups, threadKeyFor, getEmailTagIds } from "@/lib/thread-utils";
import { useContextMenu } from "@/hooks/use-context-menu";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useTranslations } from "next-intl";
import { RowTranslatorsProvider } from "./row-translators";
import { localizeMailboxName } from "@/lib/mailbox-label";
import { toast } from "@/stores/toast-store";
import { confirmMailRemoval } from "@/lib/mail-removal-confirm";
import { markSelectionReadWithUndo, runBatchEmailAction, setSelectionStarredWithUndo, setSelectionTagWithUndo, toastWithUndo, undoLabels, undoMoveAction } from "@/lib/email-action-toast";
import { useVirtualizer } from "@tanstack/react-virtual";
import { measureVisibleRow } from "@/lib/virtual-row-measure";
import { TagDisplayContext, useMeasuredTagDisplay } from "@/hooks/use-tag-display";
import { SearchChips } from "@/components/search/search-chips";
import { isFilterEmpty, DEFAULT_SEARCH_FILTERS } from "@/lib/jmap/search-utils";
import { getRuleAccountAddresses, resolveQuickRuleTarget } from "@/lib/filters/quick-rule-target";
import { emitThreadExpand } from "@/lib/plugin-thread-expand";
import { normalizeAddress } from "@/lib/filters/quick-rules";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import { PluginListFilters, useFolderListFiltered } from "./plugin-list-filters";
import { PluginActions, useFolderAccountKind } from "@/components/plugins/plugin-actions";
import { useUnreadFirstSection } from "@/hooks/use-unread-first-section";
import { useTimeoutWhileMounted } from "@/hooks/use-timeout-while-mounted";
import { unreadSectionRowCount } from "@/lib/unread-first";
import type { OpenableEmail } from "@/lib/plugin-sandbox/open-email";
import { MvListSectionHeader } from "./mv-list-section-header";
import { PluginSearchResults } from "./plugin-search-results";
import { commonTagScope } from "@/hooks/use-account-tags";
import { FolderRetentionLine } from "./retention-notice";
import { canExport, canPrint } from "@/lib/device-policy";

interface EmailListProps {
  emails: Email[];
  /** emailKeyFor of the open message: ids repeat across accounts. */
  selectedEmailKey?: string;
  onEmailSelect?: (email: Email) => void;
  /** Opens a message a plugin's search result names (PluginSearchResults). */
  onOpenSearchResult?: (email: OpenableEmail) => void;
  /** A mouse was pressed on a row: the click that follows will open it. */
  onEmailPrefetch?: (email: Email) => void;
  onEmailDoubleClick?: (email: Email) => void;
  /** Mountain View: search for the mail a sender has sent, from the row menu. */
  onFindFromSender?: (sender: { name: string; email: string }) => void;
  className?: string;
  isLoading?: boolean;
  hasMore?: boolean;
  isLoadingMoreItems?: boolean;
  onOpenConversation?: (thread: ThreadGroup) => void;
  /**
   * The reading pane shows the whole conversation: a row opens its newest
   * message there instead of unfolding the thread in the list.
   */
  conversationInReader?: boolean;
  onReply?: (email: Email) => void;
  onReplyAll?: (email: Email) => void;
  onForward?: (email: Email) => void;
  onForwardAsAttachment?: (email: Email) => void;
  onBatchForwardAsAttachment?: () => void;
  /** The empty search state's "Clear search". */
  onClearSearch?: () => void;
  /** The empty Drafts folder's "Compose". */
  onCompose?: () => void;
  onMarkAsRead?: (email: Email, read: boolean) => void;
  onToggleStar?: (email: Email) => void;
  onTogglePinned?: (email: Email) => void;
  onDelete?: (email: Email) => void;
  onArchive?: (email: Email) => void;
  /** `emailKey` (emailKeyFor of the row) tells namesakes in other accounts apart. */
  onSetTag?: (emailId: string, tagId: string | null, emailKey?: string) => void;
  onMoveToMailbox?: (emailId: string, mailboxId: string, emailKey?: string) => void;
  onMarkAsSpam?: (email: Email) => void;
  onUndoSpam?: (email: Email) => void;
  onOpenAttachment?: (email: Email, attachment: Attachment) => void;
  loadAttachments?: LoadListAttachments;
  onEditDraft?: (email: Email) => void;
  isScheduledView?: boolean;
  onLoadMoreScheduled?: () => void;
  onCancelScheduledForEdit?: (email: Email) => void | Promise<void>;
  /** Stop a scheduled message from going out; it goes back to Drafts. */
  onCancelScheduledSend?: (email: Email) => void | Promise<void>;
  onRescheduleScheduled?: (email: Email) => void | Promise<void>;
  /**
   * Mountain View folds the batch verbs into the single toolbar above the
   * list, so the separate bar that would otherwise slide in here is redundant.
   */
  hideBatchToolbar?: boolean;
  /**
   * The empty reading pane's slot for the selection: the list draws the
   * selection's count and buttons there too (mail-10).
   */
  selectionPaneHost?: HTMLElement | null;
}

/**
 * What the virtual list draws: a row, or in the "Unread first" inbox a
 * section's header and the line an empty Unread section shows.
 */
type ListItem =
  | { kind: 'row'; thread: ThreadGroup }
  | { kind: 'header'; section: 'unread' | 'rest' }
  | { kind: 'unread-empty' };

/** The most messages "Select all N conversations" loads to tick them (mail-p2-11). */
const SELECT_ALL_LIMIT = 5000;

/** Below this width the batch toolbar drops its labels (see batchNarrow). */
const BATCH_TOOLBAR_WIDE = 640;

/** Rows drawn beyond each edge of the screen, so scrolling never shows a gap. */
const LIST_OVERSCAN = 5;
/** The same for the list's first draw, which waits for every row it draws. */
const FIRST_DRAW_OVERSCAN = 1;

// Declared out here so re-renders of the list keep the same element. Inside
// EmailList every render made a new component, which remounted the skeleton
// each time the store changed while a list loaded.
function LoadingSkeleton({ shape, density, preview }: { shape: MailRowShape; density: Density; preview: boolean }) {
  // The page skeleton's rows (components/boot-skeleton), so the list the app
  // draws while it loads is the one the server painted before it started.
  return <MailListRowsSkeleton shape={shape} density={density} preview={preview} className="contents" />;
}

/** Rows per page in simple mode's paged list. */
const LIST_PAGE_SIZE = 50;

export function EmailList({
  emails,
  selectedEmailKey,
  onEmailSelect,
  onOpenSearchResult,
  onEmailPrefetch,
  onEmailDoubleClick,
  onFindFromSender,
  className,
  isLoading = false,
  hasMore,
  isLoadingMoreItems,
  onOpenConversation,
  conversationInReader = false,
  onReply,
  onReplyAll,
  onForward,
  onForwardAsAttachment,
  onBatchForwardAsAttachment,
  onClearSearch,
  onCompose,
  onMarkAsRead,
  onToggleStar,
  onTogglePinned,
  onDelete,
  onArchive,
  onSetTag,
  onMarkAsSpam,
  onUndoSpam,
  onOpenAttachment,
  loadAttachments,
  onMoveToMailbox,
  onEditDraft,
  isScheduledView = false,
  hideBatchToolbar = false,
  onLoadMoreScheduled,
  onCancelScheduledForEdit,
  onCancelScheduledSend,
  onRescheduleScheduled,
  selectionPaneHost = null,
}: EmailListProps) {
  const t = useTranslations('email_list');
  const tContextMenu = useTranslations('context_menu');
  const openInWindow = useOpenEmailInWindow();
  const tSpam = useTranslations('email_viewer.spam');
  const tNotifications = useTranslations('notifications');
  const tSelection = useTranslations('selectionView');
  const tViewer = useTranslations('email_viewer');
  const tSidebar = useTranslations('sidebar');
  const tListExtra = useTranslations('mail_list_extra');
  const tRoot = useTranslations();
  const tUnread = useTranslations('account_unread');
  const mountainViewList = useSettingsStore((state) => state.interfaceLayout === 'mountain-view');
  const isDesktopPane = useIsDesktop();
  const isEmbeddedList = useIsEmbedded();
  const undo = undoLabels(tNotifications);
  const tRemove = useTranslations('email_list.confirm_remove');
  const { client } = useAuthStore(useShallow((state) => ({ client: state.client })));
  const {
    selectedEmailKeys,
    selectAllEmails: _selectAllEmails,
    clearSelection,
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
    autoMarkExpandedThreadAsRead,
    collapseAllThreads,
    threadEmailCounts,
    searchFilters,
    setSearchFilters,
    clearSearchFilters,
    advancedSearch,
    searchQuery,
    isUnifiedView,
    unifiedRole,
  } = useEmailStore(useShallow((state) => ({
    selectedEmailKeys: state.selectedEmailKeys,
    selectAllEmails: state.selectAllEmails,
    clearSelection: state.clearSelection,
    batchDelete: state.batchDelete,
    batchMoveToMailbox: state.batchMoveToMailbox,
    batchArchive: state.batchArchive,
    batchMarkAsSpam: state.batchMarkAsSpam,
    batchUndoSpam: state.batchUndoSpam,
    loadMoreEmails: state.loadMoreEmails,
    hasMoreEmails: state.hasMoreEmails,
    isLoadingMore: state.isLoadingMore,
    mailboxes: state.mailboxes,
    selectedMailbox: state.selectedMailbox,
    emptyMailbox: state.emptyMailbox,
    expandedThreadIds: state.expandedThreadIds,
    threadEmailsCache: state.threadEmailsCache,
    isLoadingThread: state.isLoadingThread,
    toggleThreadExpansion: state.toggleThreadExpansion,
    fetchThreadEmails: state.fetchThreadEmails,
    autoMarkExpandedThreadAsRead: state.autoMarkExpandedThreadAsRead,
    collapseAllThreads: state.collapseAllThreads,
    threadEmailCounts: state.threadEmailCounts,
    searchFilters: state.searchFilters,
    setSearchFilters: state.setSearchFilters,
    clearSearchFilters: state.clearSearchFilters,
    advancedSearch: state.advancedSearch,
    searchQuery: state.searchQuery,
    isUnifiedView: state.isUnifiedView,
    unifiedRole: state.unifiedRole,
  })));

  // In aggregate role-views (e.g. "All Junk") the selected mailbox is virtual, so
  // there is no concrete mailbox to read the role from. Fall back to the unified
  // role so contextual actions (e.g. mark-as-spam ↔ not-spam) behave as if inside
  // that role's folder.
  const effectiveMailboxRole =
    mailboxes.find(m => m.id === selectedMailbox)?.role
    ?? (isUnifiedView ? (unifiedRole ?? undefined) : undefined);
  // Spam is pointless on your own outgoing mail, as in the context menu.
  const spamApplicable = spamApplicableIn(effectiveMailboxRole);

  // The folder the rows on screen were fetched for, taken when the rows
  // change. A click on another folder changes the selection at once while
  // the old rows stay until the new ones come: with the selected folder the
  // rows re-rendered then, in the click's own render pass, and drew their
  // senders as the new folder's recipients (or the other way round).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- taken with the rows, on purpose
  const rowsView = useMemo(() => ({ mailboxId: selectedMailbox, isUnifiedView, unifiedRole }), [emails]);
  const rowsRole = mailboxes.find((m) => m.id === rowsView.mailboxId)?.role
    ?? (rowsView.isUnifiedView ? (rowsView.unifiedRole ?? undefined) : undefined);
  const listFolder = useMemo<ListFolder>(() => ({ mailboxId: rowsView.mailboxId, role: rowsRole }), [rowsView, rowsRole]);

  const disableThreading = useSettingsStore((state) => state.disableThreading);
  // The order the current folder view was fetched in (#718), so thread
  // grouping mirrors the server order instead of re-sorting the page by date.
  // Search results and cross-account views are always chronological.
  const fetchedListOrder = useEmailStore((state) => state.listOrder);
  const keepServerTextOrder = useEmailStore((state) => state.listKeepsServerTextOrder);
  const crossView = useEmailStore((state) => state.crossView);
  // The row opened last stays where it was clicked while that order would
  // move it (e.g. read in "unread first").
  const listHold = useEmailStore((state) => state.listHold);
  const viewingAccountId = useEmailStore((state) => state.viewingAccountId);
  const selectedKeyword = useEmailStore((state) => state.selectedKeyword);
  const selectedKeywordAccountId = useEmailStore((state) => state.selectedKeywordAccountId);
  const searchMailboxId = useEmailStore((state) => state.searchMailboxId);
  const activeAccountId = useAuthStore((state) => state.activeAccountId);
  const activeTabId = useMessageListTabsStore((state) => state.activeTabId);

  const allThreadGroups = useMemo(() => {
    const listOrder = searchQuery || crossView || !isFilterEmpty(searchFilters) ? [] : fetchedListOrder;
    const groups = groupEmailsByThread(emails, disableThreading || isScheduledView, threadEmailCounts);
    return sortThreadGroups(groups, listOrder, { keepServerTextOrder, held: listHold?.keywords });
  }, [emails, disableThreading, isScheduledView, threadEmailCounts, fetchedListOrder, keepServerTextOrder, searchQuery, crossView, searchFilters, listHold]);

  // Mountain View's "Unread first" inbox: the Unread section's conversations
  // go first, under a header each section has, and a folded section's rows
  // leave the list. A conversation with a message in the section is the
  // section's.
  const unreadSection = useUnreadFirstSection();
  const unreadCollapsed = useSettingsStore((state) => state.mvUnreadSectionCollapsed);
  const restCollapsed = useSettingsStore((state) => state.mvEverythingElseCollapsed);
  const updateSetting = useSettingsStore((state) => state.updateSetting);
  const sections = useMemo(() => {
    if (!unreadSection) return null;
    const unread: ThreadGroup[] = [];
    const rest: ThreadGroup[] = [];
    for (const group of allThreadGroups) {
      (group.emails.some((email) => unreadSection.ids.has(email.id)) ? unread : rest).push(group);
    }
    return { unread, rest };
  }, [allThreadGroups, unreadSection]);
  const threadGroups = useMemo(() => (
    sections
      ? [...(unreadCollapsed ? [] : sections.unread), ...(restCollapsed ? [] : sections.rest)]
      : allThreadGroups
  ), [sections, unreadCollapsed, restCollapsed, allThreadGroups]);
  const { items, itemOfThread } = useMemo(() => {
    const items: ListItem[] = [];
    const itemOfThread: number[] = [];
    const addRows = (groups: ThreadGroup[]) => {
      for (const thread of groups) {
        itemOfThread.push(items.length);
        items.push({ kind: 'row', thread });
      }
    };
    if (!sections) {
      addRows(threadGroups);
      return { items, itemOfThread };
    }
    items.push({ kind: 'header', section: 'unread' });
    if (!unreadCollapsed) {
      if (sections.unread.length === 0) items.push({ kind: 'unread-empty' });
      addRows(sections.unread);
    }
    items.push({ kind: 'header', section: 'rest' });
    if (!restCollapsed) addRows(sections.rest);
    return { items, itemOfThread };
  }, [sections, threadGroups, unreadCollapsed, restCollapsed]);
  const sectionRowCount = useMemo(() => unreadSectionRowCount(emails, unreadSection), [emails, unreadSection]);
  const totalEmails = useEmailStore((state) => state.totalEmails);

  const { contextMenu, openContextMenu, openContextMenuFrom, closeContextMenu, menuRef } = useContextMenu<Email>();
  const archiveActionEnabled = useArchiveActionEnabled();
  /**
   * The row the menu was opened on, as the list currently has it. The menu holds
   * the message it was handed when it opened, but tags can be applied from
   * inside it without dismissing it, so what it draws has to keep up.
   */
  // The live copy of the row the menu was opened on, by its key: in a merged
  // view the bare id is also another account's message, and every action of
  // the menu would go to that namesake instead.
  const contextMenuEmail = contextMenu.data
    ? emails.find((email) => emailKeyFor(email) === emailKeyFor(contextMenu.data!)) ?? contextMenu.data
    : null;
  /**
   * Whose sender the menu's Rules entry uses: every selected message, or the
   * row's own message. A thread row whose newest message is the user's own
   * reply takes the newest one someone else sent, when the thread has it
   * loaded; otherwise the entry offers no sender rules.
   */
  const ruleEmails = useMemo(() => {
    if (!contextMenuEmail) return undefined;
    if (selectedEmailKeys.has(emailKeyFor(contextMenuEmail)) && selectedEmailKeys.size > 1) {
      return emails.filter((email) => selectedEmailKeys.has(emailKeyFor(email)));
    }
    // The account's own addresses only: another signed-in account's mail is a sender here.
    const own = getRuleAccountAddresses(resolveQuickRuleTarget(contextMenuEmail)).own;
    const isOwn = (email: Email) =>
      (email.from ?? []).length > 0 && (email.from ?? []).every((f) => own.has(normalizeAddress(f.email)));
    if (!isOwn(contextMenuEmail)) return undefined;
    const thread = threadGroups.find((group) => group.latestEmail.id === contextMenuEmail.id);
    if (!thread) return undefined;
    const newestOther = [...(threadEmailsCache.get(thread.threadKey) ?? []), ...thread.emails]
      .filter((email) => !isOwn(email))
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))[0];
    return newestOther ? [newestOther] : undefined;
  }, [contextMenuEmail, selectedEmailKeys, emails, threadGroups, threadEmailsCache]);
  const { dialogProps: confirmDialogProps, confirm: confirmDialog } = useConfirmDialog();

  // "Copy to" lists the folders of the other connected accounts. Only with
  // more than one account connected; the menu's own account is left out.
  const { copyTargets, copyToAccount } = useCopyToAccount(contextMenuEmail, contextMenu.isOpen);
  // Export, Print and View source from the row (R6), as the reader has them.
  const exportEmail = useEmailExport();
  const [sourceEmail, setSourceEmail] = useState<Email | null>(null);

  const [isProcessing, setIsProcessing] = useState(false);
  // The selection view's More actions opens only that part of the selection's menu.
  const [menuSection, setMenuSection] = useState<'all' | 'more' | 'rules'>('all');
  useEffect(() => {
    if (!contextMenu.isOpen) setMenuSection('all');
  }, [contextMenu.isOpen]);
  const later = useTimeoutWhileMounted();
  const parentRef = useRef<HTMLDivElement>(null);
  const batchToolbarRef = useRef<HTMLDivElement>(null);
  // The batch toolbar sits above the scroll container, so as it animates
  // open it shrinks the list and would shove every row downwards. Feed each
  // height change back into scrollTop so the rows stay put on screen (and
  // slide back when the toolbar collapses again).
  //
  // Except at the very top: there are no rows above to hold steady, so the
  // compensation just scrolls the first message underneath the toolbar and
  // reads as the toolbar covering the message you selected. Let the list
  // move down there instead.
  useEffect(() => {
    const toolbar = batchToolbarRef.current;
    if (!toolbar || typeof ResizeObserver === 'undefined') return;
    let lastHeight = toolbar.getBoundingClientRect().height;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? toolbar.getBoundingClientRect().height;
      const delta = height - lastHeight;
      lastHeight = height;
      const list = parentRef.current;
      if (!list || delta === 0) return;
      if (delta > 0 && list.scrollTop <= 0) return;
      list.scrollTop = Math.max(0, list.scrollTop + delta);
    });
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, []);
  // A narrow list (folder sidebar open, phones) has no room for the batch
  // toolbar's labels: plugin buttons go behind one "more" button and "Clear
  // selection" becomes an icon, instead of wrapping into each other.
  const [batchNarrow, setBatchNarrow] = useState(false);
  useEffect(() => {
    const toolbar = batchToolbarRef.current;
    if (!toolbar || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? toolbar.getBoundingClientRect().width;
      if (width > 0) setBatchNarrow(width < BATCH_TOOLBAR_WIDE);
    });
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, []);
  // One tag treatment for the whole list, measured from the scroll container.
  const tagDisplay = useMeasuredTagDisplay(parentRef);
  const density = useSettingsStore((state) => state.density);
  const showPreview = useSettingsStore((state) => state.showPreview);
  const showVerificationCodes = useSettingsStore((state) => state.showVerificationCodes);
  const { oneLine: isFocusedMailLayout, columns: listColumns } = useListRowShape();
  const showRecipientColumn = listFolder.role === 'sent' || listFolder.role === 'drafts';
  const footerHasMore = hasMore ?? hasMoreEmails;
  const footerIsLoadingMore = isLoadingMoreItems ?? isLoadingMore;
  const isMobile = useUIStore((state) => state.isMobile);
  // Hand the rows, in screen order, to the store for shift-click ranges: a
  // thread row selects all its messages, and an expanded thread's messages
  // are rows of their own under it. (#1230)
  const setListRows = useEmailStore((state) => state.setListRows);
  useEffect(() => {
    const rows: ListRow[] = [];
    for (const thread of threadGroups) {
      rows.push({ key: emailKeyFor(thread.latestEmail), members: thread.emails.map(emailKeyFor) });
      if (thread.emails.length > 1 && expandedThreadIds.has(thread.threadKey) && !isMobile && !conversationInReader) {
        for (const email of threadEmailsCache.get(thread.threadKey) ?? thread.emails) {
          rows.push({ key: emailKeyFor(email), members: [emailKeyFor(email)] });
        }
      }
    }
    setListRows(rows);
  }, [threadGroups, expandedThreadIds, threadEmailsCache, isMobile, conversationInReader, setListRows]);
  useEffect(() => () => setListRows(null), [setListRows]);

  // The virtualizer's guesses follow the rows' shape (see useListRowShape).

  const estimateSize = useCallback((index: number) => {
    const item = items[index];
    if (item?.kind === 'header' || item?.kind === 'unread-empty') return 48;
    if (isFocusedMailLayout) {
      return { 'extra-compact': 28, compact: 40, regular: 56, comfortable: 64 }[density];
    }
    // Rows the list has not measured yet are placed by this guess, and each
    // one it gets wrong shifts the list when it is measured on the way back
    // up after a jump down (scrollbar drag, End). So guess per row.
    const latest = item?.kind === 'row' ? item.thread.latestEmail : undefined;
    let size = { 'extra-compact': 32, compact: 60, regular: 84, comfortable: 104 }[density];
    if (showPreview && density !== 'extra-compact') {
      // A mail without a preview draws a one-line "No preview available",
      // a line (23px) shorter than a real one. Only comfortable rows show a
      // second preview line (mail-15).
      const emptyPreview = !!latest && !cleanPreview(latest.preview) && !latest.searchSnippet?.preview;
      size += emptyPreview || density !== 'comfortable' ? 36 - 23 : 36;
    }
    // The chip row (attachments, verification code): a 22px chip plus 6px margin.
    const hasCode = !!latest && showVerificationCodes && !!listVerificationCode(latest);
    if (latest && (hasCode || (onOpenAttachment && listRowShowsChips(latest, loadAttachments)))) size += 28;
    return size;
  }, [density, isFocusedMailLayout, showPreview, showVerificationCodes, items, onOpenAttachment, loadAttachments]);

  // Stable per list, so the virtualizer does not rebuild every row's
  // measurement on each scroll render.
  const getItemKey = useCallback(
    (index: number) => {
      const item = items[index];
      if (item?.kind === 'row') return item.thread.threadKey;
      if (item?.kind === 'header') return `section:${item.section}`;
      return item ? 'section:unread-empty' : String(index);
    },
    [items],
  );

  // Each row's place among the rows (headers and notes don't count).
  const rowPosOfItem = useMemo(() => new Map(itemOfThread.map((item, i) => [item, i + 1])), [itemOfThread]);
  // The rows below the screen come right after the first rows are drawn: the
  // first screen after sign-in waits only for the rows it shows. Scrolling
  // never sees the difference, the five extra rows are there by then.
  const [overscanFull, setOverscanFull] = useState(false);
  const hasItems = items.length > 0;
  useEffect(() => {
    if (overscanFull || !hasItems) return;
    let timer = 0;
    // After the frame that shows them.
    const frame = requestAnimationFrame(() => { timer = window.setTimeout(() => setOverscanFull(true), 0); });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [overscanFull, hasItems]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize,
    overscan: overscanFull ? LIST_OVERSCAN : FIRST_DRAW_OVERSCAN,
    getItemKey,
    // Keep sub-pixel row heights. The default measurer rounds them, so a
    // row could start up to half a pixel inside the one above it and paint
    // over that row's divider (at 125% or 150% display scaling).
    measureElement: measureVisibleRow,
  });


  // Another folder, tag, account, unified view or plugin tab - or another
  // search - opens at the top. The scroll container outlives the switch, so
  // the new list would otherwise open wherever the last one was scrolled to.
  // Refreshes, new mail and loading more keep the view and so the position.
  const searching = !!searchQuery.trim() || !isFilterEmpty(searchFilters);
  const viewKey = JSON.stringify([
    activeAccountId,
    viewingAccountId,
    selectedMailbox,
    selectedKeyword,
    selectedKeywordAccountId,
    isUnifiedView && (crossView ?? unifiedRole),
    isScheduledView,
    activeTabId,
    // The scope only matters while a search runs; the dropdown alone does not
    // change the list.
    searching && [searchQuery, searchFilters, searchMailboxId],
  ]);
  const shownViewKey = useRef(viewKey);
  useLayoutEffect(() => {
    if (shownViewKey.current === viewKey) return;
    shownViewKey.current = viewKey;
    virtualizer.scrollToOffset(0);
  }, [viewKey, virtualizer]);

  const hasSelection = selectedEmailKeys.size > 0;
  // What plugin buttons in the selection toolbar act on: the JMAP ids of the
  // selected messages, thread members included.
  const selectedEmailIds = useMemo(
    () => resolveSelectedEmails({ emails, threadEmailsCache, selectedEmailKeys }).map((email) => email.id),
    [emails, threadEmailsCache, selectedEmailKeys],
  );
  const bulkActionContext = useMemo(() => ({ emailIds: selectedEmailIds }), [selectedEmailIds]);
  const folderAccountKind = useFolderAccountKind();
  // A filter chip or a category tab on: the folder itself may well have mail.
  const pluginFilterOn = useFolderListFiltered(effectiveMailboxRole ?? null, folderAccountKind);
  const listNarrowed = pluginFilterOn || useMessageListTabsStore.getState().getCategoryFilter(effectiveMailboxRole) !== null;
  // "Remove from this folder" (#615): offered for a selection only when every
  // selected message is also in another folder.
  const removeFromFolder = useRemoveFromFolder();
  const folderToLeave = useEmailStore(removalFolder);
  const selectedEmailsForRemoval = useMemo(
    () => (hasSelection ? resolveSelectedEmails({ emails, threadEmailsCache, selectedEmailKeys }) : []),
    [hasSelection, emails, threadEmailsCache, selectedEmailKeys],
  );
  // The rows the selection covers: what the bar, the pane and the toasts
  // count (mail-18). A conversation row ticks all its loaded messages.
  const selectionRows = selectionRowCount(selectedEmailsForRemoval, selectedEmailKeys.size, disableThreading);
  // Report phishing for the selection, one report per message (enterprise pack).
  const selectionPhishing = usePhishingReport(selectedEmailsForRemoval, effectiveMailboxRole);
  const tPhishing = useTranslations('phishing_report');
  const selectionCanLeaveFolder = selectedEmailsForRemoval.length > 0
    && selectedEmailsForRemoval.every((email) => canRemoveFromFolder(email, folderToLeave));
  const handleBatchRemoveFromFolder = async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    try {
      await removeFromFolder(resolveSelectedEmails(useEmailStore.getState()));
    } finally {
      later(() => setIsProcessing(false), 500);
    }
  };
  const listSlotProps = useMemo(
    () => ({ mailboxId: selectedMailbox || null, mailboxRole: effectiveMailboxRole ?? null }),
    [selectedMailbox, effectiveMailboxRole],
  );
  const isSearching = !!searchQuery || !isFilterEmpty(searchFilters);
  const emptySlotProps = useMemo(() => ({ ...listSlotProps, searching: isSearching }), [listSlotProps, isSearching]);

  // The store reports a refused message (a read-only shared folder) through
  // its error; the rest of the selection is marked.
  // A toast with Undo (and Ctrl+Z) puts the messages back as they were.
  const markSelectionRead = (read: boolean) => client
    ? markSelectionReadWithUndo(client, read, {
        success: tNotifications(read ? 'emails_marked_read' : 'emails_marked_unread', { count: selectedEmailKeys.size }),
        error: tNotifications('error_updating'),
        labels: undo,
      })
    : Promise.resolve();

  const handleBatchMarkAsRead = async (read: boolean) => {
    if (!client || isProcessing) return;
    setIsProcessing(true);
    try {
      await markSelectionRead(read);
    } finally {
      later(() => setIsProcessing(false), 500);
    }
  };

  // What the tag picker shows for the selection: a tag on every selected
  // message is checked, one on only some of them is drawn as partial.
  const selectionTags = useMemo(() => {
    const selected = emails.filter((email) => selectedEmailKeys.has(emailKeyFor(email)));
    const counts = new Map<string, number>();
    for (const email of selected) {
      for (const tagId of getEmailTagIds(email.keywords)) counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
    }
    const all: string[] = [];
    const some: string[] = [];
    for (const [tagId, count] of counts) (count === selected.length ? all : some).push(tagId);
    // A selection within one group account offers that account's shared tags.
    return { all, some, scope: commonTagScope(selected) };
  }, [emails, selectedEmailKeys]);

  // A tag every selected message has comes off; any other goes onto all of
  // them. The selection stays, so several tags can be changed in a row.
  const handleBatchToggleTag = async (tagId: string) => {
    if (!client) return;
    try {
      const add = !selectionTags.all.includes(tagId);
      await setSelectionTagWithUndo(client, tagId, add, {
        describe: (count) => tNotifications(add ? 'emails_tagged' : 'tag_removed_count', { count }),
        labels: undo,
      });
    } catch (error) {
      console.error("Failed to tag emails:", error);
      toast.error(tNotifications('error_updating'));
    }
  };

  const handleBatchSetStarred = async (starred: boolean) => {
    if (!client || isProcessing) return;
    setIsProcessing(true);
    try {
      await setSelectionStarredWithUndo(client, starred, {
        success: tSelection(starred ? 'starred' : 'unstarred'),
        error: tNotifications('error_updating'),
        labels: undo,
      });
    } finally {
      later(() => setIsProcessing(false), 500);
    }
  };

  const handleBatchUndoSpam = async () => {
    if (!client || isProcessing) return;
    setIsProcessing(true);
    try {
      const emailIds = resolveSelectedEmails(useEmailStore.getState()).map(e => e.id);
      const restore = restoreBatchesForSelection(client);
      if (await batchUndoSpam(client, emailIds)) {
        toastWithUndo(tSpam('toast_not_spam_batch', { count: emailIds.length }), undoMoveAction(client, restore, undo));
      }
    } catch {
      toast.error(tSpam('error_not_spam'));
    } finally {
      later(() => setIsProcessing(false), 500);
    }
  };

  const handleBatchMarkAsSpam = async () => {
    if (!client || isProcessing) return;
    setIsProcessing(true);
    try {
      const emailIds = resolveSelectedEmails(useEmailStore.getState()).map(e => e.id);
      const restore = restoreBatchesForSelection(client);
      if (await batchMarkAsSpam(client, emailIds)) {
        toastWithUndo(tSpam('toast_batch', { count: emailIds.length }), undoMoveAction(client, restore, undo));
      }
    } catch {
      toast.error(tSpam('error'));
    } finally {
      later(() => setIsProcessing(false), 500);
    }
  };

  const handleBatchArchive = async () => {
    if (!client || isProcessing) return;
    if (!(await confirmMailRemoval('archive', selectedEmailKeys.size, confirmDialog, tRemove))) return;
    setIsProcessing(true);
    const rows = selectionRows;
    const restore = restoreBatchesForSelection(client);
    try {
      await runBatchEmailAction(() => batchArchive(client), {
        success: batchToastTitle(tRoot, 'archive', rows, disableThreading),
        error: tNotifications('error_archiving'),
        describeError: (error) => error instanceof ArchiveMailboxNotFoundError
          ? tViewer('archive_mailbox_not_found')
          : undefined,
        undo: undoMoveAction(client, restore, undo),
      });
    } finally {
      later(() => setIsProcessing(false), 500);
    }
  };

  const handleBatchMoveToMailbox = async (mailboxId: string) => {
    if (!client || isProcessing) return;
    setIsProcessing(true);
    const rows = selectionRows;
    // Undo puts the messages back; those a mixed-account list moved to
    // another account move back the same way (the receipts).
    const restore = restoreBatchesForSelection(client);
    const receipts: CrossAccountMoveReceipt[] = [];
    try {
      const destination = mailboxes.find((m) => m.id === mailboxId);
      await runBatchEmailAction(() => batchMoveToMailbox(client, mailboxId, undefined, receipts), {
        // "3 conversations moved to Family" (mail-18).
        success: batchToastTitle(tRoot, 'move', rows, disableThreading, destination ? getMailboxPath(destination, mailboxes) : undefined),
        error: tNotifications('move_failed'),
        undo: undoMoveAction(client, restore, undo, receipts),
      });
    } finally {
      later(() => setIsProcessing(false), 500);
    }
  };

  const handleBatchDelete = async () => {
    if (!client || isProcessing) return;

    const currentMailbox = mailboxes.find(m => m.id === selectedMailbox);
    const isInTrash = bulkDeleteIsPermanent(currentMailbox);

    if (shouldConfirmBulkDelete(currentMailbox)) {
      const confirmed = await confirmDialog({
        // One wording for a delete for good (mail-p3-5).
        title: isInTrash
          ? tRoot('mail_p3_actions.delete_forever_batch_title', { count: selectedEmailKeys.size })
          : t('batch_actions.delete_confirm_title'),
        message: isInTrash
          ? tRoot('mail_p3_actions.delete_forever_batch_message', { count: selectedEmailKeys.size })
          : t('batch_actions.delete_confirm_message', { count: selectedEmailKeys.size }),
        confirmText: isInTrash
          ? tRoot('reader_actions.delete_forever')
          : t('batch_actions.delete'),
        variant: "destructive",
      });
      if (!confirmed) return;
    } else if (!(await confirmMailRemoval('delete', selectedEmailKeys.size, confirmDialog, tRemove))) {
      return;
    }

    setIsProcessing(true);
    const rows = selectionRows;
    const restore = isInTrash ? null : restoreBatchesForSelection(client);
    try {
      await runBatchEmailAction(() => batchDelete(client, isInTrash), {
        success: batchToastTitle(tRoot, isInTrash ? 'delete' : 'trash', rows, disableThreading),
        error: tNotifications('error_deleting'),
        undo: undoMoveAction(client, restore, undo),
      });
    } finally {
      later(() => setIsProcessing(false), 500);
    }
  };

  // Move on the selection bar (mail-10): the folders the selection's own
  // context menu offers, with the selection's account first (#1149).
  const moveMenu = useContextMenu<null>();
  const selectionMoveModel = useMoveMenu(mailboxes, {
    currentMailboxId: selectedMailbox,
    ownerAccountId: resolveMoveOwnerAccountId(selectedEmailsForRemoval[0], mailboxes, selectedMailbox),
    emails: selectedEmailsForRemoval,
  });
  const chooseMoveFolder = useChooseMoveFolder();
  // One read/unread button: "Mark as read" while any selected message is unread.
  const selectionHasUnread = selectedEmailsForRemoval.some((email) => !email.keywords?.$seen);

  // The selection view's buttons: the selection menu's top level (useSelectionActionList).
  const shortcutOf = useMessageActionShortcut();
  const selectionUnread = selectedEmailsForRemoval.filter((email) => !email.keywords?.$seen).length;
  const selectionRestoreTo = effectiveMailboxRole === 'trash' && hasSelection
    ? restoreTargetForAll(selectedEmailsForRemoval, mailboxes, selectedMailbox)
    : undefined;
  const selectionActions = useSelectionActionList({
    emails: selectedEmailsForRemoval,
    currentMailboxRole: effectiveMailboxRole,
    canMove: !moveMenuIsEmpty(selectionMoveModel),
    canRemoveFromFolder: selectionCanLeaveFolder,
    canTag: !isScheduledView,
    onRestore: selectionRestoreTo ? () => void handleBatchMoveToMailbox(selectionRestoreTo) : undefined,
    onArchive: () => void handleBatchArchive(),
    onDelete: () => void handleBatchDelete(),
    onMarkAsRead: (read) => void handleBatchMarkAsRead(read),
    onSetStarred: (starred) => void handleBatchSetStarred(starred),
    onMarkAsSpam: () => void handleBatchMarkAsSpam(),
    onUndoSpam: () => void handleBatchUndoSpam(),
    onRemoveFromFolder: () => void handleBatchRemoveFromFolder(),
    onForwardAsAttachment: onBatchForwardAsAttachment,
  });
  // What "More actions" holds, as the pane's own buttons when that's two
  // things or fewer (mail-p3-8). Another signed-in account adds Copy to
  // account, and plugins can add entries: then More stays.
  const otherAccounts = useAccountStore((state) => state.accounts.filter((account) => account.isConnected).length > 1);
  const menuPlugins = usePluginSlotOffers('context-menu-email').length > 0;
  const selectionMoreInline = !otherAccounts && !menuPlugins ? selectionActions.more : null;

  // Archive, Delete, Move, Mark read/unread and Tag, as icons on the bar beside the
  // list. The reading pane has the selection view.
  const selectionButtons = () => (
      <>
        {archiveActionEnabled && effectiveMailboxRole !== 'archive' && (
          <IconButton label={tContextMenu('archive')} onClick={() => void handleBatchArchive()} disabled={isProcessing} data-testid="batch-archive">
            <Archive />
          </IconButton>
        )}
        <IconButton
          label={t('batch_actions.delete')}
          onClick={handleBatchDelete}
          disabled={isProcessing}
          data-testid="batch-delete"
          className="text-destructive hover:text-destructive hover:bg-destructive/10"
        >
          <Trash2 />
        </IconButton>
        {!moveMenuIsEmpty(selectionMoveModel) && (
          <IconButton
            label={tContextMenu('move_to')}
            aria-haspopup="menu"
            aria-expanded={moveMenu.contextMenu.isOpen}
            onClick={(e) => moveMenu.openContextMenuFrom(e.currentTarget, null, 'end')}
            disabled={isProcessing}
            data-testid="batch-move"
          >
            <FolderInput />
          </IconButton>
        )}
        <IconButton
          label={selectionHasUnread ? t('batch_actions.mark_read') : t('batch_actions.mark_unread')}
          onClick={() => handleBatchMarkAsRead(selectionHasUnread)}
          disabled={isProcessing}
          data-testid="batch-mark-read"
        >
          {selectionHasUnread ? <MailOpen /> : <Mail />}
        </IconButton>
        <BatchTagButton
          key={hasSelection ? 'selection' : 'none'}
          title={tContextMenu('tag')}
          selectedIds={selectionTags.all}
          partialIds={selectionTags.some}
          scope={selectionTags.scope}
          onToggle={handleBatchToggleTag}
          active={hasSelection && !isScheduledView}
          disabled={isProcessing}
          testId="batch-tag"
        />
      </>
  );

  // What the bar and the pane call the selection: conversations, as the list
  // shows them, or emails when conversations are off.
  const selectionTitle = disableThreading
    ? t('batch_actions.selected_messages', { count: selectedEmailKeys.size })
    : tListExtra('selected_conversations', { count: selectionRows });

  const currentMailbox = mailboxes.find(m => m.id === selectedMailbox);
  const isEmptyableFolder = currentMailbox?.role === 'trash' || currentMailbox?.role === 'junk';

  // Every loaded row ticked and more on the server: offer the rest, as Gmail
  // does (mail-p2-11). Taking it loads the remaining pages and ticks them,
  // so the batch actions, their Undo and their counts work as for any
  // selection. At most SELECT_ALL_LIMIT messages are loaded for it.
  const [selectingAll, setSelectingAll] = useState(false);
  const allLoadedSelected = hasSelection && emails.length > 0 && emails.every((e) => selectedEmailKeys.has(emailKeyFor(e)));
  const offerSelectAll = allLoadedSelected && footerHasMore && !isScheduledView && !hideBatchToolbar && !!client
    && emails.length < SELECT_ALL_LIMIT;
  const inPlainFolder = !!currentMailbox && !searchQuery.trim() && isFilterEmpty(searchFilters) && !isUnifiedView;
  const viewTotal = Math.max(
    inPlainFolder
      ? (disableThreading ? currentMailbox.totalEmails : (currentMailbox.totalThreads || currentMailbox.totalEmails))
      : totalEmails,
    selectionRows + 1,
  );
  const selectAllLabel = inPlainFolder
    ? tRoot(disableThreading ? 'mail_p2_list.select_all_emails_in_folder' : 'mail_p2_list.select_all_in_folder', {
        count: viewTotal,
        folder: localizeMailboxName(currentMailbox.role, currentMailbox.name, (k) => tSidebar(`mailboxes.${k}`)),
      })
    : tRoot(disableThreading ? 'mail_p2_list.select_all_emails' : 'mail_p2_list.select_all_conversations', { count: viewTotal });
  const handleSelectAllInView = async () => {
    if (!client || selectingAll) return;
    const view = () => {
      const state = useEmailStore.getState();
      return `${state.selectedMailbox}|${state.searchQuery}|${state.isUnifiedView}|${state.unifiedRole}`;
    };
    const startedIn = view();
    setSelectingAll(true);
    try {
      for (let pages = 0; pages < 1000; pages++) {
        const state = useEmailStore.getState();
        if (view() !== startedIn || state.selectedEmailKeys.size === 0) return;
        if (!state.hasMoreEmails || state.emails.length >= SELECT_ALL_LIMIT) break;
        if (state.isLoadingMore) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
        const before = state.emails.length;
        await state.loadMoreEmails(client);
        const after = useEmailStore.getState();
        if (after.emails.length === before && !after.isLoadingMore) break;
      }
      // Another folder opened or the selection was cleared meanwhile: leave it.
      if (view() !== startedIn || useEmailStore.getState().selectedEmailKeys.size === 0) return;
      useEmailStore.getState().selectAllEmails();
    } finally {
      setSelectingAll(false);
    }
  };

  const handleEmptyFolder = async () => {
    if (!client || isProcessing || !currentMailbox) return;

    // "Empty Trash" / "Empty Spam" with the count, as the folder menu asks (mail-p3-5).
    const prompt = emptyFolderPrompt(currentMailbox, false);
    const confirmed = await confirmDialog({
      title: tRoot(prompt.title),
      message: tRoot(prompt.message, prompt.values),
      confirmText: tRoot(prompt.confirm),
      variant: "destructive",
    });
    if (!confirmed) return;

    setIsProcessing(true);
    try {
      await emptyMailbox(client, currentMailbox.id);
    } finally {
      later(() => setIsProcessing(false), 500);
    }
  };

  const handleLoadMore = useCallback(() => {
    if (isScheduledView) {
      onLoadMoreScheduled?.();
      return;
    }
    if (client && hasMoreEmails && !isLoadingMore && !isLoading) {
      loadMoreEmails(client);
    }
  }, [client, hasMoreEmails, isLoadingMore, isLoading, isScheduledView, loadMoreEmails, onLoadMoreScheduled]);

  // The messages of a thread as the list knows them, for onThreadExpand.
  const threadMembers = useCallback((threadKey: string): Email[] => (
    useEmailStore.getState().threadEmailsCache.get(threadKey)
      ?? threadGroups.find((g) => g.threadKey === threadKey)?.emails
      ?? []
  ), [threadGroups]);

  const handleToggleThreadExpansion = useCallback(async (threadKey: string) => {
    const isExpanded = expandedThreadIds.has(threadKey);

    if (!isExpanded && client) {
      toggleThreadExpansion(threadKey);
      await fetchThreadEmails(client, threadKey);
      emitThreadExpand(threadKey, threadMembers(threadKey), true);
      // Mark the thread's unread emails read, following markAsReadDelay.
      autoMarkExpandedThreadAsRead(client, threadKey);
    } else {
      toggleThreadExpansion(threadKey);
      emitThreadExpand(threadKey, threadMembers(threadKey), !isExpanded);
    }
  }, [client, expandedThreadIds, toggleThreadExpansion, fetchThreadEmails, autoMarkExpandedThreadAsRead, threadMembers]);

  const collapseAllThreadsAndNotify = useCallback(() => {
    const wereExpanded = [...useEmailStore.getState().expandedThreadIds];
    const members = wereExpanded.map((key) => [key, threadMembers(key)] as const);
    collapseAllThreads();
    for (const [key, emails] of members) emitThreadExpand(key, emails, false);
  }, [collapseAllThreads, threadMembers]);

  // Rows are memoised (MemoizedThreadListItem), which only pays off if what
  // they are handed keeps its identity from one render to the next.
  const rowHandlers = useStableHandlers({
    onToggleExpandKey: handleToggleThreadExpansion,
    onCollapseAllThreads: collapseAllThreadsAndNotify,
    onEmailSelect: (email: Email) => {
      // Collapse expanded threads when selecting an email outside the expanded thread
      const currentExpanded = useEmailStore.getState().expandedThreadIds;
      if (currentExpanded.size > 0) {
        // Check if the selected email belongs to any expanded thread via its threadId
        if (!email.threadId || !currentExpanded.has(threadKeyFor(email))) {
          collapseAllThreadsAndNotify();
        }
      }
      onEmailSelect?.(email);
    },
    onEmailDoubleClick,
    onPrefetch: onEmailPrefetch,
    onContextMenu: openContextMenu,
    onOpenConversation,
    onToggleStar,
    onMarkAsRead,
    onDelete,
    onArchive,
    onSetTag,
    onMarkAsSpam,
    onUndoSpam,
    onOpenAttachment,
  });
  // One expand toggle per thread, kept for as long as the list lives.
  const toggleExpandByThread = useRef(new Map<string, () => void>());
  const toggleExpandFor = (threadKey: string) => {
    let toggle = toggleExpandByThread.current.get(threadKey);
    if (!toggle) {
      toggle = () => rowHandlers.onToggleExpandKey(threadKey);
      toggleExpandByThread.current.set(threadKey, toggle);
    }
    return toggle;
  };

  // Range-based load more: trigger when last visible item is near the end.
  // Debounce to prevent rapid cascade when thread grouping reduces item
  // count below the viewport size (e.g. 2400 emails → fewer thread groups).
  const virtualItems = virtualizer.getVirtualItems();
  // See useRowSlots: new messages update the rows on screen instead of replacing them.
  const rowSlots = useRowSlots(virtualItems.map((item) => ({ index: item.index, key: String(item.key) })));
  const lastVirtualItemIndex = virtualItems[virtualItems.length - 1]?.index;
  const loadMoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A folded "Everything else" has nothing below to load into.
  const loadsMore = !(sections && restCollapsed);
  useEffect(() => {
    if (lastVirtualItemIndex === undefined || !loadsMore) return;
    if (lastVirtualItemIndex >= items.length - 5) {
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
  }, [lastVirtualItemIndex, items.length, handleLoadMore, loadsMore]);

  // Scroll to the thread group containing the selected email
  useEffect(() => {
    if (!selectedEmailKey) return;
    const index = threadGroups.findIndex(thread =>
      emailKeyFor(thread.latestEmail) === selectedEmailKey ||
      thread.emails.some(e => emailKeyFor(e) === selectedEmailKey)
    );
    if (index < 0) return;
    // A row clicked in the list is already on screen; scrollToIndex would
    // still measure and schedule a scroll. Judge from the virtualizer's own
    // numbers, which cost no layout read.
    const itemIndex = itemOfThread[index];
    const item = virtualizer.measurementsCache[itemIndex];
    const top = virtualizer.scrollOffset;
    const height = virtualizer.scrollRect?.height;
    if (item && top !== null && height !== undefined && item.start >= top && item.end <= top + height) return;
    virtualizer.scrollToIndex(itemIndex, { align: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmailKey]);

  // Keep the moving end of a Shift+Arrow range on screen (#992).
  const selectionFocusKey = useEmailStore((state) => state.selectionFocus?.focus ?? null);
  useEffect(() => {
    if (!selectionFocusKey) return;
    const index = threadGroups.findIndex((thread) => thread.emails.some((e) => emailKeyFor(e) === selectionFocusKey));
    if (index >= 0) virtualizer.scrollToIndex(itemOfThread[index], { align: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionFocusKey]);

  // Re-measure all items when density or preview settings change
  useEffect(() => {
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [density, isFocusedMailLayout, showPreview]);

  // One list item's content, for the virtual list and the paged one.
  const renderItemContent = (index: number) => {
    const listItem = items[index];
    const thread = listItem?.kind === 'row' ? listItem.thread : null;
    return (
      <>
        {listItem?.kind === 'header' && unreadSection && (
          listItem.section === 'unread' ? (
            <MvListSectionHeader
              title={t('sections.unread')}
              collapsed={unreadCollapsed}
              onToggle={() => updateSetting('mvUnreadSectionCollapsed', !unreadCollapsed)}
              shown={sectionRowCount}
              total={unreadSection.total}
            />
          ) : (
            <MvListSectionHeader
              title={t('sections.everything_else')}
              collapsed={restCollapsed}
              onToggle={() => updateSetting('mvEverythingElseCollapsed', !restCollapsed)}
              shown={emails.length - sectionRowCount}
              total={totalEmails}
            />
          )
        )}
        {listItem?.kind === 'unread-empty' && (
          <p className="flex h-12 items-center border-b border-border px-6 text-sm text-muted-foreground">
            {t('sections.unread_empty')}
          </p>
        )}
        {thread && <MemoizedThreadListItem
          thread={thread}
          isExpanded={!conversationInReader && expandedThreadIds.has(thread.threadKey)}
          conversationInReader={conversationInReader}
          selectedEmailKey={selectedEmailKey}
          isLoading={isLoadingThread === thread.threadKey}
          expandedEmails={threadEmailsCache.get(thread.threadKey)}
          onToggleExpand={toggleExpandFor(thread.threadKey)}
          onCollapseAllThreads={rowHandlers.onCollapseAllThreads}
          onEmailSelect={rowHandlers.onEmailSelect}
          onEmailDoubleClick={rowHandlers.onEmailDoubleClick}
          onPrefetch={rowHandlers.onPrefetch}
          onContextMenu={rowHandlers.onContextMenu}
          onOpenConversation={rowHandlers.onOpenConversation}
          onToggleStar={rowHandlers.onToggleStar}
          onMarkAsRead={rowHandlers.onMarkAsRead}
          onDelete={rowHandlers.onDelete}
          onArchive={rowHandlers.onArchive}
          onSetTag={rowHandlers.onSetTag}
          onMarkAsSpam={rowHandlers.onMarkAsSpam}
          onUndoSpam={rowHandlers.onUndoSpam}
          onOpenAttachment={rowHandlers.onOpenAttachment}
          loadAttachments={loadAttachments}
          listFolder={listFolder}
        />}
      </>
    );
  };

  // Simple mode's paged list (SR-21): pages of 50 rows with Previous and
  // Next instead of endless scrolling, which a screen reader handles better.
  const paged = useSettingsStore((state) => state.simpleMode && state.simpleModePagedList);
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(itemOfThread.length / LIST_PAGE_SIZE));
  const pageItems = useMemo(
    () => (paged ? itemOfThread.slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE) : []),
    [paged, page, itemOfThread],
  );
  const canGoNext = (page + 1) * LIST_PAGE_SIZE < itemOfThread.length || footerHasMore;
  const pendingNextPage = useRef(false);
  const goToNextPage = useCallback(() => {
    if ((page + 1) * LIST_PAGE_SIZE < itemOfThread.length) setPage(page + 1);
    else if (footerHasMore) { pendingNextPage.current = true; handleLoadMore(); }
  }, [page, itemOfThread.length, footerHasMore, handleLoadMore]);
  // The next page arrives from the server: show it.
  useEffect(() => {
    if (!pendingNextPage.current || (page + 1) * LIST_PAGE_SIZE >= itemOfThread.length) return;
    pendingNextPage.current = false;
    setPage(page + 1);
  }, [itemOfThread.length, page]);
  // Another folder or search starts on its first page.
  useEffect(() => { setPage(0); }, [viewKey]);
  // j/k past the end of a page turn the page.
  useEffect(() => {
    if (!paged || !selectedEmailKey) return;
    const index = threadGroups.findIndex((thread) => thread.emails.some((e) => emailKeyFor(e) === selectedEmailKey));
    if (index < 0) return;
    const target = Math.floor(index / LIST_PAGE_SIZE);
    if (target !== page) setPage(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paged, selectedEmailKey]);

  // One Tab stop in the list, and the focus going along with j/k (SR-01/02).
  const renderedRows = virtualizer.getVirtualItems();
  useListboxFocus(
    parentRef,
    selectedEmailKey,
    `${items.length}:${renderedRows[0]?.index ?? -1}-${renderedRows[renderedRows.length - 1]?.index ?? -1}:${expandedThreadIds.size}:${paged ? page : -1}`,
  );

  // Room under the last row for the round Compose button, which would otherwise
  // sit on that row's actions. Only phones and Pro panes have that button:
  // Mountain View and the desktop have Compose in the folder sidebar
  // (mail-p3-11). A spacer and not padding on the list: padding is a minimum
  // height the list can't go under, and on a short screen it pushed the rows
  // over the tab bar.
  const composeButtonRoom = !mountainViewList && (!isDesktopPane || isEmbeddedList) ? <div aria-hidden="true" className="h-20" /> : null;

  return (
    <RowTranslatorsProvider>
    <TagDisplayContext.Provider value={tagDisplay}>
    <div className={cn("flex flex-col min-h-0", className)}>
      {/* Batch Actions Toolbar */}
      <div
        ref={batchToolbarRef}
        // Collapsed it is still in the page: keep its buttons out of the Tab
        // order and away from screen readers.
        inert={!(hasSelection && !isScheduledView && !hideBatchToolbar)}
        className={cn(
          "transition-all duration-300 ease-in-out overflow-hidden",
          hasSelection && !isScheduledView && !hideBatchToolbar ? (offerSelectAll || selectingAll ? "max-h-28 opacity-100" : "max-h-16 opacity-100") : "max-h-0 opacity-0"
        )}
      >
        {/* Only drawn while shown: collapsed it would still render every button. */}
        {hasSelection && !isScheduledView && !hideBatchToolbar && (
        <div className={cn("py-2 border-b bg-accent/30 border-border flex items-center justify-between gap-2", batchNarrow ? "px-2" : "px-4")} data-batch-narrow={batchNarrow ? "" : undefined}>
          <div className="flex items-center gap-2 min-w-0 animate-in fade-in slide-in-from-left-3 duration-300">
            {/* "5 conversations": the bar is narrow beside its buttons. */}
            <span className="text-sm font-medium text-foreground whitespace-nowrap truncate" title={selectionTitle}>
              {disableThreading ? selectionTitle : tListExtra('conversation_count', { count: selectionRows })}
            </span>
          </div>
          <div className={cn("flex items-center flex-shrink-0 animate-in fade-in slide-in-from-right-3 duration-300", batchNarrow ? "gap-0" : "gap-0.5")}>
            {/* Archive, Delete, Move, Mark read/unread, Tag, then what
                fits a wide bar. The rest is in its ⋮, the selection's
                context menu (R6). */}
            {selectionButtons()}
            {selectionCanLeaveFolder && !batchNarrow && (
              <IconButton
                label={tContextMenu('remove_from_folder')}
                onClick={handleBatchRemoveFromFolder}
                disabled={isProcessing}
                data-testid="batch-remove-from-folder"
              >
                <FolderX />
              </IconButton>
            )}
            {spamApplicable && !batchNarrow && (
              <IconButton
                label={effectiveMailboxRole === 'junk' ? tContextMenu('not_spam') : tContextMenu('mark_as_spam')}
                onClick={effectiveMailboxRole === 'junk' ? handleBatchUndoSpam : handleBatchMarkAsSpam}
                disabled={isProcessing}
                data-testid={effectiveMailboxRole === 'junk' ? 'batch-not-spam' : 'batch-spam'}
              >
                {effectiveMailboxRole === 'junk' ? <ShieldCheck /> : <ShieldAlert />}
              </IconButton>
            )}
            {selectionPhishing.available && !batchNarrow && (
              <IconButton
                label={tPhishing('action')}
                onClick={selectionPhishing.report}
                disabled={isProcessing}
                data-testid="batch-report-phishing"
              >
                <Fish />
              </IconButton>
            )}
            <IconButton
              label={t('batch_actions.more')}
              aria-haspopup="menu"
              data-testid="batch-more"
              disabled={isProcessing || selectedEmailsForRemoval.length === 0}
              onClick={(e) => {
                const anchor = selectedEmailsForRemoval[0];
                if (anchor) openContextMenuFrom(e.currentTarget, anchor, 'end');
              }}
            >
              {isProcessing ? <Spinner size="sm" /> : <MoreVertical />}
            </IconButton>
            {hasSelection && (
              <PluginActions
                surface="message-bulk-actions"
                context={bulkActionContext}
                accountKind={folderAccountKind}
                mailboxRole={effectiveMailboxRole ?? null}
                compact
                overflow={batchNarrow}
                className="flex-nowrap"
              />
            )}
            <div className={cn("w-px h-6 bg-border", batchNarrow ? "mx-0.5" : "mx-1")} />
            {/* The bar's buttons share one height (R1): 32px icons, and the
                text button at xs when there is room for it. */}
            {batchNarrow ? (
              <IconButton
                label={t('batch_actions.clear_selection')}
                onClick={clearSelection}
                disabled={isProcessing}
                className="text-muted-foreground hover:text-foreground"
              >
                <X />
              </IconButton>
            ) : (
              <Button
                variant="ghost"
                size="xs"
                onClick={clearSelection}
                disabled={isProcessing}
                className="text-muted-foreground hover:text-foreground whitespace-nowrap"
              >
                {t('batch_actions.clear_selection')}
              </Button>
            )}
          </div>
        </div>
        )}
        {hasSelection && !isScheduledView && !hideBatchToolbar && (offerSelectAll || selectingAll) && (
          <div className="px-4 py-1.5 border-b border-border bg-accent/20 text-center text-sm" data-testid="select-all-in-view">
            <button
              type="button"
              onClick={() => void handleSelectAllInView()}
              disabled={selectingAll}
              aria-busy={selectingAll || undefined}
              className="text-primary font-medium hover:underline disabled:no-underline disabled:opacity-70"
            >
              {selectingAll ? tRoot('mail_p2_list.selecting_all') : selectAllLabel}
            </button>
          </div>
        )}
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

      {/* How long Trash and Junk keep mail, and Recover deleted items from the account's own Trash, on one line */}
      {(currentMailbox?.role === 'trash' || currentMailbox?.role === 'junk') && <FolderRetentionLine mailbox={currentMailbox} />}

      {/* Empty Folder Banner for Junk/Trash */}
      {isEmptyableFolder && emails.length > 0 && !hasSelection && (
        <div className="px-4 py-2 border-b border-border bg-muted/30 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 text-sm text-muted-foreground">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {/* Named as in the sidebar ("Spam"), not by the server ("Junk"). */}
            <span>{tUnread('empty_hint', { folder: localizeMailboxName(currentMailbox?.role, currentMailbox?.name ?? '', (k) => tSidebar(`mailboxes.${k}`)) })}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleEmptyFolder}
            disabled={isProcessing}
            className="shrink-0 whitespace-nowrap text-destructive border-destructive/30 hover:bg-destructive/10 text-xs"
          >
            {isProcessing ? (
              <Loader2 className="w-3 h-3 animate-spin me-1" />
            ) : (
              <Trash2 className="w-3 h-3 me-1" />
            )}
            {tRoot(emptyFolderLabelKey(currentMailbox?.role) ?? 'email_list.empty_folder.button')}
          </Button>
        </div>
      )}

      {/* Plugins' keyword filters, in a folder's own list (not search, tags or merged views). */}
      {!isSearching && !selectedKeyword && !isUnifiedView && !isScheduledView && selectedMailbox && (
        <PluginListFilters
          mailboxRole={effectiveMailboxRole ?? null}
          accountKind={folderAccountKind}
          onChange={() => { clearSelection(); if (client) void useEmailStore.getState().fetchEmails(client); }}
        />
      )}

      <PluginSlot name="message-list-header" className="w-full" extraProps={listSlotProps} />

      <PluginSearchResults surface="search-results" onOpenEmail={onOpenSearchResult} />

      {listColumns && (
        <ListColumnsHeader density={density} selecting={hasSelection} showRecipient={showRecipientColumn} />
      )}

      {/* Email List */}
      <div
        ref={parentRef}
        // The mail shell's "Skip to message list" lands here.
        id="message-list"
        tabIndex={-1}
        data-pane="list"
        // Where the focus goes when the message it was on is deleted,
        // archived or moved (components/layout/focus-rescue).
        data-focus-fallback=""
        className="flex-1 min-h-0 overflow-y-auto bg-background relative outline-none"
        data-tour="email-list"
        // The column header above keeps the same gutter, so its titles stay over the columns.
        style={listColumns ? { scrollbarGutter: 'stable' } : undefined}
      >
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
          <div data-testid="email-list-skeleton">
            <LoadingSkeleton
              shape={isFocusedMailLayout ? (mountainViewList ? 'mv' : 'one-line') : 'stacked'}
              density={density}
              preview={showPreview}
            />
          </div>
        ) : emails.length === 0 && !isLoading ? (
          <div className="flex flex-col items-center justify-center h-full">
            {/* R9: an empty search offers Clear search; Drafts, which the
                user fills, offers Compose. */}
            <EmptyState
              icon={isScheduledView ? CalendarClock : isSearching ? SearchX : MailX}
              title={isScheduledView ? t('no_scheduled_emails') : isSearching ? t('no_search_results') : t('no_emails')}
              description={isScheduledView ? t('no_scheduled_emails_description') : isSearching ? t('no_search_results_description') : listNarrowed ? undefined : t('no_emails_description')}
              actions={!isScheduledView && isSearching && onClearSearch ? (
                <Button size="sm" variant="outline" onClick={onClearSearch}>{tSidebar('clear_search')}</Button>
              ) : !isScheduledView && !isSearching && effectiveMailboxRole === 'drafts' && onCompose ? (
                <Button size="sm" onClick={onCompose}>{tSidebar('compose')}</Button>
              ) : undefined}
            />
            <PluginSlot name="message-list-empty" className="mt-4 w-full max-w-md px-4" extraProps={emptySlotProps} />
          </div>
        ) : (
          paged ? (
            <>
              <div
                role="treegrid"
                aria-label={t('listbox_label')}
                aria-multiselectable
                aria-busy={isLoading || undefined}
                data-setsize={footerHasMore ? -1 : itemOfThread.length}
              >
                {pageItems.map((index) => (
                  <div key={items[index]?.kind === 'row' ? (items[index] as { thread: ThreadGroup }).thread.threadKey : `item-${index}`} role="presentation" data-pos={rowPosOfItem.get(index)}>
                    {renderItemContent(index)}
                  </div>
                ))}
              </div>
              <nav aria-label={t('pages.label')} className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 text-sm">
                <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
                  {t('pages.previous')}
                </Button>
                <span aria-live="polite">{t('pages.position', { page: page + 1, pages: pageCount, more: footerHasMore ? 'yes' : 'no' })}</span>
                <Button variant="outline" size="sm" onClick={goToNextPage} disabled={!canGoNext}>
                  {footerIsLoadingMore ? t('loading_more') : t('pages.next')}
                </Button>
              </nav>
              {composeButtonRoom}
            </>
          ) : (
          <>
            <div
              role="treegrid"
              aria-label={t('listbox_label')}
              aria-multiselectable
              aria-busy={isLoading || undefined}
              // Rows report where they are in the whole list (useListboxFocus);
              // -1 while more can still load.
              data-setsize={footerHasMore ? -1 : itemOfThread.length}
              className={cn("transition-opacity duration-200", isLoading && "opacity-50")}
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((virtualItem) => {
                const listItem = items[virtualItem.index];
                const thread = listItem?.kind === 'row' ? listItem.thread : null;
                return (
                  <div
                    key={rowSlots.get(String(virtualItem.key)) ?? virtualItem.key}
                    data-index={virtualItem.index}
                    role="presentation"
                    data-pos={thread ? rowPosOfItem.get(virtualItem.index) : undefined}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      // `top`, not translateY: layout snaps it to device
                      // pixels, so the fractional offsets stay crisp.
                      top: virtualItem.start,
                      left: 0,
                      width: '100%',
                    }}
                  >
                    {renderItemContent(virtualItem.index)}
                  </div>
                );
              })}
            </div>

            {loadsMore && <div className="py-4 flex justify-center">
              {footerIsLoadingMore && footerHasMore && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{t('loading_more')}</span>
                </div>
              )}
              {!footerHasMore && emails.length > 0 && (
                <div className="text-sm text-muted-foreground border-t border-border pt-6">
                  {t('no_more_emails')}
                </div>
              )}
            </div>}
            {composeButtonRoom}
          </>
          )
        )}
      </div>

      {/* The selection's Move menu, from the bar or the reading pane. */}
      {hasSelection && (
        <ContextMenu
          ref={moveMenu.menuRef}
          isOpen={moveMenu.contextMenu.isOpen}
          position={moveMenu.contextMenu.position}
          onClose={moveMenu.closeContextMenu}
          label={tContextMenu('move_to')}
        >
          <div className="w-64 max-w-full">
            <MoveFolderList
              model={selectionMoveModel}
              onPick={(mailboxId) => { moveMenu.closeContextMenu(); void handleBatchMoveToMailbox(mailboxId); }}
              onChooseFolder={chooseMoveFolder
                ? () => { moveMenu.closeContextMenu(); chooseMoveFolder({ emails: selectedEmailsForRemoval, onMove: (mailboxId) => void handleBatchMoveToMailbox(mailboxId) }); }
                : undefined}
            />
          </div>
        </ContextMenu>
      )}

      {/* The reading pane for a selection: the selection menu's actions as buttons. */}
      {selectionPaneHost && hasSelection && !isScheduledView && createPortal(
        <SelectionView
          title={selectionTitle}
          unread={selectionUnread}
          entries={selectionActions.top}
          more={selectionMoreInline}
          onOpenRules={(button) => {
            const anchor = selectedEmailsForRemoval[0];
            if (!anchor) return;
            setMenuSection('rules');
            openContextMenuFrom(button, anchor, 'start');
          }}
          shortcutOf={(entry) => (entry.key === 'star' ? undefined : shortcutOf(entry.key, entry.testId === 'ctx-mark-read'))}
          onMove={(button) => moveMenu.openContextMenuFrom(button, null, 'start')}
          onMore={(button) => {
            const anchor = selectedEmailsForRemoval[0];
            if (!anchor) return;
            setMenuSection('more');
            openContextMenuFrom(button, anchor, 'start');
          }}
          onClear={clearSelection}
          tags={{ selectedIds: selectionTags.all, partialIds: selectionTags.some, scope: selectionTags.scope, onToggle: handleBatchToggleTag }}
          disabled={isProcessing || selectedEmailsForRemoval.length === 0}
        />,
        selectionPaneHost,
      )}

      {/* Context Menu */}
      {contextMenuEmail && (
        <EmailContextMenu
          rowMenu
          email={contextMenuEmail}
          position={contextMenu.position}
          isOpen={contextMenu.isOpen}
          onClose={closeContextMenu}
          menuRef={menuRef}
          mailboxes={mailboxes}
          selectedMailbox={selectedMailbox}
          currentMailboxRole={effectiveMailboxRole}
          isMultiSelect={selectedEmailKeys.has(emailKeyFor(contextMenuEmail))}
          selectedCount={selectedEmailKeys.size}
          ruleEmails={ruleEmails}
          onReply={() => onReply?.(contextMenuEmail!)}
          onReplyAll={() => onReplyAll?.(contextMenuEmail!)}
          onForward={() => onForward?.(contextMenuEmail!)}
          onForwardAsAttachment={() => onForwardAsAttachment?.(contextMenuEmail!)}
          onFindFromSender={onFindFromSender && contextMenuEmail.from?.[0]?.email
            ? () => onFindFromSender({ name: contextMenuEmail!.from![0].name || '', email: contextMenuEmail!.from![0].email })
            : undefined}
          onBatchForwardAsAttachment={onBatchForwardAsAttachment}
          onMarkAsRead={(read) => onMarkAsRead?.(contextMenuEmail!, read)}
          onToggleStar={() => onToggleStar?.(contextMenuEmail!)}
          onTogglePinned={onTogglePinned ? () => onTogglePinned(contextMenuEmail!) : undefined}
          onDelete={() => onDelete?.(contextMenuEmail!)}
          onArchive={() => onArchive?.(contextMenuEmail!)}
          onSetTag={(color) => onSetTag?.(contextMenuEmail!.id, color, emailKeyFor(contextMenuEmail!))}
          onMoveToMailbox={(mailboxId) => onMoveToMailbox?.(contextMenuEmail!.id, mailboxId, emailKeyFor(contextMenuEmail!))}
          onRemoveFromFolder={() => void removeFromFolder([contextMenuEmail!])}
          onMarkAsSpam={() => onMarkAsSpam?.(contextMenuEmail!)}
          onUndoSpam={() => onUndoSpam?.(contextMenuEmail!)}
          onEditDraft={() => onEditDraft?.(contextMenuEmail!)}
          onCancelScheduledForEdit={onCancelScheduledForEdit ? () => onCancelScheduledForEdit(contextMenuEmail!) : undefined}
          onCancelScheduledSend={onCancelScheduledSend ? () => void onCancelScheduledSend(contextMenuEmail!) : undefined}
          onRescheduleScheduled={onRescheduleScheduled ? () => onRescheduleScheduled(contextMenuEmail!) : undefined}
          copyTargets={copyTargets}
          onCopyToAccount={async (accountId, mailboxId) => {
            const emails = selectedEmailKeys.has(emailKeyFor(contextMenuEmail!)) && selectedEmailKeys.size > 1
              ? resolveSelectedEmails(useEmailStore.getState())
              : [contextMenuEmail!];
            await copyToAccount(emails, accountId, mailboxId);
          }}
          onOpenInWindow={openInWindow && contextMenuEmail ? () => openInWindow(contextMenuEmail) : undefined}
          // Export, print and View source follow the device policy of the row's own account.
          onExport={contextMenuEmail && !canExport(contextMenuEmail) ? undefined : () => {
            const target = contextMenuEmail!;
            void exportEmail(target, {
              onArchive: onArchive ? () => onArchive(target) : undefined,
              onDelete: onDelete ? () => onDelete(target) : undefined,
              archiveEnabled: archiveActionEnabled,
            });
          }}
          onPrint={onEmailSelect && !(contextMenuEmail && !canPrint(contextMenuEmail)) ? () => {
            // The print window opens in the click; the reader fills it once
            // the message is open.
            const target = contextMenuEmail!;
            if (requestPrint(emailKeyFor(target), target)) onEmailSelect(target);
          } : undefined}
          onViewSource={contextMenuEmail && !canExport(contextMenuEmail) ? undefined : () => setSourceEmail(contextMenuEmail)}
          onBatchMarkAsRead={(read) => markSelectionRead(read)}
          onBatchSetStarred={(starred) => void handleBatchSetStarred(starred)}
          section={menuSection}
          batchTagIds={selectionTags.all}
          batchPartialTagIds={selectionTags.some}
          batchTagScope={selectionTags.scope}
          onBatchToggleTag={handleBatchToggleTag}
          onBatchDelete={() => void handleBatchDelete()}
          onBatchArchive={() => void handleBatchArchive()}
          batchEmails={selectedEmailsForRemoval}
          onBatchRemoveFromFolder={() => void handleBatchRemoveFromFolder()}
          onBatchMoveToMailbox={(mailboxId) => void handleBatchMoveToMailbox(mailboxId)}
          onBatchMarkAsSpam={() => void handleBatchMarkAsSpam()}
          onBatchUndoSpam={async () => {
            if (client) {
              await handleBatchUndoSpam();
            }
          }}
        />
      )}

      <ConfirmDialog {...confirmDialogProps} />
      {sourceEmail && (() => {
        const source = resolveEmailBlobContext(sourceEmail, client);
        return (
          <ViewSourceDialog
            isOpen
            onClose={() => setSourceEmail(null)}
            blobId={sourceEmail.blobId}
            client={source.client}
            accountId={source.accountId}
            onDownload={() => void exportEmail(sourceEmail, {
              onArchive: onArchive ? () => onArchive(sourceEmail) : undefined,
              onDelete: onDelete ? () => onDelete(sourceEmail) : undefined,
              archiveEnabled: archiveActionEnabled,
            }, source)}
          />
        );
      })()}
    </div>
    </TagDisplayContext.Provider>
    </RowTranslatorsProvider>
  );
}
