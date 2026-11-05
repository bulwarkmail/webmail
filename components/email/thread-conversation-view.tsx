"use client";

import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from "react";
import DOMPurify from "dompurify";
import { Email, ThreadGroup } from "@/lib/jmap/types";
import { EMAIL_SANITIZE_CONFIG, TRANSPARENT_BLOCKED_PIXEL, blockExternalResourcesOnNode, collapseBlockedImageContainers, emailIframeCsp, isOpenableLinkHref, plainTextToSafeHtml, restrictDataUriResourcesOnNode, sanitizeEmailBodyForIframe, sanitizePlainTextRenderedHtml } from "@/lib/email-sanitization";
import { gateLinkClick, linkCheckActive, linkText, resolveExternalLink } from "@/lib/plugin-hook-result";
import { stripBidiControls } from "@/lib/bidi";
import { requestInternalMailto } from "@/lib/protocol-handlers/mailto";
import { emailDisplayDate } from "@/lib/email-date";
import { getRenderableHtmlBody } from "@/lib/email-body-selection";
import { findVerificationCode, verificationCodeBodyText } from "@/lib/verification-code";
import { VerificationCodeChip } from "./verification-code-chip";
import { StructuredMailCards } from "./structured-mail/structured-mail-cards";
import { BookingCalendarActions } from "./structured-mail/booking-calendar-actions";
import { useStructuredMail } from "./structured-mail/use-structured-mail";
import { attachmentIcon } from "./attachment-chips";
import { ExternalSenderChip } from "./external-sender-chip";
import { ReceivedLabelChip } from "./received-label-chip";
import { collectReferencedCids, isEmbeddedInBody, isReportPart, normalizeCid, rewriteCidReferences } from "@/lib/attachment-visibility";
import { collapsePlainTextQuotes, setupQuoteCollapse } from "@/lib/quote-collapse";
import { measureEmailFrameHeight } from "@/lib/email-frame-height";
import { forwardFrameKeys } from "@/lib/email-frame-keys";
import { fitEmailBodyWidth } from "@/lib/email-fit-width";
import { mailLanguage } from "@/lib/mail-language";
import { htmlToReadableText } from "@/lib/html-to-readable-text";
import { pauseAnimatedImages } from "@/lib/animated-images";
import { applyMailTextSize, mailFitOptions } from "@/lib/mail-reading";
import { useMailReading } from "@/hooks/use-mail-reading";
import { DARK_PENDING_CLASS, applyEmailDarkMode, emailDarkModeCss } from "@/lib/email-dark-mode";
import { useThemeStore } from "@/stores/theme-store";
import { useShallow } from "zustand/react/shallow";
import { Avatar } from "@/components/ui/avatar";
import { useSenderWarning } from "@/hooks/use-sender-warning";
import { brandIndicatorDomain } from "@/lib/email-headers";
import { Button } from "@/components/ui/button";
import { formatDate, formatFileSize, cn, cleanPreview } from "@/lib/utils";
import { IconButton } from "@/components/ui/icon-button";
import { MailConversationSkeleton } from "@/components/boot-skeleton/mail-skeleton";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Reply,
  ReplyAll,
  Forward,
  Paperclip,
  Star,
  Download,
  Eye,
  CalendarClock,
  Pencil,
  Trash2,
} from "@/components/icons";
import { formatScheduledSendAt } from "@/lib/scheduled-send-label";
import { useTranslations } from "next-intl";
import { FilePen } from "@/components/icons";
import { editAccountOf, useEditAttachment } from "@/hooks/use-edit-attachment";
import { useSettingsStore } from "@/stores/settings-store";
import { useContactStore } from "@/stores/contact-store";
import { useEmailStore, resolveEmailBlobContext, type EmailBlobContext } from "@/stores/email-store";
import { useAuthStore } from "@/stores/auth-store";
import { useIdentityStore } from "@/stores/identity-store";
import { useAccountStore } from "@/stores/account-store";
import { isSelfSent, ownReplyAddresses } from "@/lib/reply-recipients";
import { isFilePreviewable, toInertBlob } from "@/lib/file-preview";
import { useWopiStatus, canWopiOpen } from "@/hooks/use-wopi-status";
import { useOwnDomainAddress } from "@/hooks/use-own-domain-address";
import { emitThreadExpand } from "@/lib/plugin-thread-expand";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import { ReaderSelectionMenu, useReaderSelectionMenu, watchBodySelection } from "./reader-selection-menu";
import { PluginActions, useMessageActionTarget } from "@/components/plugins/plugin-actions";
import { usePluginSlotOffers } from "@/hooks/use-plugin-slot-offers";
import { useDeviceDetection } from "@/hooks/use-media-query";
import { usePluginRenderedBody } from "@/hooks/use-plugin-rendered-body";
import { emailToReadView } from "@/lib/plugin-projection";
import { AttachmentPluginMenu, ReaderAboveQuoteSlot } from "./reader-plugin-surfaces";
import { useRemoteContentBlockedByOrg, useRemoteContentChecks } from "@/hooks/use-third-party-mode";
import { ConversationHeaderActions, type ConversationActions } from "./conversation-header-actions";
import { PhishingMarkBanner } from "./phishing-mark-banner";
import { turnOffLinks } from "@/lib/phishing-links";
import { usePhishingMarked } from "@/hooks/use-phishing-report";
import { useDevicePolicy } from "@/hooks/use-device-policy";
import { Watermark, useWatermarkText } from "@/components/device/watermark";
import { NO_SAVE_MEDIA_CSS, blockMediaSaving } from "@/lib/device-frame";

export type ConversationAttachmentHandler = (
  blobId: string, name: string, type: string | undefined, source: EmailBlobContext,
) => void;

interface ThreadConversationViewProps {
  thread: ThreadGroup;
  emails: Email[];
  isLoading?: boolean;
  onBack: () => void;
  onReply?: (email: Email) => void;
  onReplyAll?: (email: Email) => void;
  onForward?: (email: Email) => void;
  /** A draft in the conversation (compose-p2-6): Edit and Discard take Reply's place. */
  onEditDraft?: (email: Email) => void;
  onDiscardDraft?: (email: Email) => void;
  onDownloadAttachment?: ConversationAttachmentHandler;
  /** Routing captured when this conversation was opened. */
  blobSource?: EmailBlobContext;
  onMarkAsRead?: (emailId: string, read: boolean) => void;
  /** Role of the folder the conversation was opened from, for plugin actions limited to some folders. */
  mailboxRole?: string | null;
  /**
   * The conversation's actions in the header, on its newest message as the
   * list row offers them: Archive, Delete, Move and ⋮ with the rest.
   */
  actions?: ConversationActions;
}

/**
 * Whether a conversation message may load remote content: the user's policy,
 * a trusted sender, or a one-off "load" for that message.
 */
export function useConversationExternalContent() {
  const externalContentPolicy = useSettingsStore((state) => state.externalContentPolicy);
  const addTrustedSender = useSettingsStore((state) => state.addTrustedSender);
  const isSenderTrusted = useSettingsStore((state) => state.isSenderTrusted);
  const trustedSendersAddressBook = useSettingsStore((state) => state.trustedSendersAddressBook);
  const isTrustedAddressBookSender = useContactStore((state) => state.isTrustedAddressBookSender);
  const addToTrustedSendersBook = useContactStore((state) => state.addToTrustedSendersBook);
  const { client } = useAuthStore(useShallow((state) => ({ client: state.client })));
  const [allowedIds, setAllowedIds] = useState<Set<string>>(new Set());
  // No third-party traffic (#903), or the organisation locked "block" for
  // the message's own account: nothing remote loads and nothing offers to.
  // Also held back until that account's policy is known.
  const remoteContent = useRemoteContentChecks();

  const allow = useCallback((emailId: string) => {
    setAllowedIds(prev => new Set(prev).add(emailId));
  }, []);

  const isAllowed = (email: Email) => {
    const senderEmail = email.from?.[0]?.email?.toLowerCase();
    const senderIsTrusted = senderEmail
      ? isSenderTrusted(senderEmail) || (trustedSendersAddressBook && isTrustedAddressBookSender(senderEmail))
      : false;
    if (remoteContent.heldBack(email.sourceClientAccountId)) return false;
    return externalContentPolicy === 'allow' || !!senderIsTrusted || allowedIds.has(email.id);
  };

  const trustSender = (email: Email) => {
    const senderEmail = email.from?.[0]?.email?.toLowerCase();
    if (!senderEmail || remoteContent.blockedByOrg(email.sourceClientAccountId)) return undefined;
    return () => {
      if (trustedSendersAddressBook && client) {
        addToTrustedSendersBook(client, senderEmail).catch(console.error);
      } else {
        addTrustedSender(senderEmail);
      }
      allow(email.id);
    };
  };

  return { isAllowed, allow, trustSender };
}

/**
 * Starts the "mark as read" timer for an unread message while it is shown,
 * following the user's mark-as-read delay.
 */
export function useMarkReadWhenShown(
  email: Email,
  shown: boolean,
  onMarkAsRead?: (emailId: string, read: boolean) => void,
) {
  useEffect(() => {
    if (!shown || !onMarkAsRead || email.keywords?.$seen) {
      return;
    }

    const markAsReadDelay = useSettingsStore.getState().markAsReadDelay;

    // Never auto-mark
    if (markAsReadDelay === -1) {
      return;
    }

    // Instant mark
    if (markAsReadDelay === 0) {
      onMarkAsRead(email.id, true);
      return;
    }

    // Delayed mark
    const timeout = setTimeout(() => {
      onMarkAsRead(email.id, true);
    }, markAsReadDelay);

    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new handler identity must not restart the timer
  }, [shown, email.id, email.keywords?.$seen]);
}

export function ThreadConversationView({
  thread,
  emails,
  isLoading = false,
  onBack,
  onReply,
  onReplyAll,
  onForward,
  onEditDraft,
  onDiscardDraft,
  onDownloadAttachment,
  blobSource,
  onMarkAsRead,
  mailboxRole,
  actions,
}: ThreadConversationViewProps) {
  const t = useTranslations();
  const externalContent = useConversationExternalContent();
  // Oldest first, the newest at the bottom, as on every other layout and in
  // Gmail (mail-p2-6). The thread arrives newest first.
  const ordered = useMemo(() => oldestFirst(emails), [emails]);
  const newestId = newestReadable(ordered)?.id ?? null;
  const emailIdList = ordered.map((email) => email.id).join(',');
  // Your own messages say "me" while folded, as Gmail and Apple Mail do (mail-p3-15).
  const identities = useIdentityStore((s) => s.identities);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const account = useAccountStore((s) => (activeAccountId ? s.getAccountById(activeAccountId) : undefined));
  const ownEmails = useMemo(
    () => ownReplyAddresses(identities.map((i) => i.email), [account?.email, account?.username]),
    [identities, account?.email, account?.username],
  );
  const { isMobile: summaryOnPhone, isCompact: summaryOnTablet } = useDeviceDetection();
  const threadSummaryProps = useMemo(
    () => ({ threadId: thread.latestEmail.threadId ?? null, emailIds: emailIdList ? emailIdList.split(',') : [], deviceType: summaryOnPhone ? 'mobile' : summaryOnTablet ? 'tablet' : 'desktop' }),
    [thread.latestEmail.threadId, emailIdList, summaryOnPhone, summaryOnTablet],
  );

  // Track which emails are expanded (most recent by default)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const cardsRef = useRef<HTMLDivElement>(null);
  const scrolledThreadRef = useRef<string | null>(null);

  // Auto-expand the newest email (your own reply too) AND all unread emails
  // when the thread opens.
  useEffect(() => {
    if (ordered.length > 0) {
      const idsToExpand = new Set<string>();

      if (newestId) idsToExpand.add(newestId);

      // Also expand all unread emails
      ordered.forEach(email => {
        if (!email.keywords?.$seen && !email.keywords?.$draft) {
          idsToExpand.add(email.id);
        }
      });

      setExpandedIds(idsToExpand);
    }
  }, [ordered, newestId]);

  // Once per conversation, show the newest message: it is at the bottom.
  useEffect(() => {
    const threadId = ordered[0]?.threadId ?? null;
    if (!newestId || !threadId || scrolledThreadRef.current === threadId) return;
    scrolledThreadRef.current = threadId;
    const frame = requestAnimationFrame(() => {
      cardsRef.current?.querySelector<HTMLElement>(`[data-thread-email-id="${CSS.escape(newestId)}"]`)?.scrollIntoView?.({ block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [ordered, newestId]);

  const toggleExpanded = (emailId: string) => {
    const target = ordered.find((e) => e.id === emailId);
    if (target) emitThreadExpand(target.threadId, [target], !expandedIds.has(emailId));
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(emailId)) {
        next.delete(emailId);
      } else {
        next.add(emailId);
      }
      return next;
    });
  };

  if (isLoading) {
    // The conversation's shape (the page skeleton's), with one status message.
    return (
      <div className="flex flex-col h-full bg-background" aria-busy="true">
        <span role="status" className="sr-only">{t("threads.loading")}</span>
        <MailConversationSkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center px-4 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 sticky top-0 z-10" style={{ gap: 'var(--density-item-gap)', paddingBlock: 'var(--density-header-py)' }}>
        <IconButton size="icon-lg" className="-ms-2 flex-shrink-0" onClick={onBack} label={t('email_viewer.back_to_list')}>
          <ArrowLeft />
        </IconButton>
        <div className="flex-1 min-w-0">
          {/* Two lines at most, so a long subject leaves the actions their room. */}
          <h2 className="font-semibold text-foreground break-words line-clamp-2" dir="auto" title={thread.latestEmail.subject || undefined}>
            {thread.latestEmail.subject || t("email_viewer.no_subject")}
          </h2>
          <p className="truncate text-xs sm:text-sm text-muted-foreground">
            {t("threads.messages_count", { count: emails.length })}
          </p>
        </div>
        {actions && <ConversationHeaderActions email={thread.latestEmail} actions={actions} />}
      </div>

      {/* Email Cards */}
      <div className="flex-1 overflow-y-auto">
        <PluginSlot name="thread-summary" className="w-full" extraProps={threadSummaryProps} />
        <div ref={cardsRef} className="space-y-3" style={{ padding: 'var(--density-card-p)' }}>
          {ordered.map((email) => {
            const draft = !!email.keywords?.$draft;
            return (
            <div key={email.id} data-thread-email-id={email.id} className="scroll-mt-16">
            <EmailCard
              email={email}
              isExpanded={expandedIds.has(email.id)}
              isLatest={email.id === newestId}
              isOwn={isSelfSent(email, ownEmails)}
              allowExternal={externalContent.isAllowed(email)}
              onToggleExpanded={() => toggleExpanded(email.id)}
              onAllowExternal={() => externalContent.allow(email.id)}
              onTrustSender={externalContent.trustSender(email)}
              isDraft={draft}
              onEditDraft={draft && onEditDraft ? () => onEditDraft(email) : undefined}
              onDiscardDraft={draft && onDiscardDraft ? () => onDiscardDraft(email) : undefined}
              onReply={!draft && onReply ? () => onReply(email) : undefined}
              onReplyAll={!draft && onReplyAll ? () => onReplyAll(email) : undefined}
              onForward={!draft && onForward ? () => onForward(email) : undefined}
              onDownloadAttachment={onDownloadAttachment}
            blobSource={blobSource}
              onMarkAsRead={onMarkAsRead}
              mailboxRole={mailboxRole}
            />
            </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** A conversation's messages from the oldest to the newest. */
export function oldestFirst(emails: Email[]): Email[] {
  return [...emails].sort((a, b) => (Date.parse(a.receivedAt) || 0) - (Date.parse(b.receivedAt) || 0));
}

/** The newest message that isn't a draft or waiting to be sent. */
export function newestReadable(ordered: Email[]): Email | undefined {
  for (let i = ordered.length - 1; i >= 0; i--) {
    const e = ordered[i];
    if (!e.keywords?.$draft && !e.isScheduled) return e;
  }
  return ordered[ordered.length - 1];
}

// Individual email card component
interface EmailCardProps {
  email: Email;
  isExpanded: boolean;
  isLatest: boolean;
  /** Sent by the user: "me" on the folded card. */
  isOwn?: boolean;
  allowExternal: boolean;
  onToggleExpanded: () => void;
  onAllowExternal: () => void;
  onTrustSender?: () => void;
  onReply?: () => void;
  onReplyAll?: () => void;
  onForward?: () => void;
  isDraft?: boolean;
  onEditDraft?: () => void;
  onDiscardDraft?: () => void;
  onDownloadAttachment?: ConversationAttachmentHandler;
  /** Routing captured when this conversation was opened. */
  blobSource?: EmailBlobContext;
  onMarkAsRead?: (emailId: string, read: boolean) => void;
  mailboxRole?: string | null;
}

/**
 * The single reader's plugin surfaces for one message of the phone
 * conversation, mounted only while the message is unfolded: reader-header
 * on top, reader-below-subject and email-banner under the sender,
 * email-footer under the body. The props are the same as in the single
 * reader and stay stable across re-renders.
 */
function useConversationPluginProps(email: Email) {
  const headerOffers = usePluginSlotOffers('reader-header').length;
  const belowSubjectOffers = usePluginSlotOffers('reader-below-subject').length;
  const bannerOffers = usePluginSlotOffers('email-banner').length;
  const wantsView = headerOffers + belowSubjectOffers + bannerOffers > 0;
  const { isMobile, isCompact } = useDeviceDetection();
  const deviceType = isMobile ? 'mobile' : isCompact ? 'tablet' : 'desktop';
  const emailProps = useMemo(() => ({ email: wantsView ? emailToReadView(email) : null, deviceType }), [email, wantsView, deviceType]);
  const idProps = useMemo(() => ({ emailId: email.id }), [email.id]);
  const actionTarget = useMessageActionTarget(email);
  return { emailProps, idProps, actionTarget };
}

function EmailCard({
  email,
  isExpanded,
  isLatest: _isLatest,
  isOwn = false,
  allowExternal,
  onToggleExpanded,
  onAllowExternal,
  onTrustSender,
  onReply,
  onReplyAll,
  onForward,
  isDraft = false,
  onEditDraft,
  onDiscardDraft,
  onDownloadAttachment,
  blobSource,
  onMarkAsRead,
  mailboxRole,
}: EmailCardProps) {
  const t = useTranslations();
  const density = useSettingsStore((state) => state.density);
  const timeFormat = useSettingsStore((state) => state.timeFormat);
  const plugin = useConversationPluginProps(email);
  const sender = email.from?.[0];
  const senderWarning = useSenderWarning(email);
  const formatAddress = useOwnDomainAddress();
  const isUnread = !email.keywords?.$seen;
  const isStarred = email.keywords?.$flagged;

  // Mark as read when email is expanded
  useMarkReadWhenShown(email, isExpanded, onMarkAsRead);

  return (
    <div className={cn(
      "rounded-lg border border-border overflow-hidden transition-all duration-200",
      isExpanded ? "bg-background shadow-sm" : "bg-muted/30",
      isUnread && !isExpanded && "start-bar border-s-transparent [--start-bar-width:2px] [--start-bar:var(--color-primary)]"
    )}>
      {isExpanded && <PluginSlot name="reader-header" className="w-full" extraProps={plugin.emailProps} />}
      {/* Card Header - Always visible */}
      <button
        onClick={onToggleExpanded}
        aria-expanded={isExpanded}
        className={cn(
          "w-full flex items-start text-start transition-colors",
          !isExpanded && "hover:bg-muted/50"
        )}
        style={{ gap: 'var(--density-item-gap)', padding: 'var(--density-card-p)' }}
      >
        {density !== 'extra-compact' && (
          <Avatar
            name={sender?.name}
            email={sender?.email}
            size="md"
            className="flex-shrink-0"
            senderWarning={senderWarning}
            brandDomain={brandIndicatorDomain(email)}
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span dir="auto" data-conversation-sender="" className={cn(
              "font-medium truncate",
              isUnread ? "text-foreground" : "text-muted-foreground"
            )} title={isOwn && !isExpanded ? (sender?.name || sender?.email) : undefined}>
              {isOwn && !isExpanded
                ? t('email_viewer.recipient_me')
                : sender?.name || (sender?.email && formatAddress(sender.email)) || t('email_viewer.unknown_sender')}
            </span>
            <ExternalSenderChip from={email.from} accountId={email.sourceClientAccountId} interactive={false} />
            <ReceivedLabelChip email={email} />
            {isDraft && (
              <span data-testid="conversation-draft-label" className="text-xs font-medium text-destructive shrink-0">
                {t('email_list.draft')}
              </span>
            )}
            {email.isScheduled && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary shrink-0">
                <CalendarClock className="w-3.5 h-3.5" />
                {t('sidebar.scheduled')}
              </span>
            )}
            {isStarred && (
              <Star className="w-4 h-4 fill-amber-400 text-amber-400 flex-shrink-0" />
            )}
            {email.hasAttachment && (
              <Paperclip className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            )}
          </div>
          <div className="text-sm text-muted-foreground">
            {email.isScheduled && email.scheduledSendAt ? (
              <span className="text-primary font-medium inline-flex items-center gap-1">
                <CalendarClock className="w-3.5 h-3.5" />
                {formatScheduledSendAt(email.scheduledSendAt, timeFormat)}
              </span>
            ) : (
              formatDate(emailDisplayDate(email))
            )}
          </div>
          {!isExpanded && density !== 'extra-compact' && (
            <p dir="auto" className="text-sm text-muted-foreground mt-1 line-clamp-2">
              {cleanPreview(email.preview) || t('email_viewer.no_preview_available')}
            </p>
          )}
        </div>
        <div className="flex-shrink-0 p-1">
          {isExpanded ? (
            <ChevronUp className="w-5 h-5 text-muted-foreground" />
          ) : (
            <ChevronDown className="w-5 h-5 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="border-t border-border animate-in slide-in-from-top-2 duration-200">
          {email.isScheduled && (
            <div className="px-4 py-2 bg-primary/10 border-b border-border flex items-center gap-2 text-primary text-xs font-medium">
              <CalendarClock className="w-3.5 h-3.5 shrink-0" />
              <span>
                {t('email_viewer.scheduled_banner', { date: email.scheduledSendAt ? formatScheduledSendAt(email.scheduledSendAt, timeFormat) : '' })}
              </span>
            </div>
          )}
          <PluginSlot name="reader-below-subject" className="w-full" extraProps={plugin.emailProps} />
          <PluginSlot name="email-banner" className="w-full" extraProps={plugin.emailProps} />
          <ConversationEmailBody
            email={email}
            allowExternal={allowExternal}
            onAllowExternal={onAllowExternal}
            onTrustSender={onTrustSender}
            onDownloadAttachment={onDownloadAttachment}
            blobSource={blobSource}
          />
          <PluginSlot name="email-footer" className="w-full" extraProps={plugin.idProps} />

          {/* Action Buttons; plugin reader actions behind a "more" button, as
              in the single reader's More panel on phones. Long names (Arabic
              "Reply all") wrap to a second line instead of being cut. */}
          <div className="px-4 pb-4 flex flex-wrap gap-2">
            {onEditDraft && (
              <Button
                variant="outline"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onEditDraft();
                }}
                className="flex-auto px-2 whitespace-nowrap"
              >
                <Pencil className="w-4 h-4 me-1.5 shrink-0" />
                {t("email_viewer.edit_draft")}
              </Button>
            )}
            {onDiscardDraft && (
              <Button
                variant="outline"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onDiscardDraft();
                }}
                className="flex-auto px-2 whitespace-nowrap"
              >
                <Trash2 className="w-4 h-4 me-1.5 shrink-0" />
                {t("email_composer.discard")}
              </Button>
            )}
            {onReply && (
              <Button
                variant="outline"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onReply();
                }}
                className="flex-auto px-2 whitespace-nowrap"
              >
                <Reply className="w-4 h-4 me-1.5 shrink-0" />
                {t("email_viewer.reply")}
              </Button>
            )}
            {onReplyAll && (
              <Button
                variant="outline"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onReplyAll();
                }}
                className="flex-auto px-2 whitespace-nowrap"
              >
                <ReplyAll className="w-4 h-4 me-1.5 shrink-0" />
                {t("email_viewer.reply_all")}
              </Button>
            )}
            {onForward && (
              <Button
                variant="outline"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onForward();
                }}
                className="flex-auto px-2 whitespace-nowrap"
              >
                <Forward className="w-4 h-4 me-1.5 shrink-0" />
                {t("email_viewer.forward")}
              </Button>
            )}
            <PluginActions
              surface="reader-actions"
              context={plugin.idProps}
              target={plugin.actionTarget}
              mailboxRole={mailboxRole ?? null}
              overflow
              className="flex-shrink-0 rounded-md border border-border"
            />
          </div>
        </div>
      )}
    </div>
  );
}

interface ConversationEmailBodyProps {
  email: Email;
  allowExternal: boolean;
  onAllowExternal: () => void;
  onTrustSender?: () => void;
  onDownloadAttachment?: ConversationAttachmentHandler;
  /** Routing captured when this conversation was opened. */
  blobSource?: EmailBlobContext;
  /** Padding around the body; the phone card's density padding by default. */
  bodyStyle?: React.CSSProperties;
  className?: string;
}

/**
 * One conversation message's body: the remote-content banner, the sanitized
 * body in a sandboxed iframe and its attachments. Shared by the phone thread
 * view and Mountain View's expanded conversation messages.
 */
export function ConversationEmailBody({
  email,
  allowExternal: externalAllowed,
  onAllowExternal,
  onTrustSender,
  onDownloadAttachment,
  blobSource,
  bodyStyle,
  className,
}: ConversationEmailBodyProps) {
  const remoteBlockedByOrg = useRemoteContentBlockedByOrg(email.sourceClientAccountId);
  const t = useTranslations();
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const mailAttachmentAction = useSettingsStore((state) => state.mailAttachmentAction);
  // The device policies of the message's own account (Organisation > Devices).
  const devices = useDevicePolicy(email);
  const downloadsOffRef = useRef(devices.noDownloads);
  downloadsOffRef.current = devices.noDownloads;
  const watermark = useWatermarkText(email);
  const wopiStatus = useWopiStatus(true);
  const hideInlineImageAttachments = useSettingsStore((state) => state.hideInlineImageAttachments);
  const emailAlwaysLightMode = useSettingsStore((state) => state.emailAlwaysLightMode);
  const plainTextFont = useSettingsStore((state) => state.plainTextFont);
  const reading = useMailReading();
  // No dark recolouring in a forced-colours mode: the browser maps the mail
  // to the user's colours itself.
  const isDark = resolvedTheme === 'dark' && !emailAlwaysLightMode && !reading.forcedColors && !reading.overrideStyles;
  const appFontSources = reading.fontSources.join(' ');
  const showVerificationCodes = useSettingsStore((state) => state.showVerificationCodes);
  const verificationCode = useMemo(
    () => (showVerificationCodes ? findVerificationCode(email.subject, verificationCodeBodyText(email)) : null),
    // A keyword change replaces the email object; only another body needs another look.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showVerificationCodes, email.id, email.subject, email.bodyValues],
  );
  const [hasBlockedContent, setHasBlockedContent] = useState(false);
  const { client } = useAuthStore(useShallow((state) => ({
    client: state.client, revision: state.connectedAccountsRevision,
  })));
  const fallbackSource = useEmailStore(useShallow(() => resolveEmailBlobContext(email, client)));
  const source = blobSource ?? fallbackSource;
  const { client: blobClient, accountId } = source;
  const editAccount = source.clientAccountId ?? editAccountOf(email);
  const { canEdit: canEditAttachment, edit: editAttachment } = useEditAttachment(editAccount);
  // Reported as phishing: a banner, links off, no cards (as in the reader).
  const phishingMarked = usePhishingMarked(email);
  const tPhishing = useTranslations('phishing_report');
  // Booking, parcel and order cards; only an expanded message mounts this body.
  const structuredCards = useStructuredMail(phishingMarked ? null : email, source);
  // Local CID URLs belong to a particular client/owner/message/part list.
  // Hide the previous set during render, before the new fetch's effect runs.
  const cidRequest = useMemo(() => ({ blobClient, accountId, emailId: email.id, attachments: email.attachments }),
    [blobClient, accountId, email.id, email.attachments]);
  const [cidResult, setCidResult] = useState<{ request: typeof cidRequest; urls: Record<string, string> } | null>(null);
  const cidBlobUrls = useMemo(() => cidResult?.request === cidRequest ? cidResult.urls : {}, [cidResult, cidRequest]);
  // A crypto plugin's decrypted body (PGP, S/MIME) replaces the message's own.
  const pluginBody = usePluginRenderedBody(email);
  // The plugin can't vouch for its body: external content stays off, whatever was allowed.
  const allowExternal = externalAllowed && !pluginBody.blockExternal;
  // reader-above-quote: the body the quote was collapsed in, once it is on screen.
  const [htmlBodyEl, setHtmlBodyEl] = useState<HTMLElement | null>(null);
  const [plainBodyEl, setPlainBodyEl] = useState<HTMLDivElement | null>(null);
  const selectionMenu = useReaderSelectionMenu();
  const wantsQuoteSlot = usePluginSlotOffers('reader-above-quote').length > 0;
  const quoteSlotProps = useMemo(
    () => ({ email: wantsQuoteSlot ? emailToReadView(email) : null }),
    [email, wantsQuoteSlot],
  );

  // Fetch inline CID images with authentication to prevent browser auth dialogs
  useEffect(() => {
    if (!blobClient || !cidRequest.attachments) {
      setCidResult(null);
      return;
    }

    const cidAttachments = cidRequest.attachments.filter(att => att.cid && att.blobId);
    if (cidAttachments.length === 0) {
      setCidResult(null);
      return;
    }

    let cancelled = false;
    const objectUrls: string[] = [];

    async function fetchCidBlobs() {
      const urls: Record<string, string> = {};
      await Promise.all(cidAttachments.map(async (att) => {
        const cidValue = normalizeCid(att.cid!);
        try {
          // Re-type sender-declared script-bearing parts before they become a
          // blob: URL in our origin (GHSA-xvjh-v9c6-qcvc).
          const objectUrl = URL.createObjectURL(toInertBlob(await blobClient!.fetchBlob(att.blobId, att.name || 'inline', att.type, accountId)));
          if (!cancelled) {
            urls[cidValue] = objectUrl;
            objectUrls.push(objectUrl);
          } else {
            URL.revokeObjectURL(objectUrl);
          }
        } catch {
          // Failed to fetch inline image, will show placeholder
        }
      }));
      if (!cancelled) {
        setCidResult({ request: cidRequest, urls });
      }
    }

    fetchCidBlobs();

    return () => {
      cancelled = true;
      objectUrls.forEach(url => URL.revokeObjectURL(url));
    };
  }, [cidRequest, blobClient, accountId]);

  // Sanitize and prepare email HTML content
  const formattedContent = useMemo(() => {
    if (!email) return { html: "", isHtml: false };

    // Plugin-rendered bodies get the reader's sanitizer and remote-content
    // blocking, like any other mail body (#797).
    if (pluginBody.html) {
      const withCids = rewriteCidReferences(pluginBody.html, { ...cidBlobUrls, ...pluginBody.cidUrls }, TRANSPARENT_BLOCKED_PIXEL);
      const { html, blockedExternalContent } = sanitizeEmailBodyForIframe(withCids, !allowExternal);
      if (blockedExternalContent) {
        if (!hasBlockedContent) setHasBlockedContent(true);
        return { html: collapseBlockedImageContainers(html), isHtml: true };
      }
      return { html, isHtml: true };
    }
    if (pluginBody.text) {
      return {
        html: collapsePlainTextQuotes(plainTextToSafeHtml(pluginBody.text, 'text-primary hover:underline'), {
          show: t('email_viewer.show_quoted_text'),
          hide: t('email_viewer.hide_quoted_text'),
        }),
        isHtml: false,
      };
    }

    if (email.bodyValues) {
      let htmlContent = getRenderableHtmlBody(email);

      if (htmlContent) {
        // Replace cid: references with authenticated blob URLs (fetched via useEffect)
        // This prevents browser auth dialogs that occur when loading raw JMAP download URLs
        if (email.attachments) {
          htmlContent = rewriteCidReferences(htmlContent, cidBlobUrls, TRANSPARENT_BLOCKED_PIXEL);
        }

        let blockedExternalContent = false;

        // Use shared sanitization config as base (more secure)
        const sanitizeConfig = { ...EMAIL_SANITIZE_CONFIG };

        DOMPurify.addHook('afterSanitizeAttributes', (node) => {
          // Re-apply the data:-URI allowlist DOMPurify skips on media tags.
          restrictDataUriResourcesOnNode(node);

          // The desktop viewer's blocker: srcset, <source>, poster,
          // background attributes and escaped url()s as well as img src.
          if (!allowExternal && blockExternalResourcesOnNode(node)) {
            blockedExternalContent = true;
          }

          if (node.tagName === 'A' || node.tagName === 'AREA') {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
          }

        });

        const sanitized = DOMPurify.sanitize(htmlContent, sanitizeConfig);
        DOMPurify.removeHook('afterSanitizeAttributes');

        let finalHtml = sanitized;
        if (blockedExternalContent) {
          if (!hasBlockedContent) setHasBlockedContent(true);
          finalHtml = collapseBlockedImageContainers(sanitized);
        }

        return { html: finalHtml, isHtml: true };
      }

      // Plain text fallback
      if (email.textBody?.[0]?.partId && email.bodyValues[email.textBody[0].partId]) {
        const text = email.bodyValues[email.textBody[0].partId].value;
        return {
          // Trailing ">"-quoted block collapses behind a <details> toggle (#480).
          html: collapsePlainTextQuotes(plainTextToSafeHtml(text, 'text-primary hover:underline'), {
            show: t('email_viewer.show_quoted_text'),
            hide: t('email_viewer.hide_quoted_text'),
          }),
          isHtml: false,
        };
      }
    }

    // Fallback to preview
    if (email.preview) {
      const previewHtml = email.preview
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return { html: previewHtml, isHtml: false };
    }

    return { html: "", isHtml: false };
  // `hasBlockedContent` is only read to skip a redundant setState; as a
  // dependency it would re-run the sanitizer once the banner shows.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, allowExternal, cidBlobUrls, pluginBody, t]);

  // "Show mail as plain text" (Settings > Accessibility): the message's own
  // text/plain part, or a readable conversion of the HTML.
  const mailViewMode = useSettingsStore((state) => state.mailViewMode);
  const shownContent = useMemo(() => {
    if (mailViewMode !== 'plain' || !formattedContent.isHtml) return formattedContent;
    const textPart = !pluginBody.html ? email.textBody?.[0] : undefined;
    let text = textPart?.partId && textPart.partId !== email.htmlBody?.[0]?.partId && (textPart.type || 'text/plain').toLowerCase() === 'text/plain'
      ? email.bodyValues?.[textPart.partId]?.value ?? null
      : null;
    if (!text?.trim()) text = htmlToReadableText(formattedContent.html);
    return {
      html: collapsePlainTextQuotes(plainTextToSafeHtml(text, 'text-primary hover:underline'), {
        show: t('email_viewer.show_quoted_text'),
        hide: t('email_viewer.hide_quoted_text'),
      }),
      isHtml: false,
    };
  }, [mailViewMode, formattedContent, pluginBody.html, email, t]);
  const emailContent = useMemo(
    () => (phishingMarked ? { ...shownContent, html: turnOffLinks(shownContent.html, { title: tPhishing('link_off'), note: tPhishing('link_off_note') }) } : shownContent),
    [shownContent, phishingMarked, tPhishing],
  );

  // Parts the body embeds via cid: stay out of the attachment row while the
  // user hides inline images - the desktop viewer's rule, shared through
  // lib/attachment-visibility.ts so the two views cannot drift apart. The
  // report parts of a bounce or read receipt never show.
  const visibleAttachments = useMemo(() => {
    const attachments = (email.attachments ?? []).filter(att => !isReportPart(att.type));
    if (!hideInlineImageAttachments) return attachments;
    const bodyCids = collectReferencedCids(getRenderableHtmlBody(email));
    return attachments.filter(att => !isEmbeddedInBody(att, bodyCids));
  }, [email, hideInlineImageAttachments]);

  // Render the sanitized HTML body inside a sandboxed iframe so a malicious
  // (or accidentally-bypassed) email cannot inject styles/scripts/forms into
  // the host page. CSP <meta> is defense-in-depth in case the sanitizer ever
  // emits a <script> tag through a parser quirk.
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // The body's language for screen readers (see mailLanguage), and a frame
  // title that tells this message from the others in the conversation.
  const bodyLanguage = useMemo(() => mailLanguage(email, getRenderableHtmlBody(email)), [email]);
  const frameSender = email.from?.[0];
  const frameTitle = email.subject
    ? t('email_viewer.frame_title', { subject: email.subject })
    : t('email_viewer.frame_title_from', { sender: frameSender?.name || frameSender?.email || t('email_viewer.unknown_sender') });
  const emailIframeSrcDoc = useMemo(() => {
    if (!emailContent.isHtml || !emailContent.html) return '';
    // Strict while external content is blocked: the network-level backstop
    // for whatever the DOM walk above cannot see.
    const csp = emailIframeCsp(!allowExternal, appFontSources ? appFontSources.split(' ') : []);
    // Colours are rewritten after load (applyEmailDarkMode in handleIframeLoad).
    return `<!DOCTYPE html><html${bodyLanguage ? ` lang="${bodyLanguage}"` : ''} data-reading="${reading.frameKey}" class="${isDark ? DARK_PENDING_CLASS : ''}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<style>
  /* overflow-y hidden keeps the scrollHeight measurement below honest. overflow-x
     is auto so intrinsically wide content can pan instead of being clipped outright;
     on a phone fitEmailBodyWidth() shrinks it to the screen first, so the pan is
     only left for content too wide to stay legible when scaled. */
  html { overflow: hidden; }
  body { overflow-x: auto; overflow-y: hidden; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 0.875rem; line-height: 1.6; color: #1a1a1a; background: #ffffff; word-wrap: break-word; overflow-wrap: break-word; }
  /* Only force the cap on images that set no width of their own: an
     !important 100% also overrides a sender's inline max-width, and an
     image sized by max-width + max-height + width:100% then grows to
     the pane width while its max-height still clamps the height - the
     picture renders stretched. Same reasoning as the table rule below (#790).
     height stays !important so a fixed inline height cannot squash it. */
  img:not([style*="max-width"]) { max-width: 100% !important; }
  img[style*="max-width"] { max-width: 100%; }
  img { height: auto !important; }
  a { color: #1a73e8; }
  /* Only force the cap on tables that set no width of their own: an
     !important 100% would also override a newsletter's inline
     max-width:600px and stretch it across the pane. (#790) */
  table:not([style*="max-width"]) { max-width: 100% !important; }
  table[style*="max-width"] { max-width: 100%; }
  table { table-layout: auto; overflow-wrap: break-word; }
  td, th { word-break: break-word; padding: 0.5rem; }
  pre { white-space: pre-wrap; word-wrap: break-word; }
  ${isDark ? emailDarkModeCss() : ''}
</style>${devices.noPrint ? '<style>@media print{html,body{display:none!important}}</style>' : ''}${devices.noDownloads ? `<style>${NO_SAVE_MEDIA_CSS}</style>` : ''}</head><body dir="auto">${emailContent.html}${reading.frameCss ? `<style>${reading.frameCss}</style>` : ''}</body></html>`;
  }, [emailContent.isHtml, emailContent.html, allowExternal, isDark, bodyLanguage, reading.frameKey, reading.frameCss, appFontSources, devices.noPrint, devices.noDownloads]);
  useLayoutEffect(() => { setHtmlBodyEl(null); }, [emailIframeSrcDoc]);
  // One object per body: React writes innerHTML again whenever this object
  // changes, dropping whatever was mounted in the body.
  const plainBodyHtml = useMemo(
    () => ({ __html: sanitizePlainTextRenderedHtml(emailContent.html) }),
    [emailContent.html],
  );

  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument;
      if (!doc?.body) return;
      // Collapse the quoted original of a reply behind a "•••" toggle (#480),
      // before the first resize so the height reflects the collapsed body.
      setupQuoteCollapse(doc, {
        show: t('email_viewer.show_quoted_text'),
        hide: t('email_viewer.hide_quoted_text'),
      });
      // Text size and minimum size, before the first resize.
      applyMailTextSize(doc, {
        factor: reading.textFactor,
        minPx: reading.minFontSize,
        unjustify: reading.overrideStyles,
        sizesFromCss: reading.overrideStyles,
      });
      // Before the link handling: a Play button inside a link must not open it.
      if (reading.pauseImages) {
        pauseAnimatedImages(doc, { play: t('email_viewer.play_animation'), pause: t('email_viewer.pause_animation') });
      }
      if (isDark) applyEmailDarkMode(doc, { remoteContentAllowed: allowExternal });
      const resize = () => {
        // Fit desktop-width mail to the screen before measuring: the transform
        // leaves the layout height untouched, so scale the box by hand.
        // Phones always; any screen with "Fit wide mail" on.
        const scale = fitEmailBodyWidth(doc, reading.fitWidth ? mailFitOptions(true, true) : {});
        iframe.style.height = Math.ceil(measureEmailFrameHeight(doc) * scale) + 'px';
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(doc.body);
      doc.querySelectorAll('a, area').forEach((a) => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      });
      // The reader's link gate (email-viewer handleIframeLoad): web links go
      // through onBeforeExternalLink, and nothing resolving inside our own
      // origin (a relative path, data:) is opened. mailto: is written here
      // when the mail page takes it; the blob: URLs of cid: parts are inert.
      const onLinkClick = (ev: MouseEvent) => {
        // A middle-click opens a link too, through the link check while one
        // listens; other buttons are left alone.
        if (ev.type === 'auxclick' && (ev.button !== 1 || !linkCheckActive())) return;
        const link = (ev.target as Element | null)?.closest?.('a[href], area[href]');
        if (!link) return;
        const href = link.getAttribute('href') || '';
        if (!href || href.startsWith('#') || href.startsWith('blob:')) return;
        if (/^mailto:/i.test(href)) {
          if (requestInternalMailto(href)) ev.preventDefault();
          return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        if (!isOpenableLinkHref(href)) return;
        void resolveExternalLink({ href, target: link.getAttribute('target') ?? undefined, emailId: email.id, text: linkText(link) })
          .then((target) => { if (target) window.open(target, '_blank', 'noopener,noreferrer'); });
      };
      doc.addEventListener('click', onLinkClick, true);
      doc.addEventListener('auxclick', onLinkClick, true);
      // "No downloads": the message's own pictures can't be saved or dragged out either.
      blockMediaSaving(doc, () => downloadsOffRef.current);
      // Selected text: the onTextSelectionChange hook and the right-click
      // menu plugins may add entries to.
      watchBodySelection(doc, iframe, {
        emailId: email.id,
        onContextMenu: (point, text) => selectionMenu.openRef.current(point, { emailId: email.id, text }),
      });
      // j, k, e and the other shortcuts keep working after a click into the body.
      forwardFrameKeys(doc, iframe);
      setHtmlBodyEl(doc.body);
    } catch {
      // contentDocument may be inaccessible under stricter sandboxes; ignore.
    }
  }, [t, isDark, allowExternal, email.id, selectionMenu.openRef, reading.textFactor, reading.minFontSize, reading.overrideStyles, reading.fitWidth, reading.pauseImages]);

  return (
    <div className={className}>
      {phishingMarked && <PhishingMarkBanner className="px-4" />}
      {/* External content warning */}
      {hasBlockedContent && !allowExternal && !pluginBody.blockExternal && emailContent.isHtml && (
        <div className="px-4 py-2 bg-muted/50 flex items-center justify-between text-sm" data-testid="external-content-notice">
          <span className="text-muted-foreground">
            {remoteBlockedByOrg ? t("third_party.remote_content_blocked") : t("email_viewer.external_content_warning")}
          </span>
          {!remoteBlockedByOrg && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onAllowExternal();
              }}
            >
              {t("email_viewer.load_external_content")}
            </Button>
            {onTrustSender && (
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onTrustSender();
                }}
              >
                {t("email_viewer.trust_sender")}
              </Button>
            )}
          </div>
          )}
        </div>
      )}

      {verificationCode && (
        <div className="flex" style={{ paddingInline: 'var(--density-card-p)', paddingTop: 'var(--density-card-p)' }}>
          <VerificationCodeChip code={verificationCode} className="py-1 text-sm" />
        </div>
      )}

      {structuredCards.length > 0 && (
        // Aligned with the body: its own padding on the phone card, the
        // caller's (className) in Mountain View.
        <div style={bodyStyle ? { paddingTop: '0.5rem', paddingBottom: '0.25rem' } : { paddingInline: 'var(--density-card-p)', paddingTop: 'var(--density-card-p)' }}>
          {/* No product images when the mail is shown as plain text. */}
          <StructuredMailCards
            cards={structuredCards}
            email={email}
            allowRemoteImages={allowExternal && mailViewMode !== 'plain'}
            calendarActions={(booking) => <BookingCalendarActions booking={booking} email={email} />}
          />
        </div>
      )}

      {/* Email Body */}
      <div className="relative" style={bodyStyle ?? { padding: 'var(--density-card-p)' }}>
        <Watermark text={watermark} />
        {emailContent.isHtml ? (
          <iframe
            ref={iframeRef}
            srcDoc={emailIframeSrcDoc}
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            title={frameTitle}
            className="w-full border-0 block"
            scrolling="no"
            style={{ minHeight: '60px' }}
            onLoad={handleIframeLoad}
          />
        ) : (
          <div
            ref={setPlainBodyEl}
            // Its own direction, as in the reader: English text in an Arabic
            // UI read "1+" and ".change".
            dir="auto"
            lang={bodyLanguage ?? undefined}
            className={cn(
              "prose prose-sm max-w-none",
              !emailAlwaysLightMode && "dark:prose-invert",
              "prose-p:my-2 prose-headings:my-3",
              "prose-a:text-primary prose-a:no-underline hover:prose-a:underline",
              "[&_table]:border-collapse [&_td]:p-2 [&_th]:p-2",
              "[&_img]:max-w-full [&_img]:h-auto"
            )}
            style={{ whiteSpace: 'pre-wrap', ...(plainTextFont === 'mono' && { fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace' }), fontSize: reading.plainFontSize(13), ...(reading.comfortableWidth && { maxWidth: '80ch' }) }}
            data-plugin-source="email-body"
            data-email-id={email.id}
            onContextMenu={(e) => selectionMenu.onElementContextMenu(e, email.id)}
            // A plain-text body renders in the page, not the iframe: its
            // links go through the link check here.
            onClick={(e) => gateLinkClick(e, { emailId: email.id })}
            onAuxClick={(e) => gateLinkClick(e, { emailId: email.id })}
            dangerouslySetInnerHTML={plainBodyHtml}
          />
        )}
        <ReaderSelectionMenu menu={selectionMenu} />
        <ReaderAboveQuoteSlot
          root={emailContent.isHtml ? htmlBodyEl : plainBodyEl}
          frame={emailContent.isHtml ? iframeRef.current : null}
          extraProps={quoteSlotProps}
          version={emailContent.html}
        />
      </div>

      {/* Attachments */}
      {visibleAttachments.length > 0 && (
        <div className="px-4 pb-4">
          <div className="flex flex-wrap gap-2">
            {visibleAttachments.map((attachment, idx) => {
              const { icon: Icon, className: iconClass } = attachmentIcon(attachment.type, attachment.name);
              const isPreviewable = isFilePreviewable(attachment.name, attachment.type)
                || (!!attachment.blobId && canWopiOpen(wopiStatus, attachment.name));
              // Without downloads, whatever can be previewed is, and nothing else opens.
              const opensPreview = isPreviewable && (mailAttachmentAction === 'preview' || devices.noDownloads);
              const locked = devices.noDownloads && !opensPreview;
              return (
                <React.Fragment key={idx}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (locked) return;
                    onDownloadAttachment?.(attachment.blobId, attachment.name || 'attachment', attachment.type, source);
                  }}
                  aria-disabled={locked || undefined}
                  title={locked ? t('device_policy.downloads_off') : opensPreview ? t('files.preview') : t('email_viewer.download')}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted hover:bg-muted/80 transition-colors text-sm"
                >
                  <Icon className={cn("w-4 h-4", iconClass)} />
                  {/* The action, for screen readers: the visible name alone
                      doesn't say whether the button previews or downloads. */}
                  <span className="sr-only">{opensPreview ? t('files.preview') : t('email_viewer.download')}</span>{' '}
                  <span className="truncate max-w-[150px]">{attachment.name ? stripBidiControls(attachment.name) : 'Attachment'}</span>
                  <span className="text-muted-foreground text-xs">
                    {formatFileSize(attachment.size)}
                  </span>
                  {opensPreview ? (
                    <Eye className="w-4 h-4 text-muted-foreground" />
                  ) : locked ? null : (
                    <Download className="w-4 h-4 text-muted-foreground" />
                  )}
                </button>
                {blobClient && attachment.blobId && !phishingMarked && canEditAttachment(attachment.name) && (
                  <button
                    type="button"
                    title={t('desktopEdit.edit')}
                    aria-label={t('desktopEdit.edit_named', { name: stripBidiControls(attachment.name ?? '') })}
                    className="-ms-1.5 self-center rounded-lg p-2 text-muted-foreground hover:text-foreground"
                    onClick={(e) => {
                      e.stopPropagation();
                      const { blobId } = attachment;
                      void editAttachment({
                        key: `mail:${editAccount}:${email.id}:${blobId}`,
                        name: attachment.name ?? 'attachment',
                        type: attachment.type,
                        account: editAccount,
                        source: { kind: 'mail', emailId: email.id, ownerAccountId: accountId },
                        load: () => blobClient.fetchBlobArrayBuffer(blobId, undefined, undefined, accountId),
                      });
                    }}
                  >
                    <FilePen className="h-4 w-4" />
                  </button>
                )}
                <AttachmentPluginMenu emailId={email.id} attachment={attachment} className="-ms-1.5 self-center p-2 rounded-lg" />
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
