"use client";

import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { Sidebar } from "@/components/layout/sidebar";
import { EmailList } from "@/components/email/email-list";
import { EmailViewer } from "@/components/email/email-viewer";
import { EmailComposer } from "@/components/email/email-composer";
import type { ComposerDraftData } from "@/components/email/email-composer";
import { ThreadConversationView } from "@/components/email/thread-conversation-view";
import { MobileHeader, MobileViewerHeader } from "@/components/layout/mobile-header";
import { ThreadGroup, Email } from "@/lib/jmap/types";
import { KeyboardShortcutsModal } from "@/components/keyboard-shortcuts-modal";
import { useEmailStore } from "@/stores/email-store";
import { useAuthStore } from "@/stores/auth-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useIdentityStore } from "@/stores/identity-store";
import { useUIStore } from "@/stores/ui-store";
import { useDeviceDetection } from "@/hooks/use-media-query";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
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
import { DragDropProvider } from "@/contexts/drag-drop-context";
import { isFilterEmpty, activeFilterCount } from "@/lib/jmap/search-utils";
import { WelcomeBanner } from "@/components/ui/welcome-banner";
import { NavigationRail } from "@/components/layout/navigation-rail";
import { Input } from "@/components/ui/input";
import { Search, Filter, ChevronDown, X, Paperclip, Star, Mail, MailOpen, RotateCcw, PenSquare, PenLine } from "lucide-react";
import { ResizeHandle } from "@/components/layout/resize-handle";
import { Button } from "@/components/ui/button";

export default function Home() {
  const router = useRouter();
  const t = useTranslations();
  const tCommon = useTranslations('common');
  const [showComposer, setShowComposer] = useState(false);
  const [composerMode, setComposerMode] = useState<'compose' | 'reply' | 'replyAll' | 'forward'>('compose');
  const [composerDraftText, setComposerDraftText] = useState("");
  const [pendingDraft, setPendingDraft] = useState<ComposerDraftData | null>(null);
  const { dialogProps: confirmDialogProps, confirm: confirmDialog } = useConfirmDialog();
  const [initialCheckDone, setInitialCheckDone] = useState(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const [showAdvancedFields, setShowAdvancedFields] = useState(false);
  // Mobile conversation view state
  const [conversationThread, setConversationThread] = useState<ThreadGroup | null>(null);
  const [conversationEmails, setConversationEmails] = useState<Email[]>([]);
  const [isLoadingConversation, setIsLoadingConversation] = useState(false);
  const markAsReadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { isAuthenticated, client, logout, checkAuth, isLoading: authLoading } = useAuthStore();
  const { identities } = useIdentityStore();

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
    selectAllEmails,
    clearSelection,
    fetchMailboxes,
    fetchEmails,
    fetchQuota,
    sendEmail,
    deleteEmail,
    markAsRead,
    toggleStar,
    moveToMailbox,
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
  } = useEmailStore();

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
    let title = tCommon('app_title');

    if (showComposer) {
      // Composing email
      const modeText = {
        compose: t('email_composer.new_message'),
        reply: t('email_composer.reply'),
        replyAll: t('email_composer.reply_all'),
        forward: t('email_composer.forward'),
      }[composerMode] || t('email_composer.new_message');
      title = `${modeText} - ${tCommon('app_title')}`;
    } else if (selectedEmail) {
      // Reading email
      const subject = selectedEmail.subject || t('email_viewer.no_subject');
      title = `${subject} - ${tCommon('app_title')}`;
    } else if (selectedMailbox && mailboxes.length > 0) {
      // Mailbox view
      const mailbox = mailboxes.find(mb => mb.id === selectedMailbox);
      if (mailbox) {
        const mailboxName = mailbox.name;
        const unreadCount = mailbox.unreadEmails || 0;
        title = unreadCount > 0
          ? `${mailboxName} (${unreadCount}) - ${tCommon('app_title')}`
          : `${mailboxName} - ${tCommon('app_title')}`;
      }
    }

    document.title = title;
  }, [showComposer, composerMode, selectedEmail, selectedMailbox, mailboxes, t, tCommon]);

  // Check auth on mount
  useEffect(() => {
    checkAuth().finally(() => {
      setInitialCheckDone(true);
    });
  }, [checkAuth]);

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
      router.push('/login');
    }
  }, [initialCheckDone, isAuthenticated, authLoading, router]);

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

          // Setup push notifications after successful data load
          try {
            // Register state change callback
            client.onStateChange((change) => handleStateChange(change, client));

            // Start receiving push notifications
            const pushEnabled = client.setupPushNotifications();

            if (pushEnabled) {
              setPushConnected(true);
              debug.log('[Push] Push notifications successfully enabled');
            } else {
              debug.log('[Push] Push notifications not available on this server');
            }
          } catch (error) {
            // Push notifications are optional - don't break the app if they fail
            debug.log('[Push] Failed to setup push notifications:', error);
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
  }, [isAuthenticated, client, mailboxes.length, fetchMailboxes, fetchEmails, fetchQuota, handleStateChange, setPushConnected]);

  // Handle mark-as-read with delay based on settings
  useEffect(() => {
    // Clear any existing timeout when email changes
    if (markAsReadTimeoutRef.current) {
      debug.log('[Mark as Read] Clearing previous timeout');
      clearTimeout(markAsReadTimeoutRef.current);
      markAsReadTimeoutRef.current = null;
    }

    // Only set timeout if there's a selected email, it's unread, and we have a client
    if (!selectedEmail || !client || selectedEmail.keywords?.$seen) {
      return;
    }

    // Get current setting value
    const markAsReadDelay = useSettingsStore.getState().markAsReadDelay;
    debug.log('[Mark as Read] Delay setting:', markAsReadDelay, 'ms for email:', selectedEmail.id);

    if (markAsReadDelay === -1) {
      // Never mark as read automatically
      debug.log('[Mark as Read] Never mode - email will stay unread');
    } else if (markAsReadDelay === 0) {
      // Mark as read instantly
      debug.log('[Mark as Read] Instant mode - marking as read now');
      markAsRead(client, selectedEmail.id, true);
    } else {
      // Mark as read after delay
      debug.log('[Mark as Read] Delayed mode - will mark as read in', markAsReadDelay, 'ms');
      markAsReadTimeoutRef.current = setTimeout(() => {
        debug.log('[Mark as Read] Timeout fired - marking as read now');
        markAsRead(client, selectedEmail.id, true);
        markAsReadTimeoutRef.current = null;
      }, markAsReadDelay);
    }

    // Cleanup on unmount or when dependencies change
    return () => {
      if (markAsReadTimeoutRef.current) {
        debug.log('[Mark as Read] Cleanup - clearing timeout');
        clearTimeout(markAsReadTimeoutRef.current);
        markAsReadTimeoutRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmail?.id]);

  // Handle new email notifications - play sound
  useEffect(() => {
    if (newEmailNotification) {
      playNotificationSound();
      debug.log('New email received:', newEmailNotification.subject);
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
    draftId?: string;
    fromEmail?: string;
    fromName?: string;
    identityId?: string;
  }) => {
    if (!client) return;

    try {
      await sendEmail(client, data.to, data.subject, data.body, data.cc, data.bcc, data.identityId, data.fromEmail, data.draftId, data.fromName);
      setShowComposer(false);

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

  const handleDelete = async () => {
    if (!client || !selectedEmail) return;

    try {
      await deleteEmail(client, selectedEmail.id);
      selectEmail(null);
    } catch (error) {
      console.error("Failed to delete email:", error);
    }
  };

  const handleArchive = async () => {
    if (!client || !selectedEmail) return;

    // Find archive mailbox
    const archiveMailbox = mailboxes.find(m => m.role === "archive" || m.name.toLowerCase() === "archive");
    if (archiveMailbox) {
      try {
        await moveToMailbox(client, selectedEmail.id, archiveMailbox.id);
        selectEmail(null);
      } catch (error) {
        console.error("Failed to archive email:", error);
      }
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

  const handleMarkAsSpam = async () => {
    if (!client || !selectedEmail) return;

    const emailId = selectedEmail.id;

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

  const handleUndoSpam = async () => {
    if (!client || !selectedEmail) return;

    try {
      await undoSpam(client, selectedEmail.id);

      const toastInstance = (await import('sonner')).toast;
      toastInstance.success(t('email_viewer.spam.toast_not_spam_success'));

      // Deselect email after moving it out of junk
      selectEmail(null);
    } catch (_error) {
      console.error("Failed to restore email:", _error);
      const toastInstance = (await import('sonner')).toast;
      toastInstance.error(t('email_viewer.spam.error_not_spam'));
    }
  };

  const handleSetColorTag = async (emailId: string, color: string | null) => {
    if (!client) return;

    try {
      // Remove any existing color tags
      const email = emails.find(e => e.id === emailId);
      if (!email) return;

      const keywords = { ...email.keywords };

      // Remove old color tags - set to false for JMAP to remove them
      Object.keys(keywords).forEach(key => {
        if (key.startsWith("$color:")) {
          keywords[key] = false;
        }
      });

      // Add new color tag if specified
      if (color) {
        keywords[`$color:${color}`] = true;
      }

      // Update email keywords via JMAP
      await client.updateEmailKeywords(emailId, keywords);

      // Update local state
      selectEmail(email.id === selectedEmail?.id ? { ...email, keywords } : selectedEmail);

      // Refresh emails list to show color in list
      await fetchEmails(client, selectedMailbox);
    } catch (error) {
      console.error("Failed to set color tag:", error);
    }
  };

  const handleMailboxSelect = async (mailboxId: string) => {
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

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

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
    if (client && selectedMailbox) {
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

  const handleDownloadAttachment = async (blobId: string, name: string, type?: string) => {
    if (!client) return;

    try {
      await client.downloadBlob(blobId, name, type);
    } catch (error) {
      console.error("Failed to download attachment:", error);
    }
  };

  const handleQuickReply = async (body: string) => {
    if (!client || !selectedEmail) return;

    const sender = selectedEmail.from?.[0];
    if (!sender?.email) {
      throw new Error("No sender email found");
    }

    const primaryIdentity = identities[0];

    // Send reply with just the body text
    await sendEmail(
      client,
      [sender.email],
      `Re: ${selectedEmail.subject || "(no subject)"}`,
      body,
      undefined,
      undefined,
      primaryIdentity?.id,
      primaryIdentity?.email,
      undefined,
      primaryIdentity?.name || undefined
    );

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
      // Find selected mailbox to determine accountId (for shared folders)
      const mailbox = mailboxes.find(mb => mb.id === selectedMailbox);
      // Only pass accountId for shared mailboxes
      const accountId = mailbox?.isShared ? mailbox.accountId : undefined;

      const fullEmail = await client.getEmail(email.id, accountId);
      if (fullEmail) {
        selectEmail(fullEmail);
        // Mark-as-read logic is now handled by useEffect
      }
    } catch (error) {
      console.error('Failed to fetch email content:', error);
    } finally {
      setLoadingEmail(false);
    }
  };

  // Handle back navigation from viewer on mobile
  const handleMobileBack = () => {
    // If in conversation view, clear it
    if (conversationThread) {
      setConversationThread(null);
      setConversationEmails([]);
    }
    selectEmail(null);
    setActiveView("list");
  };

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

  return (
    <DragDropProvider>
      <div className="flex h-screen bg-background overflow-hidden">
        {/* Desktop Navigation Rail */}
        {!isMobile && !isTablet && (
          <div className="w-14 border-r border-border bg-secondary flex flex-col flex-shrink-0">
            <NavigationRail
              collapsed
              quota={quota}
              isPushConnected={isPushConnected}
              onLogout={handleLogout}
            />
          </div>
        )}

        {/* Mobile/Tablet Sidebar Overlay Backdrop */}
        {(isMobile || isTablet) && sidebarOpen && (
          <div
            className="fixed inset-0 bg-black/50 z-40 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar - overlay on mobile/tablet, fixed on desktop */}
        <div
          className={cn(
            "flex-shrink-0 h-full z-50 transition-[width] duration-300",
            // Mobile/Tablet: fixed overlay
            "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:w-72",
            "max-lg:transform max-lg:transition-transform max-lg:duration-300 max-lg:ease-in-out",
            !sidebarOpen && "max-lg:-translate-x-full",
            // Desktop: normal flow
            "lg:relative lg:translate-x-0"
          )}
          style={!isMobile && !isTablet ? { width: sidebarCollapsed ? 64 : sidebarWidth } : undefined}
        >
          <ErrorBoundary fallback={SidebarErrorFallback}>
            <Sidebar
              mailboxes={mailboxes}
              selectedMailbox={selectedMailbox}
              onMailboxSelect={handleMailboxSelect}
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
        {!isMobile && !isTablet && !sidebarCollapsed && (
          <ResizeHandle
            onResize={(delta) => setSidebarWidth(sidebarWidth + delta)}
            onResizeEnd={persistColumnWidths}
            onDoubleClick={resetSidebarWidth}
          />
        )}

        {/* Main Content Area */}
        <div className="flex flex-col flex-1 min-w-0 h-full">
          <div className="flex flex-1 min-h-0">
          {/* Email List - full width on mobile, fixed width on tablet/desktop */}
          <div
            className={cn(
              "relative flex flex-col h-full bg-background border-r border-border",
              // Mobile: full width, hidden when viewing email
              "max-md:flex-1 max-md:border-r-0",
              isMobile && activeView !== "list" && "max-md:hidden",
              // Tablet/Desktop: fixed width with collapse animation
              "md:flex-shrink-0 md:shadow-sm",
              "transition-all duration-200 ease-out",
              // Tablet: collapse when email selected
              isTablet && !tabletListVisible && "md:w-0 md:opacity-0 md:overflow-hidden md:border-r-0"
            )}
            style={!isMobile && !(isTablet && !tabletListVisible) ? { width: emailListWidth } : undefined}
          >
            {/* Mobile Header for List View */}
            <MobileHeader
              title={currentMailboxName}
            />

            {/* Search Bar + Inline Advanced Filters */}
            <div className="border-b border-border bg-background">
              <div className="px-3 py-3">
                <div className="flex items-center gap-1.5">
                  <form onSubmit={(e) => { e.preventDefault(); if (searchQuery.trim()) handleSearch(searchQuery); }} className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      type="text"
                      placeholder={t("sidebar.search_placeholder_hint")}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className={cn("pl-9 h-9", searchQuery && "pr-8")}
                      data-search-input
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
                    className={cn(
                      "relative flex-shrink-0 p-2 rounded-md transition-colors",
                      isAdvancedSearchOpen || activeFilterCount(searchFilters) > 0
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    )}
                    title={t("advanced_search.toggle_filters")}
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
                  selectEmail(email);
                  await handleDelete();
                }}
                onArchive={async (email) => {
                  selectEmail(email);
                  await handleArchive();
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
                  selectEmail(email);
                  await handleMarkAsSpam();
                }}
                onUndoSpam={async (email) => {
                  selectEmail(email);
                  await handleUndoSpam();
                }}
                className="flex-1 min-h-0"
              />
            </ErrorBoundary>
            </div>

            {/* Floating Compose Button (mobile) */}
            {isMobile && (
              <Button
                onClick={() => {
                  setComposerMode('compose');
                  setShowComposer(true);
                  setActiveView('viewer');
                }}
                className="absolute bottom-4 right-4 z-40 h-14 w-14 rounded-full shadow-lg"
                aria-label={t('sidebar.compose')}
              >
                <PenSquare className="h-6 w-6" />
              </Button>
            )}
          </div>

          {/* Email list resize handle (desktop only) */}
          {!isMobile && !isTablet && (
            <ResizeHandle
              onResize={(delta) => setEmailListWidth(emailListWidth + delta)}
              onResizeEnd={persistColumnWidths}
              onDoubleClick={resetEmailListWidth}
            />
          )}

          {/* Email Viewer / Composer - full screen on mobile, flex on tablet/desktop */}
          <div
            className={cn(
              "flex flex-col h-full bg-background",
              // Mobile: full screen overlay when active
              "max-md:fixed max-md:inset-0 max-md:z-30",
              isMobile && activeView !== "viewer" && "max-md:hidden",
              // Tablet/Desktop: flex grow, min-w-0 allows truncation of long subjects
              "md:flex-1 md:min-w-0 md:relative"
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
                  mode={pendingDraft?.mode ?? composerMode}
                  replyTo={pendingDraft?.replyTo ?? (selectedEmail ? {
                    from: selectedEmail.from,
                    to: selectedEmail.to,
                    cc: selectedEmail.cc,
                    subject: selectedEmail.subject,
                    body: selectedEmail.bodyValues?.[selectedEmail.textBody?.[0]?.partId || '']?.value || selectedEmail.preview || '',
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
                    onArchive={handleArchive}
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
                    onBack={() => {
                      setTabletListVisible(true);
                      selectEmail(null);
                    }}
                    onShowShortcuts={() => setShowShortcutsModal(true)}
                    currentUserEmail={client?.["username"]}
                    currentUserName={client?.["username"]?.split("@")[0]}
                    currentMailboxRole={mailboxes.find(m => m.id === selectedMailbox)?.role}
                    className={isMobile ? "flex-1" : undefined}
                  />
                </ErrorBoundary>
              </>
            )}
            </>
            )}
          </div>
          </div>

          {/* Mobile Bottom Navigation */}
          {isMobile && activeView !== "viewer" && (
            <NavigationRail orientation="horizontal" />
          )}
        </div>

        {/* Keyboard Shortcuts Modal */}
        <KeyboardShortcutsModal
          isOpen={showShortcutsModal}
          onClose={() => setShowShortcutsModal(false)}
        />

        {/* Screen reader live region for dynamic status announcements */}
        <div className="sr-only" aria-live="polite" aria-atomic="true" id="sr-status" />

        <ConfirmDialog {...confirmDialogProps} />
      </div>
    </DragDropProvider>
  );
}
