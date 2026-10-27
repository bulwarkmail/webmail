"use client";

import { useEffect, useLayoutEffect, useState, useRef, useMemo, useCallback, useId } from "react";
import { useTranslations } from "next-intl";
import { Sidebar } from "@/components/layout/sidebar";
import { EmailList } from "@/components/email/email-list";
import { MvComposeInline, MvComposeWindow } from "@/components/email/mv-compose-window";
import { usePinnedPerSession } from "@/hooks/use-pinned-per-session";
import { useConfig } from "@/hooks/use-config";
import { productName } from "@/lib/product-name";
import { MessageListTabs } from "@/components/email/message-list-tabs";
import dynamic from "next/dynamic";
import type { ComposerDraftData } from "@/components/email/email-composer";

// Neither the viewer (5k+ lines, postal-mime/dompurify) nor the composer (the
// entire TipTap/ProseMirror stack) is needed to paint the mail list, and both
// only ever render after client-side auth resolves — keep them out of the
// route's critical chunk. They are preloaded on idle once the list is up, so
// the first open/compose click doesn't wait on a chunk fetch.
const EmailViewer = dynamic(
  () => import("@/components/email/email-viewer").then((m) => m.EmailViewer),
  { ssr: false }
);
const EmailComposer = dynamic(
  () => import("@/components/email/email-composer").then((m) => m.EmailComposer),
  { ssr: false }
);
import { ProtocolAccountPicker } from "@/components/protocol/protocol-account-picker";
import { ThreadConversationView } from "@/components/email/thread-conversation-view";
import { MobileHeader } from "@/components/layout/mobile-header";
import { ThreadGroup, Email, Mailbox, isUnifiedMailboxId, UNIFIED_MAILBOX_IDS, UNIFIED_ROLE_BY_ID, CROSS_VIEW_BY_ID, CROSS_VIEW_IDS, isCrossViewId } from "@/lib/jmap/types";
import { useAccountStore, waitForConnectedAccount } from "@/stores/account-store";
import { useShallow } from "zustand/react/shallow";
import { usePolicyStore } from "@/stores/policy-store";
import { isArchiveActionEnabled, useArchiveActionEnabled } from "@/lib/archive-gate";
import type { UnifiedAccountClient } from "@/lib/unified-mailbox";
import { connectedAccountsGrew } from "@/lib/unified-mailbox";
import { messagePriorityFromHeaders, type MessagePriority } from "@/lib/message-priority";
import { KeyboardShortcutsModal } from "@/components/keyboard-shortcuts-modal";
import { useEmailStore, pendingInitialData, buildUnifiedAccountClients, invalidateUnifiedMailboxes, captureViewToken, ArchiveMailboxNotFoundError, ensureArchiveMailbox, resolveSelectedEmails, resolveUnstampedEmailAccountId, resolveEmailBlobContext, resolveEmailActionContext, emailWriteSource, emailLinkSource, type EmailBlobContext, emptyFolderMovesToTrash, bulkDeleteIsPermanent, shouldConfirmBulkDelete, isAggregateListView, removalFolder, canRemoveFromFolder } from "@/stores/email-store";
import { findDraftIdentityIdForLogin, listRowSource, resolveDraftSource, type DraftSource } from "@/lib/draft-source";
import { useRemoveFromFolder } from "@/hooks/use-remove-from-folder";
import { groupSearchScopeFolders, SEARCH_SCOPE_ALL_FOLDERS } from "@/lib/search-scope-folders";
import { toast } from "@/stores/toast-store";
import { cancelFailureToast, partlyRefusedWarning, rescheduleFailureToast } from "@/lib/send-failure-message";
import { formatRejectedRecipients, RescheduleRestoredError } from "@/lib/jmap/client";
import { subscribePushStateChanges } from "@/lib/push-events";
import { createMailPushListener } from "@/lib/mail-push-listener";
import { runBatchEmailAction } from "@/lib/email-action-toast";
import { MailboxShareDialog } from "@/components/layout/mailbox-share-dialog";
import { ShareNotificationToaster } from "@/components/layout/share-notification-toaster";
import { CalendarEventNotificationToaster } from "@/components/layout/calendar-event-notification-toaster";
import { useAuthStore, redirectToLogin, saveRedirectAfterLogin, canEnterLoginInPlace } from '@/stores/auth-store';
import { useRouter } from '@/i18n/navigation';
import { useSettingsStore } from "@/stores/settings-store";
import { useEffectiveMailLayout } from "@/hooks/use-effective-mail-layout";
import { useContactStore } from "@/stores/contact-store";
import { useIdentityStore } from "@/stores/identity-store";
import { useUIStore } from "@/stores/ui-store";
import { useDeviceDetection } from "@/hooks/use-media-query";
import { usePaneSize } from "@/hooks/use-pane-size";
import { usePaneId } from "@/hooks/use-pane-context";
import { useKeyboardShortcuts, type GoToMailboxTarget } from "@/hooks/use-keyboard-shortcuts";
import { findNextUnreadIndex } from "@/lib/next-unread-email";
import { useRefreshGesture } from "@/hooks/use-refresh-gesture";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { usePromptDialog } from "@/hooks/use-prompt-dialog";
import { useBrowserNavigation, type NavSnapshot } from "@/hooks/use-browser-navigation";
import { debug } from "@/lib/debug";
import { playNotificationSound } from "@/lib/notification-sound";
import { cn, formatDateTime, getMailboxPath } from "@/lib/utils";
import { localizeMailboxName } from "@/lib/mailbox-label";
import { KEYWORD_PREFIX, KEYWORD_PREFIX_LEGACY, emailKeyFor, groupEmailsByThread, threadKeyFor } from "@/lib/thread-utils";
import { resolveThreadRoute } from "@/lib/thread-routing";
import {
  ErrorBoundary,
  SidebarErrorFallback,
  EmailListErrorFallback,
  EmailViewerErrorFallback,
  ComposerErrorFallback,
} from "@/components/error";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import { TotpReauthDialog } from "@/components/totp-reauth-dialog";
import { DragDropProvider } from "@/contexts/drag-drop-context";
import { jmapErrorType } from "@/lib/jmap/jmap-error";
import { isFilterEmpty, activeFilterCount, DEFAULT_SEARCH_FILTERS } from "@/lib/jmap/search-utils";
import { SearchBox, type ContactSearchField } from "@/components/search/search-box";
import { FilterPanelHost } from "@/components/search/filter-panel-host";
import type { ContactSuggestion } from "@/lib/search-suggestions";
import type { Attachment } from "@/lib/jmap/types";
import { peekListAttachments, requestListAttachments, type ListAttachmentSource, type LoadListAttachments } from "@/lib/list-attachments";
import { useSearchHistoryStore } from "@/stores/search-history-store";
import { WelcomeBanner } from "@/components/ui/welcome-banner";
import { NavigationRail } from "@/components/layout/navigation-rail";
import { MvTopBar } from "@/components/layout/mv-top-bar";
import { PluginActions } from "@/components/plugins/plugin-actions";
import { useAppCommands } from "@/lib/app-commands";
import { MvSearchForm } from "@/components/search/mv-search-form";
import { MvSidePanel } from "@/components/layout/mv-side-panel";
import { MvListToolbar } from "@/components/email/mv-list-toolbar";
import { SidebarAppsModal } from "@/components/layout/sidebar-apps-modal";
import { InlineAppView } from "@/components/layout/inline-app-view";
import { getDraftTextBody } from '@/lib/email-body-selection';
import { useSidebarApps } from "@/hooks/use-sidebar-apps";
import { useIdentitySync } from "@/hooks/use-identity-sync";
import { useIsEmbedded } from "@/hooks/use-is-embedded";
import { useProTabStore } from "@/stores/pro-tab-store";
import { useProMultiAccountMailboxes } from "@/hooks/use-pro-multi-account-mailboxes";
import { Input } from "@/components/ui/input";
import { FilePreviewModal } from "@/components/files/file-preview-modal";
import { WopiEditor } from "@/components/files/wopi-editor";
import { useWopiStatus, canWopiOpen } from "@/hooks/use-wopi-status";
import { isFilePreviewable } from "@/lib/file-preview";
import { appendHtmlSignature, appendPlainTextSignature } from "@/lib/signature-utils";
import { computeReplyThreadingHeaders } from "@/lib/email-threading";
import { EML_IMPORT_ACCEPT, expandImportableEmails } from "@/lib/eml-import";
import { findDraftIdentityId, findReplyIdentityId, resolveComposeAccountEmail } from "@/lib/reply-identity";
import { buildReplyRecipients, isSelfSent } from "@/lib/reply-recipients";
import { useProMultiAccountIdentities } from "@/hooks/use-pro-multi-account-identities";
import { Filter, ChevronDown, X, Paperclip, Star, Mail, MailOpen, RotateCcw, PenSquare, PenLine, CheckSquare, Square, AlertTriangle, ArrowLeft } from "@/components/icons";
import { ResizeHandle } from "@/components/layout/resize-handle";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { mailTitleContext } from "@/lib/tab-title";
import { usePluginStore } from "@/stores/plugin-store";
import { AppTopBannerSlot } from "@/components/plugins/app-top-banner-slot";
import { useThemeStore } from "@/stores/theme-store";
import { consumePendingMailto, subscribeToPendingMailto } from "@/lib/protocol-handlers/session";
import { INTERNAL_MAILTO_EVENT, type ParsedMailto } from "@/lib/protocol-handlers/mailto";
import { PLUGIN_REPLY_EVENT, type PluginReplyRequest } from "@/lib/plugin-sandbox/host-api-compose";
import { mailtoComposerDraft } from "./mailto-draft";
import { getQuoteBodies } from "@/lib/email-composer-utils";
import { emailHooks } from "@/lib/plugin-hooks";
import { afterRequestDispatch } from "@/lib/after-request-dispatch";
import { useStableHandlers } from "@/hooks/use-stable-handlers";
import { prefetchEmailContent, requestEmailContent } from "@/lib/email-prefetch";
import { createMailboxWithHooks } from "@/lib/plugin-mail-hooks";
import { emailToReadView } from "@/lib/plugin-projection";
import { emitThreadExpand } from "@/lib/plugin-thread-expand";
import { announceSent, cancelAnnouncedSend, releaseAnnouncedSend } from "@/lib/plugin-after-send";
import { composeOptionsFor, runBeforeCompose, type ComposePrefill, type ComposerOpenMode } from "@/lib/plugin-compose-gate";
import { formatMailto } from "@/lib/protocol-handlers/mailto";
import { buildQuoteHeader } from "@/lib/quote-header";
import { buildComposeTabTitle, buildReplySubject } from "@/lib/subject-prefix";
import { buildForwardAsAttachmentPayload, buildBatchForwardAsAttachmentPayload } from "@/lib/forward-as-attachment";
import { getEffectiveLocale } from '@/i18n/detect-locale';
import {
  SCHEDULED_MAILBOX_ID,
  parseScheduledMailboxId,
  appPath,
  buildMailPath,
  isFolderLinkOpen,
  parseMailPath,
  resolveFolderRef,
  type MailDeepLink,
} from "@/lib/deep-links";
import { consumePendingDeepLink, subscribePendingDeepLink } from "@/lib/deep-link-handoff";
import { useProInterfaceActive } from "@/components/pro/pro-interface-redirect";
import type { QuoteHeader } from "@/lib/plugin-types";
import { initialLinkSearch, useLiteLinkSegments } from "@/hooks/use-lite-link-segments";

export interface MailAppProps {
  /**
   * Path segments after `/mail` (`['message', '<id>']`). Applied once, after
   * the JMAP session is up; see the deep-link effect below.
   */
  linkSegments?: string[];
}


/**
 * The folder list once it has been reloaded after an account switch. Until
 * then the store holds the previous mailbox's folders, or none, and resolving
 * a folder link against them reports a folder that is merely not loaded yet
 * as gone - or, worse, finds the previous mailbox's folder of that name.
 */
function freshMailboxes(previous: Mailbox[], timeoutMs = 10_000): Promise<Mailbox[]> {
  const ready = (mailboxes: Mailbox[]) => mailboxes !== previous && mailboxes.length > 0;
  const now = useEmailStore.getState().mailboxes;
  if (ready(now)) return Promise.resolve(now);
  return new Promise((resolve) => {
    const finish = (mailboxes: Mailbox[]) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(mailboxes);
    };
    const timer = setTimeout(() => finish(useEmailStore.getState().mailboxes), timeoutMs);
    const unsubscribe = useEmailStore.subscribe((state) => {
      if (ready(state.mailboxes)) finish(state.mailboxes);
    });
  });
}

/**
 * How long opening a Mountain View message waits for its conversation once the
 * message itself has loaded, before showing it with a placeholder. (#1223)
 */
const MV_CONVERSATION_WAIT_MS = 800;

/** Plugin buttons in the top bar are not about any one item. */
const TOP_BAR_CONTEXT: Record<string, unknown> = {};

/** The unified views list every login's mail, so a background login's push reaches the list (#1350). */
const UNIFIED_LIST_PUSH = {
  isUnifiedView: () => useEmailStore.getState().isUnifiedView,
  refreshList: () => {
    const active = useAuthStore.getState().client;
    return active ? useEmailStore.getState().refreshCurrentMailbox(active) : undefined;
  },
};

export function MailApp({ linkSegments: routeSegments }: MailAppProps = {}) {
  // Static Lite build: the route params are empty, read the link from the URL.
  const linkSegments = useLiteLinkSegments('mail', routeSegments);
  const t = useTranslations();
  const tCommon = useTranslations('common');
  const appName = productName(useConfig().appName);
  const tQuote = useTranslations('quote_header');
  const tComposer = useTranslations('email_composer');
  const tViewer = useTranslations('email_viewer');
  const mailLayout = useEffectiveMailLayout();
  const interfaceLayout = useSettingsStore((state) => state.interfaceLayout);
  // Phones present search full-screen from the header field rather than
  // giving it a permanent second bar under the header.
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const [composerMode, setComposerMode] = useState<'compose' | 'reply' | 'replyAll' | 'forward'>('compose');
  const [composerDraftText, setComposerDraftText] = useState("");
  const [pendingDraft, setPendingDraft] = useState<ComposerDraftData | null>(null);
  const [composerSessionId, setComposerSessionId] = useState(0);
  // Fields a plugin filled in through onBeforeCompose for the composer about
  // to open. Dropped once the composer hands its own state back, so a
  // remount restores what the user wrote instead.
  const [composerPrefill, setComposerPrefill] = useState<ComposePrefill | null>(null);
  // Plugin-resolved quote header for the next reply/forward composer open.
  // Cleared on close so a subsequent "compose new" doesn't reuse stale state.
  const [composerQuoteHeader, setComposerQuoteHeader] = useState<QuoteHeader | null>(null);
  const suppressComposerStateSaveSessionRef = useRef<number | null>(null);
  // The inline composer publishes its dirty-aware close here (the Pro tab bar
  // already uses the same seam), so entry points that replace the session can
  // ask before discarding unsaved text.
  const composerRequestCloseRef = useRef<((afterClose?: () => void) => void) | null>(null);
  const { dialogProps: confirmDialogProps, confirm: confirmDialog } = useConfirmDialog();
  const { dialogProps: promptDialogProps, prompt: promptDialog } = usePromptDialog();
  const { showAppsModal, inlineApp, loadedApps, handleManageApps, handleInlineApp, closeInlineApp, closeAppsModal } = useSidebarApps();
  const [initialCheckDone, setInitialCheckDone] = useState(() => useAuthStore.getState().isAuthenticated && !!useAuthStore.getState().client);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const [showAdvancedFields, setShowAdvancedFields] = useState(false);
  // Column resize state (disable transitions during drag)
  const [isResizing, setIsResizing] = useState(false);
  const dragStartWidth = useRef(0);
  // Mobile conversation view state
  const [conversationBlobSource, setConversationBlobSource] = useState<EmailBlobContext | undefined>();
  const conversationOpenSeqRef = useRef(0);
  const [conversationThread, setConversationThread] = useState<ThreadGroup | null>(null);
  // Mountain View writes replies in place under the conversation until the
  // user pops one out into the docked window.
  const [mvReplyPoppedOut, setMvReplyPoppedOut] = useState(false);
  useEffect(() => {
    if (!showComposer) setMvReplyPoppedOut(false);
  }, [showComposer]);
  const handleMvPopOut = useCallback(() => setMvReplyPoppedOut(true), []);
  // Mountain View: the open message's whole conversation, light properties only.
  const [mvConversationResult, setMvConversationResult] = useState<{
    emails: Email[]; source: EmailBlobContext; threadId: string;
  } | null>(null);
  // The thread whose conversation is being fetched, so the viewer waits for it
  // instead of showing the message alone first. (#1223)
  const [mvConversationLoading, setMvConversationLoading] = useState<string | null>(null);
  const mvConversationLoadRef = useRef<{
    client: NonNullable<EmailBlobContext['client']>; accountId?: string;
    threadId: string; emailId: string; startedAt: number; promise: Promise<Email[] | null>;
  } | null>(null);
  const mvConversationOpenSeqRef = useRef(0);
  const [conversationEmails, setConversationEmails] = useState<Email[]>([]);
  const [isLoadingConversation, setIsLoadingConversation] = useState(false);
  const [rateLimitSecondsLeft, setRateLimitSecondsLeft] = useState<number | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<{ blobId: string; name: string; type?: string; accountId?: string; client: NonNullable<typeof client> } | null>(null);
  // Office attachments open read-only in the configured WOPI editor (#1047).
  const [officeAttachment, setOfficeAttachment] = useState<{ blobId: string; name: string; type?: string; size?: number; accountId: string; slot: number | null } | null>(null);
  const wopiStatus = useWopiStatus(true);
  const [pendingMailtoAccountChoice, setPendingMailtoAccountChoice] = useState<ParsedMailto | null>(null);
  const [isProtocolAccountSwitching, setIsProtocolAccountSwitching] = useState(false);
  const markAsReadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastUndoToastSubmissionRef = useRef<string | null>(null);
  const initialMailLoadClientRef = useRef<object | null>(null);
  // Whether the bootstrap fetch for the default mailbox has landed. Deep links
  // wait for it so their folder switch isn't overwritten (#733).
  const [initialMailLoadDone, setInitialMailLoadDone] = useState(false);
  // Counts opens, so a slow fetch can tell it was overtaken (handleEmailSelect).
  const emailOpenSeqRef = useRef(0);
  const { isAuthenticated, client, logout, checkAuth, switchAccount, activeAccountId, isLoading: authLoading, connectionLost, isRateLimited, rateLimitUntil } = useAuthStore(useShallow((state) => ({
    isAuthenticated: state.isAuthenticated,
    client: state.client,
    logout: state.logout,
    checkAuth: state.checkAuth,
    switchAccount: state.switchAccount,
    activeAccountId: state.activeAccountId,
    isLoading: state.isLoading,
    connectionLost: state.connectionLost,
    isRateLimited: state.isRateLimited,
    rateLimitUntil: state.rateLimitUntil,
  })));
  const { identities } = useIdentityStore(useShallow((state) => ({ identities: state.identities })));
  const multiAccountIdentities = useProMultiAccountIdentities();
  useIdentitySync();
  const trustedSendersAddressBook = useSettingsStore((state) => state.trustedSendersAddressBook);
  const sendDelaySeconds = useSettingsStore((state) => state.sendDelaySeconds);
  const { loadTrustedSendersBook, trustedSendersLoaded, loadRecentRecipients } = useContactStore(useShallow((state) => ({ loadTrustedSendersBook: state.loadTrustedSendersBook, trustedSendersLoaded: state.trustedSendersLoaded, loadRecentRecipients: state.loadRecentRecipients })));

  const promptForRescheduleDelayedUntil = useCallback((): string | null => {
    const value = window.prompt(t('email_viewer.reschedule_prompt'));
    if (!value) return null;
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) {
      toast.error(t('email_composer.schedule_send_invalid'));
      return null;
    }
    if (time <= Date.now()) {
      toast.error(t('email_composer.schedule_send_future'));
      return null;
    }
    if (!client?.hasDelayedSend()) {
      toast.error(t('email_composer.schedule_send_unsupported'));
      return null;
    }
    const maxDelayedSend = client.getMaxDelayedSend();
    if (maxDelayedSend > 0 && time > Date.now() + maxDelayedSend * 1000) {
      toast.error(t('email_composer.schedule_send_too_late'));
      return null;
    }
    return new Date(time).toISOString();
  }, [client, t]);

  // Load trusted senders address book when feature is enabled
  useEffect(() => {
    if (trustedSendersAddressBook && client && !trustedSendersLoaded) {
      loadTrustedSendersBook(client);
    }
  }, [trustedSendersAddressBook, client, trustedSendersLoaded, loadTrustedSendersBook]);

  useEffect(() => {
    if (!isRateLimited || !rateLimitUntil) {
      setRateLimitSecondsLeft(null);
      return;
    }

    const updateCountdown = () => {
      const seconds = Math.max(1, Math.ceil((rateLimitUntil - Date.now()) / 1000));
      setRateLimitSecondsLeft(seconds);
    };

    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, [isRateLimited, rateLimitUntil]);

  // Window, selection and navigation events for plugins are fired app-wide
  // by components/providers/plugin-app-events.tsx.

  // Mobile/tablet responsive hooks
  const { isMobile, isTablet } = useDeviceDetection();
  const isEmbedded = useIsEmbedded();
  /**
   * Mountain View's list cursor. `j` / `k` there move a highlight without
   * opening the conversation, marking it read or changing the URL - only
   * Enter / `o` / a click do that. The app otherwise treats "selected" and
   * "open" as the same thing, so Mountain View keeps the selection (every
   * action already targets it) and records that it is only a cursor.
   */
  const [cursorOnly, setCursorOnly] = useState(false);
  // Desktop lifts search into a global header. Mobile keeps its native
  // one-pane flow, with Mountain View's own app chrome.
  const mvShell = interfaceLayout === 'mountain-view' && !isMobile && !isTablet && !isEmbedded;
  const mvMobile = interfaceLayout === 'mountain-view' && isMobile && !isEmbedded;
  // Mountain View reads a thread as one conversation in the viewer, on the
  // phone as on the desktop, so both show the same order and details. (#1224)
  const mvConversationView = mvShell || mvMobile;
  // Pane hosting (Pro shell). When this app renders inside a Pro pane, the
  // pane publishes its width and id; `isMobile` above is then pane-based,
  // and layout that would use viewport-fixed positioning must scope itself
  // to the pane instead (`paneMobile` below).
  const paneWidth = usePaneSize();
  const proPaneId = usePaneId();
  const isPaneScoped = paneWidth !== null;
  const paneMobile = isPaneScoped && isMobile;
  // Persisted column widths are viewport-sized; inside a (possibly split)
  // pane they must never exceed the pane, or the layout stays "squeezed"
  // after a split closes and reopens at a different size.
  const clampEmailListWidth = (width: number) =>
    paneWidth !== null ? Math.min(width, Math.max(220, Math.floor(paneWidth * 0.55))) : width;
  const { activeView, sidebarOpen, setSidebarOpen, setActiveView, tabletListVisible, setTabletListVisible, sidebarWidth, emailListWidth, emailListHeight, setSidebarWidth, setEmailListWidth, setEmailListHeight, persistColumnWidths, sidebarCollapsed, resetSidebarWidth, resetEmailListWidth, resetEmailListHeight } = useUIStore(useShallow((state) => ({
    activeView: state.activeView,
    sidebarOpen: state.sidebarOpen,
    setSidebarOpen: state.setSidebarOpen,
    setActiveView: state.setActiveView,
    tabletListVisible: state.tabletListVisible,
    setTabletListVisible: state.setTabletListVisible,
    sidebarWidth: state.sidebarWidth,
    emailListWidth: state.emailListWidth,
    emailListHeight: state.emailListHeight,
    setSidebarWidth: state.setSidebarWidth,
    setEmailListWidth: state.setEmailListWidth,
    setEmailListHeight: state.setEmailListHeight,
    persistColumnWidths: state.persistColumnWidths,
    sidebarCollapsed: state.sidebarCollapsed,
    resetSidebarWidth: state.resetSidebarWidth,
    resetEmailListWidth: state.resetEmailListWidth,
    resetEmailListHeight: state.resetEmailListHeight,
  })));
  const {
    emails,
    mailboxes,
    selectedEmail,
    selectedMailbox,
    quota,
    isPushConnected,
    newEmailNotification,
    selectEmail,
    selectMailbox,
    selectedEmailKeys,
    selectAllEmails,
    clearSelection,
    toggleEmailSelection,
    fetchMailboxes,
    fetchEmails,
    fetchQuota,
    sendEmail,
    deleteEmail,
    markAsRead,
    toggleStar,
    patchEmailKeywords,
    moveToMailbox,
    moveToMailboxCrossAware,
    moveThreadToMailbox,
    searchEmails,
    searchQuery,
    setSearchQuery,
    isLoading,
    isLoadingEmail,
    setLoadingEmail,
    beginOpenEmail,
    finishOpenEmail,
    abandonOpenEmail,
    handleStateChange,
    clearNewEmailNotification,
    markAsSpam,
    undoSpam,
    searchFilters,
    searchMailboxId,
    isAdvancedSearchOpen,
    setSearchFilters,
    setSearchMailboxId,
    scopeSearchToOpenFolder,
    clearSearchFilters,
    toggleAdvancedSearch,
    advancedSearch,
    selectedKeyword,
    selectKeyword,
    hasMoreEmails,
    fetchTagCounts,
    fetchEmailContent,
    isUnifiedView,
    unifiedRole,
    scheduledEmails,
    scheduledTotal,
    scheduledTotalByAccount,
    scheduledHasMore,
    isLoadingScheduled,
    isScheduledView,
    scheduledAccountScope,
    setScheduledView,
    fetchScheduledEmails,
    loadMoreScheduledEmails,
    cancelScheduledEmailForEdit,
    rescheduleScheduledEmail,
    refreshScheduledMetadata,
    cancelUndoSend,
    clearPendingUndoSend,
    pendingUndoSend,
    fetchUnifiedEmails: fetchUnifiedEmailsAction,
    fetchCrossView: fetchCrossViewAction,
    refreshUnifiedCounts,
    refreshCrossCounts,
    crossUnreadCount,
    exitUnifiedView,
    emptyMailbox,
    markMailboxAsRead,
    createMailbox,
    renameMailbox,
    deleteMailbox,
    batchDelete,
    batchArchive,
    batchMarkAsRead,
    batchMarkAsSpam,
    batchUndoSpam,
    accountMailboxes,
    viewingAccountId,
    selectAccountMailbox,
    setViewingAccount,
    refreshCurrentMailbox,
  } = useEmailStore(useShallow((state) => ({
    emails: state.emails,
    mailboxes: state.mailboxes,
    selectedEmail: state.selectedEmail,
    selectedMailbox: state.selectedMailbox,
    quota: state.quota,
    isPushConnected: state.isPushConnected,
    newEmailNotification: state.newEmailNotification,
    selectEmail: state.selectEmail,
    selectMailbox: state.selectMailbox,
    selectedEmailKeys: state.selectedEmailKeys,
    selectAllEmails: state.selectAllEmails,
    clearSelection: state.clearSelection,
    toggleEmailSelection: state.toggleEmailSelection,
    fetchMailboxes: state.fetchMailboxes,
    fetchEmails: state.fetchEmails,
    fetchQuota: state.fetchQuota,
    sendEmail: state.sendEmail,
    deleteEmail: state.deleteEmail,
    markAsRead: state.markAsRead,
    toggleStar: state.toggleStar,
    patchEmailKeywords: state.patchEmailKeywords,
    moveToMailbox: state.moveToMailbox,
    moveToMailboxCrossAware: state.moveToMailboxCrossAware,
    moveThreadToMailbox: state.moveThreadToMailbox,
    searchEmails: state.searchEmails,
    searchQuery: state.searchQuery,
    setSearchQuery: state.setSearchQuery,
    isLoading: state.isLoading,
    isLoadingEmail: state.isLoadingEmail,
    setLoadingEmail: state.setLoadingEmail,
    beginOpenEmail: state.beginOpenEmail,
    finishOpenEmail: state.finishOpenEmail,
    abandonOpenEmail: state.abandonOpenEmail,
    handleStateChange: state.handleStateChange,
    clearNewEmailNotification: state.clearNewEmailNotification,
    markAsSpam: state.markAsSpam,
    undoSpam: state.undoSpam,
    searchFilters: state.searchFilters,
    searchMailboxId: state.searchMailboxId,
    isAdvancedSearchOpen: state.isAdvancedSearchOpen,
    setSearchFilters: state.setSearchFilters,
    setSearchMailboxId: state.setSearchMailboxId,
    scopeSearchToOpenFolder: state.scopeSearchToOpenFolder,
    clearSearchFilters: state.clearSearchFilters,
    toggleAdvancedSearch: state.toggleAdvancedSearch,
    advancedSearch: state.advancedSearch,
    selectedKeyword: state.selectedKeyword,
    selectKeyword: state.selectKeyword,
    hasMoreEmails: state.hasMoreEmails,
    fetchTagCounts: state.fetchTagCounts,
    fetchEmailContent: state.fetchEmailContent,
    isUnifiedView: state.isUnifiedView,
    unifiedRole: state.unifiedRole,
    scheduledEmails: state.scheduledEmails,
    scheduledTotal: state.scheduledTotal,
    scheduledTotalByAccount: state.scheduledTotalByAccount,
    scheduledHasMore: state.scheduledHasMore,
    isLoadingScheduled: state.isLoadingScheduled,
    isScheduledView: state.isScheduledView,
    scheduledAccountScope: state.scheduledAccountScope,
    setScheduledView: state.setScheduledView,
    fetchScheduledEmails: state.fetchScheduledEmails,
    loadMoreScheduledEmails: state.loadMoreScheduledEmails,
    cancelScheduledEmailForEdit: state.cancelScheduledEmailForEdit,
    rescheduleScheduledEmail: state.rescheduleScheduledEmail,
    refreshScheduledMetadata: state.refreshScheduledMetadata,
    cancelUndoSend: state.cancelUndoSend,
    clearPendingUndoSend: state.clearPendingUndoSend,
    pendingUndoSend: state.pendingUndoSend,
    fetchUnifiedEmails: state.fetchUnifiedEmails,
    fetchCrossView: state.fetchCrossView,
    refreshUnifiedCounts: state.refreshUnifiedCounts,
    refreshCrossCounts: state.refreshCrossCounts,
    crossUnreadCount: state.crossUnreadCount,
    exitUnifiedView: state.exitUnifiedView,
    emptyMailbox: state.emptyMailbox,
    markMailboxAsRead: state.markMailboxAsRead,
    createMailbox: state.createMailbox,
    renameMailbox: state.renameMailbox,
    deleteMailbox: state.deleteMailbox,
    batchDelete: state.batchDelete,
    batchArchive: state.batchArchive,
    batchMarkAsRead: state.batchMarkAsRead,
    batchMarkAsSpam: state.batchMarkAsSpam,
    batchUndoSpam: state.batchUndoSpam,
    accountMailboxes: state.accountMailboxes,
    viewingAccountId: state.viewingAccountId,
    selectAccountMailbox: state.selectAccountMailbox,
    setViewingAccount: state.setViewingAccount,
    refreshCurrentMailbox: state.refreshCurrentMailbox,
  })));

  // Mailboxes of the account currently being browsed. Mirrors the store's
  // action-mailbox resolution so a lookup by `selectedMailbox` hits the same
  // list the email fetch used.
  const viewMailboxes = useMemo(
    () => (viewingAccountId ? (accountMailboxes[viewingAccountId] ?? mailboxes) : mailboxes),
    [viewingAccountId, accountMailboxes, mailboxes],
  );

  // Search panel's Folder dropdown: own folders flat, shared/group folders
  // under their owner account so a group's "Inbox" is not mistaken for the
  // user's own (#1082).
  const searchScopeFolders = useMemo(() => groupSearchScopeFolders(mailboxes), [mailboxes]);

  // Load recent recipients (from the Sent folder) for compose autocomplete.
  // Runs once when the Sent mailbox is known; the store guards against reloads.
  // Keyed on the folder's id, not the folder list, which changes with every
  // count; and started when the browser is idle, since it reads up to 300
  // messages that only the composer needs.
  const sentMailboxId = useMemo(() => {
    const sent = mailboxes.find((m) => m.role === 'sent');
    return sent ? sent.originalId || sent.id : null;
  }, [mailboxes]);
  useEffect(() => {
    if (!client || !sentMailboxId) return;
    const run = () => { void loadRecentRecipients(client, sentMailboxId); };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(run, { timeout: 5000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(run, 1000);
    return () => window.clearTimeout(timer);
  }, [client, sentMailboxId, loadRecentRecipients]);

  // Pro shell: populate per-account mailbox cache so the sidebar can render
  // every connected account Thunderbird-style.
  useProMultiAccountMailboxes();

  const enableUnifiedMailbox = useSettingsStore((s) => s.enableUnifiedMailbox);
  const delayedSendSupported = client?.hasDelayedSend() ?? true;

  // Cross-account "All accounts" views: a sub-feature of the unified mailbox, so
  // they require Unified Mailbox to be enabled, plus the admin gate and the
  // per-user setting. Hooks are called unconditionally.
  const crossUnreadGate = usePolicyStore((s) => s.isFeatureEnabled('crossUnreadViewEnabled'));
  const crossStarredGate = usePolicyStore((s) => s.isFeatureEnabled('crossStarredViewEnabled'));
  const crossAllGate = usePolicyStore((s) => s.isFeatureEnabled('crossAllViewEnabled'));
  const enableCrossUnreadView = useSettingsStore((s) => s.enableCrossUnreadView);
  const enableCrossStarredView = useSettingsStore((s) => s.enableCrossStarredView);
  const enableCrossAllView = useSettingsStore((s) => s.enableCrossAllView);
  const showCrossUnread = enableUnifiedMailbox && crossUnreadGate && enableCrossUnreadView;
  const showCrossStarred = enableUnifiedMailbox && crossStarredGate && enableCrossStarredView;
  const showCrossAll = enableUnifiedMailbox && crossAllGate && enableCrossAllView;
  // A shared account's "Scheduled" row narrows the (account-aggregated)
  // scheduled list to that account; the own row shows everything.
  const scopedScheduledEmails = useMemo(
    () => scheduledAccountScope
      ? scheduledEmails.filter(email => email.scheduledAccountId === scheduledAccountScope)
      : scheduledEmails,
    [scheduledEmails, scheduledAccountScope],
  );
  const activeEmails = isScheduledView ? scopedScheduledEmails : emails;
  // In an account-scoped scheduled view the visible rows are a filtered subset
  // of the loaded page, so "has more" must reflect that account's own total
  // rather than the combined one — otherwise the list looks complete while
  // later pages still hold mail for this account (or vice versa).
  const scopedScheduledHasMore = scheduledAccountScope
    ? scopedScheduledEmails.length < (scheduledTotalByAccount?.[scheduledAccountScope] ?? 0)
    : scheduledHasMore;
  const activeHasMore = isScheduledView ? scopedScheduledHasMore : hasMoreEmails;
  const activeIsLoading = isScheduledView ? isLoadingScheduled : isLoading;
  const includeGroupInUnified = useSettingsStore((s) => s.includeGroupInUnified);
  const unifiedCrossAccount = useSettingsStore((s) => s.unifiedCrossAccount);
  const unifiedCrossAccountGate = usePolicyStore((s) => s.isFeatureEnabled('unifiedCrossAccountEnabled'));
  const archiveActionEnabled = useArchiveActionEnabled();
  const accounts = useAccountStore((s) => s.accounts);
  const connectedAccountsSignature = useMemo(
    () => accounts.filter((a) => a.isConnected).map((a) => a.id).sort().join(","),
    [accounts],
  );
  // Cross-account is "active" when the user opted in, the admin allows it, and
  // more than one account is connected. Drives the sidebar header label: the
  // old "All accounts" when spanning accounts, else "Unified Mailbox".
  const crossAccountActive =
    unifiedCrossAccount &&
    unifiedCrossAccountGate &&
    accounts.filter((a) => a.isConnected).length > 1;

  // Mountain View's account popover offers the merged inbox above the addresses it
  // merges. Offering it when it cannot be built would give a row that selects
  // an empty list, so it appears on exactly the terms the sidebar's own
  // unified section does.
  const allInboxesReachable = enableUnifiedMailbox && crossAccountActive;
  const allInboxesSelected = selectedMailbox === UNIFIED_MAILBOX_IDS.inbox;

  // The node the Mountain View top bar renders under its search field; the filter
  // panel is portalled into it so it hangs off the control that opens it.
  const [filterAnchor, setFilterAnchor] = useState<HTMLDivElement | null>(null);

  // Builds the populated UnifiedAccountClient[] used by the unified-view
  // effects and one-shot actions in this page. Reads the settings at call time
  // so the latest toggle values are always honored. When the cross-account
  // sub-option is off, the unified mailbox stays within the active account
  // boundary (its own + shared folders); when on, it spans every login account.
  const buildPopulatedUnifiedAccounts = useCallback(async (): Promise<UnifiedAccountClient[]> => {
    // Cross-account scope requires both the per-user opt-in and the admin
    // capability gate; otherwise stay within the active account boundary.
    const crossAccount = useSettingsStore.getState().unifiedCrossAccount
      && usePolicyStore.getState().isFeatureEnabled('unifiedCrossAccountEnabled');
    return buildUnifiedAccountClients({
      includeGroup: useSettingsStore.getState().includeGroupInUnified,
      scopeToClientAccountId: crossAccount
        ? undefined
        : (useAccountStore.getState().activeAccountId ?? undefined),
    });
  }, []);

  const getMailtoProtocolAccounts = useCallback(() => {
    const connectedClients = useAuthStore.getState().getAllConnectedClients();
    return useAccountStore.getState().accounts.filter((account) =>
      account.isConnected && connectedClients.has(account.id)
    );
  }, []);

  // Browser back / forward integration. The restore handler reads the
  // latest values from a ref so we don't have to recreate the callback on
  // every render (and so the popstate listener is never stale).
  const navRestoreStateRef = useRef({
    client,
    emails,
    mailboxes,
    selectedMailbox,
    selectedEmailId: selectedEmail?.id ?? null,
    conversationThreadId: null as string | null,
  });
  navRestoreStateRef.current.client = client;
  navRestoreStateRef.current.emails = activeEmails;
  navRestoreStateRef.current.mailboxes = mailboxes;
  navRestoreStateRef.current.selectedMailbox = selectedMailbox;
  navRestoreStateRef.current.selectedEmailId = selectedEmail?.id ?? null;
  navRestoreStateRef.current.conversationThreadId = conversationThread?.threadId ?? null;

  const handleNavRestore = useCallback(async (state: NavSnapshot) => {
    const ctx = navRestoreStateRef.current;
    let restoredEmails = ctx.emails;

    // Restore sidebar overlay state.
    setSidebarOpen(state.sidebarOpen);

    // Restore composer visibility.
    if (!state.composerOpen) {
      setShowComposer(false);
    }

    // Derive the mobile view from the saved snapshot. The view is a
    // function of which content the user is looking at: an email, a
    // thread, the composer, or the bare list.
    const derivedView: "list" | "viewer" =
      state.emailId || state.threadId || state.composerOpen ? "viewer" : "list";
    setActiveView(derivedView);

    // Restore mailbox selection. selectMailbox clears the current email,
    // which is fine because we re-apply the saved email below.
    if (state.mailboxId === SCHEDULED_MAILBOX_ID) {
      if (!ctx.client?.hasDelayedSend()) {
        setScheduledView(false);
        selectEmail(null);
        return;
      }
      setScheduledView(true);
      selectMailbox(SCHEDULED_MAILBOX_ID);
      selectEmail(null);
      if (ctx.client) {
        try {
          await fetchScheduledEmails(ctx.client);
          restoredEmails = useEmailStore.getState().scheduledEmails;
        } catch (error) {
          debug.error('Failed to fetch scheduled emails on history restore:', error);
        }
      }
    } else if (state.mailboxId && state.mailboxId !== ctx.selectedMailbox) {
      setScheduledView(false);
      selectMailbox(state.mailboxId);
      if (ctx.client) {
        try {
          await fetchEmails(ctx.client, state.mailboxId);
        } catch (error) {
          debug.error('Failed to fetch emails on history restore:', error);
        }
      }
    }

    // Restore conversation thread (mobile only). We can clear it directly,
    // but reopening requires the thread group; if the user pressed forward
    // to return to a thread, we silently skip - back navigation always works.
    if ((state.threadId ?? null) !== ctx.conversationThreadId) {
      if (state.threadId === null) {
        ++conversationOpenSeqRef.current;
        setConversationBlobSource(undefined);
        setConversationThread(null);
        setConversationEmails([]);
      }
    }

    // Restore email selection.
    if (state.emailId !== ctx.selectedEmailId) {
      if (state.emailId === null) {
        selectEmail(null);
      } else {
        // Try the in-memory list first; the existing useEffect will fetch
        // body content if it's missing.
        const found = restoredEmails.find(e => e.id === state.emailId);
        if (found) {
          selectEmail(found);
        } else if (ctx.client) {
          // Email isn't in the current list (e.g. mailbox just changed).
          // Fetch it directly.
          try {
            const mailbox = ctx.mailboxes.find(mb => mb.id === state.mailboxId);
            const accountId = mailbox?.isShared ? mailbox.accountId : undefined;
            const fullEmail = await ctx.client.getEmail(state.emailId, accountId);
            if (fullEmail) selectEmail(fullEmail);
          } catch (error) {
            debug.error('Failed to fetch email on history restore:', error);
          }
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Permalink for a nav snapshot (#733), so the address bar always points at
  // what the user is looking at. Suppressed inside the Pro shell: there the
  // route is /pro and the tab strip owns the URL.
  const proInterfaceActive = useProInterfaceActive();
  // Fullscreen reading (#733): a `?view=fullscreen` message permalink - what a
  // mail dragged out into a new browser tab opens as - shows the message
  // alone, with the folder sidebar and list panes hidden. Cleared when the
  // message is closed, which reveals the normal layout.
  const [fullscreenReading, setFullscreenReading] = useState(false);

  const buildMailUrl = useCallback((state: NavSnapshot) => {
    if (isEmbedded || proInterfaceActive) return null;
    const open = useEmailStore.getState().selectedEmail;
    const shown = open && (open.id === state.emailId || (!!state.threadId && open.threadId === state.threadId)) ? open : null;
    // The shared account of the open message, so a reload opens it again
    // (#1351). Not another login's: a reload must not switch the login.
    const source = shown ? emailLinkSource(shown) : null;
    return appPath(
      buildMailPath(
        {
          mailboxId: state.mailboxId, emailId: state.emailId, threadId: state.threadId,
          ownerAccountId: source && !source.loginId ? source.ownerAccountId : null,
          // Keep the marker while fullscreen is active, so reloading the dragged-out
          // tab reopens the message fullscreen instead of in the normal layout.
          fullscreen: fullscreenReading,
        },
        useEmailStore.getState().mailboxes,
      ),
    );
  }, [isEmbedded, proInterfaceActive, fullscreenReading]);

  useBrowserNavigation({
    mailboxId: selectedMailbox,
    emailId: mvShell && cursorOnly ? null : (selectedEmail?.id ?? null),
    threadId: conversationThread?.threadId ?? null,
    composerOpen: showComposer,
    sidebarOpen,
    onRestore: handleNavRestore,
    enabled: isAuthenticated && mailboxes.length > 0,
    buildUrl: buildMailUrl,
  });

  // A read or star change the server refused (a read-only shared folder)
  // leaves the message as it was; say so rather than fail silently.
  const toastUpdateFailure = (error: unknown) => {
    console.error("Failed to update email:", error);
    toast.error(t('notifications.error_updating'));
  };

  // Keyboard shortcuts handlers
  const keyboardHandlers = useMemo(() => ({
    onNextEmail: () => {
      if (activeEmails.length === 0) return;
      const currentIndex = selectedEmail ? activeEmails.findIndex(e => emailKeyFor(e) === emailKeyFor(selectedEmail)) : -1;
      const nextIndex = currentIndex < activeEmails.length - 1 ? currentIndex + 1 : currentIndex;
      if (nextIndex >= 0 && nextIndex < activeEmails.length) {
        void handleEmailSelect(activeEmails[nextIndex]);
        if (mvShell) setCursorOnly(true);
      }
    },
    onPreviousEmail: () => {
      if (activeEmails.length === 0) return;
      const currentIndex = selectedEmail ? activeEmails.findIndex(e => emailKeyFor(e) === emailKeyFor(selectedEmail)) : activeEmails.length;
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : 0;
      if (prevIndex >= 0 && prevIndex < activeEmails.length) {
        void handleEmailSelect(activeEmails[prevIndex]);
        if (mvShell) setCursorOnly(true);
      }
    },
    // `n`: open the next unread message below the current one, in the order
    // the list has loaded. Only the loaded rows count; say so when none is
    // left instead of wrapping to the top. (#514)
    onNextUnread: () => {
      const nextIndex = findNextUnreadIndex(activeEmails, selectedEmail?.id);
      if (nextIndex === -1) {
        toast.info(t('shortcuts.navigation.no_more_unread'));
        return;
      }
      void handleEmailSelect(activeEmails[nextIndex]);
    },
    onOpenEmail: () => {
      // Outside Mountain View the email is already open by virtue of being
      // selected; under it this is the step that promotes cursor to open.
      setCursorOnly(false);
    },
    onCloseEmail: () => {
      setCursorOnly(false);
      selectEmail(null);
      if (isMobile) {
        setActiveView("list");
      }
      if (isTablet) {
        setTabletListVisible(true);
      }
    },
    onReply: () => {
      if (isScheduledView) return;
      if (selectedEmail) handleReply();
    },
    onReplyAll: () => {
      if (isScheduledView) return;
      if (selectedEmail) handleReplyAll();
    },
    onForward: () => {
      if (isScheduledView) return;
      if (selectedEmail) handleForward();
    },
    onToggleStar: () => {
      if (isScheduledView) return;
      if (selectedEmail) handleToggleStar();
    },
    onArchive: archiveActionEnabled ? async () => {
      if (isScheduledView) return;
      if (shortcutsTargetSelection && client) {
        const count = selectedEmailKeys.size;
        await runBatchEmailAction(() => batchArchive(client), {
          success: t('notifications.emails_archived', { count }),
          error: t('notifications.error_archiving'),
          describeError: (error) => error instanceof ArchiveMailboxNotFoundError
            ? t('email_viewer.archive_mailbox_not_found')
            : undefined,
        });
      } else if (selectedEmail) {
        handleArchive();
      }
    } : undefined,
    onDelete: async () => {
      if (isScheduledView) return;
      if (shortcutsTargetSelection && client) {
        const currentMailbox = mailboxes.find(m => m.id === selectedMailbox);
        const permanent = bulkDeleteIsPermanent(currentMailbox);
        if (shouldConfirmBulkDelete(currentMailbox)) {
          const confirmed = await confirmDialog({
            title: permanent
              ? t('email_list.permanent_delete_confirm_title')
              : t('email_list.batch_actions.delete_confirm_title'),
            message: permanent
              ? t('email_list.permanent_delete_confirm_batch_message', { count: selectedEmailKeys.size })
              : t('email_list.batch_actions.delete_confirm_message', { count: selectedEmailKeys.size }),
            confirmText: permanent
              ? t('email_list.permanent_delete')
              : t('email_list.batch_actions.delete'),
            variant: "destructive",
          });
          if (!confirmed) return;
        }
        const count = selectedEmailKeys.size;
        await runBatchEmailAction(() => batchDelete(client, permanent), {
          success: t('notifications.emails_deleted', { count }),
          error: t('notifications.error_deleting'),
        });
      } else if (selectedEmail) {
        handleDelete();
      }
    },
    onMarkAsUnread: async () => {
      if (isScheduledView) return;
      if (!client) return;
      if (shortcutsTargetSelection) {
        await runBatchEmailAction(() => batchMarkAsRead(client, false), { error: t('notifications.error_updating') });
      } else if (selectedEmail) {
        await markAsRead(client, selectedEmail.id, false, emailKeyFor(selectedEmail)).catch(toastUpdateFailure);
      }
    },
    onMarkAsRead: async () => {
      if (isScheduledView) return;
      if (!client) return;
      if (shortcutsTargetSelection) {
        await runBatchEmailAction(() => batchMarkAsRead(client, true), { error: t('notifications.error_updating') });
      } else if (selectedEmail) {
        await markAsRead(client, selectedEmail.id, true, emailKeyFor(selectedEmail)).catch(toastUpdateFailure);
      }
    },
    onToggleSpam: async () => {
      if (isScheduledView) return;
      // An aggregate role view ("All Junk") selects a virtual folder: its
      // role decides, as for the list's batch actions.
      const currentRole = mailboxes.find(m => m.id === selectedMailbox)?.role
        ?? (isUnifiedView ? (unifiedRole ?? undefined) : undefined);
      // Marking your own outgoing mail as spam makes no sense - the toolbar
      // and menus hide the action in Sent/Drafts/Scheduled, so the shortcut
      // is a no-op there too.
      if (['sent', 'drafts', 'scheduled'].includes(currentRole || '')) return;
      const isInJunk = currentRole === 'junk';
      if (shortcutsTargetSelection && client) {
        // The spam actions take bare ids of the viewed account: resolve the
        // selection keys through the loaded rows and thread members.
        const ids = resolveSelectedEmails(useEmailStore.getState()).map(e => e.id);
        try {
          if (isInJunk) {
            if (await batchUndoSpam(client, ids)) toast.success(t('email_viewer.spam.toast_not_spam_batch', { count: ids.length }));
          } else {
            if (await batchMarkAsSpam(client, ids)) toast.success(t('email_viewer.spam.toast_batch', { count: ids.length }));
          }
        } catch (error) {
          console.error("Failed to batch toggle spam:", error);
          toast.error(t(isInJunk ? 'email_viewer.spam.error_not_spam' : 'email_viewer.spam.error'));
        }
      } else if (selectedEmail) {
        if (isInJunk) {
          handleUndoSpam();
        } else {
          handleMarkAsSpam();
        }
      }
    },
    onCompose: () => {
      void withComposeGate('compose', {}, () => {
        startFreshComposerSession();
        setComposerMode('compose');
        setShowComposer(true);
        if (isMobile) setActiveView('viewer');
      });
    },
    onFocusSearch: () => {
      if (isScheduledView) return;
      const searchInput = document.querySelector('[data-search-input]') as HTMLInputElement;
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
    },
    onShowHelp: () => {
      setShowShortcutsModal(true);
    },
    onRefresh: async () => {
      if (client && selectedMailbox) {
        if (selectedMailbox === SCHEDULED_MAILBOX_ID) {
          await fetchScheduledEmails(client);
        } else {
          await fetchEmails(client, selectedMailbox);
        }
      }
    },
    onSelectAll: () => {
      if (isScheduledView) return;
      selectAllEmails();
    },
    onDeselectAll: () => {
      clearSelection();
    },
    // Shift + ↓/↑ (and Shift + j/k): grow or shrink the ticked range from the
    // open message without opening each row on the way. (#992)
    onExtendSelection: (direction: 1 | -1) => {
      if (isScheduledView) return;
      useEmailStore.getState().extendSelection(direction);
    },
    // `x` under Mountain View: put the focused conversation in or out of the
    // selection. Only reachable there, where `x` is handed over from thread
    // expansion.
    onToggleSelection: () => {
      if (isScheduledView || !selectedEmail) return;
      toggleEmailSelection(selectedEmail);
    },
    // Mountain View's `g` sequences. `g s` goes to the "All starred" view when
    // the user has one - a list you arrive at and leave, like the other `g`
    // destinations. Without it there is no starred destination here, and the
    // fallback is the advanced-search star toggle: it shows the same messages,
    // but as a search you then have to clear. All mail uses the folder the
    // account nominated in Layout settings, falling back to its Archive.
    onGoToMailbox: (target: GoToMailboxTarget) => {
      if (isScheduledView && target !== 'inbox') return;
      if (target === 'starred') {
        goToStarred();
        return;
      }
      const roleFor = { inbox: 'inbox', sent: 'sent', drafts: 'drafts' } as const;
      if (target === 'all') {
        const configured = viewingAccountId
          ? useSettingsStore.getState().allMailFolderIds[viewingAccountId]
          : undefined;
        const allMailId = (typeof configured === 'string' ? configured : undefined)
          ?? mailboxes.find((mb) => mb.role === 'archive')?.id;
        if (allMailId) void handleMailboxSelect(allMailId);
        return;
      }
      const mailbox = mailboxes.find((mb) => mb.role === roleFor[target]);
      if (mailbox) void handleMailboxSelect(mailbox.id);
    },
    // `x` in the help modal: expand/collapse the selected email's thread. Same
    // steps as EmailList.handleToggleThreadExpansion - expanding pulls the
    // thread's messages and marks them read (following markAsReadDelay),
    // collapsing only toggles. (#683)
    onToggleThreadExpansion: () => {
      if (isScheduledView || !client) return;
      if (!selectedEmail?.threadId) return;
      const threadKey = threadKeyFor(selectedEmail);
      const store = useEmailStore.getState();
      const wasExpanded = store.expandedThreadIds.has(threadKey);
      store.toggleThreadExpansion(threadKey);
      const members = () => useEmailStore.getState().threadEmailsCache.get(threadKey)
        ?? activeEmails.filter((e) => e.threadId && threadKeyFor(e) === threadKey);
      if (!wasExpanded) {
        void store.fetchThreadEmails(client, threadKey).then(() => {
          emitThreadExpand(threadKey, members(), true);
          useEmailStore.getState().autoMarkExpandedThreadAsRead(client, threadKey);
        });
      } else {
        emitThreadExpand(threadKey, members(), false);
      }
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [activeEmails, selectedEmail, client, selectedMailbox, isMobile, isTablet, selectedEmailKeys, mailboxes, isScheduledView, mvShell, showCrossStarred, isUnifiedView, unifiedRole, archiveActionEnabled]);

  // Initialize keyboard shortcuts
  // Mountain View keeps the ticked rows while a message is read (#1231). The
  // shortcuts then act on the message on screen, as its toolbar does, and
  // reach the selection again back in the list.
  const shortcutsTargetSelection = selectedEmailKeys.size > 0 && !(mvShell && !cursorOnly && selectedEmail);
  useKeyboardShortcuts({
    enabled: isAuthenticated && !showComposer,
    emails: activeEmails,
    selectedEmailId: selectedEmail?.id,
    selectionCount: selectedEmailKeys.size,
    mountainViewKeys: mvShell,
    handlers: keyboardHandlers,
  });

  // Compose and search from the command palette (components/command-palette).
  useAppCommands({
    compose: keyboardHandlers.onCompose,
    search: () => {
      if (isMobile) setMobileSearchOpen(true);
      else keyboardHandlers.onFocusSearch?.();
    },
  }, isAuthenticated && !!client);

  // Shared mail refresh: re-fetch mailboxes (unread counts) + the active list
  // via JMAP. Used by both the browser refresh gestures and the toolbar button.
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const handleManualRefresh = useCallback(async () => {
    if (!client) return;
    setIsManualRefreshing(true);
    try {
      const state = useEmailStore.getState();
      if (state.isScheduledView || state.selectedMailbox === SCHEDULED_MAILBOX_ID) {
        await Promise.all([
          state.fetchMailboxes(client),
          state.fetchScheduledEmails(client),
        ]);
      } else {
        await state.fetchMailboxes(client);
        await state.refreshScheduledMetadata(client);
        await (state.selectedMailbox ? state.fetchEmails(client, state.selectedMailbox) : state.fetchEmails(client));
      }
    } finally {
      setIsManualRefreshing(false);
    }
  }, [client]);

  // Intercept browser refresh gestures (F5, Ctrl/Cmd+R, pull-to-refresh)
  // and refresh mail data via JMAP instead of reloading the page.
  const { indicator: refreshIndicator } = useRefreshGesture({
    enabled: isAuthenticated && !!client,
    onRefresh: handleManualRefresh,
  });

  useEffect(() => {
    if (!delayedSendSupported && isScheduledView) {
      setScheduledView(false);
    }
  }, [delayedSendSupported, isScheduledView, setScheduledView]);

  useEffect(() => {
    if (!pendingUndoSend) return;
    const pendingSendTime = new Date(pendingUndoSend.sendAt).getTime();
    if (!Number.isFinite(pendingSendTime) || pendingSendTime <= Date.now()) {
      clearPendingUndoSend();
      return;
    }
    const timer = setTimeout(clearPendingUndoSend, pendingSendTime - Date.now());
    return () => clearTimeout(timer);
  }, [clearPendingUndoSend, pendingUndoSend]);

  // Page title: "<context> - <account> - <app>" (see useDocumentTitle)
  // The subject is kept out until the policy has loaded: a gate that keeps
  // subjects out of browser history must not let one through while unknown.
  const subjectInTabTitle = usePolicyStore((s) => s.loaded && s.isFeatureEnabled('tabTitleSubjectEnabled'));
  const titleContext = useMemo(() => {
    // Composing email
    const composer = showComposer
      ? {
          compose: t('email_composer.new_message'),
          reply: t('email_composer.reply'),
          replyAll: t('email_composer.reply_all'),
          forward: t('email_composer.forward'),
        }[composerMode] || t('email_composer.new_message')
      : null;

    // Reading email
    const subject = selectedEmail ? selectedEmail.subject || t('email_viewer.no_subject') : null;

    // Mailbox view
    let mailboxLine: string | null = null;
    const mailbox = selectedMailbox ? mailboxes.find(mb => mb.id === selectedMailbox) : undefined;
    if (mailbox) {
      const mailboxName = localizeMailboxName(mailbox.role, mailbox.name, (k) => t(`sidebar.mailboxes.${k}`));
      const unreadCount = mailbox.unreadEmails || 0;
      mailboxLine = unreadCount > 0 ? `${mailboxName} (${unreadCount})` : mailboxName;
    }

    return mailTitleContext({ composer, subject, mailbox: mailboxLine }, { showSubject: subjectInTabTitle });
  }, [showComposer, composerMode, selectedEmail, selectedMailbox, mailboxes, t, subjectInTabTitle]);
  useDocumentTitle(titleContext);

  // When this page is rendered inside the Pro shell as the Mail tab body,
  // we hoist every "show composer" intent into its own Pro tab and reset
  // the in-page state so the inline composer never appears in the Mail tab.
  // This makes the Pro composer behave like Thunderbird's pop-out window.
  useEffect(() => {
    if (!isEmbedded || !showComposer) return;
    // pendingDraft.replyTo, when set, was built by the opener (e.g.
    // handleForwardAsAttachment) with intent that must survive the hop into
    // the Pro tab - mirrors the same precedence the non-embedded render path
    // uses just below (`replyTo={pendingDraft !== null ? pendingDraft.replyTo
    // : ...}`). Building fresh from selectedEmail unconditionally here would
    // silently drop that intent (e.g. the synthetic message/rfc822
    // attachment "Forward as attachment" stages), falling back to a normal
    // quoted forward instead.
    const replyTo = pendingDraft?.replyTo ?? (selectedEmail ? {
      from: selectedEmail.from,
      replyToAddresses: selectedEmail.replyTo,
      to: selectedEmail.to,
      cc: selectedEmail.cc,
      bcc: selectedEmail.bcc,
      subject: selectedEmail.subject,
      ...getQuoteBodies(selectedEmail),
      receivedAt: selectedEmail.receivedAt,
      // The login that holds the message, so the reply defaults to that
      // account's identity (#1104). Same resolution as the invitation banner.
      accountId: selectedEmail.sourceClientAccountId ?? viewingAccountId ?? undefined,
      attachments: selectedEmail.attachments,
      messageId: selectedEmail.messageId,
      inReplyTo: selectedEmail.inReplyTo,
      references: selectedEmail.references,
      quoteHeaderHtml: composerQuoteHeader?.html,
      quoteHeaderText: composerQuoteHeader?.text,
      quoteWrapInBlockquote: composerQuoteHeader?.wrapInBlockquote,
    } : undefined);

    const effectiveMode = pendingDraft?.mode ?? composerMode;
    const title = buildComposeTabTitle({
      mode: effectiveMode,
      draftSubject: pendingDraft?.subject,
      sourceSubject: selectedEmail?.subject,
      replyPrefix: t('email_composer.prefix.reply'),
      forwardPrefix: t('email_composer.prefix.forward'),
      fallback: t('email_composer.new_message'),
    });

    useProTabStore.getState().openComposeTab({
      sessionId: composerSessionId + 1,
      mode: effectiveMode,
      replyTo,
      initialDraftText: composerDraftText,
      initialData: pendingDraft,
      prefill: composerPrefill,
      sourceEmailId: selectedEmail?.id ?? null,
      sourceEmailSource: selectedEmail ? emailWriteSource(selectedEmail, client) : null,
      title,
    });

    setComposerSessionId((s) => s + 1);
    setShowComposer(false);
    setComposerDraftText("");
    setPendingDraft(null);
    setComposerPrefill(null);
    setComposerQuoteHeader(null);
    // We only react to the rising edge of `showComposer` here; the other
    // variables read above are captured-but-stale-safe because the next
    // open will fire a fresh effect with new values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEmbedded, showComposer]);

  // Check auth on mount – skip when already authenticated so that navigating
  // between routes doesn't retrigger checkAuth's transient `{ client: null,
  // isLoading: true }` reset, which was flashing the spinner on every nav.
  useEffect(() => {
    const state = useAuthStore.getState();
    if (state.isAuthenticated && state.client) {
      setInitialCheckDone(true);
      return;
    }
    checkAuth().finally(() => {
      setInitialCheckDone(true);
    });
  }, [checkAuth]);

  // Initialize plugins on mount (re-activates enabled plugins after refresh)
  // Also syncs server-managed plugins and themes to the client
  useEffect(() => {
    usePluginStore.getState().initializePlugins();
    useThemeStore.getState().syncServerThemes();
  }, []);

  // Hydrate persisted column widths from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem("column-widths");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.sidebarWidth) setSidebarWidth(parsed.sidebarWidth);
        if (parsed.emailListWidth) setEmailListWidth(parsed.emailListWidth);
        if (parsed.emailListHeight) setEmailListHeight(parsed.emailListHeight);
      }
    } catch { /* ignore parse errors */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redirect to login if not authenticated. Without a session so far this is
  // a client-side navigation: reloading would download and start the whole
  // app again just to show the form.
  const router = useRouter();
  useEffect(() => {
    if (initialCheckDone && !isAuthenticated && !authLoading) {
      saveRedirectAfterLogin();
      if (canEnterLoginInPlace()) router.replace('/login');
      else redirectToLogin();
    }
  }, [initialCheckDone, isAuthenticated, authLoading, router]);

  // onBeforeCompose, in front of every way the composer opens. `open` runs
  // once plugins agreed (straight away when none listens); a plugin's
  // prefill goes to the composer through `composerPrefill`.
  const withComposeGate = useCallback(async (
    mode: ComposerOpenMode,
    fields: Omit<NonNullable<Parameters<typeof composeOptionsFor>[1]>, 'ownEmails' | 'replyPrefix' | 'forwardPrefix'>,
    open: () => void,
  ): Promise<boolean> => {
    if (emailHooks.onBeforeCompose.size === 0) {
      setComposerPrefill(null);
      open();
      return true;
    }
    const prefill = await runBeforeCompose(composeOptionsFor(mode, {
      ...fields,
      ownEmails: identities.map((i) => i.email).filter((e): e is string => Boolean(e)),
      replyPrefix: t('email_composer.prefix.reply'),
      forwardPrefix: t('email_composer.prefix.forward'),
    }));
    if (!prefill) return false;
    setComposerPrefill(Object.keys(prefill).length > 0 ? prefill : null);
    open();
    return true;
  }, [identities, t]);

  const applyMailtoDraft = useCallback((pending: ParsedMailto, suppressOutgoingStash: boolean) => {
    if (suppressOutgoingStash) {
      suppressComposerStateSaveSessionRef.current = composerSessionId;
    }
    setComposerSessionId((id) => id + 1);
    setPendingDraft(mailtoComposerDraft(pending, useSettingsStore.getState().plainTextMode));
    setComposerMode("compose");
    setShowComposer(true);
    if (isMobile) setActiveView("viewer");
  }, [composerSessionId, isMobile, setActiveView]);

  const openMailtoDraft = useCallback((pending: ParsedMailto) => withComposeGate('compose', {
    to: pending.to, cc: pending.cc, subject: pending.subject, body: pending.body,
  }, () => {
    // A live composer owns text the user has not sent. Replacing it outright
    // used to drop that text on the floor - the stash suppression below is an
    // ordering fix, not a decision anyone made. Route the request through the
    // composer's own "Save or discard draft?" guard instead and open the
    // mailto draft only once it has actually closed; cancelling leaves the
    // draft alone. No suppression on that path: when a save fails the composer
    // deliberately hands its text back to the continue-draft slot (#702), and
    // that rescue must win over this request.
    const requestClose = composerRequestCloseRef.current;
    if (showComposer && requestClose) {
      requestClose(() => applyMailtoDraft(pending, false));
      return;
    }
    applyMailtoDraft(pending, showComposer);
  }), [applyMailtoDraft, showComposer, withComposeGate]);

  const openMailtoForAccount = useCallback(async (pending: ParsedMailto, accountId: string) => {
    setIsProtocolAccountSwitching(true);
    try {
      if (useAuthStore.getState().activeAccountId !== accountId) {
        await switchAccount(accountId);
      }
      setPendingMailtoAccountChoice(null);
      openMailtoDraft(pending);
    } finally {
      setIsProtocolAccountSwitching(false);
    }
  }, [openMailtoDraft, switchAccount]);

  // onMailtoIntercept: a plugin may stop a mailto: from opening the composer.
  const mailtoAllowed = useCallback(async (pending: ParsedMailto & { href?: string }): Promise<boolean> => {
    if (emailHooks.onMailtoIntercept.size === 0) return true;
    return emailHooks.onMailtoIntercept.intercept({
      href: pending.href ?? formatMailto(pending),
      to: [...pending.to],
      ...(pending.subject ? { subject: pending.subject } : {}),
      ...(pending.body ? { body: pending.body } : {}),
    });
  }, []);

  const handleMailtoProtocolRequest = useCallback(async (pending: ParsedMailto) => {
    if (!(await mailtoAllowed(pending))) return;
    const protocolAccounts = getMailtoProtocolAccounts();
    if (protocolAccounts.length > 1) {
      setPendingMailtoAccountChoice(pending);
      return;
    }

    const accountId = protocolAccounts[0]?.id ?? activeAccountId;
    if (accountId) {
      void openMailtoForAccount(pending, accountId);
      return;
    }

    openMailtoDraft(pending);
  }, [activeAccountId, getMailtoProtocolAccounts, mailtoAllowed, openMailtoDraft, openMailtoForAccount]);

  useEffect(() => {
    if (!isAuthenticated || !client) return;

    const openPendingMailto = () => {
      const pending = consumePendingMailto();
      if (pending) void handleMailtoProtocolRequest(pending);
    };

    openPendingMailto();
    return subscribeToPendingMailto(openPendingMailto);
  }, [isAuthenticated, client, handleMailtoProtocolRequest]);

  // Address links in the app's own chrome (contact cards, sidebars, contact
  // details) compose in place. Unlike a request arriving from the OS handler,
  // an in-app click carries its own context - the account being read - so this
  // goes straight to the composer instead of through the account picker.
  // Cancelling the event tells the link its click was taken.
  useEffect(() => {
    if (!isAuthenticated || !client) return;

    const onInternalMailto = (event: Event) => {
      const pending = (event as CustomEvent<ParsedMailto & { href?: string }>).detail;
      if (!pending) return;
      // Taken, whatever plugins say: the click must not fall through to the
      // OS mail handler.
      event.preventDefault();
      void mailtoAllowed(pending).then((allowed) => {
        if (allowed) void openMailtoDraft(pending);
      });
    };

    window.addEventListener(INTERNAL_MAILTO_EVENT, onInternalMailto);
    return () => window.removeEventListener(INTERNAL_MAILTO_EVENT, onInternalMailto);
  }, [isAuthenticated, client, mailtoAllowed, openMailtoDraft]);

  // Fallback fetch for paths that didn't go through login()'s prefetch
  // (notably checkAuth on page refresh). Settings pages can also prefill
  // mailboxes without emails, so bootstrap emails once per client when the
  // mail route mounts even if mailbox data is already present.
  useEffect(() => {
    if (!isAuthenticated || !client) {
      initialMailLoadClientRef.current = null;
      setInitialMailLoadDone(false);
      return;
    }

    if (initialMailLoadClientRef.current === client) return;
    initialMailLoadClientRef.current = client;

    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const loadData = async (attempt = 1) => {
      try {
        // login() is already loading mailboxes, quota, this folder's page and
        // the tag counts for this client: wait for that instead of asking for
        // all of it again.
        const inFlight = attempt === 1 ? pendingInitialData(client) : undefined;
        if (inFlight) {
          if (inFlight !== 'done') await inFlight.catch(() => {});
          if (cancelled) return;
          if (useEmailStore.getState().mailboxes.length > 0) {
            void refreshScheduledMetadata(client);
            setInitialMailLoadDone(true);
            return;
          }
        }
        const needsMailboxes = useEmailStore.getState().mailboxes.length === 0;
        // Quota only feeds the sidebar meter - never gate the list on it.
        void fetchQuota(client);
        if (needsMailboxes) {
          await fetchMailboxes(client);
        } else {
          // Mailboxes came from the boot snapshot (or a settings page
          // prefill): refresh names/counts in the background instead of
          // gating first paint on the round trip.
          void fetchMailboxes(client);
        }

        const state = useEmailStore.getState();
        const selectedMailboxId = state.selectedMailbox;

        if (state.mailboxes.length === 0 && attempt <= 5 && !cancelled) {
          const delay = Math.min(1000 * attempt, 5000);
          debug.log('jmap', `[Mailbox] No mailboxes returned (attempt ${attempt}), retrying in ${delay}ms`);
          retryTimer = setTimeout(() => loadData(attempt + 1), delay);
          return;
        }

        // Scheduled-send metadata only annotates rows and re-annotates the
        // live list when it lands, so it must not gate the first mail fetch
        // with its own serial round trips.
        void refreshScheduledMetadata(client);

        // Fetch emails for the selected mailbox. If the list is already
        // populated (an account switch
        // restored a cached snapshot, or login prefetched it), refresh in the
        // background so the visible mail doesn't flash a loading overlay; only
        // a genuine empty first load shows the skeleton.
        const background = state.emails.length > 0;
        if (selectedMailboxId) {
          await fetchEmails(client, selectedMailboxId, { background });
        } else {
          await fetchEmails(client, undefined, { background });
        }

        fetchTagCounts(client);
        // The list for the default mailbox has landed. A deep link that needs
        // to switch folders waits for this: fetchEmails replaces the list
        // wholesale, so a link applied mid-bootstrap would be overwritten by
        // this fetch a moment later (#733).
        setInitialMailLoadDone(true);
      } catch (error) {
        console.error('Error loading email data:', error);
        initialMailLoadClientRef.current = null;
        // Still release the deep link - it does its own fetching, and is the
        // user's actual destination.
        setInitialMailLoadDone(true);
      }
    };
    loadData();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [isAuthenticated, client, fetchMailboxes, fetchEmails, fetchQuota, fetchTagCounts, refreshScheduledMetadata]);

  // Warm the code-split viewer/composer chunks once the browser is idle so the
  // first message open or compose click doesn't wait on a chunk fetch. Only
  // once signed in: a visitor on the way to the login form would otherwise
  // download and run the whole editor while that form renders.
  useEffect(() => {
    if (!isAuthenticated) return;
    const warm = () => {
      void import("@/components/email/email-viewer");
      void import("@/components/email/email-composer");
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(warm);
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(warm, 1500);
    return () => clearTimeout(id);
  }, [isAuthenticated]);

  // Push notifications: the bindings live at the app level
  // (components/providers/push-bindings-host.tsx) so other pages get changes
  // too (#1349). The mail view handles them while it is mounted.
  // Handlers are read at event time, so the subscription never holds a stale
  // closure and never has to be re-created because a callback changed identity.
  const pushHandlersRef = useRef({ handleStateChange, invalidateUnifiedMailboxes, buildPopulatedUnifiedAccounts, refreshCrossCounts, refreshUnifiedCounts, ...UNIFIED_LIST_PUSH });
  pushHandlersRef.current = { handleStateChange, invalidateUnifiedMailboxes, buildPopulatedUnifiedAccounts, refreshCrossCounts, refreshUnifiedCounts, ...UNIFIED_LIST_PUSH };
  useEffect(() => subscribePushStateChanges(createMailPushListener(() => pushHandlersRef.current)), []);

  // Keep unified mailbox counts in sync when the feature is enabled and more
  // than one account is connected. Runs whenever the set of connected accounts
  // or the primary account's mailboxes change (a proxy for "something worth
  // recounting happened"). The Pro shell always renders the unified mailbox
  // regardless of the user setting, so refresh when embedded too.
  useEffect(() => {
    const anyCross = showCrossUnread || showCrossStarred || showCrossAll;
    if (!enableUnifiedMailbox && !isEmbedded && !anyCross) return;
    if (!isAuthenticated || !client) return;
    buildPopulatedUnifiedAccounts().then((built) => {
      const hasGroupEntry = built.some((b) => b.isShared);
      if (anyCross) refreshCrossCounts(built);
      if (built.length < 2 && !hasGroupEntry && !isEmbedded) return;
      refreshUnifiedCounts(built);
    });
  }, [enableUnifiedMailbox, includeGroupInUnified, unifiedCrossAccount, activeAccountId, isEmbedded, isAuthenticated, client, mailboxes, connectedAccountsSignature, buildPopulatedUnifiedAccounts, refreshUnifiedCounts, refreshCrossCounts, showCrossUnread, showCrossStarred, showCrossAll]);

  // Refetch the open unified/cross list whenever an account joins the connected
  // set. Only growth matters - a shrink (sign-out, disconnect) is already
  // handled by the flows that cause it, and refetching there would fight them.
  const previousConnectedAccountsRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousConnectedAccountsRef.current;
    previousConnectedAccountsRef.current = connectedAccountsSignature;
    if (!connectedAccountsGrew(previous, connectedAccountsSignature)) return;
    if (!isAuthenticated || !client) return;

    // Read the view at fire time: this effect is keyed on the account set, not
    // on the view, so the deps stay free of fast-changing state.
    const state = useEmailStore.getState();
    if (!state.isUnifiedView) return;
    const { unifiedRole, crossView } = state;
    if (!unifiedRole && !crossView) return;
    // An active search owns the list; re-running a browse fetch under it would
    // replace the user's results with the folder contents.
    if (state.searchQuery || !isFilterEmpty(state.searchFilters)) return;

    const isSameView = captureViewToken();
    void buildPopulatedUnifiedAccounts()
      .then((populated) => {
        // The user left the view while the accounts loaded (#1102).
        if (!isSameView()) return;
        return unifiedRole
          ? fetchUnifiedEmailsAction(populated, unifiedRole)
          : fetchCrossViewAction(populated, crossView!);
      })
      .catch(() => { /* per-account failures surface through unifiedErrors */ });
  }, [connectedAccountsSignature, isAuthenticated, client, buildPopulatedUnifiedAccounts, fetchUnifiedEmailsAction, fetchCrossViewAction]);

  // Deep links (#733). Applies `/mail/folder|message|thread/<id>` - and the
  // legacy `?email=<id>` the push service worker used to emit - once the JMAP
  // session and the mailbox list are up. Runs at most once per mount: after
  // this, the URL is an output of the view (see buildMailUrl), not an input.
  const deepLinkHandledRef = useRef(false);
  const mailAppMountedRef = useRef(false);
  useEffect(() => { mailAppMountedRef.current = true; return () => { mailAppMountedRef.current = false; }; }, []);
  // Point the list at a folder that actually holds a linked message, so the
  // pane behind it shows real context and "back" lands somewhere useful.
  const showInOwningFolder = async (activeClient: Parameters<typeof fetchEmails>[0], email: Email) => {
    const state = useEmailStore.getState();
    const owning = Object.keys(email.mailboxIds ?? {}).find((id) =>
      state.mailboxes.some((mb) => mb.id === id || mb.originalId === id),
    );
    if (owning && owning !== state.selectedMailbox) {
      const mailbox = state.mailboxes.find((mb) => mb.id === owning || mb.originalId === owning);
      if (mailbox) {
        await fetchEmails(activeClient, mailbox.id, { background: true });
        selectMailbox(mailbox.id);
        selectEmail(email);
      }
    }
  };
  const applyMailDeepLink = async (link: MailDeepLink, opts?: { onLoad?: boolean }) => {
    // The folder list before an account switch, if one happened: until the
    // new mailbox's folders arrive the store still holds these (or nothing).
    let switchedFrom: Mailbox[] | null = null;
    // A permalink can name the account it belongs to. Ids are only meaningful
    // within their account, so switch first - but only to a login that is
    // actually connected; we can't authenticate on someone's behalf. A push
    // notification names the login by its cookie slot.
    const linkAccountId = link.accountId ?? (link.slot !== undefined
      ? useAccountStore.getState().accounts.find((a) => a.cookieSlot === link.slot)?.id ?? `slot:${link.slot}`
      : undefined);
    const switchesAccount = !!linkAccountId && linkAccountId !== useAuthStore.getState().activeAccountId;
    if (switchesAccount) {
      const startedOn = useAuthStore.getState().activeAccountId;
      const startedIn = useEmailStore.getState().selectedMailbox;
      const startedWith = useEmailStore.getState().selectedEmail?.id ?? null;
      // The login may still be reconnecting - a tapped notification reopens
      // the app and the logins come back one at a time - so wait for it
      // rather than calling a late mailbox unavailable.
      if (!(await waitForConnectedAccount(linkAccountId))) {
        toast.error(t('deep_link.account_unavailable'));
        return;
      }
      // The user moved on while the login reconnected: don't pull them away.
      if (!mailAppMountedRef.current
        || useAuthStore.getState().activeAccountId !== startedOn
        || useEmailStore.getState().selectedMailbox !== startedIn
        || (useEmailStore.getState().selectedEmail?.id ?? null) !== startedWith) return;
      switchedFrom = useEmailStore.getState().mailboxes;
      await switchAccount(linkAccountId);
      // Overtaken or failed: the folders on screen are not the link's account's.
      if (useAuthStore.getState().activeAccountId !== linkAccountId) return;
    }

    const activeClient = useAuthStore.getState().client;
    if (!activeClient) return;

    if (link.kind === 'folder') {
      const mailboxes = switchedFrom
        ? await freshMailboxes(switchedFrom)
        : useEmailStore.getState().mailboxes;
      const state = useEmailStore.getState();
      const mailboxId = resolveFolderRef(link.ref, mailboxes);
      if (!mailboxId) {
        toast.error(t('deep_link.folder_not_found'));
        return;
      }
      // Reloading the page lands here with the folder the boot fetch has just
      // loaded; selecting it again re-fetched it under the loading overlay,
      // so the list flashed right after it appeared.
      if (opts?.onLoad && !switchesAccount && isFolderLinkOpen(mailboxId, {
        selectedMailbox: state.selectedMailbox,
        isUnifiedView: state.isUnifiedView,
        isScheduledView: state.isScheduledView,
        selectedKeyword: state.selectedKeyword,
        hasSearch: !!state.searchQuery || !isFilterEmpty(state.searchFilters),
      })) {
        return;
      }
      await handleMailboxSelect(mailboxId);
      return;
    }

    if (link.kind === 'message') {
      // In the Pro shell a message permalink opens as its own fullscreen
      // email tab - the tab body fetches the message and retitles itself.
      if (isEmbedded) {
        // A shared account's message is fetched from that account through
        // the active login (#1351).
        const loginId = link.ownerAccountId ? useAuthStore.getState().activeAccountId ?? undefined : undefined;
        useProTabStore.getState().openEmailTab({
          accountId: link.ownerAccountId ?? '',
          ...(loginId ? { clientAccountId: loginId } : {}),
          emailId: link.id,
          mailboxId: null,
          title: t('common.loading'),
        });
        return;
      }
      setLoadingEmail(true);
      try {
        const email = await fetchEmailContent(activeClient, link.id, link.ownerAccountId);
        if (!email) {
          toast.error(t('deep_link.message_not_found'));
          return;
        }
        await showInOwningFolder(activeClient, email);
        if (link.fullscreen && !isMobile) {
          // The owning-folder branch above may have skipped selecting (the
          // folder was already current) - fullscreen needs the message open.
          selectEmail(email);
          setFullscreenReading(true);
        }
        if (isMobile) setActiveView('viewer');
        if (isTablet) setTabletListVisible(false);
      } finally {
        setLoadingEmail(false);
      }
      return;
    }

    // Conversation. One fetch serves both layouts: mobile opens the dedicated
    // conversation view, desktop opens the newest message of the thread (which
    // is what clicking a thread in the list does there).
    const openSeq = ++conversationOpenSeqRef.current;
    const source: EmailBlobContext = {
      client: activeClient, clientAccountId: useAuthStore.getState().activeAccountId ?? undefined,
      accountId: link.ownerAccountId,
    };
    setLoadingEmail(true);
    try {
      const threadEmails = await activeClient.getThreadEmails(link.id, link.ownerAccountId);
      if (openSeq !== conversationOpenSeqRef.current) return;
      const [group] = groupEmailsByThread(threadEmails);
      if (!group) {
        toast.error(t('deep_link.thread_not_found'));
        return;
      }
      if (isMobile) {
        setConversationThread(group);
        setConversationBlobSource(source);
        setConversationEmails(threadEmails);
        setActiveView('viewer');
      } else {
        const email = await fetchEmailContent(activeClient, group.latestEmail.id, link.ownerAccountId);
        // A shared account's conversation needs its folder open: the open
        // message is acted on in the account of the folder on screen.
        if (email && link.ownerAccountId) await showInOwningFolder(activeClient, email);
        if (isTablet) setTabletListVisible(false);
      }
    } finally {
      setLoadingEmail(false);
    }
  };

  // Held in a ref rather than memoised: the handlers it calls (notably
  // handleMailboxSelect) are rebuilt every render and close over the client and
  // mailbox list, so a memoised copy would still be holding the empty
  // first-render ones by the time the session is up and the link is applied.
  const applyMailDeepLinkRef = useRef(applyMailDeepLink);
  applyMailDeepLinkRef.current = applyMailDeepLink;

  // Pro shell only: this MailApp stays mounted for the whole session, so the
  // mount-time consume below never sees a link that arrives later (an in-app
  // navigation ProInterfaceRedirect intercepts). Subscribe for live delivery.
  // Embedded-only: during a cold-load redirect the standard instance renders
  // briefly and must not steal the link parked for the Pro one.
  useEffect(() => {
    if (!isEmbedded) return;
    return subscribePendingDeepLink('mail', (segments) => {
      const link = parseMailPath(segments, new URLSearchParams(window.location.search));
      if (link) void applyMailDeepLinkRef.current(link);
    });
  }, [isEmbedded]);

  // Leaving fullscreen reading: once nothing is open in the viewer any more
  // (message closed, composer closed), fall back to the normal layout.
  useEffect(() => {
    if (fullscreenReading && !selectedEmail && !showComposer && !conversationThread) {
      setFullscreenReading(false);
    }
  }, [fullscreenReading, selectedEmail, showComposer, conversationThread]);

  // Keep the `?view=fullscreen` marker in step with the toggle. The history
  // keeper only rewrites the URL when the nav snapshot (mailbox/message)
  // changes, so toggling fullscreen on an open message would otherwise leave
  // the address bar - and any reload of it - on the normal view.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isEmbedded || proInterfaceActive) return;
    const { pathname, search } = window.location;
    const params = new URLSearchParams(search);
    const has = params.get("view") === "fullscreen";
    const want = fullscreenReading && /\/mail\/message\//.test(pathname);
    if (want === has) return;
    if (want) params.set("view", "fullscreen");
    else params.delete("view");
    const qs = params.toString();
    window.history.replaceState(window.history.state, "", `${pathname}${qs ? `?${qs}` : ""}`);
  }, [fullscreenReading, isEmbedded, proInterfaceActive, selectedEmail]);

  // The URL keeper below (useBrowserNavigation) rewrites the address bar as
  // soon as the view initializes - long before the deep-link effect gets to
  // run (it waits for the session and mailbox list) - which strips one-shot
  // entry params like `?view=fullscreen`. Capture the query the page was
  // actually opened with on first client render.
  const initialSearchRef = useRef<string | null>(null);
  if (initialSearchRef.current === null && typeof window !== "undefined") {
    initialSearchRef.current = initialLinkSearch('mail');
  }

  useEffect(() => {
    if (deepLinkHandledRef.current) return;
    if (!isAuthenticated || !client) return;
    if (mailboxes.length === 0) return;
    if (!initialMailLoadDone) return;

    const params = new URLSearchParams(initialSearchRef.current ?? window.location.search);
    // Inside the Pro shell the route is /pro, so the segments arrive through
    // the handoff the redirect parked them in rather than as route params.
    const segments = linkSegments ?? consumePendingDeepLink('mail') ?? [];
    const link = parseMailPath(segments, params);
    const openLatestUnread = params.get('openLatestUnread') === '1';

    if (!link && !openLatestUnread) {
      deepLinkHandledRef.current = true;
      return;
    }

    // The generic "New mail" toast (the preview API failed, so the worker
    // couldn't name a message) needs the inbox loaded before it can pick the
    // newest unread. Bail and let the effect re-run once `emails` arrives.
    if (!link && openLatestUnread && emails.length === 0) return;

    deepLinkHandledRef.current = true;

    if (link) {
      void applyMailDeepLinkRef.current(link, { onLoad: true });
      return;
    }

    // emails are sorted receivedAt-desc, so the first unread is the newest.
    const newestUnread = emails.find(e => !e.keywords?.$seen);
    if (newestUnread) {
      selectEmail(newestUnread);
    }
  }, [isAuthenticated, client, mailboxes.length, emails, linkSegments, initialMailLoadDone, selectEmail]);

  // Auto-fetch full email content when an email is auto-selected (e.g. after delete/archive)
  useEffect(() => {
    if (!selectedEmail || !client) return;
    // If the email lacks bodyValues, it was auto-selected from the list and needs full content.
    // Skip when handleEmailSelect already started a fetch (it sets isLoadingEmail before
    // calling selectEmail on the stub), to avoid a duplicate request.
    if (!selectedEmail.bodyValues && !isLoadingEmail) {
      setLoadingEmail(true);
      fetchEmailContent(client, selectedEmail.id).finally(() => {
        setLoadingEmail(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmail?.id, selectedEmail?.sourceClientAccountId, selectedEmail?.sourceAccountId]);

  // Opening a message hides the list on tablet, but plenty of paths clear the
  // reading pane without going through a "back" handler (delete/move/archive,
  // a failed fetch, history restore, sending the open draft). Bring the list
  // back once there is nothing left to read, so tablet never ends up on an
  // empty reading pane with only the bottom bar.
  const readingPaneEmpty = !showComposer && !conversationThread && !selectedEmail && !isLoadingEmail;
  useEffect(() => {
    if (readingPaneEmpty && !tabletListVisible) setTabletListVisible(true);
  }, [readingPaneEmpty, tabletListVisible, setTabletListVisible]);

  // Handle mark-as-read with delay based on settings
  useEffect(() => {
    // Clear any existing timeout when email changes
    if (markAsReadTimeoutRef.current) {
      debug.log('email', '[Mark as Read] Clearing previous timeout');
      clearTimeout(markAsReadTimeoutRef.current);
      markAsReadTimeoutRef.current = null;
    }

    // Only set timeout if there's a selected email, it's unread, and we have a client
    if (!selectedEmail || !client || selectedEmail.keywords?.$seen || isScheduledView) {
      return;
    }

    // A Mountain View cursor is not a read receipt: the mail is only marked once it is
    // actually opened.
    if (mvShell && cursorOnly) {
      return;
    }

    // Get current setting value
    const markAsReadDelay = useSettingsStore.getState().markAsReadDelay;
    debug.log('email', '[Mark as Read] Delay setting:', markAsReadDelay, 'ms for email:', selectedEmail.id);

    // The server may refuse (a shared folder without the right to set seen);
    // the message then just stays unread.
    const markRead = () => markAsRead(client, selectedEmail.id, true, emailKeyFor(selectedEmail)).catch((error) => {
      debug.warn('email', '[Mark as Read] Failed:', error);
    });

    if (markAsReadDelay === -1) {
      // Never mark as read automatically
      debug.log('email', '[Mark as Read] Never mode - email will stay unread');
    } else if (markAsReadDelay === 0) {
      // Mark as read instantly
      debug.log('email', '[Mark as Read] Instant mode - marking as read now');
      void markRead();
    } else {
      // Mark as read after delay
      debug.log('email', '[Mark as Read] Delayed mode - will mark as read in', markAsReadDelay, 'ms');
      markAsReadTimeoutRef.current = setTimeout(() => {
        debug.log('email', '[Mark as Read] Timeout fired - marking as read now');
        void markRead();
        markAsReadTimeoutRef.current = null;
      }, markAsReadDelay);
    }

    // Cleanup on unmount or when dependencies change
    return () => {
      if (markAsReadTimeoutRef.current) {
        debug.log('email', '[Mark as Read] Cleanup - clearing timeout');
        clearTimeout(markAsReadTimeoutRef.current);
        markAsReadTimeoutRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmail?.id, isScheduledView, mvShell, cursorOnly]);

  // Handle new email notifications - play sound
  useEffect(() => {
    if (newEmailNotification) {
      const { emailNotificationsEnabled, emailNotificationSound, notificationSoundChoice } = useSettingsStore.getState();
      if (emailNotificationsEnabled && emailNotificationSound) {
        playNotificationSound(notificationSoundChoice);
      }
      debug.log('email', 'New email received:', newEmailNotification.subject);
      clearNewEmailNotification();
    }
  }, [newEmailNotification, clearNewEmailNotification]);

  // Lock body scroll when sidebar is open on mobile/tablet
  useEffect(() => {
    if ((isMobile || isTablet) && sidebarOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobile, isTablet, sidebarOpen]);

  // Move focus into the sidebar when it opens as an overlay, and back to the
  // toggle when it closes, so keyboard and screen reader users end up where the
  // `aria-expanded` state says they should (#721).
  const appRootRef = useRef<HTMLDivElement>(null);
  // Pro can mount two mail panes at once, so the sidebar id must be per-instance.
  const sidebarId = useId();
  const sidebarContainerRef = useRef<HTMLDivElement>(null);
  const sidebarWasOpen = useRef(false);
  useEffect(() => {
    const isOverlay = isMobile || isTablet;
    if (isOverlay && sidebarOpen) {
      sidebarWasOpen.current = true;
      const frame = requestAnimationFrame(() => {
        const first = sidebarContainerRef.current?.querySelector<HTMLElement>(
          'button:not(:disabled),[href],input:not(:disabled),[tabindex]:not([tabindex="-1"])'
        );
        first?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!sidebarWasOpen.current) return;
    sidebarWasOpen.current = false;
    // The toggle lives in whichever MobileHeader the current view renders, so
    // look it up inside this app instance rather than threading a ref through.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    appRootRef.current?.querySelector<HTMLElement>('[data-sidebar-toggle]')?.focus();
  }, [isMobile, isTablet, sidebarOpen]);

  // The message a composer session answers, pinned when the session starts.
  // Mountain View keeps its compose window open while other mail is read
  // (#1229), so the open message is no longer the one being replied to.
  const composerSourceEmail = usePinnedPerSession(composerSessionId, selectedEmail);
  // Its login and account, pinned too: the folder open at send time may hold
  // another account's message under the same id.
  const composerSource = usePinnedPerSession(composerSessionId, selectedEmail ? emailWriteSource(selectedEmail, client) : undefined);

  const handleEmailSend = async (data: {
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    body: string;
    htmlBody?: string;
    draftId?: string;
    /** JMAP account `draftId` lives in, when not the own one. */
    draftAccountId?: string;
    fromEmail?: string;
    fromName?: string;
    identityId?: string;
    /** Local account owning the selected identity, when it came from the
     *  cross-account From dropdown (more than one connected account). */
    localAccountId?: string;
    envelopeMailFrom?: string;
    attachments?: Array<{ blobId: string; name: string; type: string; size: number; disposition?: 'attachment' | 'inline'; cid?: string }>;
    inReplyTo?: string[];
    references?: string[];
    delayedUntil?: string;
    requestReadReceipt?: boolean;
    requestDsn?: boolean;
    requireTls?: boolean;
    priority?: MessagePriority;
  }) => {
    // Nothing is sent: the composer keeps what only goes once the mail is out.
    if (!client) return false;

    // Sending from an identity that belongs to another connected account has
    // to go through that account's own client: the identity id is only valid
    // on its own server, and an unknown id makes the server fall back to the
    // active account's primary identity - which then signs the message with
    // the wrong DKIM key (#461). The draft was saved against the same account.
    const sendClient = data.localAccountId
      ? (useAuthStore.getState().getClientForAccount(data.localAccountId) ?? client)
      : client;

    // Separates "the submission failed" from "a follow-up step failed". Only the
    // former may propagate: the composer treats a resolved onSend as a delivered
    // message and wipes its fields, so swallowing a real send failure here lost
    // the user's message without so much as a toast (#702).
    let submitted = false;

    try {
      const effectiveMode = pendingDraft?.mode ?? composerMode;
      const originalEmailId = composerSourceEmail?.id;

      const result = await sendEmail(sendClient, data.to, data.subject, data.body, data.cc, data.bcc, data.identityId, data.fromEmail, data.draftId, data.fromName, data.htmlBody, data.attachments, data.inReplyTo, data.references, data.delayedUntil, data.envelopeMailFrom, { requestReadReceipt: data.requestReadReceipt, requestDsn: data.requestDsn, requireTls: data.requireTls, priority: data.priority, localAccountId: data.localAccountId, draftAccountId: data.draftAccountId });
      submitted = true;
      announceSent(result, data);
      setShowComposer(false);
      // Sending an edited draft destroys it server-side - and every autosave
      // before that already replaced it under a fresh id (createDraft is a
      // destroy+create). If the email on display is the draft this session
      // was opened from, or its latest autosaved successor, clear the
      // selection like a delete does.
      if (selectedEmail && (selectedEmail.id === data.draftId || selectedEmail.id === pendingDraft?.draftId)) {
        selectEmail(null);
      }
      // On a phone the composer takes over the reading pane. With no message
      // open behind it, that pane is empty and has no way back to the list.
      if (isMobile && !useEmailStore.getState().selectedEmail) setActiveView('list');
      if (result.filingError) {
        // The mail went out, but a post-send step (filing to Sent /
        // removing the old draft) was rejected - warn instead of staying
        // silent, so a stale draft row is not mistaken for a failed send
        // and re-sent (#592).
        toast.warning(t('email_composer.send_filing_warning'));
      }
      if (result.rejectedRecipients?.length) {
        // The server refused some recipients while accepting the rest; no
        // bounce will follow for these, so this is the only notice (#1123).
        toast.warning(t('email_composer.send_some_recipients_rejected'), {
          message: formatRejectedRecipients(result.rejectedRecipients),
          duration: 15000,
        });
      }
      // Mark the original email with $answered or $forwarded keyword. Route the
      // write to the email's own account so the flag lands on shared/group-mailbox
      // messages instead of being dropped against the reaching account. (#281)
      // This runs before the scheduled early-return: the undo-send delay is a
      // HOLDFOR submission, so `scheduled` is true for every delayed send and
      // the flag was never set. (#985)
      if (originalEmailId && (effectiveMode === 'reply' || effectiveMode === 'replyAll' || effectiveMode === 'forward')) {
        const keyword = effectiveMode === 'forward' ? '$forwarded' : '$answered';
        try {
          await useEmailStore.getState().markEmailKeyword(client, originalEmailId, keyword, composerSource);
        } catch (e) {
          debug.error(`Failed to set ${keyword} keyword:`, e);
        }
      }

      if (result.scheduled) {
        await refreshScheduledMetadata(client);
        if (isScheduledView) await fetchScheduledEmails(client);
        return;
      }

      // Delayed sends get the undo toast instead; a filing error or a refused
      // recipient already warned.
      if (!result.filingError && !result.rejectedRecipients?.length) toast.success(t('notifications.email_sent'));

      // Refresh the current mailbox to update the UI
      if (!isScheduledView) {
        await refreshCurrentMailbox(client);
        // Re-fetch the replied thread's cross-folder data so the expanded
        // view shows the newly sent reply without collapsing.
        if (originalEmailId) {
          const emailState = useEmailStore.getState();
          const repliedEmail = emailState.emails.find(e => e.id === originalEmailId);
          if (repliedEmail?.threadId && emailState.expandedThreadIds.has(threadKeyFor(repliedEmail))) {
            // Route to the email's own account so shared/group threads refresh
            // from the right server, not the active one. (#281, #814)
            const route = resolveThreadRoute({
              isUnifiedView: emailState.isUnifiedView,
              ref: repliedEmail,
              mailboxes: viewMailboxes,
              selectedMailbox: emailState.selectedMailbox,
            });
            const threadClient = route.clientAccountId
              ? (useAuthStore.getState().getClientForAccount(route.clientAccountId) ?? client)
              : client;
            const fullEmails = await threadClient.getThreadEmails(
              repliedEmail.threadId,
              route.accountId ?? client.getAccountId(),
            );
            if (fullEmails.length > 0) {
              useEmailStore.setState((state) => {
                const c = new Map(state.threadEmailsCache);
                c.set(threadKeyFor(repliedEmail), fullEmails);
                return { threadEmailsCache: c };
              });
            }
          }
        }
      }
    } catch (error) {
      console.error("Failed to send email:", error);
      // Post-send bookkeeping - refreshing Sent, flagging the original as
      // answered, re-reading the thread - is cosmetic once the mail is out.
      if (!submitted) throw error;
    }
  };

  const handleDiscardDraft = async (draftId: string, draft?: { accountId?: string; localAccountId?: string }) => {
    if (!client) return;
    // Through the login the draft was saved with, as a send is (#461), and in
    // the account it lives in: a draft back from an undone group send is in
    // the group's Drafts, and the own account may hold another message under
    // the same id. Never through another login, also not once that one is
    // gone: the id names another message there (as removeDraftVersion).
    const draftClient = draft?.localAccountId
      ? useAuthStore.getState().getClientForAccount(draft.localAccountId)
      : client;
    if (!draftClient) {
      toast.error(t('email_composer.discard_signed_out'));
      return;
    }

    try {
      await draftClient.deleteEmail(draftId, draft?.accountId);
    } catch (error) {
      console.error("Failed to discard draft:", error);
    }
  };

  // Build the quote header for a reply/forward open, running it through the
  // emailHooks.onBuildQuoteHeader transform so plugins can replace it. Stores
  // the result in composerQuoteHeader; the render site spreads it into
  // EmailComposer.replyTo. Errors fall back to the composer's built-in
  // header (state set to null).
  const prepareComposerQuoteHeader = useCallback(async (
    email: Email | null,
    mode: 'reply' | 'replyAll' | 'forward',
  ) => {
    if (!email) { setComposerQuoteHeader(null); return; }
    try {
      const replyTargets = (email.replyTo?.length
        ? email.replyTo
        : email.from ?? []).filter(r => r.email).map(r => r.email!);
      const newTo = mode === 'reply'
        ? replyTargets
        : mode === 'replyAll'
          ? [...replyTargets, ...(email.to ?? []).filter(r => r.email).map(r => r.email!)]
          : [];
      const newCc = mode === 'replyAll'
        ? (email.cc ?? []).filter(r => r.email).map(r => r.email!)
        : [];
      const header = await buildQuoteHeader({
        mode,
        email: {
          from: email.from,
          to: email.to,
          cc: email.cc,
          subject: email.subject,
          receivedAt: email.receivedAt,
        },
        newTo,
        newCc,
        locale: getEffectiveLocale(),
        timeFormat: useSettingsStore.getState().timeFormat,
        unknownLabel: tCommon('unknown'),
        labels: {
          formatReplyLine: (vars) => tQuote('reply_line', vars),
          forwardedSeparator: tQuote('forwarded_separator'),
          fromLabel: tQuote('from_label'),
          dateLabel: tQuote('date_label'),
          subjectLabel: tQuote('subject_label'),
        },
      });
      setComposerQuoteHeader(header);
    } catch (err) {
      console.warn('[quote-header] plugin transform failed; using default', err);
      setComposerQuoteHeader(null);
    }
  }, [tCommon, tQuote]);

  // Force a clean composer remount on every fresh entry point so prior
  // compose state can't bleed into the new session (#329 C). The composer is
  // keyed on composerSessionId, and pendingDraft would otherwise pin the
  // composer to a stale draft from a discarded reply.
  const startFreshComposerSession = useCallback(() => {
    setComposerSessionId(id => id + 1);
    setPendingDraft(null);
  }, []);

  const handleReply = async (draftText?: string) => {
    if (selectedEmail) {
      const formerSelected = { ...selectedEmail };
      const enrichedEmail = await emailHooks.onBeforeComposeOpenToReply.transform(selectedEmail);
      selectEmail(enrichedEmail);
      const ok = await emailHooks.onBeforeReply.intercept({
        originalEmailId: selectedEmail.id,
        originalEmail: emailToReadView(selectedEmail),
        mode: 'reply' as const,
      });
      if (!ok){ 
        selectEmail(formerSelected);
        return;
      }
      await prepareComposerQuoteHeader(selectedEmail, 'reply');
    } else {
      setComposerQuoteHeader(null);
    }
    await withComposeGate('reply', { source: selectedEmail, body: draftText || '' }, () => {
      startFreshComposerSession();
      setComposerDraftText(draftText || "");
      setComposerMode('reply');
      setShowComposer(true);
      if (isMobile) setActiveView('viewer');
    });
  };

  /**
   * `source`: where the draft lives, given for a message whose send was just
   * undone or cancelled - the account it was sent from (a group or shared one
   * for mail sent from its identity) and the login that sent it.
   */
  const handleEditDraft = async (email?: Email, source?: DraftSource) => {
    if (!client) return;
    const draftCandidate = email && typeof email === 'object' && typeof email.id === 'string'
      ? email
      : selectedEmail;
    let draft = draftCandidate;
    if (!draft) return;

    // The login and account the draft lives in (resolveDraftSource). The
    // composer removes the old version there when it saves, sends or
    // discards: email ids repeat across accounts and servers, so another
    // account may hold an unrelated message under the same id.
    const { localAccountId, accountId } = resolveDraftSource(draft, {
      source,
      aggregate: isAggregateListView(),
      mailbox: viewMailboxes.find(mb => mb.id === selectedMailbox),
      viewingAccountId,
      activeAccountId,
    });
    const draftClient = (localAccountId ? useAuthStore.getState().getClientForAccount(localAccountId) : undefined) ?? client;

    // The email list only fetches limited properties (no bodyValues/htmlBody/bcc).
    // Fetch the full email so the composer gets all draft content.
    if (!draft.bodyValues) {
      const fullDraft = await draftClient.getEmail(draft.id, accountId);
      if (!fullDraft) return;
      draft = { ...fullDraft, sourceClientAccountId: draft.sourceClientAccountId, sourceAccountId: draft.sourceAccountId };
    }

    draft = await emailHooks.onBeforeEditDraft.transform(draft);

    // Only the parts the server lists as the body: bodyValues also carries
    // every text/* ATTACHMENT, which used to be joined in as the message.
    const bodyText = getDraftTextBody(draft);
    // A plain-text-only draft lists its text/plain part under htmlBody
    // (RFC 8621 § 4.1.4 fallback) - only treat it as HTML when it really is.
    const draftHtmlPart = draft.htmlBody?.[0];
    const htmlBody = draftHtmlPart?.partId
      && (!draftHtmlPart.type || draftHtmlPart.type.toLowerCase() === 'text/html')
      && draft.bodyValues?.[draftHtmlPart.partId]
      ? draft.bodyValues[draftHtmlPart.partId].value
      : undefined;

    // Restore the identity the draft was composed with. Match the saved From
    // (name + address) against the same list the composer renders — the flat
    // cross-account list when multi-account is on — so a draft from a non-active
    // account, or one of two identities sharing an address, is restored rather
    // than reset to the default.
    const composerIdentities = multiAccountIdentities.enabled
      ? multiAccountIdentities.allIdentities
      : identities;
    const matchedIdentityId = findDraftIdentityIdForLogin(composerIdentities, draft.from?.[0], localAccountId);

    const draftRecipients = (list: typeof draft.to) => (list ?? []).map(a => a.email).filter(Boolean);
    if (!(await withComposeGate('compose', {
      to: draftRecipients(draft.to),
      cc: draftRecipients(draft.cc),
      subject: draft.subject && draft.subject !== t('email_composer.no_subject') ? draft.subject : '',
      body: bodyText,
    }, () => {}))) return;

    // Increment session ID to force the composer to remount with fresh state,
    // even if it was already open (e.g. right-clicking a draft while composing).
    setComposerSessionId(id => id + 1);
    setPendingDraft({
      to: draft.to?.map(a => a.email).filter(Boolean).join(', ') || '',
      cc: draft.cc?.map(a => a.email).filter(Boolean).join(', ') || '',
      bcc: draft.bcc?.map(a => a.email).filter(Boolean).join(', ') || '',
      // Drafts saved before #1189 stored an empty subject as the composer's
      // "(No Subject)" placeholder; reopen those with an empty field.
      subject: draft.subject && draft.subject !== t('email_composer.no_subject') ? draft.subject : '',
      body: htmlBody || bodyText,
      // Re-open in the format the draft was written in: a text-only draft
      // used to land raw in the rich-text editor (newlines collapsed) and an
      // HTML draft raw in the plain-text textarea. Empty draft: the setting
      // decides (#1022).
      plainTextMode: htmlBody != null ? false : bodyText ? true : undefined,
      showCc: (draft.cc?.length || 0) > 0,
      showBcc: (draft.bcc?.length || 0) > 0,
      selectedIdentityId: matchedIdentityId,
      subAddressTag: '',
      mode: 'compose',
      draftId: draft.id,
      draftAccountId: accountId,
      draftLocalAccountId: localAccountId,
      // A reply draft re-opens in compose mode; its threading headers must
      // come along or the reply leaves its thread.
      inReplyTo: draft.inReplyTo ?? undefined,
      references: draft.references ?? undefined,
      priority: messagePriorityFromHeaders(draft.headers),
      // Existing server-side attachments must ride along, or the composer
      // starts empty and the next save/send silently rebuilds the draft
      // without them (#849).
      attachments: (draft.attachments ?? [])
        .filter(a => !!a.blobId)
        .map(a => ({
          blobId: a.blobId,
          name: a.name,
          type: a.type,
          size: a.size,
          cid: a.cid,
          disposition: a.disposition,
        })),
    });
    setComposerMode('compose');
    setShowComposer(true);
    if (isMobile) setActiveView('viewer');
  };

  /** When a scheduled message goes out, as the user reads times, if known. */
  const scheduledTime = (sendAt: string | undefined) =>
    sendAt ? formatDateTime(sendAt, useSettingsStore.getState().timeFormat) : undefined;

  const toastCancelFailure = (error: unknown, cancelFailedTitle: string) => {
    const { title, message } = cancelFailureToast(error, tViewer, cancelFailedTitle);
    toast.error(title, message ? { message } : undefined);
  };

  // The send is cancelled and the message back in Drafts by then.
  const reportDraftOpenFailure = (error: unknown) => {
    console.error('Cancelled the scheduled send, but opening the draft failed:', error);
  };

  /**
   * "Cancel and edit" from the list or the viewer, neither of which waits for
   * it: the draft to open (null for S/MIME, which is composed again), or
   * undefined once a failure is reported.
   */
  const cancelScheduledForEdit = async (email: Email): Promise<Email | null | undefined> => {
    if (!client) return undefined;
    try {
      return await cancelScheduledEmailForEdit(client, email);
    } catch (error) {
      console.error('Failed to cancel the scheduled send for editing:', error);
      toastCancelFailure(error, tViewer('cancel_scheduled_failed'));
      return undefined;
    }
  };

  useEffect(() => {
    if (!pendingUndoSend || !client) return;
    if (lastUndoToastSubmissionRef.current === pendingUndoSend.submissionId) return;

    lastUndoToastSubmissionRef.current = pendingUndoSend.submissionId;
    const pending = pendingUndoSend;
    // The submission lives on the account that owns the sending identity,
    // which is not always the active one in the multi-account shell (#461).
    // Never another login, also not once that one is gone: the submission id
    // names another submission there.
    const undoClient = pending.localAccountId
      ? useAuthStore.getState().getClientForAccount(pending.localAccountId)
      : client;
    const refuseSignedOut = () => toast.error(t('email_viewer.undo_send_signed_out'));
    // The login the draft is restored through. The classic shell leaves
    // `localAccountId` unset, and the user may switch logins before clicking
    // Undo: without this, the draft's next save would run through the new
    // active login and remove its old version by id in the wrong account.
    const undoLogin = pending.localAccountId ?? useAuthStore.getState().activeAccountId ?? undefined;
    // A send-delay window (seconds away) closes the toast a second before the
    // server releases the message, so Undo is never offered once it is too
    // late. A message scheduled for later keeps the toast up a short while.
    const remainingMs = Date.parse(pending.sendAt) - Date.now();
    const isUndoWindow = Number.isFinite(remainingMs) && remainingMs <= 120_000;
    const undoDurationMs = isUndoWindow
      ? Math.max(remainingMs - 1000, 1000)
      : Math.max(sendDelaySeconds, 8) * 1000;

    toast.success(isUndoWindow
      ? t('email_viewer.sending_in', { seconds: Math.round(remainingMs / 1000) })
      : t('email_viewer.scheduled_send_created'), {
      duration: undoDurationMs,
      pauseOnHover: false,
      secondaryAction: (pending.emailId && pending.identityId)
        ? {
            label: t('email_viewer.send_now'),
            onClick: () => {
              if (!undoClient) return refuseSignedOut();
              void (async () => {
                try {
                  const result = await undoClient.rescheduleEmailSubmission(
                    pending.submissionId,
                    pending.emailId!,
                    pending.identityId!,
                    new Date(Date.now() + 1000).toISOString(),
                    // Shared-identity sends live in the shared account (#874).
                    pending.submissionAccountId,
                  );
                  clearPendingUndoSend();
                  // The recipients are checked again for the release.
                  const refused = partlyRefusedWarning(result, tComposer);
                  if (refused) toast.warning(refused);
                  releaseAnnouncedSend(pending.submissionId);
                  if (isScheduledView) await fetchScheduledEmails(client);
                } catch (error) {
                  console.error('Failed to send now:', error);
                  // The original was put back under a new id: show the undo
                  // toast again for that one so Undo still cancels it.
                  if (error instanceof RescheduleRestoredError) {
                    const current = useEmailStore.getState().pendingUndoSend;
                    if (current?.submissionId === pending.submissionId) {
                      useEmailStore.setState({ pendingUndoSend: { ...current, submissionId: error.restoredSubmissionId, sendAt: error.restoredSendAt || current.sendAt } });
                    }
                  }
                  const { title, message } = rescheduleFailureToast(error, tViewer, tComposer, scheduledTime(pending.sendAt));
                  toast.error(title, message ? { message } : undefined);
                }
              })();
            },
          }
        : undefined,
      action: {
        label: t('email_viewer.undo_send'),
        onClick: () => {
          if (!undoClient) return refuseSignedOut();
          void (async () => {
            let restored: Awaited<ReturnType<typeof cancelUndoSend>>;
            try {
              restored = await cancelUndoSend(undoClient, pending);
            } catch (error) {
              console.error('Failed to undo scheduled send:', error);
              toastCancelFailure(error, t('email_viewer.undo_send_failed'));
              return;
            }
            // The send is undone; opening the draft or refreshing the list
            // failing is no reason to say otherwise.
            try {
              // Never left the server: plugins don't hear about it.
              cancelAnnouncedSend(pending.submissionId);
              if (restored && !pending.isSmime) {
                // Back in the Drafts of the account it was sent from, through
                // the login that sent it.
                await handleEditDraft(restored, { accountId: pending.submissionAccountId, localAccountId: undoLogin });
              }
              if (isScheduledView) await fetchScheduledEmails(client);
            } catch (error) {
              console.error('Undid the send, but reopening it failed:', error);
            }
          })();
        },
      },
    });

    const timer = setTimeout(() => {
      const current = useEmailStore.getState().pendingUndoSend;
      if (current?.submissionId === pending.submissionId) {
        clearPendingUndoSend();
      }
    }, undoDurationMs);
    // Once the server has released the message, the Scheduled count in the
    // sidebar no longer includes it. Not cleared with the effect: clearing the
    // pending undo above re-runs this effect before the release.
    if (isUndoWindow) {
      setTimeout(() => { void refreshScheduledMetadata(client); }, remainingMs + 3000);
    }

    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelUndoSend, clearPendingUndoSend, client, fetchScheduledEmails, isScheduledView, pendingUndoSend?.submissionId, sendDelaySeconds, t, tComposer, tViewer]);

  const handleReplyAll = async (draftText?: string) => {
    if (selectedEmail) {
      const formerSelected = { ...selectedEmail };
      const enrichedEmail = await emailHooks.onBeforeComposeOpenToReplyAll.transform(selectedEmail);
      selectEmail(enrichedEmail);
      const ok = await emailHooks.onBeforeReplyAll.intercept({
        originalEmailId: selectedEmail.id,
        originalEmail: emailToReadView(selectedEmail),
        mode: 'reply-all' as const,
      });
      if (!ok) {
        selectEmail(formerSelected);
        return;
      }
      await prepareComposerQuoteHeader(selectedEmail, 'replyAll');
    } else {
      setComposerQuoteHeader(null);
    }
    const text = typeof draftText === 'string' ? draftText : '';
    await withComposeGate('replyAll', { source: selectedEmail, ...(text ? { body: text } : {}) }, () => {
      startFreshComposerSession();
      setComposerDraftText(text);
      setComposerMode('replyAll');
      setShowComposer(true);
      if (isMobile) setActiveView('viewer');
    });
  };

  // A plugin's "reply with this" (api.compose.reply), for the open message only.
  const pluginReplyRef = useRef({ handleReply, handleReplyAll, openId: selectedEmail?.id ?? null });
  pluginReplyRef.current = { handleReply, handleReplyAll, openId: selectedEmail?.id ?? null };
  useEffect(() => {
    const onPluginReply = (event: Event) => {
      const req = (event as CustomEvent<PluginReplyRequest>).detail;
      const { openId, handleReply: reply, handleReplyAll: replyAll } = pluginReplyRef.current;
      if (!req || !openId || req.emailId !== openId) return;
      event.preventDefault();
      void (req.all ? replyAll(req.text) : reply(req.text));
    };
    window.addEventListener(PLUGIN_REPLY_EVENT, onPluginReply);
    return () => window.removeEventListener(PLUGIN_REPLY_EVENT, onPluginReply);
  }, []);

  const handleForward = async () => {
    if (selectedEmail) {
      const formerSelected = { ...selectedEmail };
      const enrichedEmail = await emailHooks.onBeforeComposeOpenToForward.transform(selectedEmail);
      selectEmail(enrichedEmail);
      const ok = await emailHooks.onBeforeForward.intercept({
        originalEmailId: selectedEmail.id,
        originalEmail: emailToReadView(selectedEmail),
        mode: 'forward' as const,
      });
      if (!ok) {
        selectEmail(formerSelected);
        return;
      }
      await prepareComposerQuoteHeader(selectedEmail, 'forward');
    } else {
      setComposerQuoteHeader(null);
    }
    await withComposeGate('forward', { source: selectedEmail }, () => {
      startFreshComposerSession();
      setComposerMode('forward');
      setShowComposer(true);
      if (isMobile) setActiveView('viewer');
    });
  };

  // Forward the original message as a message/rfc822 attachment instead of
  // inline-quoted text - e.g. for reporting spam to an upstream gateway
  // that expects the raw original as an attachment, or preserving exact
  // formatting/headers the recipient needs to see untouched. Reuses the
  // same attachment-carry-forward mechanism native Forward already uses
  // for a forwarded message's own attachments (see the `attachments`
  // useState initializer in email-composer.tsx) - we just add one more
  // synthetic entry representing the whole original message, referenced
  // by its existing blobId (no re-fetch/re-upload needed - JMAP blobs are
  // account-scoped, not per-email). Skips prepareComposerQuoteHeader
  // entirely, so the body starts blank instead of quoting the original.
  // Takes an explicit `email` (defaulting to selectedEmail), same pattern
  // handleDelete uses just below, rather than always reading selectedEmail
  // from this closure - callers that just called selectEmail(email) and
  // invoke this synchronously in the same tick would otherwise see the
  // PRE-update value (the Zustand store updates immediately, but this
  // render's selectedEmail closure doesn't until the next render),
  // forwarding the previously selected message or no-op'ing on an
  // unselected row. See the list context-menu wiring below.
  const handleForwardAsAttachment = async (email: Email | null = selectedEmail) => {
    if (!email) return;
    email = await emailHooks.onBeforeComposeOpenToForwardAsAttachment.transform(email);
    // Same filename options "Export as .eml" uses (see emailFilenameOptions
    // in email-viewer.tsx), so the two actions produce consistent filenames
    // for the same message rather than the synthetic attachment silently
    // ignoring the user's configured naming template.
    const {
      emailDownloadTemplate,
      filenameSpaceReplacement,
      filenameLowercase,
      filenameStripDiacritics,
      filenameCollapseSeparators,
    } = useSettingsStore.getState();
    const payload = buildForwardAsAttachmentPayload(email, t('email_composer.prefix.forward'), {
      template: emailDownloadTemplate,
      spaceReplacement: filenameSpaceReplacement,
      lowercase: filenameLowercase,
      stripDiacritics: filenameStripDiacritics,
      collapseSeparators: filenameCollapseSeparators,
    });
    if (!payload) return;

    const ok = await emailHooks.onBeforeForward.intercept({
      originalEmailId: email.id,
      originalEmail: emailToReadView(email),
      mode: 'forward' as const,
    });
    if (!ok) return;

    if (!(await withComposeGate('forward', { subject: payload.subject }, () => {}))) return;
    startFreshComposerSession();
    setPendingDraft({
      to: "",
      cc: "",
      bcc: "",
      subject: payload.subject,
      body: "",
      showCc: false,
      showBcc: false,
      selectedIdentityId: null,
      subAddressTag: "",
      mode: "forward",
      draftId: null,
      replyTo: {
        subject: email.subject,
        attachments: [payload.attachment],
      },
    });
    setComposerMode('forward');
    setShowComposer(true);
    if (isMobile) setActiveView('viewer');
  };

  // Batch sibling of handleForwardAsAttachment above: opens ONE composer with
  // every selected message attached as message/rfc822. Resolution goes through
  // useEmailStore.getState() - always fresh, immune to the closure-staleness
  // noted above - and matches the account-scoped selection keys against the
  // loaded rows and expanded thread members, so attachment order follows the
  // list, not checkbox-click order. Stale selection keys (folder switched under
  // the selection) simply drop out rather than forwarding something the user
  // can no longer see. Scheduled view offers no selection (its batch toolbar
  // and menu are gated off), so resolving the regular lists is enough.
  const handleBatchForwardAsAttachment = async () => {
    const selected = resolveSelectedEmails(useEmailStore.getState());
    if (selected.length < 2) return; // menu only offers this for >1; guards future wiring

    const {
      emailDownloadTemplate,
      filenameSpaceReplacement,
      filenameLowercase,
      filenameStripDiacritics,
      filenameCollapseSeparators,
    } = useSettingsStore.getState();

    const transformed: Email[] = [];
    for (const e of selected) {
      transformed.push(await emailHooks.onBeforeComposeOpenToForwardAsAttachment.transform(e));
    }
    const payload = buildBatchForwardAsAttachmentPayload(
      transformed,
      t('email_composer.prefix.forward'),
      (count) => t('email_composer.forward_batch_count', { count }),
      {
        template: emailDownloadTemplate,
        spaceReplacement: filenameSpaceReplacement,
        lowercase: filenameLowercase,
        stripDiacritics: filenameStripDiacritics,
        collapseSeparators: filenameCollapseSeparators,
      },
    );
    if (!payload) return; // nothing attachable - same silent no-op as the single flow

    // A veto on any one original cancels the whole batch compose: opening a
    // composer missing a message a plugin refused would forward a partial set
    // the user never chose. (ReplyContext is single-email; no batch variant.)
    for (const e of transformed) {
      const ok = await emailHooks.onBeforeForward.intercept({
        originalEmailId: e.id,
        originalEmail: emailToReadView(e),
        mode: 'forward' as const,
      });
      if (!ok) return;
    }

    if (!(await withComposeGate('forward', { subject: payload.subject }, () => {}))) return;

    // A selection in the Unified Inbox can span logins, and a blobId only
    // resolves on the login that holds the message. Tag each attachment with
    // its own login so the composer copies the foreign ones over before
    // saving; when they all share one, the composer also defaults to it.
    const owners = transformed
      .filter((e) => e.blobId)
      .map((e) => e.sourceClientAccountId ?? viewingAccountId ?? undefined);
    const attachments = payload.attachments.map((att, i) =>
      owners[i] ? { ...att, sourceAccountId: owners[i] } : att);
    const sharedOwner = owners.every((o) => o === owners[0]) ? owners[0] : undefined;

    startFreshComposerSession();
    setPendingDraft({
      to: "",
      cc: "",
      bcc: "",
      subject: payload.subject,
      body: "",
      showCc: false,
      showBcc: false,
      selectedIdentityId: null,
      subAddressTag: "",
      mode: "forward",
      draftId: null,
      // No single original subject to quote - the count-based subject above
      // is the whole story, and the composer seeds attachments from this array.
      replyTo: { attachments, ...(sharedOwner ? { accountId: sharedOwner } : {}) },
    });
    setComposerMode('forward');
    setShowComposer(true);
    if (isMobile) setActiveView('viewer');
    clearSelection(); // only on success - a vetoed/no-op attempt keeps the selection
  };

  const handleDelete = async (emailToDelete: Email | null = selectedEmail) => {
    if (!client || !emailToDelete) return;

    // The trash destination and current-folder check come from the email's own
    // login and account, as the delete itself is routed: its source in a list
    // that mixes accounts, else the folder being browsed. Never the list cached
    // under the bare account id, which can be another server's account. (#281)
    let action: ReturnType<typeof resolveEmailActionContext>;
    try {
      action = resolveEmailActionContext(emailToDelete, client);
    } catch (error) {
      toast.error(t('notifications.error_deleting'), error instanceof Error ? error.message : undefined);
      return;
    }
    const actionMailboxes = action.mailboxes;

    // Check if we're currently in the trash or junk folder. In unified view the
    // "current folder" is the unified role within the email's account.
    const currentMailbox = isUnifiedView
      ? (actionMailboxes.find(m => m.role === unifiedRole && emailToDelete.mailboxIds?.[m.id])
          ?? actionMailboxes.find(m => m.role === unifiedRole))
      : actionMailboxes.find(m => m.id === selectedMailbox);
    const isInTrash = currentMailbox?.role === 'trash';
    const isInJunk = currentMailbox?.role === 'junk';
    const permanentlyDeleteJunk = useSettingsStore.getState().permanentlyDeleteJunk;

    if (isInTrash || (isInJunk && permanentlyDeleteJunk)) {
      // In trash or junk with permanent delete enabled: confirm before permanently deleting
      const confirmed = await confirmDialog({
        title: t('email_list.permanent_delete_confirm_title'),
        message: t('email_list.permanent_delete_confirm_message'),
        confirmText: t('email_list.permanent_delete'),
        variant: "destructive",
      });
      if (!confirmed) return;

      try {
        // false: a plugin stopped it and said why, so no "deleted" here.
        if (await deleteEmail(client, emailToDelete.id, true, emailKeyFor(emailToDelete))) toast.success(t('notifications.email_deleted'));
      } catch (error) {
        console.error("Failed to permanently delete email:", error);
        toast.error(t('notifications.error_deleting'), error instanceof Error ? error.message : undefined);
      }
    } else {
      // Not in trash: always move to trash (in the email's own account). Scope
      // the trash lookup to the email's account: for a shared/group source every
      // mailbox in the list is `isShared`, so we match by accountId instead of
      // excluding shared (otherwise no trash is found and the delete fails). (#281)
      const matchesScope = (m: Mailbox) =>
        action.accountId ? m.accountId === action.accountId : !m.isShared;
      const trashMailbox =
        actionMailboxes.find(m => m.role === 'trash' && matchesScope(m)) ??
        actionMailboxes.find(m => {
          if (!matchesScope(m)) return false;
          const lower = m.name.toLowerCase();
          return lower.includes('trash') || lower.includes('deleted');
        });
      if (trashMailbox) {
        try {
          if (await moveToMailbox(client, emailToDelete.id, trashMailbox.id, emailKeyFor(emailToDelete))) toast.success(t('notifications.email_deleted'));
        } catch (error) {
          console.error("Failed to move email to trash:", error);
          toast.error(error instanceof Error ? error.message : 'Failed to move email to trash');
        }
      } else {
        toast.error('Trash mailbox not found - cannot move email to trash');
      }
    }
  };

  const handleArchive = async (emailToArchive: Email | null = selectedEmail) => {
    if (!client || !emailToArchive || !isArchiveActionEnabled()) return;

    // In a list that mixes accounts (the unified views, a tag view) the archive
    // folder (and any year/month subfolders we create) must live in the email's
    // own account, reached through the login it is reachable via
    // (`sourceClientAccountId`) and routed to its owning JMAP account
    // (`sourceAccountId`), with that source's own folder list. For personal
    // sources these resolve to the account itself, so behavior is unchanged. (#281)
    const archiveClientId = emailToArchive.sourceAccountId ? emailToArchive.sourceClientAccountId : undefined;
    const archiveAccountId = archiveClientId ? emailToArchive.sourceAccountId : undefined;
    const archiveClient = archiveClientId ? useAuthStore.getState().getClientForAccount(archiveClientId) : client;
    if (!archiveClient) {
      toast.error(t('notifications.error_archiving'), 'Not connected');
      return;
    }
    // Read fresh mailboxes from the store – batch archive calls this in a loop,
    // and each iteration needs to see folders created by prior iterations.
    const readMailboxes = () => archiveAccountId
      ? resolveEmailActionContext(emailToArchive, client).mailboxes
      : useEmailStore.getState().mailboxes;
    const refreshMailboxes = () =>
      archiveAccountId
        ? useEmailStore.getState().fetchAccountMailboxes(archiveClient, archiveAccountId, archiveClientId)
        : fetchMailboxes(client);

    const currentMailboxes = readMailboxes();

    const { archiveMode } = useSettingsStore.getState();

    try {
      // Scope like batchArchive: the owning account in unified view, otherwise
      // the selected shared folder's owner, otherwise the user's own archive
      // (#889); created on first use when the account has none (#578).
      const archiveMailbox = await ensureArchiveMailbox({
        client: archiveClient,
        mailboxes: currentMailboxes,
        selectedMailboxId: selectedMailbox,
        accountId: archiveAccountId,
        refresh: async () => {
          await refreshMailboxes();
          return readMailboxes();
        },
      });
      if (!archiveMailbox) return; // a plugin refused the Archive folder

      let archived: boolean;
      if (archiveMode === 'single') {
        archived = await moveThreadToMailbox(client, emailToArchive.id, archiveMailbox.id, emailKeyFor(emailToArchive));
      } else {
        const emailDate = new Date(emailToArchive.receivedAt);
        const year = emailDate.getFullYear().toString();
        const month = (emailDate.getMonth() + 1).toString().padStart(2, '0');
        const archiveId = archiveMailbox.originalId || archiveMailbox.id;
        // By the server's ids: the list names a shared account's folders and
        // their parents `account:id`, so a group's year folder was never
        // found again. The folders go in the Archive's own account, and only
        // that account's are looked at: the own folders have server ids too.
        const parentOf = (m: Mailbox) => (m.parentId && m.accountId && m.parentId.startsWith(`${m.accountId}:`)
          ? m.parentId.slice(m.accountId.length + 1)
          : m.parentId);
        const folderAccountId = archiveMailbox.accountId ?? archiveAccountId;
        const isFolder = (m: Mailbox, name: string, parentId: string) =>
          m.name === name && parentOf(m) === parentId && (!folderAccountId || m.accountId === folderAccountId);

        let yearMailbox = currentMailboxes.find(m => isFolder(m, year, archiveId)) ?? null;
        if (!yearMailbox) {
          yearMailbox = await createMailboxWithHooks(archiveClient, year, archiveId, folderAccountId);
          if (!yearMailbox) return; // a plugin refused the folder
          await refreshMailboxes();
        }

        if (archiveMode === 'year') {
          archived = await moveThreadToMailbox(client, emailToArchive.id, yearMailbox.id, emailKeyFor(emailToArchive));
        } else {
          const yearId = yearMailbox.originalId || yearMailbox.id;
          const afterYear = readMailboxes();
          let monthMailbox = afterYear.find(m => isFolder(m, month, yearId)) ?? null;
          if (!monthMailbox) {
            monthMailbox = await createMailboxWithHooks(archiveClient, month, yearId, folderAccountId);
            if (!monthMailbox) return; // a plugin refused the folder
            await refreshMailboxes();
          }
          archived = await moveThreadToMailbox(client, emailToArchive.id, monthMailbox.id, emailKeyFor(emailToArchive));
        }
      }
      if (!archived) return;

      if (conversationThread && conversationThread.threadKey === threadKeyFor(emailToArchive)) {
        ++conversationOpenSeqRef.current;
        setConversationBlobSource(undefined);
        setConversationThread(null);
        setConversationEmails([]);
      }

      toast.success(t('notifications.email_archived'));
      void refreshMailboxes();
    } catch (error) {
      console.error("Failed to archive email:", error);
      if (error instanceof ArchiveMailboxNotFoundError) {
        toast.error(t('email_viewer.archive_mailbox_not_found'));
        return;
      }
      toast.error(t('notifications.error_archiving'), error instanceof Error ? error.message : undefined);
    }
  };

  // "Remove from this folder" for the open message (#615): only when it is
  // in the folder the list shows and in another one too.
  const removeFromFolder = useRemoveFromFolder();
  const folderToLeave = useEmailStore(removalFolder);
  const openEmailCanLeaveFolder = !!selectedEmail && canRemoveFromFolder(selectedEmail, folderToLeave);

  const handleMoveToMailbox = async (emailId: string, mailboxId: string, emailKey?: string) => {
    if (!client) return;
    const destinationList = [mailboxes, ...Object.values(accountMailboxes)]
      .find(list => list.some(m => m.id === mailboxId));
    const destination = destinationList?.find(m => m.id === mailboxId);
    try {
      if (!(await moveToMailboxCrossAware(client, emailId, mailboxId, emailKey))) return;
      toast.success(
        t('notifications.email_moved'),
        destination && destinationList
          ? t('notifications.moved_to_mailbox', { mailbox: getMailboxPath(destination, destinationList) })
          : undefined,
      );
    } catch (error) {
      console.error("Failed to move email:", error);
      toast.error(t('notifications.move_failed'), t('notifications.move_error'));
    }
  };

  const handleToggleStar = async () => {
    if (!client || !selectedEmail) return;

    try {
      await toggleStar(client, selectedEmail.id, emailKeyFor(selectedEmail));
    } catch (error) {
      console.error("Failed to toggle star:", error);
      toast.error(t('notifications.error_updating'));
    }
  };

  const handleMarkAsSpam = async (emailToMark: Email | null = selectedEmail) => {
    if (!client || !emailToMark) return;

    const emailId = emailToMark.id;

    try {
      if (!(await markAsSpam(client, emailId, emailKeyFor(emailToMark)))) return;

      toast.success(t('email_viewer.spam.toast_success'), {
        action: {
          label: t('email_viewer.spam.toast_undo'),
          onClick: async () => {
            try {
              if (await undoSpam(client, emailId, emailKeyFor(emailToMark))) toast.success(t('notifications.email_moved'));
            } catch (_error) {
              console.error("Failed to undo spam:", _error);
              toast.error(t('email_viewer.spam.error'));
            }
          },
        },
        duration: 5000,
      });
    } catch (_error) {
      console.error("Failed to mark as spam:", _error);
      toast.error(t('email_viewer.spam.error'));
    }
  };

  const handleUndoSpam = async (emailToRestore: Email | null = selectedEmail) => {
    if (!client || !emailToRestore) return;

    try {
      if (!(await undoSpam(client, emailToRestore.id, emailKeyFor(emailToRestore)))) return;

      toast.success(t('email_viewer.spam.toast_not_spam_success'));
    } catch (_error) {
      console.error("Failed to restore email:", _error);
      toast.error(t('email_viewer.spam.error_not_spam'));
    }
  };

  const handleTogglePinned = async (emailToPin: Email) => {
    if (!client) return;

    try {
      const email = emails.find(e => emailKeyFor(e) === emailKeyFor(emailToPin)) ?? emailToPin;
      const isPinned = email.keywords?.['$pinned'] === true;

      // Same routing as tags: the write goes to the email's own account, and
      // the local patch flips the icon immediately. Then refetch the first page
      // so the mail floats/sinks per the server's pinned-first sort. Skip the
      // refetch where that sort does not apply (unified views) or where it
      // would replace a tag-filtered list (refreshCurrentMailbox fetches by
      // folder only). (#281)
      // Only $pinned changes; the row's other keywords may be stale.
      await patchEmailKeywords(client, email.id, { $pinned: !isPinned }, emailKeyFor(email));
      if (!isUnifiedView && !useEmailStore.getState().selectedKeyword) {
        void refreshCurrentMailbox(client);
      }
    } catch (error) {
      console.error("Failed to toggle pin:", error);
      toast.error(t('notifications.error_updating'));
    }
  };

  const handleSetTag = async (emailId: string, tagId: string | null, emailKey?: string) => {
    if (!client) return;

    try {
      // Remove any existing tag keywords. By the row's key when given: the bare
      // id can also be another account's message in a merged view.
      const email = emailKey ? emails.find(e => emailKeyFor(e) === emailKey) : emails.find(e => e.id === emailId);
      if (!email) return;

      // Only the tag keywords change: writing the whole set from this row
      // would undo keywords another client set since ($seen, $answered).
      const keywords = email.keywords ?? {};
      const changes: Record<string, boolean> = {};

      if (tagId === null) {
        // Remove all tag keywords
        Object.keys(keywords).forEach(key => {
          if (keywords[key] && (key.startsWith(KEYWORD_PREFIX) || key.startsWith(KEYWORD_PREFIX_LEGACY))) {
            changes[key] = false;
          }
        });
      } else {
        // Both prefixes name the same tag when read, so taking one off has to
        // clear whichever spellings are actually set.
        const activeKeys = [KEYWORD_PREFIX + tagId, KEYWORD_PREFIX_LEGACY + tagId]
          .filter(key => keywords[key]);
        if (activeKeys.length > 0) {
          activeKeys.forEach(key => {
            changes[key] = false;
          });
        } else {
          // Add the tag without disturbing others
          changes[KEYWORD_PREFIX + tagId] = true;
        }
      }

      // Routes the write to the email's own account, then patches the email in
      // place so the list keeps its scroll/pagination state instead of being
      // reset to the first page by a full refetch. Resolving the account at the
      // call site covered only the unified view, so a tag set on a directly
      // selected shared folder was written to the reaching account and silently
      // dropped by the server. (#281)
      await patchEmailKeywords(client, emailId, changes, emailKeyFor(email));

      // Refresh tag counts
      fetchTagCounts(client);
    } catch (error) {
      // The message keeps its old tags. Stalwart 1.0 refuses keywords over
      // 128 bytes and more than 100 on one message.
      console.error("Failed to set tag:", error);
      toast.error(t('notifications.tag_failed'));
    }
  };

  // Whenever the global active account changes, drop any non-active viewing
  // override so we don't leave the email list pointed at a now-stale id.
  useEffect(() => {
    if (viewingAccountId && viewingAccountId === activeAccountId) {
      setViewingAccount(null);
    }
  }, [activeAccountId, viewingAccountId, setViewingAccount]);

  // Pro sidebar: user clicked a folder under a specific account group.
  // accountId === null means the active account; non-null means a viewing
  // override that fetches via that account's JMAP client.
  // When "Clear search when switching folders" is on, a folder click drops
  // any active text query + advanced filters and browses the folder instead
  // of re-running the search there (#553 is the default: search follows you
  // across folders). Returns true when it cleared, so the caller browses
  // rather than re-searching. Reads the current query/filters from the
  // closure to decide whether there was anything to clear.
  const clearSearchIfFolderChangeResets = (): boolean => {
    if (!useSettingsStore.getState().clearSearchOnFolderChange) return false;
    if (isFilterEmpty(searchFilters) && !searchQuery) return false;
    setSearchQuery("");
    clearSearchFilters();
    return true;
  };

  const handleAccountMailboxSelect = async (accountId: string | null, mailboxId: string) => {
    const viewingClient = accountId
      ? useAuthStore.getState().getClientForAccount(accountId) ?? client
      : client;
    selectAccountMailbox(accountId, mailboxId);
    selectEmail(null);
    if (isMobile) {
      setSidebarOpen(false);
      setActiveView("list");
    }
    if (isTablet) {
      setTabletListVisible(true);
    }
    if (viewingClient) {
      // Keep an active search applied when switching folders (#553), unless
      // the user opted to reset search on folder change. The store actions
      // resolve the viewing account's client internally.
      const searchCleared = clearSearchIfFolderChangeResets();
      if (!searchCleared && !isFilterEmpty(searchFilters)) {
        await advancedSearch(viewingClient);
      } else if (!searchCleared && searchQuery) {
        await searchEmails(viewingClient, searchQuery);
      } else {
        await fetchEmails(viewingClient, mailboxId);
      }
    }
  };

  const handleMailboxSelect = async (mailboxId: string) => {
    // A shared account's Scheduled row arrives as "__scheduled__:<accountId>";
    // the store only ever sees the plain virtual id plus the account scope.
    const scheduledSelection = parseScheduledMailboxId(mailboxId);
    if (scheduledSelection.isScheduled) {
      if (!delayedSendSupported) {
        setScheduledView(false);
        return;
      }
      if (isUnifiedView) exitUnifiedView();
      setScheduledView(true, scheduledSelection.accountId);
      selectMailbox(SCHEDULED_MAILBOX_ID);
      selectEmail(null);
      clearSelection();
      if (isMobile) {
        setSidebarOpen(false);
        setActiveView("list");
      }
      if (isTablet) {
        setTabletListVisible(true);
      }
      if (client) await fetchScheduledEmails(client);
      return;
    }

    if (isUnifiedMailboxId(mailboxId)) {
      setScheduledView(false);
      const role = UNIFIED_ROLE_BY_ID[mailboxId];
      if (!role) return;

      selectMailbox(mailboxId);
      selectEmail(null);

      if (isMobile) {
        setSidebarOpen(false);
        setActiveView("list");
      }
      if (isTablet) {
        setTabletListVisible(true);
      }

      const isSameView = captureViewToken();
      const populated = await buildPopulatedUnifiedAccounts();
      // Another folder was picked while the accounts loaded; entering this
      // view now would put it over that folder (#1102).
      if (!isSameView()) return;
      const searchCleared = clearSearchIfFolderChangeResets();
      // Keep an active search across the switch and re-run it in this view
      // (mirrors normal mailboxes), preserving advanced filters; otherwise browse.
      if (client && !searchCleared && (!isFilterEmpty(searchFilters) || searchQuery)) {
        useEmailStore.setState({ isUnifiedView: true, unifiedRole: role, crossView: null });
        if (!isFilterEmpty(searchFilters)) {
          await advancedSearch(client);
        } else {
          await searchEmails(client, searchQuery);
        }
      } else {
        await fetchUnifiedEmailsAction(populated, role);
      }
      refreshUnifiedCounts(populated);
      return;
    }

    if (isCrossViewId(mailboxId)) {
      setScheduledView(false);
      const view = CROSS_VIEW_BY_ID[mailboxId];
      if (!view) return;

      selectMailbox(mailboxId);
      selectEmail(null);

      if (isMobile) {
        setSidebarOpen(false);
        setActiveView("list");
      }
      if (isTablet) {
        setTabletListVisible(true);
      }

      const isSameView = captureViewToken();
      const populated = await buildPopulatedUnifiedAccounts();
      if (!isSameView()) return;
      const searchCleared = clearSearchIfFolderChangeResets();
      // Keep an active search across the switch and re-run it in this view
      // (mirrors normal mailboxes), preserving advanced filters; otherwise browse.
      if (client && !searchCleared && (!isFilterEmpty(searchFilters) || searchQuery)) {
        useEmailStore.setState({ isUnifiedView: true, crossView: view, unifiedRole: null });
        if (!isFilterEmpty(searchFilters)) {
          await advancedSearch(client);
        } else {
          await searchEmails(client, searchQuery);
        }
      } else {
        await fetchCrossViewAction(populated, view);
      }
      refreshCrossCounts(populated);
      return;
    }

    if (isUnifiedView) {
      exitUnifiedView();
    }
    setScheduledView(false);

    selectMailbox(mailboxId);
    selectEmail(null); // Clear selected email when switching mailboxes

    // On mobile, close sidebar and go to list view
    if (isMobile) {
      setSidebarOpen(false);
      setActiveView("list");
    }

    // On tablet, show the list again
    if (isTablet) {
      setTabletListVisible(true);
    }

    if (client) {
      // If there's an active search, re-run it in the new mailbox unless the
      // user opted to reset search on folder change. Advanced filters must go
      // through advancedSearch (which also includes the text query) — falling
      // back to fetchEmails would silently drop them while the UI still shows
      // them as active (#553).
      const searchCleared = clearSearchIfFolderChangeResets();
      if (!searchCleared && !isFilterEmpty(searchFilters)) {
        await advancedSearch(client);
      } else if (!searchCleared && searchQuery) {
        await searchEmails(client, searchQuery);
      } else {
        await fetchEmails(client, mailboxId);
      }
    }
  };

  const handleTagSelect = async (keywordId: string | null) => {
    setScheduledView(false);
    selectKeyword(keywordId);

    // On mobile, close sidebar and go to list view
    if (isMobile) {
      setSidebarOpen(false);
      setActiveView("list");
    }

    // On tablet, show the list again
    if (isTablet) {
      setTabletListVisible(true);
    }

    if (client) {
      await fetchEmails(client);
    }
  };

  const handleUnreadFilterClick = async (mailboxId: string) => {
    const isTogglingOff = selectedMailbox === mailboxId && !selectedKeyword && searchFilters.isUnread === true;

    // Open the mailbox unless it is already the one listed. A tag view keeps
    // selectedMailbox, so it counts as another view.
    if (selectedMailbox !== mailboxId || selectedKeyword) {
      if (isUnifiedView) exitUnifiedView();
      setScheduledView(false);
      selectMailbox(mailboxId);
      selectEmail(null);
    }

    // On mobile, close sidebar and go to list view
    if (isMobile) {
      setSidebarOpen(false);
      setActiveView("list");
    }

    // On tablet, show the list again
    if (isTablet) {
      setTabletListVisible(true);
    }

    if (isTogglingOff) {
      // Disable the unread filter and show all emails
      clearSearchFilters();
      if (client) {
        await fetchEmails(client, mailboxId);
      }
    } else {
      // Enable unread filter, in this folder only
      clearSearchFilters();
      scopeSearchToOpenFolder();
      setSearchFilters({ isUnread: true });
      if (client) {
        await advancedSearch(client);
      }
    }
  };

  const tCtxMenu = t;

  const handleMarkFolderRead = async (mailboxId: string) => {
    if (!client) return;
    try {
      const count = await markMailboxAsRead(client, mailboxId);
      if (count === null) return; // a plugin stopped it and said why
      await fetchMailboxes(client);
      if (selectedMailbox === mailboxId) await fetchEmails(client, mailboxId);
      if (count > 0) {
        toast.success(tCtxMenu('mailbox_context_menu.toast_marked_read_count', { count }));
      } else {
        toast.success(tCtxMenu('mailbox_context_menu.toast_already_read'));
      }
    } catch {
      toast.error(tCtxMenu('mailbox_context_menu.toast_error_mark_read'));
    }
  };

  const handleMarkFolderTreeRead = async (mailboxId: string) => {
    if (!client) return;
    const collectIds = (rootId: string): string[] => {
      const ids: string[] = [rootId];
      const stack = [rootId];
      while (stack.length > 0) {
        const current = stack.pop()!;
        for (const mb of mailboxes) {
          if (mb.parentId === current) {
            ids.push(mb.id);
            stack.push(mb.id);
          }
        }
      }
      return ids;
    };

    try {
      const ids = collectIds(mailboxId);
      let total = 0;
      let stopped = false;
      for (const id of ids) {
        const count = await markMailboxAsRead(client, id);
        if (count === null) stopped = true;
        else total += count;
      }
      // Every folder a plugin stopped: it said why, nothing to report.
      if (stopped && total === 0) return;
      await fetchMailboxes(client);
      if (selectedMailbox && ids.includes(selectedMailbox)) await fetchEmails(client, selectedMailbox);
      if (total > 0) {
        toast.success(tCtxMenu('mailbox_context_menu.toast_marked_read_count', { count: total }));
      } else {
        toast.success(tCtxMenu('mailbox_context_menu.toast_already_read'));
      }
    } catch {
      toast.error(tCtxMenu('mailbox_context_menu.toast_error_mark_read'));
    }
  };

  const handleMarkAllFoldersRead = async () => {
    if (!client) return;

    const confirmed = await confirmDialog({
      title: tCtxMenu('mailbox_context_menu.mark_all_confirm_title'),
      message: tCtxMenu('mailbox_context_menu.mark_all_confirm_message'),
      confirmText: tCtxMenu('mailbox_context_menu.mark_all_folders_read'),
      variant: "default",
    });
    if (!confirmed) return;

    try {
      const total = await useEmailStore.getState().markAllMailboxesAsRead(client);
      if (total === null) return; // a plugin stopped it and said why
      await fetchMailboxes(client);
      if (selectedMailbox) await fetchEmails(client, selectedMailbox);
      if (total > 0) {
        toast.success(tCtxMenu('mailbox_context_menu.toast_marked_read_count', { count: total }));
      } else {
        toast.success(tCtxMenu('mailbox_context_menu.toast_already_read'));
      }
    } catch {
      toast.error(tCtxMenu('mailbox_context_menu.toast_error_mark_read'));
    }
  };

  const handleEmptyFolderFromContextMenu = async (mailboxId: string) => {
    if (!client) return;
    const mailbox = mailboxes.find(mb => mb.id === mailboxId);
    if (!mailbox) return;

    const confirmed = await confirmDialog({
      title: tCtxMenu('email_list.empty_folder.confirm_title'),
      message: emptyFolderMovesToTrash(mailbox)
        ? tCtxMenu('email_list.empty_folder.confirm_message_trash')
        : tCtxMenu('email_list.empty_folder.confirm_message'),
      confirmText: tCtxMenu('email_list.empty_folder.confirm_button'),
      variant: "destructive",
    });
    if (!confirmed) return;

    try {
      if (await emptyMailbox(client, mailboxId)) toast.success(tCtxMenu('mailbox_context_menu.toast_emptied'));
    } catch {
      toast.error(tCtxMenu('mailbox_context_menu.toast_error_empty'));
    }
  };

  const handleCreateSubfolderFromContextMenu = async (parentId: string) => {
    if (!client) return;
    const name = await promptDialog({
      title: tCtxMenu('mailbox_context_menu.new_subfolder'),
      message: tCtxMenu('mailbox_context_menu.prompt_new_subfolder'),
      placeholder: tCtxMenu('mailbox_context_menu.placeholder_folder_name'),
      confirmText: tCtxMenu('mailbox_context_menu.create'),
    });
    if (!name) return;
    try {
      if (await createMailbox(client, name, parentId)) toast.success(tCtxMenu('mailbox_context_menu.toast_folder_created'));
    } catch {
      toast.error(tCtxMenu('mailbox_context_menu.toast_error_create'));
    }
  };

  const handleCreateFolderFromContextMenu = async (accountId?: string) => {
    if (!client) return;
    const name = await promptDialog({
      title: tCtxMenu('mailbox_context_menu.new_folder'),
      message: tCtxMenu('mailbox_context_menu.prompt_new_folder'),
      placeholder: tCtxMenu('mailbox_context_menu.placeholder_folder_name'),
      confirmText: tCtxMenu('mailbox_context_menu.create'),
    });
    if (!name) return;
    try {
      if (await createMailbox(client, name, undefined, accountId)) toast.success(tCtxMenu('mailbox_context_menu.toast_folder_created'));
    } catch {
      toast.error(tCtxMenu('mailbox_context_menu.toast_error_create'));
    }
  };

  const handleRenameFolderFromContextMenu = async (mailboxId: string) => {
    if (!client) return;
    const mailbox = mailboxes.find(mb => mb.id === mailboxId);
    if (!mailbox) return;
    const name = await promptDialog({
      title: tCtxMenu('mailbox_context_menu.rename'),
      message: tCtxMenu('mailbox_context_menu.prompt_rename'),
      placeholder: tCtxMenu('mailbox_context_menu.placeholder_folder_name'),
      defaultValue: mailbox.name,
      confirmText: tCtxMenu('mailbox_context_menu.rename_confirm'),
    });
    if (!name || name === mailbox.name) return;
    try {
      if (await renameMailbox(client, mailboxId, name)) toast.success(tCtxMenu('mailbox_context_menu.toast_folder_renamed'));
    } catch {
      toast.error(tCtxMenu('mailbox_context_menu.toast_error_rename'));
    }
  };

  // Folder sharing (mail:share): the dialog loads the folder's shareWith on
  // open, so only the id needs to be remembered here.
  const [sharingMailboxId, setSharingMailboxId] = useState<string | null>(null);
  const sharingMailbox = sharingMailboxId ? mailboxes.find(mb => mb.id === sharingMailboxId) ?? null : null;
  const supportsMailboxSharing = !!client?.supportsMailboxSharing?.();
  const handleShareFolderFromContextMenu = (mailboxId: string) => {
    if (!client) return;
    setSharingMailboxId(mailboxId);
  };

  const handleDeleteFolderFromContextMenu = async (mailboxId: string) => {
    if (!client) return;
    const mailbox = mailboxes.find(mb => mb.id === mailboxId);
    if (!mailbox) return;

    const confirmed = await confirmDialog({
      title: tCtxMenu('mailbox_context_menu.delete_confirm_title'),
      message: tCtxMenu('mailbox_context_menu.delete_confirm_message', { name: mailbox.name }),
      confirmText: tCtxMenu('mailbox_context_menu.delete_folder'),
      variant: "destructive",
    });
    if (!confirmed) return;

    try {
      if (await deleteMailbox(client, mailboxId)) toast.success(tCtxMenu('mailbox_context_menu.toast_folder_deleted'));
    } catch (err: unknown) {
      const jmapType = jmapErrorType(err);
      if (jmapType === 'mailboxHasChild') {
        toast.error(tCtxMenu('mailbox_context_menu.toast_error_delete_has_children'));
      } else if (jmapType === 'mailboxHasEmail') {
        // The server refuses to drop a folder that still holds mail. Offer to
        // take the messages with it (onDestroyRemoveEmails) after a second,
        // explicit confirmation that names the count.
        const withContents = await confirmDialog({
          title: tCtxMenu('mailbox_context_menu.delete_with_contents_title'),
          message: tCtxMenu('mailbox_context_menu.delete_with_contents_message', { name: mailbox.name, count: mailbox.totalEmails }),
          confirmText: tCtxMenu('mailbox_context_menu.delete_with_contents_confirm'),
          variant: "destructive",
        });
        if (!withContents) return;
        try {
          if (await deleteMailbox(client, mailboxId, { removeEmails: true })) toast.success(tCtxMenu('mailbox_context_menu.toast_folder_deleted'));
        } catch {
          toast.error(tCtxMenu('mailbox_context_menu.toast_error_delete'));
        }
      } else {
        toast.error(tCtxMenu('mailbox_context_menu.toast_error_delete'));
      }
    }
  };

  const handleImportEmailFromContextMenu = (mailboxId: string) => {
    if (!client) return;
    const mailbox = mailboxes.find(mb => mb.id === mailboxId);
    if (!mailbox) return;
    const targetMailboxId = mailbox.originalId || mailbox.id;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = EML_IMPORT_ACCEPT;
    input.multiple = true;
    input.onchange = async (e) => {
      const files = Array.from((e.target as HTMLInputElement).files ?? []);
      if (files.length === 0) return;

      let emails;
      try {
        emails = await expandImportableEmails(files);
      } catch {
        toast.error(t('notifications.import_email_error'));
        return;
      }

      let imported = 0;
      let failed = 0;
      for (const { blob, receivedAt } of emails) {
        try {
          await client.importRawEmail(blob, { [targetMailboxId]: true }, { '$seen': true }, undefined, receivedAt);
          imported++;
        } catch {
          failed++;
        }
      }

      if (imported > 0) {
        toast.success(t('notifications.import_email_success'));
        if (selectedMailbox) await fetchEmails(client, selectedMailbox);
      }
      if (failed > 0 || (imported === 0 && emails.length === 0)) {
        toast.error(t('notifications.import_email_error'));
      }
    };
    input.click();
  };

  const handleRefreshMailboxes = async () => {
    if (!client) return;
    try {
      await fetchMailboxes(client);
      if (selectedMailbox) await fetchEmails(client, selectedMailbox);
    } catch {
      // silent
    }
  };

  const handleLogout = logout;

  const handleSearch = async (query: string) => {
    if (!client) return;
    // Nothing the mail view renders from is written before the request has
    // left (see afterRequestDispatch): searchEmails records the query itself,
    // and the history entry only feeds the suggestion dropdown.
    afterRequestDispatch(() => useSearchHistoryStore.getState().addRecentSearch(query));
    if (!isFilterEmpty(searchFilters)) {
      // advancedSearch reads the query from the store.
      setSearchQuery(query);
      await advancedSearch(client);
    } else {
      await searchEmails(client, query);
    }
  };

  // A contact picked from the search-bar suggestions (#845) becomes a
  // from:/to: filter — the typed text was only ever the lookup key, so it is
  // dropped rather than ANDed into the query as a full-text term.
  const handleSelectContactSuggestion = async (contact: ContactSuggestion, field: ContactSearchField) => {
    if (!client) return;
    setSearchQuery("");
    setSearchFilters({ [field]: contact.email });
    await advancedSearch(client);
  };

  const handleClearSearch = async () => {
    setSearchQuery("");
    clearSearchFilters();
    if (!client) return;
    // In unified view the active "mailbox" is a virtual role or cross view, so
    // refresh via the unified fan-out instead of fetchEmails.
    if (isUnifiedView) {
      const isSameView = captureViewToken();
      const populated = await buildPopulatedUnifiedAccounts();
      if (!isSameView()) return;
      const role = useEmailStore.getState().unifiedRole;
      const cross = useEmailStore.getState().crossView;
      if (role) {
        await fetchUnifiedEmailsAction(populated, role);
      } else if (cross) {
        await fetchCrossViewAction(populated, cross);
      }
      return;
    }
    if (selectedMailbox) {
      await fetchEmails(client, selectedMailbox);
    }
  };

  // Starred for Mountain View: the "All starred" view when the user has one, otherwise
  // the advanced-search star toggle, which shows the same messages as a
  // search. Used by `g s` and by Mountain View's Starred row.
  const goToStarred = () => {
    if (showCrossStarred) {
      void handleMailboxSelect(CROSS_VIEW_IDS.starred);
      return;
    }
    setSearchFilters({ ...DEFAULT_SEARCH_FILTERS, isStarred: true });
    void handleAdvancedSearch();
  };

  const handleAdvancedSearch = async () => {
    if (!client) return;
    await advancedSearch(client);
  };

  const advancedSearchDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const handleAdvancedSearchDebounced = useCallback(() => {
    if (advancedSearchDebounceRef.current) {
      clearTimeout(advancedSearchDebounceRef.current);
    }
    advancedSearchDebounceRef.current = setTimeout(() => {
      if (client) advancedSearch(client);
    }, 300);
  }, [client, advancedSearch]);

  useEffect(() => {
    return () => {
      if (advancedSearchDebounceRef.current) {
        clearTimeout(advancedSearchDebounceRef.current);
      }
    };
  }, []);

  // Resolve from the originating message, including direct shared folders.
  const resolveBlobSource = useCallback((email: typeof selectedEmail) => {
    const { client: blobClient, accountId, clientAccountId } = resolveEmailBlobContext(email, client);
    return { blobClient, accountId, clientAccountId };
  }, [client]);

  // Opens an attachment the built-in preview cannot render but the office
  // editor can (docx, odt, xlsx, ...). The launch route runs server-side with
  // one login's cookie, so it needs that login's slot and an explicit
  // accountId (the client's default one when the message is not delegated).
  const openOfficeAttachment = useCallback((
    blobClient: NonNullable<typeof client>,
    attachment: { blobId: string; name: string; type?: string; size?: number },
    accountId: string | undefined,
    clientAccountId: string | undefined,
  ): boolean => {
    if (isFilePreviewable(attachment.name, attachment.type) || !canWopiOpen(wopiStatus, attachment.name)) return false;
    const slot = clientAccountId
      ? (useAccountStore.getState().getAccountById(clientAccountId)?.cookieSlot ?? null)
      : null;
    setOfficeAttachment({ ...attachment, accountId: accountId || blobClient.getAccountId(), slot });
    return true;
  }, [wopiStatus]);

  // Opening an attachment straight from a list row. Deliberately resolves
  // the blob source from that row's own email rather than the selected one:
  // in the unified inbox each row can belong to a different account, and
  // the selected message may be from another one entirely — or none.
  const handleOpenListAttachment = useCallback(async (email: Email, attachment: Attachment) => {
    const { blobClient, accountId, clientAccountId } = resolveBlobSource(email);
    const name = attachment.name;
    if (!blobClient || !name) return;
    try {
      const { mailAttachmentAction } = useSettingsStore.getState();
      if (mailAttachmentAction === 'preview' && isFilePreviewable(name, attachment.type)) {
        setPreviewAttachment({ blobId: attachment.blobId, name, type: attachment.type, accountId, client: blobClient });
        return;
      }
      if (mailAttachmentAction === 'preview' && openOfficeAttachment(
        blobClient, { blobId: attachment.blobId, name, type: attachment.type, size: attachment.size }, accountId, clientAccountId,
      )) return;
      await blobClient.downloadBlob(attachment.blobId, name, attachment.type, accountId);
    } catch (error) {
      console.error("Failed to open attachment from the list:", error);
    }
  }, [resolveBlobSource, openOfficeAttachment]);

  // Where a list row's attachment parts are fetched from: the same routing
  // the viewer uses to open that row (source stamps first, then the account
  // being browsed, then a shared folder's owner). Read through a ref so the
  // loader stays stable and rows do not re-request on every folder count
  // change. A layout effect, because the rows ask from their own (passive)
  // effects in the same commit.
  const listRowSourceRef = useRef<(email: Email) => { source: ListAttachmentSource; accountId?: string } | null>(() => null);
  useLayoutEffect(() => {
    listRowSourceRef.current = (email) => {
      const auth = useAuthStore.getState();
      if (email.sourceClientAccountId) {
        const source = auth.getClientForAccount(email.sourceClientAccountId);
        return source ? { source, accountId: email.sourceAccountId } : null;
      }
      const source = (viewingAccountId ? auth.getClientForAccount(viewingAccountId) : undefined) ?? client;
      if (!source) return null;
      const accountId = email.sourceAccountId
        ?? resolveUnstampedEmailAccountId({
            mailboxes: viewMailboxes,
            selectedMailbox,
            searchActive: !!searchQuery || !isFilterEmpty(searchFilters),
            searchMailboxId,
          });
      return { source, accountId };
    };
  }, [client, viewingAccountId, viewMailboxes, selectedMailbox, searchQuery, searchFilters, searchMailboxId]);

  const loadListAttachments = useMemo<LoadListAttachments>(() => {
    const load: LoadListAttachments = (email, onLoad) => {
      const target = listRowSourceRef.current(email);
      if (!target) return () => {};
      return requestListAttachments(target.source, target.accountId, email.id, onLoad);
    };
    load.peek = (email) => {
      const target = listRowSourceRef.current(email);
      return target ? peekListAttachments(target.source, target.accountId, email.id) : undefined;
    };
    return load;
  }, []);

  const handleDownloadAttachment = async (blobId: string, name: string, type?: string, forceDownload?: boolean, source?: EmailBlobContext) => {
    const { client: blobClient, accountId, clientAccountId } = source ?? resolveEmailBlobContext(selectedEmail, client);
    if (!blobClient) return;

    try {
      const { mailAttachmentAction } = useSettingsStore.getState();

      if (!forceDownload && mailAttachmentAction === 'preview' && isFilePreviewable(name, type)) {
        setPreviewAttachment({ blobId, name, type, accountId, client: blobClient });
        return;
      }
      if (!forceDownload && mailAttachmentAction === 'preview' && openOfficeAttachment(
        blobClient, { blobId, name, type }, accountId, clientAccountId,
      )) return;

      await blobClient.downloadBlob(blobId, name, type, accountId);
    } catch (error) {
      console.error("Failed to download attachment:", error);
    }
  };

  const handleDownloadConversationAttachment = (blobId: string, name: string, type: string | undefined, source: EmailBlobContext) =>
    handleDownloadAttachment(blobId, name, type, false, source);

  const handlePreviewAttachmentDownload = useCallback(async () => {
    const c = previewAttachment?.client;
    if (!c || !previewAttachment) return;

    await c.downloadBlob(previewAttachment.blobId, previewAttachment.name, previewAttachment.type, previewAttachment.accountId);
  }, [previewAttachment]);

  const getPreviewAttachmentContent = useCallback(async () => {
    const c = previewAttachment?.client;
    if (!c || !previewAttachment) {
      throw new Error('No attachment selected');
    }

    const blob = await c.fetchBlob(previewAttachment.blobId, previewAttachment.name, previewAttachment.type, previewAttachment.accountId);

    return {
      blob,
      contentType: previewAttachment.type || blob.type || 'application/octet-stream',
    };
  }, [previewAttachment]);

  const handleQuickReply = async (body: string) => {
    if (!client || !selectedEmail) return;

    // Quick reply follows the same addressing rules as the composer: Reply-To
    // over From, and for our own messages in a thread the original recipients
    // instead of ourselves (#703).
    const ownIdentityEmails = identities.map(i => i.email).filter(Boolean);
    const replySource = {
      from: selectedEmail.from,
      replyToAddresses: selectedEmail.replyTo,
      to: selectedEmail.to,
      cc: selectedEmail.cc,
    };
    const recipients = buildReplyRecipients(replySource, 'reply', ownIdentityEmails).to
      .map(r => r.email)
      .filter((email): email is string => Boolean(email));
    if (recipients.length === 0) {
      throw new Error("No sender email found");
    }

    const primaryIdentity = identities[0];

    // Send from the address the message was delivered to, so a reply out of a
    // shared or aliased mailbox does not go out as the account owner. Our own
    // message keeps the identity it was sent from - the recipients are the
    // other party, so resolving from them would send as their address.
    //
    // Quick reply resolves the user's OWN identities only. It deliberately does
    // NOT take the domain catch-all `From:` rewrite that the full composer
    // offers: this surface is a bare text box with no From row, so a rewritten
    // From would be applied with nothing on screen to show it - or to correct
    // it. A catch-all delivery quick-replies as the matching own identity, and
    // the user can open the full composer when they need the rewrite.
    const selfSentIdentityId = isSelfSent(replySource, ownIdentityEmails)
      ? findDraftIdentityId(identities, selectedEmail.from?.[0])
      : null;
    const sendingIdentityId = selfSentIdentityId ?? findReplyIdentityId(identities, {
      to: selectedEmail.to,
      cc: selectedEmail.cc,
      bcc: selectedEmail.bcc,
    });
    const sendingIdentity =
      (sendingIdentityId ? identities.find((i) => i.id === sendingIdentityId) : undefined) || primaryIdentity;
    const headerFromEmail = sendingIdentity?.email;
    const headerFromName = sendingIdentity?.name || undefined;

    // Alias and shared identities frequently carry no signature of their own,
    // so fall back to the primary's - the composer does the same
    // (`signatureIdentity`). Without it, quick-replying from a shared mailbox
    // silently drops the user's signature.
    const signatureIdentity = (sendingIdentity?.htmlSignature || sendingIdentity?.textSignature)
      ? sendingIdentity
      : primaryIdentity;
    const separator = useSettingsStore.getState().signatureSeparatorEnabled;
    const finalBody = appendPlainTextSignature(body, signatureIdentity, { separator });

    // When the identity has an HTML signature, send a matching HTML body so the
    // signature keeps its formatting; appendPlainTextSignature would otherwise
    // flatten it to plain text. Text-only identities keep the plain-text-only
    // behavior (htmlBody stays undefined).
    const escapedBody = body
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    const finalHtmlBody = signatureIdentity?.htmlSignature?.trim()
      ? appendHtmlSignature(`<div>${escapedBody}</div>`, signatureIdentity, { separator })
      : undefined;

    const originalEmailId = selectedEmail.id;
    const originalSource = emailWriteSource(selectedEmail, client);
    const sendDelaySeconds = useSettingsStore.getState().sendDelaySeconds;
    let delayedUntil: string | undefined;
    if (sendDelaySeconds > 0) {
      if (!client.hasDelayedSend()) {
        const confirmed = window.confirm(t('email_composer.send_delay_unsupported_confirm'));
        if (!confirmed) return;
      } else {
        delayedUntil = new Date(Date.now() + sendDelaySeconds * 1000).toISOString();
      }
    }

    // RFC 5322 §3.6.4 threading - keep the conversation stitched together (#234).
    const threading = computeReplyThreadingHeaders({
      messageId: selectedEmail.messageId,
      references: selectedEmail.references,
    });

    // Send reply with just the body text
    const result = await sendEmail(
      client,
      recipients,
      buildReplySubject(selectedEmail.subject || "(no subject)", t('email_composer.prefix.reply')),
      finalBody,
      undefined,
      undefined,
      sendingIdentity?.id,
      headerFromEmail,
      undefined,
      headerFromName,
      finalHtmlBody,
      undefined,
      threading?.inReplyTo,
      threading?.references,
      delayedUntil,
      undefined,
    );
    // As after the composer's send: the server refused some recipients, held
    // reply or not, and nothing else would say they never get it.
    const refused = partlyRefusedWarning(result, tComposer);
    if (refused) toast.warning(refused);

    // Mark the original email as answered. Route the write to the email's own
    // account so the flag lands on shared/group-mailbox messages instead of
    // being dropped against the reaching account. (#281) Runs before the
    // scheduled early-return so a delayed (undo-send) reply is flagged too. (#985)
    {
      try {
        await useEmailStore.getState().markEmailKeyword(client, originalEmailId, '$answered', originalSource);
      } catch (e) {
        debug.error('Failed to set $answered keyword:', e);
      }
    }

    if (result.scheduled) {
      await refreshScheduledMetadata(client);
      return;
    }

    if (!refused) toast.success(t('notifications.email_sent'));

    // The reply is out: a failed refresh from here on must not reach the
    // quick-reply box, which would report the send as failed and invite a
    // duplicate.
    try {
      // Refresh emails to show the sent reply
      await refreshCurrentMailbox(client);
      // Re-fetch the replied thread's cross-folder data so the expanded
      // view shows the newly sent reply without collapsing.
      const emailState = useEmailStore.getState();
      const repliedEmail = emailState.emails.find(e => e.id === originalEmailId);
      if (repliedEmail?.threadId && emailState.expandedThreadIds.has(threadKeyFor(repliedEmail))) {
        // Route to the email's own account so shared/group threads refresh from
        // the right server, not the active one. (#281, #814)
        const route = resolveThreadRoute({
          isUnifiedView: emailState.isUnifiedView,
          ref: repliedEmail,
          mailboxes: viewMailboxes,
          selectedMailbox: emailState.selectedMailbox,
        });
        const threadClient = route.clientAccountId
          ? (useAuthStore.getState().getClientForAccount(route.clientAccountId) ?? client)
          : client;
        const fullEmails = await threadClient.getThreadEmails(
          repliedEmail.threadId,
          route.accountId ?? client.getAccountId(),
        );
        if (fullEmails.length > 0) {
          useEmailStore.setState((state) => {
            const c = new Map(state.threadEmailsCache);
            c.set(threadKeyFor(repliedEmail), fullEmails);
            return { threadEmailsCache: c };
          });
        }
      }
    } catch (error) {
      console.error('Quick reply sent, but refreshing the view failed:', error);
    }
  };

  // Mountain View reads a message inside its conversation, as Gmail does: load
  // the rest of the thread (list properties only) whenever another opens.
  const mvConversationThreadId = mvConversationView && !cursorOnly ? (selectedEmail?.threadId ?? null) : null;
  const mvConversationRef = mvConversationView && !cursorOnly ? selectedEmail : null;
  const mvConversationRoute = (ref: Email, fallback: NonNullable<typeof client>) => {
    const source = resolveEmailBlobContext(ref, fallback);
    return { threadClient: source.client, accountId: source.accountId };
  };
  const mvBlobSource = resolveEmailBlobContext(mvConversationRef, client);
  // Do not render the previous owner's cards while the replacement loads.
  const mvConversation = mvConversationResult?.source.client === mvBlobSource.client
    && mvConversationResult?.source.accountId === mvBlobSource.accountId
    && mvConversationResult?.threadId === mvConversationThreadId
    ? mvConversationResult.emails : null;
  // Fetches the conversation around `ref`, oldest first. Opening a message
  // starts this next to the message fetch, and the effect below picks up that
  // same request rather than sending a second one.
  const loadMvConversation = (ref: Email, fallback: NonNullable<typeof client>): Promise<Email[] | null> => {
    const { threadClient, accountId } = mvConversationRoute(ref, fallback);
    if (!threadClient) return Promise.resolve(null);
    const pending = mvConversationLoadRef.current;
    // Bare ids overlap across shared owners and across connected clients.
    if (pending?.client === threadClient && pending.accountId === accountId
      && pending.threadId === ref.threadId && pending.emailId === ref.id
      && Date.now() - pending.startedAt < 10_000) return pending.promise;
    const promise = (async () => {
      const thread = await threadClient.getThread(ref.threadId, accountId);
      const ids = thread?.emailIds ?? [];
      if (ids.length < 2) return null;
      const emails = await threadClient.getSomeEmails(ids, accountId);
      for (const e of emails) {
        // Carry the open message's source stamps, so opening one of these
        // in a merged view reaches the right account.
        e.accountId = ref.accountId;
        e.accountLabel = ref.accountLabel;
        e.sourceClientAccountId = ref.sourceClientAccountId;
        e.sourceAccountId = ref.sourceAccountId;
      }
      return emails
        .filter((e) => e.id === ref.id || !e.keywords?.$draft)
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    })().catch(() => null);
    mvConversationLoadRef.current = { client: threadClient, accountId, threadId: ref.threadId, emailId: ref.id, startedAt: Date.now(), promise };
    return promise;
  };

  useEffect(() => {
    ++mvConversationOpenSeqRef.current;
    if (!mvConversationThreadId || !client || !mvConversationRef) {
      setMvConversationResult(null);
      setMvConversationLoading(null);
      return;
    }
    let cancelled = false;
    setMvConversationResult(null);
    setMvConversationLoading(mvConversationThreadId);
    void loadMvConversation(mvConversationRef, client).then((conversation) => {
      if (cancelled) return;
      setMvConversationResult(conversation ? {
        emails: conversation, source: mvBlobSource, threadId: mvConversationThreadId,
      } : null);
      setMvConversationLoading(null);
    });
    return () => { cancelled = true; ++mvConversationOpenSeqRef.current; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the open message, not on every list refresh
  }, [mvConversationThreadId, mvConversationRef?.id, mvBlobSource.client, mvBlobSource.accountId, client]);

  const patchMvConversation = (id: string, patch: (e: Email) => Email) =>
    setMvConversationResult(prev => prev ? {
      ...prev, emails: prev.emails.map(e => e.id === id ? patch(e) : e),
    } : null);

  // An unfolded conversation message needs its body: the thread fetch above
  // only carries list properties.
  const handleLoadConversationEmail = async (target: Email): Promise<Email | null> => {
    if (!client) return null;
    const { threadClient, accountId } = mvConversationRoute(target, client);
    if (!threadClient) return null;
    const openSeq = mvConversationOpenSeqRef.current;
    const fetched = await threadClient.getEmail(target.id, accountId);
    if (!fetched || openSeq !== mvConversationOpenSeqRef.current) return null;
    const full: Email = {
      ...fetched,
      accountId: target.accountId,
      accountLabel: target.accountLabel,
      sourceClientAccountId: target.sourceClientAccountId,
      sourceAccountId: target.sourceAccountId,
    };
    patchMvConversation(target.id, (e) => ({ ...full, keywords: e.keywords }));
    return full;
  };

  // Reading an unfolded message marks it read. Older messages of the thread
  // are often not in the loaded list (another folder, an older page), where
  // the store's markAsRead has nothing to update, so those go to the server
  // directly. (#1222)
  const handleMarkConversationEmailRead = async (target: Email) => {
    if (!client || target.keywords?.$seen) return;
    try {
      if (useEmailStore.getState().emails.some((e) => e.id === target.id)) {
        await markAsRead(client, target.id, true, emailKeyFor(target));
        // Still unread: a plugin stopped it, so the copy here stays unread too.
        if (!useEmailStore.getState().emails.find((e) => emailKeyFor(e) === emailKeyFor(target))?.keywords?.$seen) return;
      } else {
        // Not in the store's list, so the store action can't ask plugins.
        if (emailHooks.onBeforeEmailReadStateChange.size > 0
          && !(await emailHooks.onBeforeEmailReadStateChange.intercept({ emailIds: [target.id], read: true }))) {
          return;
        }
        const { threadClient, accountId } = mvConversationRoute(target, client);
        if (!threadClient) return;
        await threadClient.markAsRead(target.id, true, accountId);
        void emailHooks.onEmailReadStateChange.emit({ emailIds: [target.id], read: true });
      }
      patchMvConversation(target.id, (e) => ({ ...e, keywords: { ...e.keywords, $seen: true } }));
    } catch (error) {
      console.error('Failed to mark conversation message read:', error);
    }
  };

  // Show loading state while checking auth
  // The sidebar is memoised; handlers that keep their identity across renders
  // are what let it skip the mail view's renders (opening a message, a list
  // update), which change nothing it shows.
  const sidebarHandlers = useStableHandlers({
    onOpenStarred: mvShell ? goToStarred : undefined,
    onMailboxSelect: handleMailboxSelect,
    onTagSelect: handleTagSelect,
    onUnreadFilterClick: handleUnreadFilterClick,
    onMarkFolderRead: handleMarkFolderRead,
    onMarkFolderTreeRead: handleMarkFolderTreeRead,
    onMarkAllFoldersRead: handleMarkAllFoldersRead,
    onEmptyFolder: handleEmptyFolderFromContextMenu,
    onCreateSubfolder: handleCreateSubfolderFromContextMenu,
    onCreateFolder: handleCreateFolderFromContextMenu,
    onRenameFolder: handleRenameFolderFromContextMenu,
    onDeleteFolder: handleDeleteFolderFromContextMenu,
    onShareFolder: supportsMailboxSharing ? handleShareFolderFromContextMenu : undefined,
    onImportEmail: handleImportEmailFromContextMenu,
    onRefreshMailboxes: handleRefreshMailboxes,
    onCompose: () => {
      void withComposeGate('compose', {}, () => {
        startFreshComposerSession();
        setComposerMode('compose');
        setShowComposer(true);
        if (isMobile) {
          setSidebarOpen(false);
          setActiveView('viewer');
        }
      });
    },
    onSidebarClose: () => setSidebarOpen(false),
    onAccountMailboxSelect: handleAccountMailboxSelect,
  });

  if (!initialCheckDone || authLoading || (!isAuthenticated || !client)) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-foreground mx-auto"></div>
          <p className="mt-4 text-sm text-muted-foreground">{t("common.loading")}</p>
        </div>
      </div>
    );
  }

  // Get current mailbox name for mobile header
  const currentMailboxName = isScheduledView
    ? t('sidebar.scheduled')
    : (() => {
        const mb = mailboxes.find(m => m.id === selectedMailbox);
        return mb
          ? localizeMailboxName(mb.role, mb.name, (k) => t(`sidebar.mailboxes.${k}`))
          : "Inbox";
      })();
  const isFocusedMailLayout = mailLayout === 'focus';
  const isHorizontalMailLayout = mailLayout === 'horizontal' && !isMobile && !isTablet;
  // Under Mountain View on desktop the composer floats over the list in a
  // docked window instead of taking the reading pane.
  const mvInlineReply = mvShell && showComposer && !isEmbedded && !mvReplyPoppedOut
    && (pendingDraft?.mode ?? composerMode) !== 'compose' && Boolean(selectedEmail);
  const floatingComposer = mvShell && showComposer && !isEmbedded && !mvInlineReply;
  const hasViewerContent = (showComposer && !floatingComposer) || Boolean(conversationThread)
    || Boolean(selectedEmail && !(mvShell && cursorOnly));
  const shouldCollapseListPane = (isTablet && !tabletListVisible && !readingPaneEmpty) || (!isMobile && isFocusedMailLayout && hasViewerContent);
  const shouldHideViewerPane = !isMobile && !hasViewerContent && isFocusedMailLayout;
  const shouldHideHorizontalViewerPane = isHorizontalMailLayout && !hasViewerContent;

  // Handle email selection with mobile view switching
  // A mouse pressed on a row: the click that follows opens the message, so
  // its content is requested now (see lib/email-prefetch). Resolved the way
  // handleEmailSelect resolves it, so the open finds this very request.
  const handleEmailPrefetch = (email: Email) => {
    if (!client) return;
    const { client: fetchClient, accountId } = resolveEmailBlobContext(email, client);
    if (fetchClient) prefetchEmailContent(fetchClient, email.id, accountId);
  };

  const handleEmailSelect = async (
    email: { id: string } & Partial<Pick<Email, 'sourceClientAccountId' | 'sourceAccountId'>>,
  ) => {
    if (!client || !email) return;
    setCursorOnly(false);

    // If composing, suspend the composer (unmount will trigger onSaveState).
    // Mountain View's compose window stays open while other mail is read,
    // as Gmail's does. (#1229)
    if (showComposer && !floatingComposer) {
      setShowComposer(false);
    }

    // Find the list-level email for metadata (accountId, scheduled flags, etc.).
    //
    // JMAP email ids are only unique per account (RFC 8621 §1.3) and Stalwart
    // hands out overlapping id ranges, so in aggregate views one bare id can name
    // unrelated mails in different accounts. Prefer the clicked object itself (it
    // is the list row) and only fall back to an id lookup that also matches the
    // source stamps — never the first bare-id hit. (#847)
    const listEmail: Partial<Email> | undefined =
      activeEmails.find(e => e === email)
      ?? activeEmails.find(e =>
        e.id === email.id
        && (email.sourceClientAccountId === undefined || e.sourceClientAccountId === email.sourceClientAccountId)
        && (email.sourceAccountId === undefined || e.sourceAccountId === email.sourceAccountId))
      ?? (email.sourceClientAccountId ? email : undefined);

    // Expanding a conversation may have scheduled a delayed "mark read" for
    // it (markAsReadDelay). Moving on to a message outside that conversation
    // (j/k, a click) drops it, as the reading pane drops its own pending
    // mark; the conversation stays expanded.
    const openRef = (listEmail ?? email) as Partial<Email>;
    if (openRef.threadId) {
      const openThreadKey = threadKeyFor(openRef as Email);
      const emailStore = useEmailStore.getState();
      for (const key of emailStore.expandedThreadIds) {
        if (key !== openThreadKey) emailStore.cancelAutoMarkThreadAsRead(key);
      }
    }

    // Only the newest open may touch the viewer: a slow fetch for a message
    // the user has already clicked away from must neither replace the one
    // they are looking at nor end its loading state.
    const openSeq = ++emailOpenSeqRef.current;
    const previousEmail = useEmailStore.getState().selectedEmail;
    // Paint the header from the row at once (subject, sender and date are in
    // hand) and let the body follow; the viewer shows a row without body
    // values as loading. Mountain View shows the message inside its
    // conversation, which is fetched alongside, so it waits for both.
    const rowEmail = !mvConversationView && listEmail && 'receivedAt' in listEmail ? listEmail as Email : null;
    if (rowEmail) {
      beginOpenEmail(rowEmail);
    } else {
      setLoadingEmail(true);
    }

    // On mobile, switch to viewer
    if (isMobile) {
      setActiveView("viewer");
    }

    // On tablet, hide the list to maximize viewer space
    if (isTablet) {
      setTabletListVisible(false);
    }

    // Fetch the full content
    try {
      const source = resolveEmailBlobContext(listEmail ?? null, client);
      const { client: fetchClient, accountId } = source;
      if (!fetchClient) {
        console.warn('[mail-app] No connected client for email source');
        if (openSeq === emailOpenSeqRef.current) abandonOpenEmail(previousEmail);
        return;
      }

      // Mountain View shows the message inside its conversation: fetch that
      // alongside the message, so the two appear together. (#1223)
      const conversationPrefetch = mvConversationView && listEmail?.id && listEmail.threadId
        ? loadMvConversation(listEmail as Email, client)
        : null;
      // The request a mouse press on the row already started, if any.
      const fullEmail = await requestEmailContent(fetchClient, email.id, accountId);
      if (openSeq !== emailOpenSeqRef.current) return;
      if (fullEmail) {
        if (listEmail?.isScheduled) {
          fullEmail.scheduledSendAt = listEmail.scheduledSendAt;
          fullEmail.emailSubmissionId = listEmail.emailSubmissionId;
          fullEmail.scheduledIdentityId = listEmail.scheduledIdentityId;
          fullEmail.scheduledUndoStatus = listEmail.scheduledUndoStatus;
          fullEmail.scheduledAccountId = listEmail.scheduledAccountId;
          fullEmail.isScheduled = true;
          fullEmail.isSmimeScheduled = listEmail.isSmimeScheduled;
        }
        // Re-stamp the source reference so later actions on the open email
        // resolve to the right account (the fetched object lacks these).
        if (listEmail?.sourceClientAccountId) {
          fullEmail.accountId = listEmail.accountId;
          fullEmail.accountLabel = listEmail.accountLabel;
          fullEmail.sourceFolder = listEmail.sourceFolder;
        }
        // Only stamped rows are re-stamped. A direct-folder row stays
        // unstamped, since threadKeyFor scopes keys by these stamps.
        fullEmail.sourceAccountId = listEmail?.sourceAccountId;
        fullEmail.sourceClientAccountId = listEmail?.sourceClientAccountId;
        if (conversationPrefetch) {
          // Wait a little for the conversation, never long: past that the
          // viewer shows a placeholder until it arrives.
          const conversation = await Promise.race([
            conversationPrefetch,
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), MV_CONVERSATION_WAIT_MS)),
          ]);
          if (openSeq !== emailOpenSeqRef.current) return;
          if (conversation !== undefined) setMvConversationResult(conversation ? {
            emails: conversation, source, threadId: fullEmail.threadId,
          } : null);
        }
        // One write: the message, and the end of its loading state.
        finishOpenEmail(fullEmail);
        // Mark-as-read logic is now handled by useEffect
      } else {
        abandonOpenEmail(previousEmail);
      }
    } catch (error) {
      console.error('Failed to fetch email content:', error);
      if (openSeq === emailOpenSeqRef.current) abandonOpenEmail(previousEmail);
    }
  };

  // Handle back navigation from viewer on mobile.
  // Reset to list state directly. We can't just call window.history.back()
  // because the nav hook pushes a new entry for every email the user opens,
  // so history.back() would pop to the previous email rather than the list.
  // The OS / hardware back button is still wired through popstate → handleNavRestore.
  const handleMobileBack = () => {
    if (conversationThread) {
      ++conversationOpenSeqRef.current;
      setConversationBlobSource(undefined);
      setConversationThread(null);
      setConversationEmails([]);
    }
    selectEmail(null);
    if (isTablet) {
      setTabletListVisible(true);
    }
    setActiveView("list");
  };

  // Navigate to next/previous email in the list
  const selectedEmailIndex = selectedEmail ? activeEmails.findIndex(e => emailKeyFor(e) === emailKeyFor(selectedEmail)) : -1;

  const handleNavigateNext = selectedEmailIndex >= 0 && selectedEmailIndex < activeEmails.length - 1
    ? () => handleEmailSelect(activeEmails[selectedEmailIndex + 1])
    : undefined;

  const handleNavigatePrev = selectedEmailIndex > 0
    ? () => handleEmailSelect(activeEmails[selectedEmailIndex - 1])
    : undefined;

  // Handle opening conversation view on mobile
  const handleOpenConversation = async (thread: ThreadGroup) => {
    if (!client) return;
    const source = resolveEmailBlobContext(thread.latestEmail, client);
    // Never fetch a stamped thread through an unrelated login.
    if (!source.client) return;
    const openSeq = ++conversationOpenSeqRef.current;

    useEmailStore.getState().holdListRow(thread.threadKey);
    setConversationThread(thread);
    setConversationBlobSource(source);
    setConversationEmails([]);
    setIsLoadingConversation(true);
    setActiveView("viewer");

    try {
      const emails = await source.client.getThreadEmails(thread.threadId, source.accountId);
      if (openSeq !== conversationOpenSeqRef.current) return;
      // Preserve UI identity stamps; direct-folder messages stay unstamped.
      const ref = thread.latestEmail;
      setConversationEmails(emails.map(e => ({
        ...e,
        accountId: ref.accountId,
        accountLabel: ref.accountLabel,
        sourceClientAccountId: ref.sourceClientAccountId,
        sourceAccountId: ref.sourceAccountId,
      })));
    } catch (error) {
      if (openSeq !== conversationOpenSeqRef.current) return;
      console.error('Failed to fetch thread emails:', error);
      setConversationEmails(thread.emails);
    } finally {
      if (openSeq === conversationOpenSeqRef.current) setIsLoadingConversation(false);
    }
  };

  // Handle reply from conversation view
  const handleConversationReply = async (email: Email) => {
    email = await emailHooks.onBeforeComposeOpenToReply.transform(email);
    selectEmail(email);
    await prepareComposerQuoteHeader(email, 'reply');
    await withComposeGate('reply', { source: email }, () => {
      startFreshComposerSession();
      setComposerMode('reply');
      setShowComposer(true);
      if (isMobile) setActiveView('viewer');
    });
  };

  const handleConversationReplyAll = async (email: Email) => {
    email = await emailHooks.onBeforeComposeOpenToReplyAll.transform(email);
    selectEmail(email);
    await prepareComposerQuoteHeader(email, 'replyAll');
    await withComposeGate('replyAll', { source: email }, () => {
      startFreshComposerSession();
      setComposerMode('replyAll');
      setShowComposer(true);
      if (isMobile) setActiveView('viewer');
    });
  };

  const handleConversationForward = async (email: Email) => {
    email = await emailHooks.onBeforeComposeOpenToForward.transform(email);
    selectEmail(email);
    await prepareComposerQuoteHeader(email, 'forward');
    await withComposeGate('forward', { source: email }, () => {
      startFreshComposerSession();
      setComposerMode('forward');
      setShowComposer(true);
      if (isMobile) setActiveView('viewer');
    });
  };

  const ToggleChip = ({ icon, label, value, onClick }: { icon: React.ReactNode; label: string; value: boolean | null; onClick: () => void }) => (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs transition-colors border",
        value === true && "bg-primary/10 border-primary/30 text-primary",
        value === false && "bg-muted border-border text-muted-foreground line-through",
        value === null && "bg-background border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground"
      )}
    >
      {icon}
      {label}
    </button>
  );

  // The folder the advanced search runs in. Scopes the search only - it does
  // not navigate the mail list. `rerun` re-queries straight away when a search
  // is running; Mountain View's form waits for its Search button instead.
  const renderSearchFolderSelect = (className: string, rerun: boolean) => (
    <select
      value={searchMailboxId}
      onChange={(e) => {
        setSearchMailboxId(e.target.value);
        // Only re-query when a search is actually running;
        // otherwise just remember the scope for the next one.
        if (rerun && (searchQuery.trim() || !isFilterEmpty(searchFilters))) handleAdvancedSearch();
      }}
      className={className}
    >
      <option value="">{t("advanced_search.all_folders_except_spam_trash")}</option>
      <option value={SEARCH_SCOPE_ALL_FOLDERS}>{t("advanced_search.all_folders")}</option>
      {searchScopeFolders.own.map((mb) => (
        <option key={mb.id} value={mb.id}>
          {"\u00A0".repeat(mb.depth * 3)}{mb.name}
        </option>
      ))}
      {searchScopeFolders.shared.map((group) => (
        <optgroup key={group.ownerId} label={group.label}>
          {group.mailboxes.map((mb) => (
            <option key={mb.id} value={mb.id}>
              {"\u00A0".repeat(mb.depth * 3)}{mb.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );

  // The composer, rendered in the reading pane - or, under Mountain View on
  // desktop, in a window docked over the list (see MvComposeWindow).
  const composerNode = (
    <ErrorBoundary
      fallback={ComposerErrorFallback}
      onReset={() => {
        setShowComposer(false);
        setComposerMode('compose');
        setComposerQuoteHeader(null);
      }}
    >
      <EmailComposer
        key={composerSessionId}
        mode={pendingDraft?.mode ?? composerMode}
        composeFromAccountEmail={resolveComposeAccountEmail(
          mailboxes,
          selectedMailbox,
          useAccountStore
            .getState()
            .getAccountById(viewingAccountId ?? activeAccountId ?? '')?.email,
        )}
        replyTo={pendingDraft !== null ? pendingDraft.replyTo : (composerSourceEmail ? {
          from: composerSourceEmail.from,
          replyToAddresses: composerSourceEmail.replyTo,
          to: composerSourceEmail.to,
          cc: composerSourceEmail.cc,
          bcc: composerSourceEmail.bcc,
          subject: composerSourceEmail.subject,
          ...getQuoteBodies(composerSourceEmail),
          receivedAt: composerSourceEmail.receivedAt,
          // The login that holds the message, so the reply
          // defaults to that account's identity (#1104).
          accountId: composerSourceEmail.sourceClientAccountId ?? viewingAccountId ?? undefined,
          attachments: composerSourceEmail.attachments,
          messageId: composerSourceEmail.messageId,
          inReplyTo: composerSourceEmail.inReplyTo,
          references: composerSourceEmail.references,
          quoteHeaderHtml: composerQuoteHeader?.html,
          quoteHeaderText: composerQuoteHeader?.text,
          quoteWrapInBlockquote: composerQuoteHeader?.wrapInBlockquote,
        } : undefined)}
        initialDraftText={composerDraftText}
        initialData={pendingDraft}
        prefill={composerPrefill}
        sessionKey={`inline-${composerSessionId}`}
        sourceEmailId={composerSourceEmail?.id}
        onSaveState={(data) => {
          setComposerPrefill(null);
          if (suppressComposerStateSaveSessionRef.current === composerSessionId) {
            suppressComposerStateSaveSessionRef.current = null;
            return;
          }
          setPendingDraft(data);
        }}
        onSend={async (data) => {
          const outcome = await handleEmailSend(data);
          setPendingDraft(null);
          setComposerPrefill(null);
          return outcome;
        }}
        onScheduledSendCreated={async () => {
          if (client) {
            await refreshScheduledMetadata(client);
            if (isScheduledView) await fetchScheduledEmails(client);
          }
          setShowComposer(false);
          setPendingDraft(null);
          if (isMobile && !useEmailStore.getState().selectedEmail) setActiveView('list');
        }}
        onClose={() => {
          setShowComposer(false);
          setComposerMode('compose');
          setComposerDraftText("");
          setPendingDraft(null);
          setComposerPrefill(null);
          setComposerQuoteHeader(null);
          if (isMobile) {
            setActiveView('list');
          }
        }}
        requestCloseRef={composerRequestCloseRef}
        onDiscardDraft={(draftId, draft) => {
          handleDiscardDraft(draftId, draft);
          setPendingDraft(null);
        }}
      />
    </ErrorBoundary>
  );

  if (!isAuthenticated) {
    return null;
  }

  return (
    <DragDropProvider>
      <div ref={appRootRef} className={cn("flex flex-col overflow-hidden pt-[env(safe-area-inset-top)]", mvShell ? "bg-[var(--mv-canvas)]" : "bg-background", isEmbedded ? "h-full" : "h-dvh")}>
        <AppTopBannerSlot />
        {refreshIndicator}
        {isRateLimited && rateLimitSecondsLeft !== null && (
          <div className="flex items-center justify-center gap-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-700 dark:text-amber-300 text-sm py-1.5 px-4 flex-shrink-0">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>{tCommon('rate_limited_title')}</span>
            <span className="text-amber-700/80 dark:text-amber-300/80">{tCommon('rate_limited_detail', { seconds: rateLimitSecondsLeft, appName })}</span>
          </div>
        )}
        {connectionLost && (
          <div className="flex items-center justify-center gap-2 bg-destructive/10 border-b border-destructive/30 text-destructive text-sm py-1.5 px-4 flex-shrink-0">
            <RotateCcw className="h-3.5 w-3.5 animate-spin" />
            <span>{tCommon('reconnecting')}</span>
          </div>
        )}
        {mvShell && !fullscreenReading && (
          <MvTopBar
            search={{
              query: searchQuery,
              onQueryChange: setSearchQuery,
              onSubmit: handleSearch,
              onClear: handleClearSearch,
              onSelectContact: handleSelectContactSuggestion,
              onToggleFilters: toggleAdvancedSearch,
              filtersOpen: isAdvancedSearchOpen,
              activeFilterCount: activeFilterCount(searchFilters),
              disabled: isScheduledView,
              onFilterAnchorChange: setFilterAnchor,
            }}
            onShowShortcuts={() => setShowShortcutsModal(true)}
            onManageApps={handleManageApps}
            onInlineApp={handleInlineApp}
            onCloseInlineApp={closeInlineApp}
            activeAppId={inlineApp?.id ?? null}
            onSelectAllInboxes={
              allInboxesReachable ? () => handleMailboxSelect(UNIFIED_MAILBOX_IDS.inbox) : undefined
            }
            allInboxesSelected={allInboxesSelected}
          />
        )}
        <div className="flex flex-1 overflow-hidden">
        {/* Desktop Navigation Rail (hidden when embedded inside Pro shell, and
            under Mountain View, whose header carries the app grid instead) */}
        {!isMobile && !isTablet && !isEmbedded && !mvShell && (
          <div className="w-14 bg-secondary flex flex-col flex-shrink-0" style={{ borderRight: '1px solid rgba(128, 128, 128, 0.3)' }}>
            <NavigationRail
              collapsed
              quota={quota}
              isPushConnected={isPushConnected}
              onLogout={handleLogout}
              onShowShortcuts={() => setShowShortcutsModal(true)}
              onManageApps={handleManageApps}
              onInlineApp={handleInlineApp}
              onCloseInlineApp={closeInlineApp}
              activeAppId={inlineApp?.id ?? null}
            />
          </div>
        )}

        {inlineApp && (
          <InlineAppView apps={loadedApps} activeAppId={inlineApp!.id} onClose={closeInlineApp} className="flex-1" />
        )}

        {/* Mobile/Tablet Sidebar Overlay Backdrop.
            When embedded in a Pro pane the viewport is desktop-wide, so the
            `lg:hidden` viewport-variant alone wouldn't gate this overlay;
            scope to the pane via `absolute` so the backdrop stays inside
            the pane instead of covering the whole window. */}
        {(isMobile || isTablet) && sidebarOpen && !inlineApp && (
          <div
            className={cn(
              "inset-0 bg-black/50 z-40",
              isEmbedded ? "absolute" : "fixed lg:hidden"
            )}
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar - overlay on mobile/tablet, in-flow on desktop.
            When embedded, overlay-mode is driven by pane-aware JS rather
            than viewport-variants (which still see the full window). */}
        <div
          id={sidebarId}
          ref={sidebarContainerRef}
          /* On mobile/tablet the sidebar is only slid off-screen, so without
             `inert` it stays in the accessibility tree and screen readers can
             reach a menu the Toggle menu button reports as collapsed (#721). */
          inert={(isMobile || isTablet) && !sidebarOpen}
          onKeyDown={(isMobile || isTablet) && sidebarOpen ? (e) => {
            if (e.key === 'Escape') setSidebarOpen(false);
          } : undefined}
          className={cn(
            "flex-shrink-0 h-full z-50",
            // The z-index is for the phone drawer. On a desktop under Mountain
            // View it only has to lift the hover peek over the list: at 40 the
            // compose window, drawn later at the same level, stays on top.
            mvShell && "lg:z-40",
            !isResizing && "transition-[width] duration-300",
            isEmbedded
              ? (isMobile || isTablet
                  ? cn(
                      "absolute inset-y-0 start-0 w-72 pt-[env(safe-area-inset-top)]",
                      "transform transition-transform duration-300 ease-in-out",
                      // translate-x is physical, so RTL needs the opposite
                      // sign or the drawer slides off the wrong edge.
                      !sidebarOpen && "-translate-x-full rtl:translate-x-full"
                    )
                  : "relative translate-x-0")
              : cn(
                  // Mobile/Tablet: fixed overlay
                  // start-0 rather than left-0: in RTL the drawer belongs on
                  // the right, matching the hamburger that opens it.
                  "max-lg:fixed max-lg:inset-y-0 max-lg:start-0 max-lg:w-72 max-lg:pt-[env(safe-area-inset-top)]",
                  "max-lg:transform max-lg:transition-transform max-lg:duration-300 max-lg:ease-in-out",
                  !sidebarOpen && "max-lg:-translate-x-full max-lg:rtl:translate-x-full",
                  // Desktop: normal flow
                  "lg:relative lg:translate-x-0"
                ),
            inlineApp && "hidden",
            fullscreenReading && "hidden"
          )}
          style={!isMobile && !isTablet ? { width: sidebarCollapsed ? (mvShell ? 72 : 48) : sidebarWidth } : undefined}
        >
          <ErrorBoundary fallback={SidebarErrorFallback}>
            <Sidebar
              mailboxes={mailboxes}
              selectedMailbox={selectedMailbox}
              selectedKeyword={selectedKeyword}
              scheduledTotal={scheduledTotal}
              scheduledTotalByAccount={scheduledTotalByAccount}
              scheduledAccountScope={scheduledAccountScope}
              showScheduledMailbox={delayedSendSupported}
              crossAccountActive={crossAccountActive}
              showCrossUnread={showCrossUnread}
              showCrossStarred={showCrossStarred}
              showCrossAll={showCrossAll}
              crossUnreadCount={crossUnreadCount}
              {...sidebarHandlers}
              mvShell={mvShell}
              multiAccountMode={isEmbedded}
              accountMailboxes={accountMailboxes}
              viewingAccountId={viewingAccountId}
            />
          </ErrorBoundary>
        </div>

        {/* Sidebar resize handle (desktop only, hidden when collapsed, and
            absent under Mountain View, whose navigation has a fixed width) */}
        {!isMobile && !isTablet && !sidebarCollapsed && !inlineApp && !fullscreenReading && !mvShell && (
          <ResizeHandle
            onResizeStart={() => { dragStartWidth.current = sidebarWidth; setIsResizing(true); }}
            onResize={(delta) => setSidebarWidth(dragStartWidth.current + delta)}
            onResizeEnd={() => { setIsResizing(false); persistColumnWidths(); }}
            onDoubleClick={resetSidebarWidth}
          />
        )}

        {/* Main Content Area. Under Mountain View it is the rounded card
            inset from the canvas. */}
        <div
          data-mv-card={mvShell ? "" : undefined}
          className={cn("flex flex-col flex-1 min-w-0", mvShell ? "mb-4 me-4" : "h-full", inlineApp && "hidden")}
        >
          <div className={cn("relative flex flex-1 min-h-0", isHorizontalMailLayout && "md:flex-col")}>
          {/* Email List - full width on mobile, fixed width/height on tablet/desktop */}
          <div
            className={cn(
              "relative flex flex-col bg-background min-w-0",
              isHorizontalMailLayout
                ? (shouldHideHorizontalViewerPane ? "md:w-full md:min-h-0" : "md:w-full md:h-auto")
                : "h-full border-e border-border",
              // Mobile: full width, hidden when viewing email
              "max-md:flex-1 max-md:border-e-0 max-md:border-b-0",
              isMobile && activeView !== "list" && "max-md:hidden",
              // Pane-mobile (narrow Pro pane on a wide viewport): the
              // `max-md:` viewport classes above never apply, so mirror
              // them with pane-scoped equivalents.
              paneMobile && "flex-1 border-e-0 border-b-0",
              paneMobile && activeView !== "list" && "hidden",
              // Tablet/Desktop: fixed width with collapse animation
              !isHorizontalMailLayout && (shouldHideViewerPane ? "md:flex-1 md:border-e-0" : "md:flex-shrink-0"),
              isHorizontalMailLayout && (shouldHideHorizontalViewerPane ? "md:flex-1" : "md:flex-shrink-0"),
              isHorizontalMailLayout && !shouldHideHorizontalViewerPane && "md:shadow-[0_8px_12px_-6px_rgba(0,0,0,0.18)] dark:md:shadow-[0_8px_14px_-6px_rgba(0,0,0,0.55)]",
              !isHorizontalMailLayout && "md:shadow-sm",
              !isResizing && "transition-all duration-200 ease-out",
              shouldCollapseListPane && "md:w-0 md:opacity-0 md:overflow-hidden md:border-e-0",
              fullscreenReading && "hidden"
            )}
            style={
              isMobile
                ? undefined
                : isHorizontalMailLayout
                  ? (!shouldHideHorizontalViewerPane ? { height: emailListHeight } : undefined)
                  : (!shouldCollapseListPane && !shouldHideViewerPane ? { width: clampEmailListWidth(emailListWidth) } : undefined)
            }
          >
            {/* Mobile Header for List View */}
            <MobileHeader
              title={currentMailboxName}
              sidebarId={sidebarId}
              onOpenSearch={isMobile ? () => setMobileSearchOpen(true) : undefined}
              searchPlaceholder={searchQuery || t('sidebar.search_placeholder_hint')}
              searchActive={!!searchQuery}
              onClearSearch={handleClearSearch}
              onSelectAllInboxes={
                allInboxesReachable ? () => handleMailboxSelect(UNIFIED_MAILBOX_IDS.inbox) : undefined
              }
              allInboxesSelected={allInboxesSelected}
            />

            {/* Search Bar + Inline Advanced Filters. On phones this is not a
                permanent second bar: the header carries a search field, and
                tapping it presents this panel full-screen. Select-all and
                refresh stay reachable there too, and long-press / pull-to-
                refresh already cover them on the list itself. */}
            {(!isMobile || mobileSearchOpen) && (
            <div className={cn(
              "border-b border-border bg-background",
              isMobile && mobileSearchOpen && "fixed inset-0 z-50 overflow-y-auto"
            )}>
              {isMobile && mobileSearchOpen && (
                <div className="h-14 px-2 flex items-center border-b border-border">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11"
                    onClick={() => setMobileSearchOpen(false)}
                    aria-label={t('sidebar.mobile.go_back')}
                  >
                    <ArrowLeft className="h-5 w-5 rtl:-scale-x-100" />
                  </Button>
                  <span className="font-medium truncate">{t('sidebar.search_placeholder_hint')}</span>
                </div>
              )}
              {mvShell ? (
                <MvListToolbar
                  loadedCount={activeEmails.length}
                  // A search's results are not the folder: count what came back.
                  totalCount={searchQuery || !isFilterEmpty(searchFilters) ? undefined : mailboxes.find((mb) => mb.id === selectedMailbox)?.totalEmails}
                  onRefresh={handleManualRefresh}
                  isRefreshing={isManualRefreshing}
                  onMarkFolderRead={selectedMailbox ? () => handleMarkFolderRead(selectedMailbox) : undefined}
                  onMarkAllFoldersRead={handleMarkAllFoldersRead}
                  onEmptyFolder={selectedMailbox ? () => void handleEmptyFolderFromContextMenu(selectedMailbox) : undefined}
                  onCreateFolder={() => handleCreateFolderFromContextMenu()}
                  disabled={isScheduledView}
                />
              ) : (
              <div className="px-3 h-14 flex items-center">
                <div className="flex items-center gap-1.5 w-full">
                  {/* Select / Select All toggle */}
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedEmailKeys.size > 0) {
                        if (selectedEmailKeys.size === activeEmails.length) {
                          clearSelection();
                        } else {
                          selectAllEmails();
                        }
                      } else if (activeEmails.length > 0) {
                        // The open message when it is in this list, else the
                        // first row - as an email, so the selection is keyed by
                        // its owning account and not by a colliding id.
                        const openKey = selectedEmail ? emailKeyFor(selectedEmail) : null;
                        const target = activeEmails.find((e) => emailKeyFor(e) === openKey) ?? activeEmails[0];
                        toggleEmailSelection(target);
                      }
                    }}
                    disabled={isScheduledView}
                    className={cn(
                      "flex-shrink-0 p-2 rounded-md transition-colors",
                      selectedEmailKeys.size > 0
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    )}
                    title={isScheduledView ? t('email_viewer.scheduled_actions_only') : selectedEmailKeys.size > 0 ? (selectedEmailKeys.size === activeEmails.length ? t('email_list.batch_actions.clear_selection') : t('email_list.batch_actions.select_all')) : t('email_list.batch_actions.select')}
                  >
                    {selectedEmailKeys.size > 0 ? (
                      <CheckSquare className="w-4 h-4" />
                    ) : (
                      <Square className="w-4 h-4" />
                    )}
                  </button>
                  <SearchBox
                    value={searchQuery}
                    onChange={setSearchQuery}
                    autoFocus={isMobile && mobileSearchOpen}
                    onSubmit={(query) => { handleSearch(query); setMobileSearchOpen(false); }}
                    onClear={() => { handleClearSearch(); setMobileSearchOpen(false); }}
                    onSelectContact={(contact, field) => {
                      handleSelectContactSuggestion(contact, field);
                      setMobileSearchOpen(false);
                    }}
                    disabled={isScheduledView}
                    title={isScheduledView ? t('email_viewer.scheduled_actions_only') : undefined}
                  />
                  <button
                    type="button"
                    onClick={toggleAdvancedSearch}
                    disabled={isScheduledView}
                    className={cn(
                      "relative flex-shrink-0 p-2 rounded-md transition-colors",
                      isScheduledView && "opacity-50 cursor-not-allowed",
                      isAdvancedSearchOpen || activeFilterCount(searchFilters) > 0
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    )}
                    title={isScheduledView ? t('email_viewer.scheduled_actions_only') : t("advanced_search.toggle_filters")}
                  >
                    <Filter className="w-4 h-4" />
                    {!isAdvancedSearchOpen && activeFilterCount(searchFilters) > 0 && (
                      <span className="absolute -top-1 -right-1 flex items-center justify-center w-4 h-4 text-[10px] font-bold rounded-full bg-primary text-primary-foreground">
                        {activeFilterCount(searchFilters)}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={handleManualRefresh}
                    disabled={!client || isManualRefreshing}
                    className={cn(
                      "flex-shrink-0 p-2 rounded-md transition-colors",
                      "text-muted-foreground hover:text-foreground hover:bg-muted",
                      (!client || isManualRefreshing) && "opacity-50 cursor-not-allowed"
                    )}
                    title={tCommon("refresh")}
                    aria-label={tCommon("refresh")}
                  >
                    <RotateCcw className={cn("w-4 h-4", isManualRefreshing && "animate-spin")} />
                  </button>
                  {/* Plugin buttons (top-bar-actions). On phones they sit in
                      the header's overflow menu instead (MobileHeader). */}
                  {!isMobile && (
                    <PluginActions surface="top-bar-actions" context={TOP_BAR_CONTEXT} compact className="flex-shrink-0 flex-nowrap" />
                  )}
                </div>
              </div>
              )}

              {/* Filter Area. Under Mountain View the button that opens this
                  lives in the global top bar, so the panel drops from the
                  search field there rather than from the list header. */}
              {isAdvancedSearchOpen && (
                <FilterPanelHost anchor={mvShell ? filterAnchor : null}>
                  {mvShell ? (
                    <MvSearchForm
                      filters={searchFilters}
                      onChange={setSearchFilters}
                      onSearch={() => { handleAdvancedSearch(); toggleAdvancedSearch(); }}
                      onClear={() => { clearSearchFilters(); if (client) advancedSearch(client); }}
                      folderSelect={!isUnifiedView ? renderSearchFolderSelect(
                        "w-full h-8 bg-transparent border-0 border-b border-border px-0 text-sm text-foreground focus:outline-none focus:border-b-2 focus:border-primary",
                        false,
                      ) : undefined}
                    />
                  ) : (<>
                  {/* Quick toggle filters + clear */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 flex-wrap">
                      <ToggleChip
                        icon={<Paperclip className="w-3.5 h-3.5" />}
                        label={t("advanced_search.has_attachment")}
                        value={searchFilters.hasAttachment}
                        onClick={() => { const next = searchFilters.hasAttachment === null ? true : searchFilters.hasAttachment ? false : null; setSearchFilters({ hasAttachment: next }); handleAdvancedSearch(); }}
                      />
                      <ToggleChip
                        icon={<Star className="w-3.5 h-3.5" />}
                        label={t("advanced_search.starred")}
                        value={searchFilters.isStarred}
                        onClick={() => { const next = searchFilters.isStarred === null ? true : searchFilters.isStarred ? false : null; setSearchFilters({ isStarred: next }); handleAdvancedSearch(); }}
                      />
                      <ToggleChip
                        icon={searchFilters.isUnread === false ? <MailOpen className="w-3.5 h-3.5" /> : <Mail className="w-3.5 h-3.5" />}
                        label={searchFilters.isUnread === false ? t("advanced_search.read") : t("advanced_search.unread")}
                        value={searchFilters.isUnread}
                        onClick={() => { const next = searchFilters.isUnread === null ? true : searchFilters.isUnread ? false : null; setSearchFilters({ isUnread: next }); handleAdvancedSearch(); }}
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => { clearSearchFilters(); setShowAdvancedFields(false); if (client) advancedSearch(client); }} className="h-7 px-2 text-xs text-muted-foreground">
                        <RotateCcw className="w-3 h-3 me-1" />
                        {t("advanced_search.clear")}
                      </Button>
                    </div>
                  </div>

                  {/* "More" expand for advanced fields */}
                  <button
                    type="button"
                    onClick={() => setShowAdvancedFields(!showAdvancedFields)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", showAdvancedFields && "rotate-180")} />
                    <span>{t("advanced_search.title")}</span>
                  </button>

                  {/* Advanced fields */}
                  {showAdvancedFields && (
                    <div className="space-y-2.5 animate-in slide-in-from-top-1 fade-in duration-150">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">{t("advanced_search.from")}</label>
                          <Input
                            value={searchFilters.from}
                            onChange={(e) => { setSearchFilters({ from: e.target.value }); handleAdvancedSearchDebounced(); }}
                            placeholder={t("advanced_search.from_placeholder")}
                            className="h-8 text-sm"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">{t("advanced_search.to")}</label>
                          <Input
                            value={searchFilters.to}
                            onChange={(e) => { setSearchFilters({ to: e.target.value }); handleAdvancedSearchDebounced(); }}
                            placeholder={t("advanced_search.to_placeholder")}
                            className="h-8 text-sm"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">{t("advanced_search.subject")}</label>
                        <Input
                          value={searchFilters.subject}
                          onChange={(e) => { setSearchFilters({ subject: e.target.value }); handleAdvancedSearchDebounced(); }}
                          placeholder={t("advanced_search.subject_placeholder")}
                          className="h-8 text-sm"
                        />
                      </div>

                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">{t("advanced_search.body")}</label>
                        <Input
                          value={searchFilters.body}
                          onChange={(e) => { setSearchFilters({ body: e.target.value }); handleAdvancedSearchDebounced(); }}
                          placeholder={t("advanced_search.body_placeholder")}
                          className="h-8 text-sm"
                        />
                      </div>

                      {/* Folder selector. Scopes the search only - it does not
                          navigate the mail list. It defaults to "All folders
                          except Spam and Trash", or to Spam/Trash itself while
                          that folder is open (defaultSearchScopeFor), and keeps
                          whatever the user picked. Both folder-less scopes span
                          the own AND the group/shared accounts' folders (#1082);
                          "All folders" also searches Trash and Junk. The shared
                          folders are listed under their owner, and subfolders
                          are indented under their parent as in the sidebar
                          (a native select has no tree, so the indent is
                          non-breaking spaces, as in the filter rule modal).
                          The unified views already search across every
                          account's folders, so it is hidden there. */}
                      {!isUnifiedView && (
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">{t("advanced_search.folder")}</label>
                          {renderSearchFolderSelect(
                            "w-full h-8 text-sm rounded-md border border-input bg-background px-3 text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
                            true,
                          )}
                        </div>
                      )}

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">{t("advanced_search.date_after")}</label>
                          <Input
                            type="date"
                            value={searchFilters.dateAfter}
                            onChange={(e) => { setSearchFilters({ dateAfter: e.target.value }); handleAdvancedSearch(); }}
                            className="h-8 text-sm"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">{t("advanced_search.date_before")}</label>
                          <Input
                            type="date"
                            value={searchFilters.dateBefore}
                            onChange={(e) => { setSearchFilters({ dateBefore: e.target.value }); handleAdvancedSearch(); }}
                            className="h-8 text-sm"
                          />
                        </div>
                      </div>

                      {/* Message size (Email/query minSize / maxSize, RFC 8621 §4.4.1) */}
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">{t("advanced_search.size_min")}</label>
                          <Input
                            type="number"
                            min={1}
                            inputMode="numeric"
                            value={searchFilters.minSizeKb}
                            onChange={(e) => { setSearchFilters({ minSizeKb: e.target.value }); handleAdvancedSearch(); }}
                            className="h-8 text-sm"
                            data-testid="advanced-search-min-size"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">{t("advanced_search.size_max")}</label>
                          <Input
                            type="number"
                            min={1}
                            inputMode="numeric"
                            value={searchFilters.maxSizeKb}
                            onChange={(e) => { setSearchFilters({ maxSizeKb: e.target.value }); handleAdvancedSearch(); }}
                            className="h-8 text-sm"
                            data-testid="advanced-search-max-size"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                  </>)}
                </FilterPanelHost>
              )}
            </div>
            )}

            {(searchQuery || !isFilterEmpty(searchFilters)) && !activeIsLoading && !isScheduledView && (
              <div className="px-4 py-1.5 text-xs text-muted-foreground border-b border-border bg-muted/20">
                {activeHasMore
                  ? t("advanced_search.results_found_more", { count: activeEmails.length })
                  : t("advanced_search.results_found", { count: activeEmails.length })}
              </div>
            )}

            {isScheduledView && !activeIsLoading && (
              <div className="px-4 py-1.5 text-xs text-muted-foreground border-b border-border bg-muted/20">
                {t('email_list.scheduled_count', { count: scheduledTotal })}
              </div>
            )}

            <div className="flex-1 min-h-0 flex flex-col">
            {/* Plugin-registered category tabs (Gmail-style). Renders nothing
                unless an enabled plugin registered tabs via api.tabs.set. */}
            {!isScheduledView && <MessageListTabs />}
            <WelcomeBanner />

            <ErrorBoundary fallback={EmailListErrorFallback}>
              <EmailList
                onFindFromSender={mvShell ? (sender) => void handleSelectContactSuggestion(sender, 'from') : undefined}
                hideBatchToolbar={mvShell}
                emails={activeEmails}
                selectedEmailKey={selectedEmail ? emailKeyFor(selectedEmail) : undefined}
                isLoading={activeIsLoading}
                hasMore={activeHasMore}
                isLoadingMoreItems={isScheduledView ? isLoadingScheduled && activeEmails.length > 0 : undefined}
                isScheduledView={isScheduledView}
                onLoadMoreScheduled={() => client && loadMoreScheduledEmails(client)}
                onCancelScheduledForEdit={async (email) => {
                  if (!client) return;
                  // The context menu does not wait for this; report here.
                  const restored = await cancelScheduledForEdit(email);
                  if (restored === undefined) return;
                  if (email.isSmimeScheduled) {
                    setComposerMode('compose');
                    setPendingDraft(null);
                  } else if (restored) {
                    // Restored through the active login's client, the one
                    // Scheduled lists - not a login browsed before.
                    await handleEditDraft(restored, { accountId: email.scheduledAccountId, localAccountId: activeAccountId ?? undefined }).catch(reportDraftOpenFailure);
                    return;
                  }
                  setShowComposer(true);
                  if (isMobile) setActiveView('viewer');
                }}
                onRescheduleScheduled={async (email) => {
                  const delayedUntil = promptForRescheduleDelayedUntil();
                  if (delayedUntil && client && email.emailSubmissionId && email.scheduledIdentityId) {
                    // The context menu does not wait for this; report here.
                    try {
                      const result = await rescheduleScheduledEmail(client, email.emailSubmissionId, email.id, email.scheduledIdentityId, delayedUntil, email.scheduledAccountId);
                      const refused = partlyRefusedWarning(result, tComposer);
                      if (refused) toast.warning(refused);
                    } catch (error) {
                      console.error('Failed to reschedule the scheduled send:', error);
                      const { title, message } = rescheduleFailureToast(error, tViewer, tComposer, scheduledTime(email.scheduledSendAt));
                      toast.error(title, message ? { message } : undefined);
                    }
                  }
                }}
                onEmailSelect={handleEmailSelect}
                onOpenSearchResult={handleEmailSelect}
                onEmailPrefetch={handleEmailPrefetch}
                onEmailDoubleClick={isEmbedded ? ((email) => {
                  const store = useProTabStore.getState();
                  const hasSplit = store.tabs.some((tab) => tab.paneId === 'split');
                  // In a split, open on the *other* side so this list stays
                  // visible; the shared reader tab keeps repeated
                  // double-clicks driving a single tab instead of piling up.
                  const sourcePane = proPaneId ?? 'main';
                  const targetPane = hasSplit
                    ? (sourcePane === 'main' ? 'split' : 'main')
                    : sourcePane;
                  // The tab reads the row again through the login and account
                  // it was listed from, and a draft reopened there is saved
                  // over and removed through them.
                  const source = listRowSource(email, {
                    isScheduledView,
                    viewingAccountId,
                    activeAccountId,
                    accountId: resolveUnstampedEmailAccountId({
                      mailboxes: viewMailboxes,
                      selectedMailbox,
                      searchActive: !!searchQuery || !isFilterEmpty(searchFilters),
                      searchMailboxId,
                    }),
                  });
                  store.openEmailTab({
                    accountId: source.accountId ?? '',
                    clientAccountId: source.localAccountId,
                    emailId: email.id,
                    mailboxId: selectedMailbox,
                    title: email.subject?.trim() || t('email_composer.new_message'),
                  }, { pane: targetPane, reuseReader: hasSplit });
                }) : undefined}
                onOpenConversation={handleOpenConversation}
                // Context menu handlers
                onReply={(email) => {
                  selectEmail(email);
                  handleReply();
                }}
                onReplyAll={(email) => {
                  selectEmail(email);
                  handleReplyAll();
                }}
                onForward={(email) => {
                  selectEmail(email);
                  handleForward();
                }}
                onForwardAsAttachment={(email) => {
                  selectEmail(email);
                  handleForwardAsAttachment(email);
                }}
                onBatchForwardAsAttachment={() => {
                  void handleBatchForwardAsAttachment();
                }}
                onMarkAsRead={async (email, read) => {
                  if (client) {
                    await markAsRead(client, email.id, read, emailKeyFor(email)).catch(toastUpdateFailure);
                  }
                }}
                onToggleStar={async (email) => {
                  if (client) {
                    await toggleStar(client, email.id, emailKeyFor(email)).catch(toastUpdateFailure);
                  }
                }}
                onTogglePinned={async (email) => {
                  await handleTogglePinned(email);
                }}
                onDelete={async (email) => {
                  await handleDelete(email);
                }}
                onArchive={archiveActionEnabled ? async (email) => {
                  await handleArchive(email);
                } : undefined}
                onSetTag={(emailId, color, emailKey) => {
                  handleSetTag(emailId, color, emailKey);
                }}
                onMoveToMailbox={handleMoveToMailbox}
                onMarkAsSpam={async (email) => {
                  await handleMarkAsSpam(email);
                }}
                onUndoSpam={async (email) => {
                  await handleUndoSpam(email);
                }}
                onOpenAttachment={handleOpenListAttachment}
                loadAttachments={loadListAttachments}
                onEditDraft={(email) => {
                  handleEditDraft(email);
                }}
                className="flex-1 min-h-0"
              />
            </ErrorBoundary>
            </div>

            {/* Floating Compose Button - on desktop Mountain View puts Compose
                at the top of the navigation rail instead. */}
            {!mvShell && <Button
              onClick={() => {
                void withComposeGate('compose', {}, () => {
                  startFreshComposerSession();
                  setComposerMode('compose');
                  setShowComposer(true);
                  if (isMobile) setActiveView('viewer');
                });
              }}
              className={cn(
                "absolute z-40 shadow-lg",
                mvMobile
                  ? "bottom-4 end-4 h-14 gap-3 rounded-2xl px-5"
                  : isMobile
                    ? "bottom-4 end-4 h-14 w-14 rounded-full"
                    : "bottom-4 end-4 h-12 w-12 rounded-full"
              )}
              aria-label={t('sidebar.compose')}
              title={t('sidebar.compose_hint')}
              data-tour="compose-button"
            >
              <PenSquare className={isMobile ? "h-6 w-6" : "h-5 w-5"} />
              {mvMobile && <span className="text-sm font-medium">{t('sidebar.compose')}</span>}
            </Button>}
          </div>

          {/* Email list resize handle (desktop only) */}
          {!isMobile && !isTablet && !isFocusedMailLayout && !isHorizontalMailLayout && !shouldHideViewerPane && !fullscreenReading && (
            <ResizeHandle
              onResizeStart={() => { dragStartWidth.current = emailListWidth; setIsResizing(true); }}
              onResize={(delta) => setEmailListWidth(dragStartWidth.current + delta)}
              onResizeEnd={() => { setIsResizing(false); persistColumnWidths(); }}
              onDoubleClick={resetEmailListWidth}
            />
          )}
          {!isMobile && !isTablet && isHorizontalMailLayout && !shouldHideHorizontalViewerPane && !fullscreenReading && (
            <ResizeHandle
              orientation="horizontal"
              onResizeStart={() => { dragStartWidth.current = emailListHeight; setIsResizing(true); }}
              onResize={(delta) => setEmailListHeight(dragStartWidth.current + delta)}
              onResizeEnd={() => { setIsResizing(false); persistColumnWidths(); }}
              onDoubleClick={resetEmailListHeight}
            />
          )}

          {/* Email Viewer / Composer - full screen on mobile, flex on tablet/desktop */}
          <div
            className={cn(
              "flex flex-col bg-background flex-1 min-w-0",
              isHorizontalMailLayout ? "min-h-0" : "h-full",
              // Mobile: full screen overlay when active
              "max-md:fixed max-md:inset-0 max-md:z-30",
              "max-md:h-full max-md:pt-[env(safe-area-inset-top)]",
              isMobile && activeView !== "viewer" && "max-md:hidden",
              // Tablet/Desktop: relative. Pane-mobile instead overlays the
              // pane (absolute within the relative content row above) - the
              // viewport `max-md:` classes never fire there, and `fixed`
              // would escape the pane.
              !paneMobile && "md:relative",
              paneMobile && (activeView === "viewer" ? "absolute inset-0 z-30 h-full" : "hidden"),
              shouldHideViewerPane && "md:hidden",
              shouldHideHorizontalViewerPane && "md:hidden"
            )}
          >
            {/* Inline Composer - shown in viewer pane.
                In Pro/embedded mode the composer is hoisted into its own
                Pro tab (see the effect below), so we never render it inline. */}
            {(showComposer && !isEmbedded && !floatingComposer && !mvInlineReply) ? composerNode : (
            <>
            {/* Pending draft banner */}
            {pendingDraft && (
              <button
                onClick={() => {
                  setShowComposer(true);
                  if (isMobile) setActiveView('viewer');
                }}
                className="flex items-center gap-3 px-4 py-2.5 bg-primary/10 border-b border-primary/20 hover:bg-primary/15 transition-colors cursor-pointer w-full text-start"
              >
                <PenLine className="w-4 h-4 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-primary">{t('email_composer.continue_draft')}</span>
                  {pendingDraft.subject && (
                    <span className="text-xs text-muted-foreground ms-2 truncate">{pendingDraft.subject}</span>
                  )}
                </div>
                <X
                  className="w-4 h-4 text-muted-foreground hover:text-foreground shrink-0"
                  onClick={async (e) => {
                    e.stopPropagation();
                    const confirmed = await confirmDialog({
                      title: t('email_composer.discard_draft_title'),
                      message: t('email_composer.discard_draft_confirm'),
                      confirmText: t('email_composer.discard'),
                      variant: "destructive",
                    });
                    if (confirmed) {
                      setPendingDraft(null);
                    }
                  }}
                />
              </button>
            )}
            {/* Mobile Conversation View - shown when thread is selected on mobile */}
            {isMobile && conversationThread ? (
              <ThreadConversationView
                thread={conversationThread}
                emails={conversationEmails}
                isLoading={isLoadingConversation}
                onBack={handleMobileBack}
                onReply={handleConversationReply}
                onReplyAll={handleConversationReplyAll}
                onForward={handleConversationForward}
                blobSource={conversationBlobSource}
                onDownloadAttachment={handleDownloadConversationAttachment}
                onMarkAsRead={async (emailId, read) => {
                  // Only ever the mark-as-read on expanding a message: a refusal
                  // (a read-only shared folder) just leaves it unread.
                  if (client) {
                    const target = conversationEmails.find((e) => e.id === emailId);
                    await markAsRead(client, emailId, read, target ? emailKeyFor(target) : undefined).catch((error) => {
                      debug.warn('email', '[Mark as Read] Failed:', error);
                    });
                  }
                }}
                mailboxRole={mailboxes.find(m => m.id === selectedMailbox)?.role ?? (isUnifiedView ? (unifiedRole ?? undefined) : undefined)}
              />
            ) : (
              <>
                <ErrorBoundary fallback={EmailViewerErrorFallback}>
                  <EmailViewer
                    email={selectedEmail}
                    blobSource={resolveEmailBlobContext(selectedEmail, client)}
                    isLoading={isLoadingEmail}
                    onReply={handleReply}
                    onReplyAll={handleReplyAll}
                    onForward={handleForward}
                    onForwardAsAttachment={handleForwardAsAttachment}
                    onDelete={() => {
                      // Deleting the open message returns to the list (Gmail-style),
                      // not the next email — unless the user turned the setting off.
                      // Deselect first so the store's remove-and-advance sees no
                      // selection and doesn't auto-open the next message.
                      const target = selectedEmail;
                      if (useSettingsStore.getState().returnToListAfterAction) {
                        handleMobileBack();
                      }
                      handleDelete(target);
                    }}
                    onArchive={archiveActionEnabled ? () => handleArchive() : undefined}
                    onToggleStar={handleToggleStar}
                    onSetTag={handleSetTag}
                    onMarkAsSpam={() => handleMarkAsSpam()}
                    onUndoSpam={() => handleUndoSpam()}
                    onMarkAsRead={async (emailId, read, opts) => {
                      if (client) {
                        const emailKey = selectedEmail?.id === emailId ? emailKeyFor(selectedEmail) : undefined;
                        try {
                          await markAsRead(client, emailId, read, emailKey);
                        } catch (error) {
                          // Refused: the message stays as it was, and open.
                          // Opening it is no request to report back on.
                          if (opts?.automatic) debug.warn('email', '[Mark as Read] Failed:', error);
                          else toastUpdateFailure(error);
                          return;
                        }
                        const nowRead = !!useEmailStore.getState().emails
                          .find((e) => (emailKey ? emailKeyFor(e) === emailKey : e.id === emailId))?.keywords?.$seen;
                        if (nowRead !== read) return; // a plugin stopped it
                        // Marking the open message unread returns to the list
                        // (Gmail-style, gated on returnToListAfterAction). Staying
                        // in the reading pane would just re-mark it read on view.
                        if (!read && useSettingsStore.getState().returnToListAfterAction) {
                          handleMobileBack();
                        }
                      }
                    }}
                    onDownloadAttachment={handleDownloadAttachment}
                    onQuickReply={handleQuickReply}
                    onBack={handleMobileBack}
                    onNavigateNext={handleNavigateNext}
                    onNavigatePrev={handleNavigatePrev}
                    mvPosition={mvShell && selectedEmailIndex >= 0 ? {
                      index: selectedEmailIndex + 1,
                      total: Math.max(activeEmails.length, mailboxes.find((mb) => mb.id === selectedMailbox)?.totalEmails ?? 0),
                    } : undefined}
                    mvFolderName={mvShell && !isScheduledView && !isUnifiedView ? currentMailboxName : undefined}
                    mvConversation={mvConversationView ? mvConversation ?? undefined : undefined}
                    mvConversationPending={mvConversationView && !!selectedEmail && mvConversationLoading === selectedEmail.threadId}
                    onLoadConversationEmail={mvConversationView ? (e) => void handleLoadConversationEmail(e) : undefined}
                    onMarkConversationEmailRead={mvConversationView ? (e) => void handleMarkConversationEmailRead(e) : undefined}
                    onReplyConversationEmail={mvConversationView ? async (e) => {
                      // The reply quotes the message, so it needs the body.
                      const full = e.bodyValues ? e : await handleLoadConversationEmail(e);
                      await handleConversationReply(full ?? e);
                    } : undefined}
                    mvInlineComposer={mvInlineReply ? <MvComposeInline onPopOut={handleMvPopOut}>{composerNode}</MvComposeInline> : undefined}
                    onToggleFullscreen={!isEmbedded && !isMobile ? () => setFullscreenReading((v) => !v) : undefined}
                    isFullscreen={fullscreenReading}
                    onShowShortcuts={() => setShowShortcutsModal(true)}
                    onEditDraft={handleEditDraft}
                    onCancelScheduledForEdit={async () => {
                      if (!client || !selectedEmail) return;
                      // The button does not wait for this; report here.
                      const restored = await cancelScheduledForEdit(selectedEmail);
                      if (restored === undefined) return;
                      if (selectedEmail.isSmimeScheduled) {
                        setComposerMode('compose');
                        setShowComposer(true);
                        return;
                      }
                      // Restored through the active login's client (see the list's Cancel and edit).
                      if (restored) await handleEditDraft(restored, { accountId: selectedEmail.scheduledAccountId, localAccountId: activeAccountId ?? undefined }).catch(reportDraftOpenFailure);
                    }}
                    onRescheduleScheduled={async (delayedUntil) => {
                      if (client && selectedEmail?.emailSubmissionId && selectedEmail.scheduledIdentityId) {
                        const result = await rescheduleScheduledEmail(client, selectedEmail.emailSubmissionId, selectedEmail.id, selectedEmail.scheduledIdentityId, delayedUntil, selectedEmail.scheduledAccountId);
                        const refused = partlyRefusedWarning(result, tComposer);
                        if (refused) toast.warning(refused);
                      }
                    }}
                    onCompose={() => {
                      void withComposeGate('compose', {}, () => {
                        startFreshComposerSession();
                        setComposerMode('compose');
                        setShowComposer(true);
                      });
                    }}
                    currentUserEmail={client?.getUsername()}
                    currentUserName={client?.getUsername()?.split("@")[0]}
                    currentMailboxRole={mailboxes.find(m => m.id === selectedMailbox)?.role ?? (isUnifiedView ? (unifiedRole ?? undefined) : undefined)}
                    mailboxes={mailboxes}
                    selectedMailbox={selectedMailbox}
                    onMoveToMailbox={async (mailboxId) => {
                      if (selectedEmail) await handleMoveToMailbox(selectedEmail.id, mailboxId);
                    }}
                    onRemoveFromFolder={openEmailCanLeaveFolder ? () => {
                      if (selectedEmail) void removeFromFolder([selectedEmail]);
                    } : undefined}
                    className={isMobile ? "flex-1" : undefined}
                  />
                </ErrorBoundary>
              </>
            )}
            </>
            )}
          </div>
          </div>

          {/* Bottom Navigation - mobile and tablet (hidden when embedded) */}
          {(isMobile || isTablet) && activeView !== "viewer" && !isEmbedded && (
            <NavigationRail
              orientation="horizontal"
              onManageApps={handleManageApps}
              onInlineApp={handleInlineApp}
              onCloseInlineApp={closeInlineApp}
              activeAppId={inlineApp?.id ?? null}
            />
          )}
        </div>
        {/* Mountain View: Gmail's side panel - calendar, tasks and contacts
            next to the mail, with their icons down the right edge. */}
        {mvShell && !inlineApp && !fullscreenReading && <MvSidePanel />}
        </div>

        {/* Keyboard Shortcuts Modal */}
        <KeyboardShortcutsModal
          isOpen={showShortcutsModal}
          onClose={() => setShowShortcutsModal(false)}
        />

        {previewAttachment && (
          <FilePreviewModal
            name={previewAttachment.name}
            onClose={() => setPreviewAttachment(null)}
            onDownload={handlePreviewAttachmentDownload}
            getFileContent={getPreviewAttachmentContent}
          />
        )}

        {officeAttachment && (
          <WopiEditor
            target={{ kind: "attachment", blobId: officeAttachment.blobId, name: officeAttachment.name, type: officeAttachment.type, size: officeAttachment.size }}
            accountId={officeAttachment.accountId}
            slot={officeAttachment.slot}
            onClose={() => setOfficeAttachment(null)}
          />
        )}

        {/* Screen reader live region for dynamic status announcements */}
        <div className="sr-only" aria-live="polite" aria-atomic="true" id="sr-status" />

        <SidebarAppsModal isOpen={showAppsModal} onClose={closeAppsModal} />
        {pendingMailtoAccountChoice && (
          <ProtocolAccountPicker
            kind="mailto"
            operation={pendingMailtoAccountChoice}
            accounts={getMailtoProtocolAccounts()}
            activeAccountId={activeAccountId}
            isSwitching={isProtocolAccountSwitching}
            onSelect={(accountId) => void openMailtoForAccount(pendingMailtoAccountChoice, accountId)}
            onCancel={() => setPendingMailtoAccountChoice(null)}
          />
        )}
        <ConfirmDialog {...confirmDialogProps} />
        <PromptDialog {...promptDialogProps} />
        {client && sharingMailbox && (
          <MailboxShareDialog
            client={client}
            mailbox={sharingMailbox}
            onClose={() => setSharingMailboxId(null)}
          />
        )}
        <ShareNotificationToaster client={client} />
        <CalendarEventNotificationToaster client={client} />
        <TotpReauthDialog />
        {floatingComposer && <MvComposeWindow>{composerNode}</MvComposeWindow>}
      </div>
    </DragDropProvider>
  );
}
