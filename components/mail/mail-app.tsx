"use client";

import { useEffect, useState, useRef, useMemo, useCallback, useId } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Sidebar } from "@/components/layout/sidebar";
import { EmailList } from "@/components/email/email-list";
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
import { ThreadGroup, Email, Mailbox, isUnifiedMailboxId, UNIFIED_ROLE_BY_ID, CROSS_VIEW_BY_ID, isCrossViewId } from "@/lib/jmap/types";
import { useAccountStore } from "@/stores/account-store";
import { usePolicyStore } from "@/stores/policy-store";
import type { UnifiedAccountClient } from "@/lib/unified-mailbox";
import { KeyboardShortcutsModal } from "@/components/keyboard-shortcuts-modal";
import { useEmailStore, buildUnifiedAccountClients } from "@/stores/email-store";
import { toast } from "@/stores/toast-store";
import { useAuthStore, redirectToLogin, saveRedirectAfterLogin } from '@/stores/auth-store';
import { useSettingsStore } from "@/stores/settings-store";
import { useContactStore } from "@/stores/contact-store";
import { useIdentityStore } from "@/stores/identity-store";
import { useUIStore } from "@/stores/ui-store";
import { useDeviceDetection } from "@/hooks/use-media-query";
import { usePaneSize } from "@/hooks/use-pane-size";
import { usePaneId } from "@/hooks/use-pane-context";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useRefreshGesture } from "@/hooks/use-refresh-gesture";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { usePromptDialog } from "@/hooks/use-prompt-dialog";
import { useBrowserNavigation, type NavSnapshot } from "@/hooks/use-browser-navigation";
import { debug } from "@/lib/debug";
import { playNotificationSound } from "@/lib/notification-sound";
import { cn } from "@/lib/utils";
import { localizeMailboxName } from "@/lib/mailbox-label";
import { KEYWORD_PREFIX, KEYWORD_PREFIX_LEGACY, groupEmailsByThread } from "@/lib/thread-utils";
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
import { isFilterEmpty, activeFilterCount } from "@/lib/jmap/search-utils";
import { WelcomeBanner } from "@/components/ui/welcome-banner";
import { NavigationRail } from "@/components/layout/navigation-rail";
import { SidebarAppsModal } from "@/components/layout/sidebar-apps-modal";
import { InlineAppView } from "@/components/layout/inline-app-view";
import { useSidebarApps } from "@/hooks/use-sidebar-apps";
import { useIdentitySync } from "@/hooks/use-identity-sync";
import { useIsEmbedded } from "@/hooks/use-is-embedded";
import { useProTabStore } from "@/stores/pro-tab-store";
import { useProMultiAccountMailboxes } from "@/hooks/use-pro-multi-account-mailboxes";
import { Input } from "@/components/ui/input";
import { FilePreviewModal } from "@/components/files/file-preview-modal";
import { isFilePreviewable } from "@/lib/file-preview";
import { appendHtmlSignature, appendPlainTextSignature } from "@/lib/signature-utils";
import { computeReplyThreadingHeaders } from "@/lib/email-threading";
import { EML_IMPORT_ACCEPT, expandImportableEmails } from "@/lib/eml-import";
import { findDraftIdentityId, resolveComposeAccountEmail, resolveReplyFrom, type ReplyFromResolution } from "@/lib/reply-identity";
import { buildReplyRecipients, isSelfSent } from "@/lib/reply-recipients";
import { useProMultiAccountIdentities } from "@/hooks/use-pro-multi-account-identities";
import { Search, Filter, ChevronDown, X, Paperclip, Star, Mail, MailOpen, RotateCcw, PenSquare, PenLine, CheckSquare, Square, AlertTriangle } from "lucide-react";
import { ResizeHandle } from "@/components/layout/resize-handle";
import { Button } from "@/components/ui/button";
import { useConfig } from "@/hooks/use-config";
import { usePluginStore } from "@/stores/plugin-store";
import { AppTopBannerSlot } from "@/components/plugins/app-top-banner-slot";
import { useThemeStore } from "@/stores/theme-store";
import { consumePendingMailto, subscribeToPendingMailto } from "@/lib/protocol-handlers/session";
import { INTERNAL_MAILTO_EVENT, type ParsedMailto } from "@/lib/protocol-handlers/mailto";
import { plainTextToComposerBody, getQuoteBodies } from "@/lib/email-composer-utils";
import { appLifecycleHooks, uiHooks, routerHooks, toastHooks, emailHooks } from "@/lib/plugin-hooks";
import { emailToReadView } from "@/lib/plugin-projection";
import { buildQuoteHeader } from "@/lib/quote-header";
import { buildReplySubject, buildForwardSubject } from "@/lib/subject-prefix";
import { buildForwardAsAttachmentPayload } from "@/lib/forward-as-attachment";
import { getEffectiveLocale } from '@/i18n/detect-locale';
import {
  SCHEDULED_MAILBOX_ID,
  appPath,
  buildMailPath,
  parseMailPath,
  resolveFolderRef,
  type MailDeepLink,
} from "@/lib/deep-links";
import { consumePendingDeepLink, subscribePendingDeepLink } from "@/lib/deep-link-handoff";
import { useProInterfaceActive } from "@/components/pro/pro-interface-redirect";
import type { QuoteHeader } from "@/lib/plugin-types";

export interface MailAppProps {
  /**
   * Path segments after `/mail` (`['message', '<id>']`). Applied once, after
   * the JMAP session is up; see the deep-link effect below.
   */
  linkSegments?: string[];
}

export function MailApp({ linkSegments }: MailAppProps = {}) {
  const t = useTranslations();
  const tCommon = useTranslations('common');
  const tQuote = useTranslations('quote_header');
  const { appName } = useConfig();
  const mailLayout = useSettingsStore((state) => state.mailLayout);
  const [showComposer, setShowComposer] = useState(false);
  const [composerMode, setComposerMode] = useState<'compose' | 'reply' | 'replyAll' | 'forward'>('compose');
  const [composerDraftText, setComposerDraftText] = useState("");
  const [pendingDraft, setPendingDraft] = useState<ComposerDraftData | null>(null);
  const [composerSessionId, setComposerSessionId] = useState(0);
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
  const [conversationThread, setConversationThread] = useState<ThreadGroup | null>(null);
  const [conversationEmails, setConversationEmails] = useState<Email[]>([]);
  const [isLoadingConversation, setIsLoadingConversation] = useState(false);
  const [rateLimitSecondsLeft, setRateLimitSecondsLeft] = useState<number | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<{ blobId: string; name: string; type?: string; accountId?: string; clientAccountId?: string } | null>(null);
  const [pendingMailtoAccountChoice, setPendingMailtoAccountChoice] = useState<ParsedMailto | null>(null);
  const [isProtocolAccountSwitching, setIsProtocolAccountSwitching] = useState(false);
  const markAsReadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastUndoToastSubmissionRef = useRef<string | null>(null);
  const initialMailLoadClientRef = useRef<object | null>(null);
  // Whether the bootstrap fetch for the default mailbox has landed. Deep links
  // wait for it so their folder switch isn't overwritten (#733).
  const [initialMailLoadDone, setInitialMailLoadDone] = useState(false);
  const { isAuthenticated, client, logout, checkAuth, switchAccount, activeAccountId, isLoading: authLoading, connectionLost, isRateLimited, rateLimitUntil } = useAuthStore();
  const { identities } = useIdentityStore();
  const multiAccountIdentities = useProMultiAccountIdentities();
  useIdentitySync();
  const trustedSendersAddressBook = useSettingsStore((state) => state.trustedSendersAddressBook);
  const sendDelaySeconds = useSettingsStore((state) => state.sendDelaySeconds);
  const { loadTrustedSendersBook, trustedSendersLoaded, loadRecentRecipients } = useContactStore();

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

  // Plugin hooks: window-level lifecycle + selection + service-worker messages.
  // One effect because the listeners share a registration / cleanup window.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onFocus = () => { appLifecycleHooks.onWindowFocus.emit(); };
    const onBlur = () => { appLifecycleHooks.onWindowBlur.emit(); };
    const onOnline = () => { appLifecycleHooks.onOnline.emit(); };
    const onOffline = () => { appLifecycleHooks.onOffline.emit(); };

    let selectionTimer: ReturnType<typeof setTimeout> | null = null;
    const onSelectionChange = () => {
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        const sel = document.getSelection();
        const text = sel?.toString() ?? '';
        if (!text) return;
        const anchorNode = sel?.anchorNode as Node | null;
        const anchorEl = (anchorNode?.nodeType === Node.ELEMENT_NODE
          ? anchorNode as Element
          : anchorNode?.parentElement) ?? null;
        let source: 'email-body' | 'composer' | 'task-detail' | 'event-detail' | 'other' = 'other';
        let emailId: string | undefined;
        if (anchorEl) {
          if (anchorEl.closest('[data-plugin-source="email-body"], iframe.email-body, .email-viewer-body')) {
            source = 'email-body';
            const idEl = anchorEl.closest('[data-email-id]') as HTMLElement | null;
            emailId = idEl?.dataset.emailId;
          } else if (anchorEl.closest('[data-plugin-source="composer"], .email-composer')) {
            source = 'composer';
          } else if (anchorEl.closest('[data-plugin-source="task-detail"]')) {
            source = 'task-detail';
          } else if (anchorEl.closest('[data-plugin-source="event-detail"]')) {
            source = 'event-detail';
          }
        }
        uiHooks.onTextSelectionChange.emit({ text, source, emailId });
      }, 150);
    };

    const onSwMessage = (e: MessageEvent) => {
      const msg = e.data as { kind?: string; tag?: string; data?: unknown } | null;
      if (msg && msg.kind === 'notificationclick' && typeof msg.tag === 'string') {
        toastHooks.onNotificationClick.emit({ tag: msg.tag, data: msg.data });
      }
    };

    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('selectionchange', onSelectionChange);
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', onSwMessage);
    }
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('selectionchange', onSelectionChange);
      if (selectionTimer) clearTimeout(selectionTimer);
      if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
        navigator.serviceWorker.removeEventListener('message', onSwMessage);
      }
    };
  }, []);

  // Plugin hooks: route navigation. Tracks Next.js pathname transitions.
  const pathname = usePathname();
  const prevPathnameRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pathname) return;
    const from = prevPathnameRef.current;
    if (from === pathname) return;
    if (from !== null) {
      routerHooks.onRouteLeave.emit({ path: from });
      routerHooks.onNavigate.emit({ path: pathname, from });
    }
    routerHooks.onRouteEnter.emit({ path: pathname });
    prevPathnameRef.current = pathname;
  }, [pathname]);

  // Mobile/tablet responsive hooks
  const { isMobile, isTablet } = useDeviceDetection();
  const isEmbedded = useIsEmbedded();
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
  const { activeView, sidebarOpen, setSidebarOpen, setActiveView, tabletListVisible, setTabletListVisible, sidebarWidth, emailListWidth, emailListHeight, setSidebarWidth, setEmailListWidth, setEmailListHeight, persistColumnWidths, sidebarCollapsed, resetSidebarWidth, resetEmailListWidth, resetEmailListHeight } = useUIStore();
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
    selectedEmailIds,
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
    setEmailKeywords,
    moveToMailbox,
    moveToMailboxCrossAware,
    moveThreadToMailbox,
    searchEmails,
    searchQuery,
    setSearchQuery,
    isLoading,
    isLoadingEmail,
    setLoadingEmail,
    setPushConnected,
    handleStateChange,
    clearNewEmailNotification,
    markAsSpam,
    undoSpam,
    searchFilters,
    searchMailboxId,
    isAdvancedSearchOpen,
    setSearchFilters,
    setSearchMailboxId,
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
    scheduledHasMore,
    isLoadingScheduled,
    isScheduledView,
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
  } = useEmailStore();

  // Mailboxes of the account currently being browsed. Mirrors the store's
  // action-mailbox resolution so a lookup by `selectedMailbox` hits the same
  // list the email fetch used.
  const viewMailboxes = useMemo(
    () => (viewingAccountId ? (accountMailboxes[viewingAccountId] ?? mailboxes) : mailboxes),
    [viewingAccountId, accountMailboxes, mailboxes],
  );

  // Load recent recipients (from the Sent folder) for compose autocomplete.
  // Runs once when the Sent mailbox is known; the store guards against reloads.
  useEffect(() => {
    const sent = mailboxes.find((m) => m.role === 'sent');
    if (client && sent) {
      loadRecentRecipients(client, sent.originalId || sent.id);
    }
  }, [client, mailboxes, loadRecentRecipients]);

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
  const activeEmails = isScheduledView ? scheduledEmails : emails;
  const activeHasMore = isScheduledView ? scheduledHasMore : hasMoreEmails;
  const activeIsLoading = isScheduledView ? isLoadingScheduled : isLoading;
  const includeGroupInUnified = useSettingsStore((s) => s.includeGroupInUnified);
  const unifiedCrossAccount = useSettingsStore((s) => s.unifiedCrossAccount);
  const unifiedCrossAccountGate = usePolicyStore((s) => s.isFeatureEnabled('unifiedCrossAccountEnabled'));
  const accounts = useAccountStore((s) => s.accounts);
  const connectedAccountsSignature = useMemo(
    () => accounts.filter((a) => a.isConnected).map((a) => a.id).sort().join(","),
    [accounts],
  );
  // Bumped when checkAuth finishes connecting background accounts after the UI
  // already unblocked - the push-binding effect below must re-run over them.
  const connectedAccountsRevision = useAuthStore((s) => s.connectedAccountsRevision);
  // Cross-account is "active" when the user opted in, the admin allows it, and
  // more than one account is connected. Drives the sidebar header label: the
  // old "All accounts" when spanning accounts, else "Unified Mailbox".
  const crossAccountActive =
    unifiedCrossAccount &&
    unifiedCrossAccountGate &&
    accounts.filter((a) => a.isConnected).length > 1;

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
    const path = appPath(
      buildMailPath(
        { mailboxId: state.mailboxId, emailId: state.emailId, threadId: state.threadId },
        useEmailStore.getState().mailboxes,
      ),
    );
    // Keep the marker while fullscreen is active, so reloading the dragged-out
    // tab reopens the message fullscreen instead of in the normal layout.
    return fullscreenReading && state.emailId ? `${path}?view=fullscreen` : path;
  }, [isEmbedded, proInterfaceActive, fullscreenReading]);

  useBrowserNavigation({
    mailboxId: selectedMailbox,
    emailId: selectedEmail?.id ?? null,
    threadId: conversationThread?.threadId ?? null,
    composerOpen: showComposer,
    sidebarOpen,
    onRestore: handleNavRestore,
    enabled: isAuthenticated && mailboxes.length > 0,
    buildUrl: buildMailUrl,
  });

  // Keyboard shortcuts handlers
  const keyboardHandlers = useMemo(() => ({
    onNextEmail: () => {
      if (activeEmails.length === 0) return;
      const currentIndex = selectedEmail ? activeEmails.findIndex(e => e.id === selectedEmail.id) : -1;
      const nextIndex = currentIndex < activeEmails.length - 1 ? currentIndex + 1 : currentIndex;
      if (nextIndex >= 0 && nextIndex < activeEmails.length) {
        handleEmailSelect(activeEmails[nextIndex]);
      }
    },
    onPreviousEmail: () => {
      if (activeEmails.length === 0) return;
      const currentIndex = selectedEmail ? activeEmails.findIndex(e => e.id === selectedEmail.id) : activeEmails.length;
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : 0;
      if (prevIndex >= 0 && prevIndex < activeEmails.length) {
        handleEmailSelect(activeEmails[prevIndex]);
      }
    },
    onOpenEmail: () => {
      // Email is already opened when selected
    },
    onCloseEmail: () => {
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
    onArchive: async () => {
      if (isScheduledView) return;
      if (selectedEmailIds.size > 0 && client) {
        try {
          await batchArchive(client);
        } catch (error) {
          console.error("Failed to batch archive:", error);
        }
      } else if (selectedEmail) {
        handleArchive();
      }
    },
    onDelete: async () => {
      if (isScheduledView) return;
      if (selectedEmailIds.size > 0 && client) {
        const currentMailbox = mailboxes.find(m => m.id === selectedMailbox);
        const isInTrash = currentMailbox?.role === 'trash';
        const isInJunk = currentMailbox?.role === 'junk';
        const permanentlyDeleteJunk = useSettingsStore.getState().permanentlyDeleteJunk;
        const permanent = isInTrash || (isInJunk && permanentlyDeleteJunk);
        const confirmed = await confirmDialog({
          title: permanent
            ? t('email_list.permanent_delete_confirm_title')
            : t('email_list.batch_actions.delete_confirm_title'),
          message: permanent
            ? t('email_list.permanent_delete_confirm_batch_message', { count: selectedEmailIds.size })
            : t('email_list.batch_actions.delete_confirm_message', { count: selectedEmailIds.size }),
          confirmText: permanent
            ? t('email_list.permanent_delete')
            : t('email_list.batch_actions.delete'),
          variant: "destructive",
        });
        if (!confirmed) return;
        try {
          await batchDelete(client, permanent);
        } catch (error) {
          console.error("Failed to batch delete:", error);
        }
      } else if (selectedEmail) {
        handleDelete();
      }
    },
    onMarkAsUnread: async () => {
      if (isScheduledView) return;
      if (!client) return;
      if (selectedEmailIds.size > 0) {
        await batchMarkAsRead(client, false);
      } else if (selectedEmail) {
        await markAsRead(client, selectedEmail.id, false);
      }
    },
    onMarkAsRead: async () => {
      if (isScheduledView) return;
      if (!client) return;
      if (selectedEmailIds.size > 0) {
        await batchMarkAsRead(client, true);
      } else if (selectedEmail) {
        await markAsRead(client, selectedEmail.id, true);
      }
    },
    onToggleSpam: async () => {
      if (isScheduledView) return;
      const currentMailbox = mailboxes.find(m => m.id === selectedMailbox);
      // Marking your own outgoing mail as spam makes no sense - the toolbar
      // and menus hide the action in Sent/Drafts/Scheduled, so the shortcut
      // is a no-op there too.
      if (['sent', 'drafts', 'scheduled'].includes(currentMailbox?.role || '')) return;
      const isInJunk = currentMailbox?.role === 'junk';
      if (selectedEmailIds.size > 0 && client) {
        const ids = Array.from(selectedEmailIds);
        try {
          if (isInJunk) {
            await batchUndoSpam(client, ids);
          } else {
            await batchMarkAsSpam(client, ids);
          }
        } catch (error) {
          console.error("Failed to batch toggle spam:", error);
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
      startFreshComposerSession();
      setComposerMode('compose');
      setShowComposer(true);
      if (isMobile) setActiveView('viewer');
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [activeEmails, selectedEmail, client, selectedMailbox, isMobile, isTablet, selectedEmailIds, mailboxes, isScheduledView]);

  // Initialize keyboard shortcuts
  useKeyboardShortcuts({
    enabled: isAuthenticated && !showComposer,
    emails: activeEmails,
    selectedEmailId: selectedEmail?.id,
    selectionCount: selectedEmailIds.size,
    handlers: keyboardHandlers,
  });

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

  // Update page title based on context
  useEffect(() => {
    let title = appName;

    if (showComposer) {
      // Composing email
      const modeText = {
        compose: t('email_composer.new_message'),
        reply: t('email_composer.reply'),
        replyAll: t('email_composer.reply_all'),
        forward: t('email_composer.forward'),
      }[composerMode] || t('email_composer.new_message');
      title = `${modeText} - ${appName}`;
    } else if (selectedEmail) {
      // Reading email
      const subject = selectedEmail.subject || t('email_viewer.no_subject');
      title = `${subject} - ${appName}`;
    } else if (selectedMailbox && mailboxes.length > 0) {
      // Mailbox view
      const mailbox = mailboxes.find(mb => mb.id === selectedMailbox);
      if (mailbox) {
        const mailboxName = localizeMailboxName(mailbox.role, mailbox.name, (k) => t(`sidebar.mailboxes.${k}`));
        const unreadCount = mailbox.unreadEmails || 0;
        title = unreadCount > 0
          ? `${mailboxName} (${unreadCount}) - ${appName}`
          : `${mailboxName} - ${appName}`;
      }
    }

    document.title = title;
  }, [showComposer, composerMode, selectedEmail, selectedMailbox, mailboxes, t, appName]);

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
      attachments: selectedEmail.attachments,
      messageId: selectedEmail.messageId,
      inReplyTo: selectedEmail.inReplyTo,
      references: selectedEmail.references,
      quoteHeaderHtml: composerQuoteHeader?.html,
      quoteHeaderText: composerQuoteHeader?.text,
      quoteWrapInBlockquote: composerQuoteHeader?.wrapInBlockquote,
    } : undefined);

    const effectiveMode = pendingDraft?.mode ?? composerMode;
    const baseSubject = (pendingDraft?.subject?.trim() || selectedEmail?.subject?.trim()) ?? '';
    let title = t('email_composer.new_message');
    if (baseSubject) {
      if (effectiveMode === 'reply' || effectiveMode === 'replyAll') {
        title = buildReplySubject(baseSubject, t('email_composer.prefix.reply'));
      } else if (effectiveMode === 'forward') {
        title = buildForwardSubject(baseSubject, t('email_composer.prefix.forward'));
      } else {
        title = baseSubject;
      }
    }

    useProTabStore.getState().openComposeTab({
      sessionId: composerSessionId + 1,
      mode: effectiveMode,
      replyTo,
      initialDraftText: composerDraftText,
      initialData: pendingDraft,
      sourceEmailId: selectedEmail?.id ?? null,
      title,
    });

    setComposerSessionId((s) => s + 1);
    setShowComposer(false);
    setComposerDraftText("");
    setPendingDraft(null);
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

  // Redirect to login if not authenticated
  useEffect(() => {
    if (initialCheckDone && !isAuthenticated && !authLoading) {
      saveRedirectAfterLogin();
      redirectToLogin();
    }
  }, [initialCheckDone, isAuthenticated, authLoading]);

  const applyMailtoDraft = useCallback((pending: ParsedMailto, suppressOutgoingStash: boolean) => {
    const body = useSettingsStore.getState().plainTextMode
      ? pending.body
      : plainTextToComposerBody(pending.body);

    if (suppressOutgoingStash) {
      suppressComposerStateSaveSessionRef.current = composerSessionId;
    }
    setComposerSessionId((id) => id + 1);
    setPendingDraft({
      to: pending.to.join(", "),
      cc: pending.cc.join(", "),
      bcc: pending.bcc.join(", "),
      subject: pending.subject,
      body,
      showCc: pending.cc.length > 0,
      showBcc: pending.bcc.length > 0,
      selectedIdentityId: null,
      subAddressTag: "",
      mode: "compose",
      draftId: null,
    });
    setComposerMode("compose");
    setShowComposer(true);
    if (isMobile) setActiveView("viewer");
  }, [composerSessionId, isMobile, setActiveView]);

  const openMailtoDraft = useCallback((pending: ParsedMailto) => {
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
  }, [applyMailtoDraft, showComposer]);

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

  const handleMailtoProtocolRequest = useCallback((pending: ParsedMailto) => {
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
  }, [activeAccountId, getMailtoProtocolAccounts, openMailtoDraft, openMailtoForAccount]);

  useEffect(() => {
    if (!isAuthenticated || !client) return;

    const openPendingMailto = () => {
      const pending = consumePendingMailto();
      if (pending) handleMailtoProtocolRequest(pending);
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
      const pending = (event as CustomEvent<ParsedMailto>).detail;
      if (!pending) return;
      event.preventDefault();
      openMailtoDraft(pending);
    };

    window.addEventListener(INTERNAL_MAILTO_EVENT, onInternalMailto);
    return () => window.removeEventListener(INTERNAL_MAILTO_EVENT, onInternalMailto);
  }, [isAuthenticated, client, openMailtoDraft]);

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
  // first message open or compose click doesn't wait on a chunk fetch.
  useEffect(() => {
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
  }, []);

  // Push notifications: set up once per CONNECTED client and tear down when the
  // clients go away (logout or account switch). Kept separate from the fetch
  // effect above so it still runs when data was prefetched at login time.
  //
  // We bind every connected login, not just the active one: background accounts
  // must drive the unified-section counters too. The active client keeps the
  // full handler (current list / scheduled / calendar / filters); background
  // logins only re-project the unified counts by rebuilding the unified scope
  // (which refreshes every account's cached mailbox list), since their changes
  // never touch the active `mailboxes`. (#281 background push)
  useEffect(() => {
    if (!isAuthenticated || !client) return;

    const clients = useAuthStore.getState().getAllConnectedClients();
    const cleanups: Array<() => void> = [];

    for (const [accId, c] of clients) {
      try {
        if (accId === activeAccountId) {
          c.onStateChange((change) => handleStateChange(change, c));
        } else {
          c.onStateChange(() => {
            buildPopulatedUnifiedAccounts()
              .then((built) => {
                refreshCrossCounts(built);
                refreshUnifiedCounts(built);
              })
              .catch(() => { /* per-account fetch failures surface elsewhere */ });
          });
        }
        c.setupPushNotifications();
        cleanups.push(() => c.closePushNotifications());
      } catch (error) {
        debug.log('push', '[Push] Failed to setup push notifications for account:', accId, error);
      }
    }

    if (cleanups.length > 0) {
      setPushConnected(true);
      debug.log('push', `[Push] Push notifications enabled for ${cleanups.length} account(s)`);
    }

    return () => {
      cleanups.forEach((fn) => fn());
    };
  }, [isAuthenticated, client, activeAccountId, connectedAccountsSignature, connectedAccountsRevision, handleStateChange, setPushConnected, buildPopulatedUnifiedAccounts, refreshCrossCounts, refreshUnifiedCounts]);

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

  // Deep links (#733). Applies `/mail/folder|message|thread/<id>` - and the
  // legacy `?email=<id>` the push service worker used to emit - once the JMAP
  // session and the mailbox list are up. Runs at most once per mount: after
  // this, the URL is an output of the view (see buildMailUrl), not an input.
  const deepLinkHandledRef = useRef(false);
  const applyMailDeepLink = async (link: MailDeepLink) => {
    // A permalink can name the account it belongs to. Ids are only meaningful
    // within their account, so switch first - but only to a login that is
    // actually connected; we can't authenticate on someone's behalf.
    if (link.accountId && link.accountId !== useAuthStore.getState().activeAccountId) {
      const target = useAccountStore.getState().accounts.find(
        (a) => a.id === link.accountId && a.isConnected,
      );
      if (!target) {
        toast.error(t('deep_link.account_unavailable'));
        return;
      }
      await switchAccount(link.accountId);
    }

    const activeClient = useAuthStore.getState().client;
    if (!activeClient) return;

    if (link.kind === 'folder') {
      const mailboxId = resolveFolderRef(link.ref, useEmailStore.getState().mailboxes);
      if (!mailboxId) {
        toast.error(t('deep_link.folder_not_found'));
        return;
      }
      await handleMailboxSelect(mailboxId);
      return;
    }

    if (link.kind === 'message') {
      // In the Pro shell a message permalink opens as its own fullscreen
      // email tab - the tab body fetches the message and retitles itself.
      if (isEmbedded) {
        useProTabStore.getState().openEmailTab({
          accountId: '',
          emailId: link.id,
          mailboxId: null,
          title: t('common.loading'),
        });
        return;
      }
      setLoadingEmail(true);
      try {
        const email = await fetchEmailContent(activeClient, link.id);
        if (!email) {
          toast.error(t('deep_link.message_not_found'));
          return;
        }
        // Point the list at a folder that actually holds the message, so the
        // pane behind it shows real context and "back" lands somewhere useful.
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
    setLoadingEmail(true);
    try {
      const threadEmails = await activeClient.getThreadEmails(link.id);
      const [group] = groupEmailsByThread(threadEmails);
      if (!group) {
        toast.error(t('deep_link.thread_not_found'));
        return;
      }
      if (isMobile) {
        setConversationThread(group);
        setConversationEmails(threadEmails);
        setActiveView('viewer');
      } else {
        await fetchEmailContent(activeClient, group.latestEmail.id);
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
    initialSearchRef.current = window.location.search;
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
      void applyMailDeepLinkRef.current(link);
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
      const perAccountClient = isUnifiedView && selectedEmail.sourceClientAccountId
        ? useAuthStore.getState().getClientForAccount(selectedEmail.sourceClientAccountId)
        : undefined;
      const fetchClient = perAccountClient ?? client;
      setLoadingEmail(true);
      fetchEmailContent(fetchClient, selectedEmail.id).finally(() => {
        setLoadingEmail(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmail?.id]);

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

    // Get current setting value
    const markAsReadDelay = useSettingsStore.getState().markAsReadDelay;
    debug.log('email', '[Mark as Read] Delay setting:', markAsReadDelay, 'ms for email:', selectedEmail.id);

    if (markAsReadDelay === -1) {
      // Never mark as read automatically
      debug.log('email', '[Mark as Read] Never mode - email will stay unread');
    } else if (markAsReadDelay === 0) {
      // Mark as read instantly
      debug.log('email', '[Mark as Read] Instant mode - marking as read now');
      markAsRead(client, selectedEmail.id, true);
    } else {
      // Mark as read after delay
      debug.log('email', '[Mark as Read] Delayed mode - will mark as read in', markAsReadDelay, 'ms');
      markAsReadTimeoutRef.current = setTimeout(() => {
        debug.log('email', '[Mark as Read] Timeout fired - marking as read now');
        markAsRead(client, selectedEmail.id, true);
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
  }, [selectedEmail?.id, isScheduledView]);

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

  const handleEmailSend = async (data: {
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    body: string;
    htmlBody?: string;
    draftId?: string;
    fromEmail?: string;
    fromName?: string;
    identityId?: string;
    /** Local account owning the selected identity, when it came from the
     *  cross-account From dropdown (Pro / embedded multi-account). */
    localAccountId?: string;
    envelopeMailFrom?: string;
    attachments?: Array<{ blobId: string; name: string; type: string; size: number; disposition?: 'attachment' | 'inline'; cid?: string }>;
    inReplyTo?: string[];
    references?: string[];
    delayedUntil?: string;
    requestReadReceipt?: boolean;
  }) => {
    if (!client) return;

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
      const originalEmailId = selectedEmail?.id;

      const result = await sendEmail(sendClient, data.to, data.subject, data.body, data.cc, data.bcc, data.identityId, data.fromEmail, data.draftId, data.fromName, data.htmlBody, data.attachments, data.inReplyTo, data.references, data.delayedUntil, data.envelopeMailFrom, { requestReadReceipt: data.requestReadReceipt, localAccountId: data.localAccountId });
      submitted = true;
      setShowComposer(false);
      // Sending an edited draft destroys it server-side - and every autosave
      // before that already replaced it under a fresh id (createDraft is a
      // destroy+create). If the email on display is the draft this session
      // was opened from, or its latest autosaved successor, clear the
      // selection like a delete does.
      if (selectedEmail && (selectedEmail.id === data.draftId || selectedEmail.id === pendingDraft?.draftId)) {
        selectEmail(null);
        if (isMobile) setActiveView('list');
      }
      if (result.filingError) {
        // The mail went out, but a post-send step (filing to Sent /
        // removing the old draft) was rejected - warn instead of staying
        // silent, so a stale draft row is not mistaken for a failed send
        // and re-sent (#592).
        const toastInstance = (await import('sonner')).toast;
        toastInstance.warning(t('email_composer.send_filing_warning'));
      }
      if (result.scheduled) {
        await refreshScheduledMetadata(client);
        if (isScheduledView) await fetchScheduledEmails(client);
        return;
      }

      // Mark the original email with $answered or $forwarded keyword. Route the
      // write to the email's own account so the flag lands on shared/group-mailbox
      // messages instead of being dropped against the reaching account. (#281)
      if (originalEmailId && (effectiveMode === 'reply' || effectiveMode === 'replyAll' || effectiveMode === 'forward')) {
        const keyword = effectiveMode === 'forward' ? '$forwarded' : '$answered';
        try {
          await useEmailStore.getState().markEmailKeyword(client, originalEmailId, keyword);
        } catch (e) {
          debug.error(`Failed to set ${keyword} keyword:`, e);
        }
      }

      // Refresh the current mailbox to update the UI
      if (!isScheduledView) {
        await refreshCurrentMailbox(client);
        // Re-fetch the replied thread's cross-folder data so the expanded
        // view shows the newly sent reply without collapsing.
        if (originalEmailId) {
          const emailState = useEmailStore.getState();
          const repliedEmail = emailState.emails.find(e => e.id === originalEmailId);
          if (repliedEmail?.threadId && emailState.expandedThreadIds.has(repliedEmail.threadId)) {
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
                c.set(repliedEmail.threadId!, fullEmails);
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

  const handleDiscardDraft = async (draftId: string) => {
    if (!client) return;

    try {
      await client.deleteEmail(draftId);
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
    startFreshComposerSession();
    setComposerDraftText(draftText || "");
    setComposerMode('reply');
    setShowComposer(true);
    if (isMobile) setActiveView('viewer');
  };

  const handleEditDraft = async (email?: Email) => {
    if (!client) return;
    const draftCandidate = email && typeof email === 'object' && typeof email.id === 'string'
      ? email
      : selectedEmail;
    let draft = draftCandidate;
    if (!draft) return;

    // The email list only fetches limited properties (no bodyValues/htmlBody/bcc).
    // Fetch the full email so the composer gets all draft content.
    if (!draft.bodyValues) {
      const mailbox = mailboxes.find(mb => mb.id === selectedMailbox);
      const accountId = mailbox?.isShared ? mailbox.accountId : undefined;
      const fullDraft = await client.getEmail(draft.id, accountId);
      if (!fullDraft) return;
      draft = fullDraft;
    }

    draft = await emailHooks.onBeforeEditDraft.transform(draft);

    const bodyText = draft.bodyValues
      ? Object.values(draft.bodyValues).map(v => v.value).join('\n')
      : '';
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
    const matchedIdentityId = findDraftIdentityId(composerIdentities, draft.from?.[0]);

    // Increment session ID to force the composer to remount with fresh state,
    // even if it was already open (e.g. right-clicking a draft while composing).
    setComposerSessionId(id => id + 1);
    setPendingDraft({
      to: draft.to?.map(a => a.email).filter(Boolean).join(', ') || '',
      cc: draft.cc?.map(a => a.email).filter(Boolean).join(', ') || '',
      bcc: draft.bcc?.map(a => a.email).filter(Boolean).join(', ') || '',
      subject: draft.subject || '',
      body: htmlBody || bodyText,
      showCc: (draft.cc?.length || 0) > 0,
      showBcc: (draft.bcc?.length || 0) > 0,
      selectedIdentityId: matchedIdentityId,
      subAddressTag: '',
      mode: 'compose',
      draftId: draft.id,
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

  useEffect(() => {
    if (!pendingUndoSend || !client) return;
    if (lastUndoToastSubmissionRef.current === pendingUndoSend.submissionId) return;

    lastUndoToastSubmissionRef.current = pendingUndoSend.submissionId;
    const pending = pendingUndoSend;
    // The submission lives on the account that owns the sending identity,
    // which is not always the active one in the multi-account shell (#461).
    const undoClient = pending.localAccountId
      ? (useAuthStore.getState().getClientForAccount(pending.localAccountId) ?? client)
      : client;
    const undoDurationMs = Math.max(sendDelaySeconds, 8) * 1000;

    toast.success(t('email_viewer.scheduled_send_created'), {
      duration: undoDurationMs,
      secondaryAction: (pending.emailId && pending.identityId)
        ? {
            label: t('email_viewer.send_now'),
            onClick: () => {
              void (async () => {
                try {
                  await undoClient.rescheduleEmailSubmission(
                    pending.submissionId,
                    pending.emailId!,
                    pending.identityId!,
                    new Date(Date.now() + 1000).toISOString(),
                  );
                  clearPendingUndoSend();
                  if (isScheduledView) await fetchScheduledEmails(client);
                } catch (error) {
                  console.error('Failed to send now:', error);
                }
              })();
            },
          }
        : undefined,
      action: {
        label: t('email_viewer.undo_send'),
        onClick: () => {
          void (async () => {
            try {
              const restored = await cancelUndoSend(undoClient, pending);
              if (restored && !pending.isSmime) {
                await handleEditDraft(restored);
              }
              if (isScheduledView) await fetchScheduledEmails(client);
            } catch (error) {
              console.error('Failed to undo scheduled send:', error);
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

    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelUndoSend, clearPendingUndoSend, client, fetchScheduledEmails, isScheduledView, pendingUndoSend?.submissionId, sendDelaySeconds, t]);

  const handleReplyAll = async () => {
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
    startFreshComposerSession();
    setComposerMode('replyAll');
    setShowComposer(true);
    if (isMobile) setActiveView('viewer');
  };

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
    startFreshComposerSession();
    setComposerMode('forward');
    setShowComposer(true);
    if (isMobile) setActiveView('viewer');
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

  const handleDelete = async (emailToDelete: Email | null = selectedEmail) => {
    if (!client || !emailToDelete) return;

    // In unified view the trash destination and current-folder check must come
    // from the email's own account, not the active one. The owning account's
    // mailbox list is cached under its JMAP id (`sourceAccountId`). (#281)
    const actionMailboxes =
      isUnifiedView && emailToDelete.sourceAccountId
        ? (accountMailboxes[emailToDelete.sourceAccountId] ?? mailboxes)
        : mailboxes;

    // Check if we're currently in the trash or junk folder. In unified view the
    // "current folder" is the unified role within the email's account.
    const currentMailbox = isUnifiedView
      ? (actionMailboxes.find(m => m.role === unifiedRole && emailToDelete.mailboxIds?.[m.id])
          ?? actionMailboxes.find(m => m.role === unifiedRole))
      : mailboxes.find(m => m.id === selectedMailbox);
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
        await deleteEmail(client, emailToDelete.id, true);
      } catch (error) {
        console.error("Failed to permanently delete email:", error);
      }
    } else {
      // Not in trash: always move to trash (in the email's own account). Scope
      // the trash lookup to the email's account: for a shared/group source every
      // mailbox in the list is `isShared`, so we match by accountId instead of
      // excluding shared (otherwise no trash is found and the delete fails). (#281)
      const sourceAccountId = isUnifiedView ? emailToDelete.sourceAccountId : undefined;
      const matchesScope = (m: Mailbox) =>
        sourceAccountId ? m.accountId === sourceAccountId : !m.isShared;
      const trashMailbox =
        actionMailboxes.find(m => m.role === 'trash' && matchesScope(m)) ??
        actionMailboxes.find(m => {
          if (!matchesScope(m)) return false;
          const lower = m.name.toLowerCase();
          return lower.includes('trash') || lower.includes('deleted');
        });
      if (trashMailbox) {
        try {
          await moveToMailbox(client, emailToDelete.id, trashMailbox.id);
        } catch (error) {
          console.error("Failed to move email to trash:", error);
          const { toast } = await import('sonner');
          toast.error(error instanceof Error ? error.message : 'Failed to move email to trash');
        }
      } else {
        const { toast } = await import('sonner');
        toast.error('Trash mailbox not found - cannot move email to trash');
      }
    }
  };

  const handleArchive = async (emailToArchive: Email | null = selectedEmail) => {
    if (!client || !emailToArchive) return;

    // In unified view the archive folder (and any year/month subfolders we
    // create) must live in the email's own account, reached through the login it
    // is reachable via (`sourceClientAccountId`) and routed to its owning JMAP
    // account (`sourceAccountId`). For personal sources these resolve to the
    // account itself, so behavior is unchanged. (#281)
    const archiveClientId = isUnifiedView ? emailToArchive.sourceClientAccountId : undefined;
    const archiveAccountId = isUnifiedView ? emailToArchive.sourceAccountId : undefined;
    const archiveClient = archiveClientId
      ? (useAuthStore.getState().getClientForAccount(archiveClientId) ?? client)
      : client;
    // Read fresh mailboxes from the store – batch archive calls this in a loop,
    // and each iteration needs to see folders created by prior iterations.
    const readMailboxes = () => {
      const s = useEmailStore.getState();
      return archiveAccountId
        ? (s.accountMailboxes[archiveAccountId] ?? s.mailboxes)
        : s.mailboxes;
    };
    const refreshMailboxes = () =>
      archiveAccountId
        ? useEmailStore.getState().fetchAccountMailboxes(archiveClient, archiveAccountId)
        : fetchMailboxes(client);

    const currentMailboxes = readMailboxes();

    const archiveMailbox = currentMailboxes.find(m => m.role === "archive" || m.name.toLowerCase() === "archive");
    if (!archiveMailbox) return;

    const { archiveMode } = useSettingsStore.getState();

    try {
      if (archiveMode === 'single') {
        await moveThreadToMailbox(client, emailToArchive.id, archiveMailbox.id);
      } else {
        const emailDate = new Date(emailToArchive.receivedAt);
        const year = emailDate.getFullYear().toString();
        const month = (emailDate.getMonth() + 1).toString().padStart(2, '0');
        const archiveId = archiveMailbox.originalId || archiveMailbox.id;

        let yearMailbox = currentMailboxes.find(
          m => m.name === year && m.parentId === archiveId
        );
        if (!yearMailbox) {
          yearMailbox = await archiveClient.createMailbox(year, archiveId, archiveAccountId);
          await refreshMailboxes();
        }

        if (archiveMode === 'year') {
          await moveThreadToMailbox(client, emailToArchive.id, yearMailbox.id);
        } else {
          const yearId = yearMailbox.originalId || yearMailbox.id;
          const afterYear = readMailboxes();
          let monthMailbox = afterYear.find(
            m => m.name === month && m.parentId === yearId
          );
          if (!monthMailbox) {
            monthMailbox = await archiveClient.createMailbox(month, yearId, archiveAccountId);
            await refreshMailboxes();
          }
          await moveThreadToMailbox(client, emailToArchive.id, monthMailbox.id);
        }
      }

      if (conversationThread?.threadId === emailToArchive.threadId) {
        setConversationThread(null);
        setConversationEmails([]);
      }

      void refreshMailboxes();
    } catch (error) {
      console.error("Failed to archive email:", error);
    }
  };

  const handleToggleStar = async () => {
    if (!client || !selectedEmail) return;

    try {
      await toggleStar(client, selectedEmail.id);
    } catch (error) {
      console.error("Failed to toggle star:", error);
    }
  };

  const handleMarkAsSpam = async (emailToMark: Email | null = selectedEmail) => {
    if (!client || !emailToMark) return;

    const emailId = emailToMark.id;

    try {
      await markAsSpam(client, emailId);

      const toastInstance = (await import('sonner')).toast;
      toastInstance.success(t('email_viewer.spam.toast_success'), {
        action: {
          label: t('email_viewer.spam.toast_undo'),
          onClick: async () => {
            try {
              await undoSpam(client, emailId);
              toastInstance.success(t('notifications.email_moved'));
            } catch (_error) {
              console.error("Failed to undo spam:", _error);
              toastInstance.error(t('email_viewer.spam.error'));
            }
          },
        },
        duration: 5000,
      });
    } catch (_error) {
      console.error("Failed to mark as spam:", _error);
      const toastInstance = (await import('sonner')).toast;
      toastInstance.error(t('email_viewer.spam.error'));
    }
  };

  const handleUndoSpam = async (emailToRestore: Email | null = selectedEmail) => {
    if (!client || !emailToRestore) return;

    try {
      await undoSpam(client, emailToRestore.id);

      const toastInstance = (await import('sonner')).toast;
      toastInstance.success(t('email_viewer.spam.toast_not_spam_success'));
    } catch (_error) {
      console.error("Failed to restore email:", _error);
      const toastInstance = (await import('sonner')).toast;
      toastInstance.error(t('email_viewer.spam.error_not_spam'));
    }
  };

  const handleTogglePinned = async (emailToPin: Email) => {
    if (!client) return;

    try {
      const email = emails.find(e => e.id === emailToPin.id) ?? emailToPin;
      const isPinned = email.keywords?.['$pinned'] === true;
      // JMAP keywords are a set of present keys - drop the key to unpin
      // rather than writing a false value.
      const keywords = { ...email.keywords };
      if (isPinned) {
        delete keywords['$pinned'];
      } else {
        keywords['$pinned'] = true;
      }

      // Same routing as tags: the write goes to the email's own account, and
      // the local patch flips the icon immediately. Then refetch the first page
      // so the mail floats/sinks per the server's pinned-first sort. Skip the
      // refetch where that sort does not apply (unified views) or where it
      // would replace a tag-filtered list (refreshCurrentMailbox fetches by
      // folder only). (#281)
      await setEmailKeywords(client, email.id, keywords);
      if (!isUnifiedView && !useEmailStore.getState().selectedKeyword) {
        void refreshCurrentMailbox(client);
      }
    } catch (error) {
      console.error("Failed to toggle pin:", error);
    }
  };

  const handleSetTag = async (emailId: string, tagId: string | null) => {
    if (!client) return;

    try {
      // Remove any existing tag keywords
      const email = emails.find(e => e.id === emailId);
      if (!email) return;

      const keywords = { ...email.keywords };

      if (tagId === null) {
        // Remove all tag keywords
        Object.keys(keywords).forEach(key => {
          if (key.startsWith(KEYWORD_PREFIX) || key.startsWith(KEYWORD_PREFIX_LEGACY)) {
            keywords[key] = false;
          }
        });
      } else {
        // Both prefixes name the same tag when read, so taking one off has to
        // clear whichever spellings are actually set.
        const activeKeys = [KEYWORD_PREFIX + tagId, KEYWORD_PREFIX_LEGACY + tagId]
          .filter(key => keywords[key]);
        if (activeKeys.length > 0) {
          activeKeys.forEach(key => {
            keywords[key] = false;
          });
        } else {
          // Add the tag without disturbing others
          keywords[KEYWORD_PREFIX + tagId] = true;
        }
      }

      // Routes the write to the email's own account, then patches the email in
      // place so the list keeps its scroll/pagination state instead of being
      // reset to the first page by a full refetch. Resolving the account at the
      // call site covered only the unified view, so a tag set on a directly
      // selected shared folder was written to the reaching account and silently
      // dropped by the server. (#281)
      await setEmailKeywords(client, emailId, keywords);

      // Refresh tag counts
      fetchTagCounts(client);
    } catch (error) {
      console.error("Failed to set tag:", error);
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
      // Keep an active search applied when switching folders (#553); the
      // store actions resolve the viewing account's client internally.
      if (!isFilterEmpty(searchFilters)) {
        await advancedSearch(viewingClient);
      } else if (searchQuery) {
        await searchEmails(viewingClient, searchQuery);
      } else {
        await fetchEmails(viewingClient, mailboxId);
      }
    }
  };

  const handleMailboxSelect = async (mailboxId: string) => {
    if (mailboxId === SCHEDULED_MAILBOX_ID) {
      if (!delayedSendSupported) {
        setScheduledView(false);
        return;
      }
      if (isUnifiedView) exitUnifiedView();
      setScheduledView(true);
      selectMailbox(mailboxId);
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

      const populated = await buildPopulatedUnifiedAccounts();
      // Keep an active search across the switch and re-run it in this view
      // (mirrors normal mailboxes), preserving advanced filters; otherwise browse.
      if (client && (!isFilterEmpty(searchFilters) || searchQuery)) {
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

      const populated = await buildPopulatedUnifiedAccounts();
      // Keep an active search across the switch and re-run it in this view
      // (mirrors normal mailboxes), preserving advanced filters; otherwise browse.
      if (client && (!isFilterEmpty(searchFilters) || searchQuery)) {
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
      // If there's an active search, re-run it in the new mailbox. Advanced
      // filters must go through advancedSearch (which also includes the text
      // query) — falling back to fetchEmails would silently drop them while
      // the UI still shows them as active (#553).
      if (!isFilterEmpty(searchFilters)) {
        await advancedSearch(client);
      } else if (searchQuery) {
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
    const isTogglingOff = selectedMailbox === mailboxId && searchFilters.isUnread === true;

    // Select the mailbox if not already selected
    if (selectedMailbox !== mailboxId) {
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
      // Enable unread filter
      clearSearchFilters();
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
      for (const id of ids) {
        total += await markMailboxAsRead(client, id);
      }
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
      const total = await client.markAllAsRead();
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
      message: tCtxMenu('email_list.empty_folder.confirm_message'),
      confirmText: tCtxMenu('email_list.empty_folder.confirm_button'),
      variant: "destructive",
    });
    if (!confirmed) return;

    try {
      await emptyMailbox(client, mailboxId);
      toast.success(tCtxMenu('mailbox_context_menu.toast_emptied'));
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
      await createMailbox(client, name, parentId);
      toast.success(tCtxMenu('mailbox_context_menu.toast_folder_created'));
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
      await createMailbox(client, name, undefined, accountId);
      toast.success(tCtxMenu('mailbox_context_menu.toast_folder_created'));
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
      await renameMailbox(client, mailboxId, name);
      toast.success(tCtxMenu('mailbox_context_menu.toast_folder_renamed'));
    } catch {
      toast.error(tCtxMenu('mailbox_context_menu.toast_error_rename'));
    }
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
      await deleteMailbox(client, mailboxId);
      toast.success(tCtxMenu('mailbox_context_menu.toast_folder_deleted'));
    } catch (err: unknown) {
      const jmapType = (err as Error & { jmapType?: string })?.jmapType;
      if (jmapType === 'mailboxHasChild') {
        toast.error(tCtxMenu('mailbox_context_menu.toast_error_delete_has_children'));
      } else if (jmapType === 'mailboxHasEmail') {
        toast.error(tCtxMenu('mailbox_context_menu.toast_error_delete_has_email'));
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
      for (const { blob } of emails) {
        try {
          await client.importRawEmail(blob, { [targetMailboxId]: true }, { '$seen': true });
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
    setSearchQuery(query);
    if (!isFilterEmpty(searchFilters)) {
      await advancedSearch(client);
    } else {
      await searchEmails(client, query);
    }
  };

  const handleClearSearch = async () => {
    setSearchQuery("");
    clearSearchFilters();
    if (!client) return;
    // In unified view the active "mailbox" is a virtual role or cross view, so
    // refresh via the unified fan-out instead of fetchEmails.
    if (isUnifiedView) {
      const populated = await buildPopulatedUnifiedAccounts();
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

  // Blobs are scoped per JMAP account. In the unified/All-Mail view the open
  // message may belong to another login (route to its client) or to a delegated
  // shared account (same client, but the owner's accountId in the download URL).
  // Resolve both from the email's source so attachments on cross-account
  // messages can be viewed/downloaded instead of 404ing against the active
  // account.
  const resolveBlobSource = useCallback((email: typeof selectedEmail) => {
    const clientAccountId = isUnifiedView ? email?.sourceClientAccountId : undefined;
    const blobClient = clientAccountId
      ? (useAuthStore.getState().getClientForAccount(clientAccountId) ?? client)
      : client;
    const accountId = isUnifiedView ? email?.sourceAccountId : undefined;
    return { blobClient, accountId, clientAccountId };
  }, [isUnifiedView, client]);

  const handleDownloadAttachment = async (blobId: string, name: string, type?: string, forceDownload?: boolean) => {
    const { blobClient, accountId, clientAccountId } = resolveBlobSource(selectedEmail);
    if (!blobClient) return;

    try {
      const { mailAttachmentAction } = useSettingsStore.getState();

      if (!forceDownload && mailAttachmentAction === 'preview' && isFilePreviewable(name, type)) {
        setPreviewAttachment({ blobId, name, type, accountId, clientAccountId });
        return;
      }

      await blobClient.downloadBlob(blobId, name, type, accountId);
    } catch (error) {
      console.error("Failed to download attachment:", error);
    }
  };

  const previewBlobClient = useCallback(() => {
    const id = previewAttachment?.clientAccountId;
    return id ? (useAuthStore.getState().getClientForAccount(id) ?? client) : client;
  }, [previewAttachment, client]);

  const handlePreviewAttachmentDownload = useCallback(async () => {
    const c = previewBlobClient();
    if (!c || !previewAttachment) return;

    await c.downloadBlob(previewAttachment.blobId, previewAttachment.name, previewAttachment.type, previewAttachment.accountId);
  }, [previewBlobClient, previewAttachment]);

  const getPreviewAttachmentContent = useCallback(async () => {
    const c = previewBlobClient();
    if (!c || !previewAttachment) {
      throw new Error('No attachment selected');
    }

    const blob = await c.fetchBlob(previewAttachment.blobId, previewAttachment.name, previewAttachment.type, previewAttachment.accountId);

    return {
      blob,
      contentType: previewAttachment.type || blob.type || 'application/octet-stream',
    };
  }, [previewBlobClient, previewAttachment]);

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
    const autoSelectReplyIdentity = useSettingsStore.getState().autoSelectReplyIdentity;

    // Decide the sending identity and (for domain-catch-all) an optional
    // header From override that matches the address the message was sent to.
    // Our own message keeps the identity it was sent from - the recipients are
    // the other party, so resolving from them would send as their address.
    // When the setting is off, fall through to primary-identity behavior.
    const selfSentIdentityId = isSelfSent(replySource, ownIdentityEmails)
      ? findDraftIdentityId(identities, selectedEmail.from?.[0])
      : null;
    const resolved: ReplyFromResolution | null = !autoSelectReplyIdentity
      ? null
      : selfSentIdentityId
        ? { identityId: selfSentIdentityId }
        : resolveReplyFrom(identities, {
            to: selectedEmail.to,
            cc: selectedEmail.cc,
            bcc: selectedEmail.bcc,
          });
    const sendingIdentity = resolved
      ? (identities.find((i) => i.id === resolved.identityId) || primaryIdentity)
      : primaryIdentity;
    const headerFromEmail = resolved?.overrideEmail || sendingIdentity?.email;
    const headerFromName = resolved?.overrideName || sendingIdentity?.name || undefined;
    const envelopeMailFrom = resolved?.overrideEmail ? sendingIdentity?.email : undefined;

    // Append signature from the sending identity (fall back to primary
    // when the reply-from lives on the same identity but a different alias).
    const separator = useSettingsStore.getState().signatureSeparatorEnabled;
    const finalBody = appendPlainTextSignature(body, sendingIdentity, { separator });

    // When the identity has an HTML signature, send a matching HTML body so the
    // signature keeps its formatting; appendPlainTextSignature would otherwise
    // flatten it to plain text. Text-only identities keep the plain-text-only
    // behavior (htmlBody stays undefined).
    const escapedBody = body
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    const finalHtmlBody = sendingIdentity?.htmlSignature?.trim()
      ? appendHtmlSignature(`<div>${escapedBody}</div>`, sendingIdentity, { separator })
      : undefined;

    const originalEmailId = selectedEmail.id;
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
      envelopeMailFrom,
    );

    if (result.scheduled) {
      await refreshScheduledMetadata(client);
      return;
    }

    // Mark the original email as answered. Route the write to the email's own
    // account so the flag lands on shared/group-mailbox messages instead of
    // being dropped against the reaching account. (#281)
    {
      try {
        await useEmailStore.getState().markEmailKeyword(client, originalEmailId, '$answered');
      } catch (e) {
        debug.error('Failed to set $answered keyword:', e);
      }
    }

    // Refresh emails to show the sent reply
    await refreshCurrentMailbox(client);
    // Re-fetch the replied thread's cross-folder data so the expanded
    // view shows the newly sent reply without collapsing.
    const emailState = useEmailStore.getState();
    const repliedEmail = emailState.emails.find(e => e.id === originalEmailId);
    if (repliedEmail?.threadId && emailState.expandedThreadIds.has(repliedEmail.threadId)) {
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
          c.set(repliedEmail.threadId!, fullEmails);
          return { threadEmailsCache: c };
        });
      }
    }
  };

  // Show loading state while checking auth
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
  const hasViewerContent = showComposer || Boolean(conversationThread) || Boolean(selectedEmail);
  const shouldCollapseListPane = (isTablet && !tabletListVisible) || (!isMobile && isFocusedMailLayout && hasViewerContent);
  const shouldHideViewerPane = !isMobile && !hasViewerContent && isFocusedMailLayout;
  const shouldHideHorizontalViewerPane = isHorizontalMailLayout && !hasViewerContent;

  // Handle email selection with mobile view switching
  const handleEmailSelect = async (email: { id: string }) => {
    if (!client || !email) return;

    // If composing, suspend the composer (unmount will trigger onSaveState)
    if (showComposer) {
      setShowComposer(false);
    }

    // Find the list-level email for metadata (accountId, scheduled flags, etc.)
    // but don't select it yet — wait for the full fetch to avoid a toolbar flash
    // caused by rendering with the stub (no bodyValues) then re-rendering with the full email.
    const listEmail = activeEmails.find(e => e.id === email.id);

    setLoadingEmail(true);

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
      // In unified view each email carries its source reference: the login it is
      // reachable through (`sourceClientAccountId`) and its owning JMAP account
      // (`sourceAccountId`). Resolve both so we fetch from the server that actually
      // owns it — works uniformly for personal and shared/group sources, since for
      // personal the owning account equals the client's primary (no-op). (#281)
      const sourceClientId = isUnifiedView ? listEmail?.sourceClientAccountId : undefined;
      const perAccountClient = sourceClientId
        ? useAuthStore.getState().getClientForAccount(sourceClientId)
        : undefined;
      const fetchClient = perAccountClient ?? client;

      const accountId = isUnifiedView
        ? listEmail?.sourceAccountId
        : (() => {
            // Non-unified: shared folders on the active client still need their
            // owner accountId passed explicitly.
            const mailbox = mailboxes.find(mb => mb.id === selectedMailbox);
            return mailbox?.isShared ? mailbox.accountId : undefined;
          })();

      const fullEmail = await fetchClient.getEmail(email.id, accountId);
      if (fullEmail) {
        if (listEmail?.isScheduled) {
          fullEmail.scheduledSendAt = listEmail.scheduledSendAt;
          fullEmail.emailSubmissionId = listEmail.emailSubmissionId;
          fullEmail.scheduledIdentityId = listEmail.scheduledIdentityId;
          fullEmail.scheduledUndoStatus = listEmail.scheduledUndoStatus;
          fullEmail.isScheduled = true;
          fullEmail.isSmimeScheduled = listEmail.isSmimeScheduled;
        }
        // Re-stamp the source reference so later actions on the open email
        // resolve to the right account (the fetched object lacks these).
        if (isUnifiedView && listEmail) {
          fullEmail.accountId = listEmail.accountId;
          fullEmail.accountLabel = listEmail.accountLabel;
          fullEmail.sourceClientAccountId = listEmail.sourceClientAccountId;
          fullEmail.sourceAccountId = listEmail.sourceAccountId;
        }
        selectEmail(fullEmail);
        // Mark-as-read logic is now handled by useEffect
      }
    } catch (error) {
      console.error('Failed to fetch email content:', error);
    } finally {
      setLoadingEmail(false);
    }
  };

  // Handle back navigation from viewer on mobile.
  // Reset to list state directly. We can't just call window.history.back()
  // because the nav hook pushes a new entry for every email the user opens,
  // so history.back() would pop to the previous email rather than the list.
  // The OS / hardware back button is still wired through popstate → handleNavRestore.
  const handleMobileBack = () => {
    if (conversationThread) {
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
  const selectedEmailIndex = selectedEmail ? activeEmails.findIndex(e => e.id === selectedEmail.id) : -1;

  const handleNavigateNext = selectedEmailIndex >= 0 && selectedEmailIndex < activeEmails.length - 1
    ? () => handleEmailSelect(activeEmails[selectedEmailIndex + 1])
    : undefined;

  const handleNavigatePrev = selectedEmailIndex > 0
    ? () => handleEmailSelect(activeEmails[selectedEmailIndex - 1])
    : undefined;

  // Handle opening conversation view on mobile
  const handleOpenConversation = async (thread: ThreadGroup) => {
    if (!client) return;

    setConversationThread(thread);
    setIsLoadingConversation(true);
    setActiveView("viewer");

    try {
      // The thread may belong to another account: in unified/aggregate views via
      // the email's own source stamp (#281), and in a directly-browsed shared
      // folder via the selected mailbox's owner (#814). Either way the fetch has
      // to name that account - thread ids are per-account, so an unscoped fetch
      // resolves to an unrelated thread in the active one.
      const ref = thread.emails?.[0];
      const route = resolveThreadRoute({ isUnifiedView, ref, mailboxes: viewMailboxes, selectedMailbox });
      const threadClient = route.clientAccountId
        ? (useAuthStore.getState().getClientForAccount(route.clientAccountId) ?? client)
        : client;
      const emails = await threadClient.getThreadEmails(thread.threadId, route.accountId);
      // Re-stamp the source reference so conversation actions (reply/move/…)
      // resolve to the right account; the fetched objects don't carry it.
      if (isUnifiedView && ref) {
        for (const e of emails) {
          e.accountId = ref.accountId;
          e.accountLabel = ref.accountLabel;
          e.sourceClientAccountId = ref.sourceClientAccountId;
          e.sourceAccountId = ref.sourceAccountId;
        }
      }
      setConversationEmails(emails);
    } catch (error) {
      console.error('Failed to fetch thread emails:', error);
      // Fall back to thread.emails
      setConversationEmails(thread.emails);
    } finally {
      setIsLoadingConversation(false);
    }
  };

  // Handle reply from conversation view
  const handleConversationReply = async (email: Email) => {
    email = await emailHooks.onBeforeComposeOpenToReply.transform(email);
    selectEmail(email);
    await prepareComposerQuoteHeader(email, 'reply');
    startFreshComposerSession();
    setComposerMode('reply');
    setShowComposer(true);
    if (isMobile) setActiveView('viewer');
  };

  const handleConversationReplyAll = async (email: Email) => {
    email = await emailHooks.onBeforeComposeOpenToReplyAll.transform(email);
    selectEmail(email);
    await prepareComposerQuoteHeader(email, 'replyAll');
    startFreshComposerSession();
    setComposerMode('replyAll');
    setShowComposer(true);
    if (isMobile) setActiveView('viewer');
  };

  const handleConversationForward = async (email: Email) => {
    email = await emailHooks.onBeforeComposeOpenToForward.transform(email);
    selectEmail(email);
    await prepareComposerQuoteHeader(email, 'forward');
    startFreshComposerSession();
    setComposerMode('forward');
    setShowComposer(true);
    if (isMobile) setActiveView('viewer');
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

  if (!isAuthenticated) {
    return null;
  }

  return (
    <DragDropProvider>
      <div ref={appRootRef} className={cn("flex flex-col bg-background overflow-hidden pt-[env(safe-area-inset-top)]", isEmbedded ? "h-full" : "h-dvh")}>
        <AppTopBannerSlot />
        {refreshIndicator}
        {isRateLimited && rateLimitSecondsLeft !== null && (
          <div className="flex items-center justify-center gap-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-700 dark:text-amber-300 text-sm py-1.5 px-4 flex-shrink-0">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>{tCommon('rate_limited_title')}</span>
            <span className="text-amber-700/80 dark:text-amber-300/80">{tCommon('rate_limited_detail', { seconds: rateLimitSecondsLeft })}</span>
          </div>
        )}
        {connectionLost && (
          <div className="flex items-center justify-center gap-2 bg-destructive/10 border-b border-destructive/30 text-destructive text-sm py-1.5 px-4 flex-shrink-0">
            <RotateCcw className="h-3.5 w-3.5 animate-spin" />
            <span>{tCommon('reconnecting')}</span>
          </div>
        )}
        <div className="flex flex-1 overflow-hidden">
        {/* Desktop Navigation Rail (hidden when embedded inside Pro shell) */}
        {!isMobile && !isTablet && !isEmbedded && (
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
            !isResizing && "transition-[width] duration-300",
            isEmbedded
              ? (isMobile || isTablet
                  ? cn(
                      "absolute inset-y-0 left-0 w-72 pt-[env(safe-area-inset-top)]",
                      "transform transition-transform duration-300 ease-in-out",
                      !sidebarOpen && "-translate-x-full"
                    )
                  : "relative translate-x-0")
              : cn(
                  // Mobile/Tablet: fixed overlay
                  "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:w-72 max-lg:pt-[env(safe-area-inset-top)]",
                  "max-lg:transform max-lg:transition-transform max-lg:duration-300 max-lg:ease-in-out",
                  !sidebarOpen && "max-lg:-translate-x-full",
                  // Desktop: normal flow
                  "lg:relative lg:translate-x-0"
                ),
            inlineApp && "hidden",
            fullscreenReading && "hidden"
          )}
          style={!isMobile && !isTablet ? { width: sidebarCollapsed ? 48 : sidebarWidth } : undefined}
        >
          <ErrorBoundary fallback={SidebarErrorFallback}>
            <Sidebar
              mailboxes={mailboxes}
              selectedMailbox={selectedMailbox}
              selectedKeyword={selectedKeyword}
              scheduledTotal={scheduledTotal}
              showScheduledMailbox={delayedSendSupported}
              crossAccountActive={crossAccountActive}
              showCrossUnread={showCrossUnread}
              showCrossStarred={showCrossStarred}
              showCrossAll={showCrossAll}
              crossUnreadCount={crossUnreadCount}
              onMailboxSelect={handleMailboxSelect}
              onTagSelect={handleTagSelect}
              onUnreadFilterClick={handleUnreadFilterClick}
              onMarkFolderRead={handleMarkFolderRead}
              onMarkFolderTreeRead={handleMarkFolderTreeRead}
              onMarkAllFoldersRead={handleMarkAllFoldersRead}
              onEmptyFolder={handleEmptyFolderFromContextMenu}
              onCreateSubfolder={handleCreateSubfolderFromContextMenu}
              onCreateFolder={handleCreateFolderFromContextMenu}
              onRenameFolder={handleRenameFolderFromContextMenu}
              onDeleteFolder={handleDeleteFolderFromContextMenu}
              onImportEmail={handleImportEmailFromContextMenu}
              onRefreshMailboxes={handleRefreshMailboxes}
              onCompose={() => {
                startFreshComposerSession();
                setComposerMode('compose');
                setShowComposer(true);
                if (isMobile) {
                  setSidebarOpen(false);
                  setActiveView('viewer');
                }
              }}
              onSidebarClose={() => setSidebarOpen(false)}
              multiAccountMode={isEmbedded}
              accountMailboxes={accountMailboxes}
              viewingAccountId={viewingAccountId}
              onAccountMailboxSelect={handleAccountMailboxSelect}
            />
          </ErrorBoundary>
        </div>

        {/* Sidebar resize handle (desktop only, hidden when collapsed) */}
        {!isMobile && !isTablet && !sidebarCollapsed && !inlineApp && !fullscreenReading && (
          <ResizeHandle
            onResizeStart={() => { dragStartWidth.current = sidebarWidth; setIsResizing(true); }}
            onResize={(delta) => setSidebarWidth(dragStartWidth.current + delta)}
            onResizeEnd={() => { setIsResizing(false); persistColumnWidths(); }}
            onDoubleClick={resetSidebarWidth}
          />
        )}

        {/* Main Content Area */}
        <div className={cn("flex flex-col flex-1 min-w-0 h-full", inlineApp && "hidden")}>
          <div className={cn("relative flex flex-1 min-h-0", isHorizontalMailLayout && "md:flex-col")}>
          {/* Email List - full width on mobile, fixed width/height on tablet/desktop */}
          <div
            className={cn(
              "relative flex flex-col bg-background",
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
            />

            {/* Search Bar + Inline Advanced Filters */}
            <div className="border-b border-border bg-background">
              <div className="px-3 h-14 flex items-center">
                <div className="flex items-center gap-1.5 w-full">
                  {/* Select / Select All toggle */}
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedEmailIds.size > 0) {
                        if (selectedEmailIds.size === activeEmails.length) {
                          clearSelection();
                        } else {
                          selectAllEmails();
                        }
                      } else if (activeEmails.length > 0) {
                        const currentId = selectedEmail?.id;
                        const target = currentId && activeEmails.some((e) => e.id === currentId)
                          ? currentId
                          : activeEmails[0].id;
                        toggleEmailSelection(target);
                      }
                    }}
                    disabled={isScheduledView}
                    className={cn(
                      "flex-shrink-0 p-2 rounded-md transition-colors",
                      selectedEmailIds.size > 0
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    )}
                    title={isScheduledView ? t('email_viewer.scheduled_actions_only') : selectedEmailIds.size > 0 ? (selectedEmailIds.size === activeEmails.length ? t('email_list.batch_actions.clear_selection') : t('email_list.batch_actions.select_all')) : t('email_list.batch_actions.select')}
                  >
                    {selectedEmailIds.size > 0 ? (
                      <CheckSquare className="w-4 h-4" />
                    ) : (
                      <Square className="w-4 h-4" />
                    )}
                  </button>
                  <form onSubmit={(e) => { e.preventDefault(); if (searchQuery.trim()) handleSearch(searchQuery); }} className="relative flex-1">
                    <Search className="absolute start-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      type="text"
                      placeholder={t("sidebar.search_placeholder_hint")}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className={cn("ps-9 h-9", searchQuery && "pe-8")}
                      data-search-input
                      data-tour="search-input"
                      disabled={isScheduledView}
                      title={isScheduledView ? t('email_viewer.scheduled_actions_only') : undefined}
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={handleClearSearch}
                        className="absolute end-2 top-1/2 transform -translate-y-1/2 p-1 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        aria-label={t("sidebar.clear_search")}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </form>
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
                </div>
              </div>

              {/* Filter Area */}
              {isAdvancedSearchOpen && (
                <div className="px-3 pb-3 space-y-2.5 animate-in slide-in-from-top-1 fade-in duration-150">
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
                          navigate the mail list, so it defaults to "All folders"
                          regardless of which folder is open and keeps whatever
                          the user picked. The unified views already search
                          across every account's folders, so it is hidden there. */}
                      {!isUnifiedView && (
                        <div>
                          <label className="text-xs text-muted-foreground mb-1 block">{t("advanced_search.folder")}</label>
                          <select
                            value={searchMailboxId}
                            onChange={(e) => {
                              setSearchMailboxId(e.target.value);
                              // Only re-query when a search is actually running;
                              // otherwise just remember the scope for the next one.
                              if (searchQuery.trim() || !isFilterEmpty(searchFilters)) handleAdvancedSearch();
                            }}
                            className="w-full h-8 text-sm rounded-md border border-input bg-background px-3 text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
                          >
                            <option value="">{t("advanced_search.all_folders")}</option>
                            {mailboxes.map((mb) => (
                              <option key={mb.id} value={mb.id}>
                                {mb.name}
                              </option>
                            ))}
                          </select>
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
                    </div>
                  )}
                </div>
              )}
            </div>

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
                emails={activeEmails}
                selectedEmailId={selectedEmail?.id}
                isLoading={activeIsLoading}
                hasMore={activeHasMore}
                isLoadingMoreItems={isScheduledView ? isLoadingScheduled && activeEmails.length > 0 : undefined}
                isScheduledView={isScheduledView}
                onLoadMoreScheduled={() => client && loadMoreScheduledEmails(client)}
                onCancelScheduledForEdit={async (email) => {
                  if (!client) return;
                  const restored = await cancelScheduledEmailForEdit(client, email);
                  if (email.isSmimeScheduled) {
                    setComposerMode('compose');
                    setPendingDraft(null);
                  } else if (restored) {
                    await handleEditDraft(restored);
                    return;
                  }
                  setShowComposer(true);
                  if (isMobile) setActiveView('viewer');
                }}
                onRescheduleScheduled={async (email) => {
                  const delayedUntil = promptForRescheduleDelayedUntil();
                  if (delayedUntil && client && email.emailSubmissionId && email.scheduledIdentityId) {
                    await rescheduleScheduledEmail(client, email.emailSubmissionId, email.id, email.scheduledIdentityId, delayedUntil);
                  }
                }}
                onEmailSelect={handleEmailSelect}
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
                  store.openEmailTab({
                    accountId: email.accountId ?? '',
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
                onMarkAsRead={async (email, read) => {
                  if (client) {
                    await markAsRead(client, email.id, read);
                  }
                }}
                onToggleStar={async (email) => {
                  if (client) {
                    await toggleStar(client, email.id);
                  }
                }}
                onTogglePinned={async (email) => {
                  await handleTogglePinned(email);
                }}
                onDelete={async (email) => {
                  await handleDelete(email);
                }}
                onArchive={async (email) => {
                  await handleArchive(email);
                }}
                onSetTag={(emailId, color) => {
                  handleSetTag(emailId, color);
                }}
                onMoveToMailbox={async (emailId, mailboxId) => {
                  if (client) {
                    await moveToMailboxCrossAware(client, emailId, mailboxId);
                  }
                }}
                onMarkAsSpam={async (email) => {
                  await handleMarkAsSpam(email);
                }}
                onUndoSpam={async (email) => {
                  await handleUndoSpam(email);
                }}
                onEditDraft={(email) => {
                  handleEditDraft(email);
                }}
                className="flex-1 min-h-0"
              />
            </ErrorBoundary>
            </div>

            {/* Floating Compose Button */}
            <Button
              onClick={() => {
                startFreshComposerSession();
                setComposerMode('compose');
                setShowComposer(true);
                if (isMobile) setActiveView('viewer');
              }}
              className={cn(
                "absolute z-40 rounded-full shadow-lg",
                isMobile ? "bottom-4 end-4 h-14 w-14" : "bottom-4 end-4 h-12 w-12"
              )}
              aria-label={t('sidebar.compose')}
              title={t('sidebar.compose_hint')}
              data-tour="compose-button"
            >
              <PenSquare className={isMobile ? "h-6 w-6" : "h-5 w-5"} />
            </Button>
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
            {(showComposer && !isEmbedded) ? (
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
                  replyTo={pendingDraft !== null ? pendingDraft.replyTo : (selectedEmail ? {
                    from: selectedEmail.from,
                    replyToAddresses: selectedEmail.replyTo,
                    to: selectedEmail.to,
                    cc: selectedEmail.cc,
                    bcc: selectedEmail.bcc,
                    subject: selectedEmail.subject,
                    ...getQuoteBodies(selectedEmail),
                    receivedAt: selectedEmail.receivedAt,
                    attachments: selectedEmail.attachments,
                    messageId: selectedEmail.messageId,
                    inReplyTo: selectedEmail.inReplyTo,
                    references: selectedEmail.references,
                    quoteHeaderHtml: composerQuoteHeader?.html,
                    quoteHeaderText: composerQuoteHeader?.text,
                    quoteWrapInBlockquote: composerQuoteHeader?.wrapInBlockquote,
                  } : undefined)}
                  initialDraftText={composerDraftText}
                  initialData={pendingDraft}
                  onSaveState={(data) => {
                    if (suppressComposerStateSaveSessionRef.current === composerSessionId) {
                      suppressComposerStateSaveSessionRef.current = null;
                      return;
                    }
                    setPendingDraft(data);
                  }}
                  onSend={async (data) => {
                    await handleEmailSend(data);
                    setPendingDraft(null);
                  }}
                  onScheduledSendCreated={async () => {
                    if (client) {
                      await refreshScheduledMetadata(client);
                      if (isScheduledView) await fetchScheduledEmails(client);
                    }
                    setShowComposer(false);
                    setPendingDraft(null);
                  }}
                  onClose={() => {
                    setShowComposer(false);
                    setComposerMode('compose');
                    setComposerDraftText("");
                    setPendingDraft(null);
                    setComposerQuoteHeader(null);
                    if (isMobile) {
                      setActiveView('list');
                    }
                  }}
                  requestCloseRef={composerRequestCloseRef}
                  onDiscardDraft={(draftId) => {
                    handleDiscardDraft(draftId);
                    setPendingDraft(null);
                  }}
                />
              </ErrorBoundary>
            ) : (
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
                onDownloadAttachment={handleDownloadAttachment}
                onMarkAsRead={async (emailId, read) => {
                  if (client) {
                    await markAsRead(client, emailId, read);
                  }
                }}
              />
            ) : (
              <>
                <ErrorBoundary fallback={EmailViewerErrorFallback}>
                  <EmailViewer
                    email={selectedEmail}
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
                    onArchive={() => handleArchive()}
                    onToggleStar={handleToggleStar}
                    onSetTag={handleSetTag}
                    onMarkAsSpam={() => handleMarkAsSpam()}
                    onUndoSpam={() => handleUndoSpam()}
                    onMarkAsRead={async (emailId, read) => {
                      if (client) {
                        await markAsRead(client, emailId, read);
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
                    onToggleFullscreen={!isEmbedded && !isMobile ? () => setFullscreenReading((v) => !v) : undefined}
                    isFullscreen={fullscreenReading}
                    onShowShortcuts={() => setShowShortcutsModal(true)}
                    onEditDraft={handleEditDraft}
                    onCancelScheduledForEdit={async () => {
                      if (!client || !selectedEmail) return;
                      const restored = await cancelScheduledEmailForEdit(client, selectedEmail);
                      if (selectedEmail.isSmimeScheduled) {
                        setComposerMode('compose');
                        setShowComposer(true);
                        return;
                      }
                      if (restored) await handleEditDraft(restored);
                    }}
                    onRescheduleScheduled={async (delayedUntil) => {
                      if (client && selectedEmail?.emailSubmissionId && selectedEmail.scheduledIdentityId) {
                        await rescheduleScheduledEmail(client, selectedEmail.emailSubmissionId, selectedEmail.id, selectedEmail.scheduledIdentityId, delayedUntil);
                      }
                    }}
                    onCompose={() => {
                      startFreshComposerSession();
                      setComposerMode('compose');
                      setShowComposer(true);
                    }}
                    currentUserEmail={client?.getUsername()}
                    currentUserName={client?.getUsername()?.split("@")[0]}
                    currentMailboxRole={mailboxes.find(m => m.id === selectedMailbox)?.role ?? (isUnifiedView ? (unifiedRole ?? undefined) : undefined)}
                    mailboxes={mailboxes}
                    selectedMailbox={selectedMailbox}
                    onMoveToMailbox={async (mailboxId) => {
                      if (client && selectedEmail) {
                        await moveToMailboxCrossAware(client, selectedEmail.id, mailboxId);
                      }
                    }}
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
        <TotpReauthDialog />
      </div>
    </DragDropProvider>
  );
}
