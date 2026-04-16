"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Sidebar } from "@/components/layout/sidebar";
import { EmailList } from "@/components/email/email-list";
import { EmailViewer } from "@/components/email/email-viewer";
import { EmailComposer } from "@/components/email/email-composer";
import type { ComposerDraftData } from "@/components/email/email-composer";
import { ThreadConversationView } from "@/components/email/thread-conversation-view";
import { MobileHeader, MobileViewerHeader } from "@/components/layout/mobile-header";
import { ThreadGroup, Email, isUnifiedMailboxId, UNIFIED_ROLE_BY_ID } from "@/lib/jmap/types";
import { useAccountStore } from "@/stores/account-store";
import type { UnifiedAccountClient } from "@/lib/unified-mailbox";
import { KeyboardShortcutsModal } from "@/components/keyboard-shortcuts-modal";
import { useEmailStore } from "@/stores/email-store";
import { useAuthStore, redirectToLogin } from "@/stores/auth-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useContactStore } from "@/stores/contact-store";
import { useIdentityStore } from "@/stores/identity-store";
import { useUIStore } from "@/stores/ui-store";
import { useDeviceDetection } from "@/hooks/use-media-query";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useBrowserNavigation, type NavSnapshot } from "@/hooks/use-browser-navigation";
import { debug } from "@/lib/debug";
import { playNotificationSound } from "@/lib/notification-sound";
import { cn } from "@/lib/utils";
import {
  ErrorBoundary,
  SidebarErrorFallback,
  EmailListErrorFallback,
  EmailViewerErrorFallback,
  ComposerErrorFallback,
} from "@/components/error";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TotpReauthDialog } from "@/components/totp-reauth-dialog";
import { DragDropProvider } from "@/contexts/drag-drop-context";
import { isFilterEmpty, activeFilterCount } from "@/lib/jmap/search-utils";
import { WelcomeBanner } from "@/components/ui/welcome-banner";
import { NavigationRail } from "@/components/layout/navigation-rail";
import { SidebarAppsModal } from "@/components/layout/sidebar-apps-modal";
import { InlineAppView } from "@/components/layout/inline-app-view";
import { useSidebarApps } from "@/hooks/use-sidebar-apps";
import { useIdentitySync } from "@/hooks/use-identity-sync";
import { Input } from "@/components/ui/input";
import { FilePreviewModal } from "@/components/files/file-preview-modal";
import { isFilePreviewable } from "@/lib/file-preview";
import { appendPlainTextSignature } from "@/lib/signature-utils";
import { Search, Filter, ChevronDown, X, Paperclip, Star, Mail, MailOpen, RotateCcw, PenSquare, PenLine, CheckSquare, Square, AlertTriangle } from "lucide-react";
import { ResizeHandle } from "@/components/layout/resize-handle";
import { Button } from "@/components/ui/button";
import { useConfig } from "@/hooks/use-config";
import { usePluginStore } from "@/stores/plugin-store";
import { useThemeStore } from "@/stores/theme-store";


export default function Home() {
  const t = useTranslations();
  const tCommon = useTranslations('common');
  const { appName } = useConfig();
  const mailLayout = useSettingsStore((state) => state.mailLayout);
  const [showComposer, setShowComposer] = useState(false);
  const [composerMode, setComposerMode] = useState<'compose' | 'reply' | 'replyAll' | 'forward'>('compose');
  const [composerDraftText, setComposerDraftText] = useState("");
  const [pendingDraft, setPendingDraft] = useState<ComposerDraftData | null>(null);
  const [composerSessionId, setComposerSessionId] = useState(0);
  const { dialogProps: confirmDialogProps, confirm: confirmDialog } = useConfirmDialog();
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
  const [previewAttachment, setPreviewAttachment] = useState<{ blobId: string; name: string; type?: string } | null>(null);
  const markAsReadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { isAuthenticated, client, logout, checkAuth, isLoading: authLoading, connectionLost, isRateLimited, rateLimitUntil } = useAuthStore();
  const { identities } = useIdentityStore();
  useIdentitySync();
  const trustedSendersAddressBook = useSettingsStore((state) => state.trustedSendersAddressBook);
  const { loadTrustedSendersBook, trustedSendersLoaded } = useContactStore();

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

  // Mobile/tablet responsive hooks
  const { isMobile, isTablet } = useDeviceDetection();
  const { activeView, sidebarOpen, setSidebarOpen, setActiveView, tabletListVisible, setTabletListVisible, sidebarWidth, emailListWidth, setSidebarWidth, setEmailListWidth, persistColumnWidths, sidebarCollapsed, resetSidebarWidth, resetEmailListWidth } = useUIStore();
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
    moveToMailbox,
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
    isAdvancedSearchOpen,
    setSearchFilters,
    clearSearchFilters,
    toggleAdvancedSearch,
    advancedSearch,
    selectedKeyword,
    selectKeyword,
    hasMoreEmails,
    fetchTagCounts,
    fetchEmailContent,
    isUnifiedView,
    fetchUnifiedEmails: fetchUnifiedEmailsAction,
    refreshUnifiedCounts,
    exitUnifiedView,
  } = useEmailStore();

  const enableUnifiedMailbox = useSettingsStore((s) => s.enableUnifiedMailbox);
  const accounts = useAccountStore((s) => s.accounts);
  const connectedAccountsSignature = useMemo(
    () => accounts.filter((a) => a.isConnected).map((a) => a.id).sort().join(","),
    [accounts],
  );

  const buildUnifiedAccounts = useCallback((): UnifiedAccountClient[] => {
    const connected = useAccountStore.getState().accounts.filter((a) => a.isConnected);
    const clients = useAuthStore.getState().getAllConnectedClients();
    const result: UnifiedAccountClient[] = [];
    for (const account of connected) {
      const accountClient = clients.get(account.id);
      if (!accountClient) continue;
      result.push({
        accountId: account.id,
        accountLabel: account.label || account.email,
        client: accountClient,
        mailboxes: [],
      });
    }
    return result;
  }, []);

  const populateUnifiedAccountMailboxes = useCallback(
    async (list: UnifiedAccountClient[]): Promise<UnifiedAccountClient[]> => {
      const populated = await Promise.all(
        list.map(async (entry) => {
          try {
            const mailboxes = await entry.client.getMailboxes();
            return { ...entry, mailboxes };
          } catch (err) {
            debug.error('Failed to load mailboxes for unified account', entry.accountId, err);
            return entry;
          }
        }),
      );
      return populated;
    },
    [],
  );

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
  navRestoreStateRef.current.emails = emails;
  navRestoreStateRef.current.mailboxes = mailboxes;
  navRestoreStateRef.current.selectedMailbox = selectedMailbox;
  navRestoreStateRef.current.selectedEmailId = selectedEmail?.id ?? null;
  navRestoreStateRef.current.conversationThreadId = conversationThread?.threadId ?? null;

  const handleNavRestore = useCallback(async (state: NavSnapshot) => {
    const ctx = navRestoreStateRef.current;

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
    if (state.mailboxId && state.mailboxId !== ctx.selectedMailbox) {
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
        const found = ctx.emails.find(e => e.id === state.emailId);
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

  useBrowserNavigation({
    mailboxId: selectedMailbox,
    emailId: selectedEmail?.id ?? null,
    threadId: conversationThread?.threadId ?? null,
    composerOpen: showComposer,
    sidebarOpen,
    onRestore: handleNavRestore,
    enabled: isAuthenticated && mailboxes.length > 0,
  });

  // Keyboard shortcuts handlers
  const keyboardHandlers = useMemo(() => ({
    onNextEmail: () => {
      if (emails.length === 0) return;
      const currentIndex = selectedEmail ? emails.findIndex(e => e.id === selectedEmail.id) : -1;
      const nextIndex = currentIndex < emails.length - 1 ? currentIndex + 1 : currentIndex;
      if (nextIndex >= 0 && nextIndex < emails.length) {
        handleEmailSelect(emails[nextIndex]);
      }
    },
    onPreviousEmail: () => {
      if (emails.length === 0) return;
      const currentIndex = selectedEmail ? emails.findIndex(e => e.id === selectedEmail.id) : emails.length;
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : 0;
      if (prevIndex >= 0 && prevIndex < emails.length) {
        handleEmailSelect(emails[prevIndex]);
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
      if (selectedEmail) handleReply();
    },
    onReplyAll: () => {
      if (selectedEmail) handleReplyAll();
    },
    onForward: () => {
      if (selectedEmail) handleForward();
    },
    onToggleStar: () => {
      if (selectedEmail) handleToggleStar();
    },
    onArchive: () => {
      if (selectedEmail) handleArchive();
    },
    onDelete: () => {
      if (selectedEmail) handleDelete();
    },
    onMarkAsUnread: async () => {
      if (selectedEmail && client) {
        await markAsRead(client, selectedEmail.id, false);
      }
    },
    onMarkAsRead: async () => {
      if (selectedEmail && client) {
        await markAsRead(client, selectedEmail.id, true);
      }
    },
    onToggleSpam: () => {
      if (selectedEmail) {
        // Check if we're in junk folder
        const currentMailbox = mailboxes.find(m => m.id === selectedMailbox);
        const isInJunk = currentMailbox?.role === 'junk';
        if (isInJunk) {
          handleUndoSpam();
        } else {
          handleMarkAsSpam();
        }
      }
    },
    onCompose: () => {
      setComposerMode('compose');
      setShowComposer(true);
      if (isMobile) setActiveView('viewer');
    },
    onFocusSearch: () => {
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
        await fetchEmails(client, selectedMailbox);
      }
    },
    onSelectAll: () => {
      selectAllEmails();
    },
    onDeselectAll: () => {
      clearSelection();
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [emails, selectedEmail, client, selectedMailbox, isMobile, isTablet]);

  // Initialize keyboard shortcuts
  useKeyboardShortcuts({
    enabled: isAuthenticated && !showComposer,
    emails,
    selectedEmailId: selectedEmail?.id,
    handlers: keyboardHandlers,
  });

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
        const mailboxName = mailbox.name;
        const unreadCount = mailbox.unreadEmails || 0;
        title = unreadCount > 0
          ? `${mailboxName} (${unreadCount}) - ${appName}`
          : `${mailboxName} - ${appName}`;
      }
    }

    document.title = title;
  }, [showComposer, composerMode, selectedEmail, selectedMailbox, mailboxes, t, appName]);

  // Check auth on mount
  useEffect(() => {
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
      }
    } catch { /* ignore parse errors */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (initialCheckDone && !isAuthenticated && !authLoading) {
      try { sessionStorage.setItem('redirect_after_login', window.location.pathname); } catch { /* ignore */ }
      redirectToLogin();
    }
  }, [initialCheckDone, isAuthenticated, authLoading]);

  // Load mailboxes and emails when authenticated (only if not already loaded)
  useEffect(() => {
    if (isAuthenticated && client && mailboxes.length === 0) {
      const loadData = async () => {
        try {
          // First fetch mailboxes and quota (inbox will be auto-selected in fetchMailboxes)
          await Promise.all([
            fetchMailboxes(client),
            fetchQuota(client)
          ]);

          // Get the selected mailbox (should be inbox by default)
          const state = useEmailStore.getState();
          const selectedMailboxId = state.selectedMailbox;

          // Fetch emails for the selected mailbox
          if (selectedMailboxId) {
            await fetchEmails(client, selectedMailboxId);
          } else {
            await fetchEmails(client);
          }

          // Fetch tag counts
          fetchTagCounts(client);

          // Setup push notifications after successful data load
          try {
            // Register state change callback
            client.onStateChange((change) => handleStateChange(change, client));

            // Start receiving push notifications
            const pushEnabled = client.setupPushNotifications();

            if (pushEnabled) {
              setPushConnected(true);
              debug.log('push', '[Push] Push notifications successfully enabled');
            } else {
              debug.log('push', '[Push] Push notifications not available on this server');
            }
          } catch (error) {
            // Push notifications are optional - don't break the app if they fail
            debug.log('push', '[Push] Failed to setup push notifications:', error);
          }
        } catch (error) {
          console.error('Error loading email data:', error);
        }
      };
      loadData();
    }

    // Cleanup push notifications on unmount
    return () => {
      if (client) {
        client.closePushNotifications();
      }
    };
  }, [isAuthenticated, client, mailboxes.length, fetchMailboxes, fetchEmails, fetchQuota, fetchTagCounts, handleStateChange, setPushConnected]);

  // Keep unified mailbox counts in sync when the feature is enabled and more
  // than one account is connected. Runs whenever the set of connected accounts
  // or the primary account's mailboxes change (a proxy for "something worth
  // recounting happened").
  useEffect(() => {
    if (!enableUnifiedMailbox || !isAuthenticated || !client) return;
    const built = buildUnifiedAccounts();
    if (built.length < 2) return;
    populateUnifiedAccountMailboxes(built).then((populated) => {
      refreshUnifiedCounts(populated);
    });
  }, [enableUnifiedMailbox, isAuthenticated, client, mailboxes, connectedAccountsSignature, buildUnifiedAccounts, populateUnifiedAccountMailboxes, refreshUnifiedCounts]);

  // Auto-fetch full email content when an email is auto-selected (e.g. after delete/archive)
  useEffect(() => {
    if (!selectedEmail || !client) return;
    // If the email lacks bodyValues, it was auto-selected from the list and needs full content
    if (!selectedEmail.bodyValues) {
      const perAccountClient = isUnifiedView && selectedEmail.accountId
        ? useAuthStore.getState().getClientForAccount(selectedEmail.accountId)
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
    if (!selectedEmail || !client || selectedEmail.keywords?.$seen) {
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
  }, [selectedEmail?.id]);

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
    attachments?: Array<{ blobId: string; name: string; type: string; size: number }>;
  }) => {
    if (!client) return;

    try {
      const effectiveMode = pendingDraft?.mode ?? composerMode;
      const originalEmailId = selectedEmail?.id;

      await sendEmail(client, data.to, data.subject, data.body, data.cc, data.bcc, data.identityId, data.fromEmail, data.draftId, data.fromName, data.htmlBody, data.attachments);
      setShowComposer(false);

      // Mark the original email with $answered or $forwarded keyword
      if (originalEmailId && (effectiveMode === 'reply' || effectiveMode === 'replyAll')) {
        try {
          await client.setKeyword(originalEmailId, '$answered');
        } catch (e) {
          debug.error('Failed to set $answered keyword:', e);
        }
      } else if (originalEmailId && effectiveMode === 'forward') {
        try {
          await client.setKeyword(originalEmailId, '$forwarded');
        } catch (e) {
          debug.error('Failed to set $forwarded keyword:', e);
        }
      }

      // Refresh the current mailbox to update the UI
      await fetchEmails(client, selectedMailbox);
    } catch (error) {
      console.error("Failed to send email:", error);
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

  const handleReply = (draftText?: string) => {
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

    const bodyText = draft.bodyValues
      ? Object.values(draft.bodyValues).map(v => v.value).join('\n')
      : '';
    const htmlBody = draft.htmlBody?.[0]?.partId && draft.bodyValues?.[draft.htmlBody[0].partId]
      ? draft.bodyValues[draft.htmlBody[0].partId].value
      : undefined;

    // Try to find the identity that matches the draft's from address to preserve it
    const draftFromEmail = draft.from?.[0]?.email;
    const matchedIdentity = draftFromEmail
      ? identities.find(id => id.email === draftFromEmail)
      : null;

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
      selectedIdentityId: matchedIdentity?.id ?? null,
      subAddressTag: '',
      mode: 'compose',
      draftId: draft.id,
    });
    setComposerMode('compose');
    setShowComposer(true);
    if (isMobile) setActiveView('viewer');
  };

  const handleReplyAll = () => {
    setComposerMode('replyAll');
    setShowComposer(true);
    if (isMobile) setActiveView('viewer');
  };

  const handleForward = () => {
    setComposerMode('forward');
    setShowComposer(true);
    if (isMobile) setActiveView('viewer');
  };

  const handleDelete = async (emailToDelete: Email | null = selectedEmail) => {
    if (!client || !emailToDelete) return;

    // Check if we're currently in the trash or junk folder
    const currentMailbox = mailboxes.find(m => m.id === selectedMailbox);
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
      // Not in trash: always move to trash
      const trashMailbox = mailboxes.find(m => m.role === 'trash' && !m.isShared);
      if (trashMailbox) {
        try {
          await moveToMailbox(client, emailToDelete.id, trashMailbox.id);
        } catch (error) {
          console.error("Failed to move email to trash:", error);
        }
      }
    }
  };

  const handleArchive = async (emailToArchive: Email | null = selectedEmail) => {
    if (!client || !emailToArchive) return;

    // Find archive mailbox
    const archiveMailbox = mailboxes.find(m => m.role === "archive" || m.name.toLowerCase() === "archive");
    if (!archiveMailbox) return;

    const { archiveMode } = useSettingsStore.getState();

    try {
      if (archiveMode === 'single') {
        await moveThreadToMailbox(client, emailToArchive.id, archiveMailbox.id);
      } else {
        // Determine year/month from the email's received date
        const emailDate = new Date(emailToArchive.receivedAt);
        const year = emailDate.getFullYear().toString();
        const month = (emailDate.getMonth() + 1).toString().padStart(2, '0');
        const archiveId = archiveMailbox.originalId || archiveMailbox.id;

        // Find or create year subfolder under archive
        let yearMailbox = mailboxes.find(
          m => m.name === year && m.parentId === archiveId
        );
        if (!yearMailbox) {
          yearMailbox = await client.createMailbox(year, archiveId);
          await fetchMailboxes(client);
        }

        if (archiveMode === 'year') {
          await moveThreadToMailbox(client, emailToArchive.id, yearMailbox.id);
        } else {
          // archiveMode === 'month' - find or create month subfolder under year
          const yearId = yearMailbox.originalId || yearMailbox.id;
          let monthMailbox = mailboxes.find(
            m => m.name === month && m.parentId === yearId
          );
          if (!monthMailbox) {
            monthMailbox = await client.createMailbox(month, yearId);
            await fetchMailboxes(client);
          }
          await moveThreadToMailbox(client, emailToArchive.id, monthMailbox.id);
        }
      }

      if (conversationThread?.threadId === emailToArchive.threadId) {
        setConversationThread(null);
        setConversationEmails([]);
      }

      void fetchMailboxes(client);
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

  const handleSetColorTag = async (emailId: string, color: string | null) => {
    if (!client) return;

    try {
      // Remove any existing label/color tags
      const email = emails.find(e => e.id === emailId);
      if (!email) return;

      const keywords = { ...email.keywords };

      if (color === null) {
        // Remove all label/color tags
        Object.keys(keywords).forEach(key => {
          if (key.startsWith("$label:") || key.startsWith("$color:")) {
            keywords[key] = false;
          }
        });
      } else {
        const jmapKey = `$label:${color}`;
        if (keywords[jmapKey] === true) {
          // Toggle off if already active
          keywords[jmapKey] = false;
        } else {
          // Add the tag without disturbing others
          keywords[jmapKey] = true;
        }
      }

      // Update email keywords via JMAP
      await client.updateEmailKeywords(emailId, keywords);

      // Update local state
      selectEmail(email.id === selectedEmail?.id ? { ...email, keywords } : selectedEmail);

      // Refresh emails list to show color in list
      await fetchEmails(client, selectedMailbox);

      // Refresh tag counts
      fetchTagCounts(client);
    } catch (error) {
      console.error("Failed to set color tag:", error);
    }
  };

  const handleMailboxSelect = async (mailboxId: string) => {
    if (isUnifiedMailboxId(mailboxId)) {
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

      const built = buildUnifiedAccounts();
      const populated = await populateUnifiedAccountMailboxes(built);
      await fetchUnifiedEmailsAction(populated, role);
      refreshUnifiedCounts(populated);
      return;
    }

    if (isUnifiedView) {
      exitUnifiedView();
    }

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
      // If there's an active search, re-run it in the new mailbox
      if (searchQuery) {
        await searchEmails(client, searchQuery);
      } else {
        await fetchEmails(client, mailboxId);
      }
    }
  };

  const handleTagSelect = async (keywordId: string | null) => {
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

  const handleLogout = logout;

  const handleSearch = async (query: string) => {
    if (!client) return;
    if (isUnifiedView) return;
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
    if (client && selectedMailbox) {
      await fetchEmails(client, selectedMailbox);
    }
  };

  const handleAdvancedSearch = async () => {
    if (!client) return;
    if (isUnifiedView) return;
    await advancedSearch(client);
  };

  const advancedSearchDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const handleAdvancedSearchDebounced = useCallback(() => {
    if (advancedSearchDebounceRef.current) {
      clearTimeout(advancedSearchDebounceRef.current);
    }
    advancedSearchDebounceRef.current = setTimeout(() => {
      if (client && !isUnifiedView) advancedSearch(client);
    }, 300);
  }, [client, advancedSearch, isUnifiedView]);

  useEffect(() => {
    return () => {
      if (advancedSearchDebounceRef.current) {
        clearTimeout(advancedSearchDebounceRef.current);
      }
    };
  }, []);

  const handleDownloadAttachment = async (blobId: string, name: string, type?: string, forceDownload?: boolean) => {
    if (!client) return;

    try {
      const { mailAttachmentAction } = useSettingsStore.getState();

      if (!forceDownload && mailAttachmentAction === 'preview' && isFilePreviewable(name, type)) {
        setPreviewAttachment({ blobId, name, type });
        return;
      }

      await client.downloadBlob(blobId, name, type);
    } catch (error) {
      console.error("Failed to download attachment:", error);
    }
  };

  const handlePreviewAttachmentDownload = useCallback(async () => {
    if (!client || !previewAttachment) return;

    await client.downloadBlob(previewAttachment.blobId, previewAttachment.name, previewAttachment.type);
  }, [client, previewAttachment]);

  const getPreviewAttachmentContent = useCallback(async () => {
    if (!client || !previewAttachment) {
      throw new Error('No attachment selected');
    }

    const blob = await client.fetchBlob(previewAttachment.blobId, previewAttachment.name, previewAttachment.type);

    return {
      blob,
      contentType: previewAttachment.type || blob.type || 'application/octet-stream',
    };
  }, [client, previewAttachment]);

  const handleQuickReply = async (body: string) => {
    if (!client || !selectedEmail) return;

    const sender = selectedEmail.from?.[0];
    if (!sender?.email) {
      throw new Error("No sender email found");
    }

    const primaryIdentity = identities[0];

    // Append signature from the primary identity
    const finalBody = appendPlainTextSignature(body, primaryIdentity);

    const originalEmailId = selectedEmail.id;

    // Send reply with just the body text
    await sendEmail(
      client,
      [sender.email],
      `Re: ${selectedEmail.subject || "(no subject)"}`,
      finalBody,
      undefined,
      undefined,
      primaryIdentity?.id,
      primaryIdentity?.email,
      undefined,
      primaryIdentity?.name || undefined
    );

    // Mark the original email as answered
    try {
      await client.setKeyword(originalEmailId, '$answered');
    } catch (e) {
      debug.error('Failed to set $answered keyword:', e);
    }

    // Refresh emails to show the sent reply
    await fetchEmails(client, selectedMailbox);
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
  const currentMailboxName = mailboxes.find(m => m.id === selectedMailbox)?.name || "Inbox";
  const isFocusedMailLayout = mailLayout === 'focus';
  const hasViewerContent = showComposer || Boolean(conversationThread) || Boolean(selectedEmail);
  const shouldCollapseListPane = (isTablet && !tabletListVisible) || (!isMobile && isFocusedMailLayout && hasViewerContent);
  const shouldHideViewerPane = !isMobile && isFocusedMailLayout && !hasViewerContent;

  // Handle email selection with mobile view switching
  const handleEmailSelect = async (email: { id: string }) => {
    if (!client || !email) return;

    // If composing, suspend the composer (unmount will trigger onSaveState)
    if (showComposer) {
      setShowComposer(false);
    }

    // Set loading state immediately (keep current email visible)
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
      // In unified view each email carries its own accountId. Use that
      // account's client so we fetch from the server that actually owns it.
      const listEmail = emails.find(e => e.id === email.id);
      const emailAccountId = isUnifiedView ? listEmail?.accountId : undefined;
      const perAccountClient = emailAccountId
        ? useAuthStore.getState().getClientForAccount(emailAccountId)
        : undefined;
      const fetchClient = perAccountClient ?? client;

      // For shared folders on the primary client, we still need to pass the
      // shared account's id. In unified view we use the per-account client
      // directly, so no explicit accountId is needed.
      const mailbox = mailboxes.find(mb => mb.id === selectedMailbox);
      const accountId = perAccountClient
        ? undefined
        : mailbox?.isShared ? mailbox.accountId : undefined;

      const fullEmail = await fetchClient.getEmail(email.id, accountId);
      if (fullEmail) {
        if (emailAccountId) {
          fullEmail.accountId = emailAccountId;
          fullEmail.accountLabel = listEmail?.accountLabel;
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
  // Delegate to the browser history stack so this button is equivalent to
  // the OS back button / mouse back button - popstate then restores the
  // previous snapshot via handleNavRestore. The viewer is only reachable
  // from a state that pushed history, so back() always lands on an app entry.
  const handleMobileBack = () => {
    if (typeof window !== 'undefined') {
      window.history.back();
      return;
    }
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
  const selectedEmailIndex = selectedEmail ? emails.findIndex(e => e.id === selectedEmail.id) : -1;

  const handleNavigateNext = selectedEmailIndex >= 0 && selectedEmailIndex < emails.length - 1
    ? () => handleEmailSelect(emails[selectedEmailIndex + 1])
    : undefined;

  const handleNavigatePrev = selectedEmailIndex > 0
    ? () => handleEmailSelect(emails[selectedEmailIndex - 1])
    : undefined;

  // Handle opening conversation view on mobile
  const handleOpenConversation = async (thread: ThreadGroup) => {
    if (!client) return;

    setConversationThread(thread);
    setIsLoadingConversation(true);
    setActiveView("viewer");

    try {
      // Fetch complete thread emails
      const emails = await client.getThreadEmails(thread.threadId);
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
  const handleConversationReply = (email: Email) => {
    selectEmail(email);
    setComposerMode('reply');
    setShowComposer(true);
    if (isMobile) setActiveView('viewer');
  };

  const handleConversationReplyAll = (email: Email) => {
    selectEmail(email);
    setComposerMode('replyAll');
    setShowComposer(true);
    if (isMobile) setActiveView('viewer');
  };

  const handleConversationForward = (email: Email) => {
    selectEmail(email);
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
      <div className="flex flex-col h-dvh bg-background overflow-hidden">
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
        {/* Desktop Navigation Rail */}
        {!isMobile && !isTablet && (
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

        {/* Mobile/Tablet Sidebar Overlay Backdrop */}
        {(isMobile || isTablet) && sidebarOpen && !inlineApp && (
          <div
            className="fixed inset-0 bg-black/50 z-40 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar - overlay on mobile/tablet, fixed on desktop */}
        <div
          className={cn(
            "flex-shrink-0 h-full z-50",
            !isResizing && "transition-[width] duration-300",
            // Mobile/Tablet: fixed overlay
            "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:w-72",
            "max-lg:transform max-lg:transition-transform max-lg:duration-300 max-lg:ease-in-out",
            !sidebarOpen && "max-lg:-translate-x-full",
            // Desktop: normal flow
            "lg:relative lg:translate-x-0",
            inlineApp && "hidden"
          )}
          style={!isMobile && !isTablet ? { width: sidebarCollapsed ? 64 : sidebarWidth } : undefined}
        >
          <ErrorBoundary fallback={SidebarErrorFallback}>
            <Sidebar
              mailboxes={mailboxes}
              selectedMailbox={selectedMailbox}
              selectedKeyword={selectedKeyword}
              onMailboxSelect={handleMailboxSelect}
              onTagSelect={handleTagSelect}
              onUnreadFilterClick={handleUnreadFilterClick}
              onCompose={() => {
                setComposerMode('compose');
                setShowComposer(true);
                if (isMobile) {
                  setSidebarOpen(false);
                  setActiveView('viewer');
                }
              }}
              onSidebarClose={() => setSidebarOpen(false)}
            />
          </ErrorBoundary>
        </div>

        {/* Sidebar resize handle (desktop only, hidden when collapsed) */}
        {!isMobile && !isTablet && !sidebarCollapsed && !inlineApp && (
          <ResizeHandle
            onResizeStart={() => { dragStartWidth.current = sidebarWidth; setIsResizing(true); }}
            onResize={(delta) => setSidebarWidth(dragStartWidth.current + delta)}
            onResizeEnd={() => { setIsResizing(false); persistColumnWidths(); }}
            onDoubleClick={resetSidebarWidth}
          />
        )}

        {/* Main Content Area */}
        <div className={cn("flex flex-col flex-1 min-w-0 h-full", inlineApp && "hidden")}>
          <div className="flex flex-1 min-h-0">
          {/* Email List - full width on mobile, fixed width on tablet/desktop */}
          <div
            className={cn(
              "relative flex flex-col h-full bg-background border-r border-border",
              // Mobile: full width, hidden when viewing email
              "max-md:flex-1 max-md:border-r-0",
              isMobile && activeView !== "list" && "max-md:hidden",
              // Tablet/Desktop: fixed width with collapse animation
              shouldHideViewerPane ? "md:flex-1 md:border-r-0" : "md:flex-shrink-0",
              "md:shadow-sm",
              !isResizing && "transition-all duration-200 ease-out",
              shouldCollapseListPane && "md:w-0 md:opacity-0 md:overflow-hidden md:border-r-0"
            )}
            style={!isMobile && !shouldCollapseListPane && !shouldHideViewerPane ? { width: emailListWidth } : undefined}
          >
            {/* Mobile Header for List View */}
            <MobileHeader
              title={currentMailboxName}
            />

            {/* Search Bar + Inline Advanced Filters */}
            <div className="border-b border-border bg-background">
              <div className="px-3 py-3">
                <div className="flex items-center gap-1.5">
                  {/* Select / Select All toggle */}
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedEmailIds.size > 0) {
                        if (selectedEmailIds.size === emails.length) {
                          clearSelection();
                        } else {
                          selectAllEmails();
                        }
                      } else {
                        // Enter selection mode by selecting the first email
                        if (emails.length > 0) toggleEmailSelection(emails[0].id);
                      }
                    }}
                    className={cn(
                      "flex-shrink-0 p-2 rounded-md transition-colors",
                      selectedEmailIds.size > 0
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    )}
                    title={selectedEmailIds.size > 0 ? (selectedEmailIds.size === emails.length ? t('email_list.batch_actions.clear_selection') : t('email_list.batch_actions.select_all')) : t('email_list.batch_actions.select')}
                  >
                    {selectedEmailIds.size > 0 ? (
                      <CheckSquare className="w-4 h-4" />
                    ) : (
                      <Square className="w-4 h-4" />
                    )}
                  </button>
                  <form onSubmit={(e) => { e.preventDefault(); if (searchQuery.trim()) handleSearch(searchQuery); }} className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      type="text"
                      placeholder={t("sidebar.search_placeholder_hint")}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className={cn("pl-9 h-9", searchQuery && "pr-8")}
                      data-search-input
                      data-tour="search-input"
                      disabled={isUnifiedView}
                      title={isUnifiedView ? t("unified_mailbox.search_unavailable") : undefined}
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={handleClearSearch}
                        className="absolute right-2 top-1/2 transform -translate-y-1/2 p-1 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        aria-label={t("sidebar.clear_search")}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </form>
                  <button
                    type="button"
                    onClick={toggleAdvancedSearch}
                    disabled={isUnifiedView}
                    className={cn(
                      "relative flex-shrink-0 p-2 rounded-md transition-colors",
                      isUnifiedView && "opacity-50 cursor-not-allowed",
                      isAdvancedSearchOpen || activeFilterCount(searchFilters) > 0
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    )}
                    title={isUnifiedView ? t("unified_mailbox.search_unavailable") : t("advanced_search.toggle_filters")}
                  >
                    <Filter className="w-4 h-4" />
                    {!isAdvancedSearchOpen && activeFilterCount(searchFilters) > 0 && (
                      <span className="absolute -top-1 -right-1 flex items-center justify-center w-4 h-4 text-[10px] font-bold rounded-full bg-primary text-primary-foreground">
                        {activeFilterCount(searchFilters)}
                      </span>
                    )}
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
                        onClick={() => { const next = searchFilters.hasAttachment === null ? true : searchFilters.hasAttachment === true ? false : null; setSearchFilters({ hasAttachment: next }); handleAdvancedSearch(); }}
                      />
                      <ToggleChip
                        icon={<Star className="w-3.5 h-3.5" />}
                        label={t("advanced_search.starred")}
                        value={searchFilters.isStarred}
                        onClick={() => { const next = searchFilters.isStarred === null ? true : searchFilters.isStarred === true ? false : null; setSearchFilters({ isStarred: next }); handleAdvancedSearch(); }}
                      />
                      <ToggleChip
                        icon={searchFilters.isUnread === false ? <MailOpen className="w-3.5 h-3.5" /> : <Mail className="w-3.5 h-3.5" />}
                        label={searchFilters.isUnread === false ? t("advanced_search.read") : t("advanced_search.unread")}
                        value={searchFilters.isUnread}
                        onClick={() => { const next = searchFilters.isUnread === null ? true : searchFilters.isUnread === true ? false : null; setSearchFilters({ isUnread: next }); handleAdvancedSearch(); }}
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => { clearSearchFilters(); setShowAdvancedFields(false); if (client) advancedSearch(client); }} className="h-7 px-2 text-xs text-muted-foreground">
                        <RotateCcw className="w-3 h-3 mr-1" />
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

                      {/* Folder selector */}
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">{t("advanced_search.folder")}</label>
                        <select
                          value={selectedMailbox || ""}
                          onChange={(e) => { handleMailboxSelect(e.target.value); }}
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

            {(searchQuery || !isFilterEmpty(searchFilters)) && !isLoading && (
              <div className="px-4 py-1.5 text-xs text-muted-foreground border-b border-border bg-muted/20">
                {hasMoreEmails
                  ? t("advanced_search.results_found_more", { count: emails.length })
                  : t("advanced_search.results_found", { count: emails.length })}
              </div>
            )}

            <div className="flex-1 min-h-0 flex flex-col">
            <WelcomeBanner />

            <ErrorBoundary fallback={EmailListErrorFallback}>
              <EmailList
                emails={emails}
                selectedEmailId={selectedEmail?.id}
                isLoading={isLoading}
                onEmailSelect={handleEmailSelect}
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
                onDelete={async (email) => {
                  await handleDelete(email);
                }}
                onArchive={async (email) => {
                  await handleArchive(email);
                }}
                onSetColorTag={(emailId, color) => {
                  handleSetColorTag(emailId, color);
                }}
                onMoveToMailbox={async (emailId, mailboxId) => {
                  if (client) {
                    await moveToMailbox(client, emailId, mailboxId);
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
                setComposerMode('compose');
                setShowComposer(true);
                if (isMobile) setActiveView('viewer');
              }}
              className={cn(
                "absolute z-40 rounded-full shadow-lg",
                isMobile ? "bottom-4 right-4 h-14 w-14" : "bottom-4 right-4 h-12 w-12"
              )}
              aria-label={t('sidebar.compose')}
              title={t('sidebar.compose_hint')}
              data-tour="compose-button"
            >
              <PenSquare className={isMobile ? "h-6 w-6" : "h-5 w-5"} />
            </Button>
          </div>

          {/* Email list resize handle (desktop only) */}
          {!isMobile && !isTablet && !isFocusedMailLayout && (
            <ResizeHandle
              onResizeStart={() => { dragStartWidth.current = emailListWidth; setIsResizing(true); }}
              onResize={(delta) => setEmailListWidth(dragStartWidth.current + delta)}
              onResizeEnd={() => { setIsResizing(false); persistColumnWidths(); }}
              onDoubleClick={resetEmailListWidth}
            />
          )}

          {/* Email Viewer / Composer - full screen on mobile, flex on tablet/desktop */}
          <div
            className={cn(
              "flex flex-col h-full bg-background flex-1 min-w-0",
              // Mobile: full screen overlay when active
              "max-md:fixed max-md:inset-0 max-md:z-30",
              isMobile && activeView !== "viewer" && "max-md:hidden",
              // Tablet/Desktop: relative
              "md:relative",
              shouldHideViewerPane && "md:hidden"
            )}
          >
            {/* Inline Composer - shown in viewer pane */}
            {showComposer ? (
              <ErrorBoundary
                fallback={ComposerErrorFallback}
                onReset={() => {
                  setShowComposer(false);
                  setComposerMode('compose');
                }}
              >
                <EmailComposer
                  key={composerSessionId}
                  mode={pendingDraft?.mode ?? composerMode}
                  replyTo={pendingDraft !== null ? pendingDraft.replyTo : (selectedEmail ? {
                    from: selectedEmail.from,
                    replyToAddresses: selectedEmail.replyTo,
                    to: selectedEmail.to,
                    cc: selectedEmail.cc,
                    bcc: selectedEmail.bcc,
                    subject: selectedEmail.subject,
                    body: selectedEmail.bodyValues?.[selectedEmail.textBody?.[0]?.partId || '']?.value || selectedEmail.preview || '',
                    htmlBody: selectedEmail.bodyValues?.[selectedEmail.htmlBody?.[0]?.partId || '']?.value || undefined,
                    receivedAt: selectedEmail.receivedAt
                  } : undefined)}
                  initialDraftText={composerDraftText}
                  initialData={pendingDraft}
                  onSaveState={(data) => setPendingDraft(data)}
                  onSend={async (data) => {
                    await handleEmailSend(data);
                    setPendingDraft(null);
                  }}
                  onClose={() => {
                    setShowComposer(false);
                    setComposerMode('compose');
                    setComposerDraftText("");
                    setPendingDraft(null);
                    if (isMobile) {
                      setActiveView('list');
                    }
                  }}
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
                className="flex items-center gap-3 px-4 py-2.5 bg-primary/10 border-b border-primary/20 hover:bg-primary/15 transition-colors cursor-pointer w-full text-left"
              >
                <PenLine className="w-4 h-4 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-primary">{t('email_composer.continue_draft')}</span>
                  {pendingDraft.subject && (
                    <span className="text-xs text-muted-foreground ml-2 truncate">{pendingDraft.subject}</span>
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
                {/* Mobile Header for Viewer */}
                {isMobile && activeView === "viewer" && (
                  <MobileViewerHeader
                    subject={selectedEmail?.subject}
                    onBack={handleMobileBack}
                  />
                )}

                <ErrorBoundary fallback={EmailViewerErrorFallback}>
                  <EmailViewer
                    email={selectedEmail}
                    isLoading={isLoadingEmail}
                    onReply={handleReply}
                    onReplyAll={handleReplyAll}
                    onForward={handleForward}
                    onDelete={handleDelete}
                    onArchive={() => handleArchive()}
                    onToggleStar={handleToggleStar}
                    onSetColorTag={handleSetColorTag}
                    onMarkAsSpam={handleMarkAsSpam}
                    onUndoSpam={handleUndoSpam}
                    onMarkAsRead={async (emailId, read) => {
                      if (client) {
                        await markAsRead(client, emailId, read);
                      }
                    }}
                    onDownloadAttachment={handleDownloadAttachment}
                    onQuickReply={handleQuickReply}
                    onBack={handleMobileBack}
                    onNavigateNext={handleNavigateNext}
                    onNavigatePrev={handleNavigatePrev}
                    onShowShortcuts={() => setShowShortcutsModal(true)}
                    onEditDraft={handleEditDraft}
                    onCompose={() => {
                      setComposerMode('compose');
                      setShowComposer(true);
                    }}
                    currentUserEmail={client?.getUsername()}
                    currentUserName={client?.getUsername()?.split("@")[0]}
                    currentMailboxRole={mailboxes.find(m => m.id === selectedMailbox)?.role}
                    mailboxes={mailboxes}
                    selectedMailbox={selectedMailbox}
                    onMoveToMailbox={async (mailboxId) => {
                      if (client && selectedEmail) {
                        await moveToMailbox(client, selectedEmail.id, mailboxId);
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

          {/* Bottom Navigation - mobile and tablet */}
          {(isMobile || isTablet) && activeView !== "viewer" && (
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
        <ConfirmDialog {...confirmDialogProps} />
        <TotpReauthDialog />
      </div>
    </DragDropProvider>
  );
}
