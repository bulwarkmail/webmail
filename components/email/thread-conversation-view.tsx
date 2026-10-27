"use client";

import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from "react";
import DOMPurify from "dompurify";
import { Email, ThreadGroup } from "@/lib/jmap/types";
import { EMAIL_SANITIZE_CONFIG, TRANSPARENT_BLOCKED_PIXEL, blockExternalResourcesOnNode, collapseBlockedImageContainers, emailIframeCsp, isOpenableLinkHref, plainTextToSafeHtml, restrictDataUriResourcesOnNode, sanitizeEmailBodyForIframe, sanitizePlainTextRenderedHtml } from "@/lib/email-sanitization";
import { resolveExternalLink } from "@/lib/plugin-hook-result";
import { stripBidiControls } from "@/lib/bidi";
import { requestInternalMailto } from "@/lib/protocol-handlers/mailto";
import { emailDisplayDate } from "@/lib/email-date";
import { getRenderableHtmlBody } from "@/lib/email-body-selection";
import { findVerificationCode, verificationCodeBodyText } from "@/lib/verification-code";
import { VerificationCodeChip } from "./verification-code-chip";
import { collectReferencedCids, isEmbeddedInBody, normalizeCid, rewriteCidReferences } from "@/lib/attachment-visibility";
import { collapsePlainTextQuotes, setupQuoteCollapse } from "@/lib/quote-collapse";
import { fitEmailBodyWidth } from "@/lib/email-fit-width";
import { DARK_PENDING_CLASS, applyEmailDarkMode, emailDarkModeCss } from "@/lib/email-dark-mode";
import { useThemeStore } from "@/stores/theme-store";
import { useShallow } from "zustand/react/shallow";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { formatDate, formatFileSize, cn, cleanPreview } from "@/lib/utils";
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
  Loader2,
  FileText,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  File,
  Eye,
} from "@/components/icons";
import { useTranslations } from "next-intl";
import { useSettingsStore } from "@/stores/settings-store";
import { useContactStore } from "@/stores/contact-store";
import { useEmailStore, resolveEmailBlobContext, type EmailBlobContext } from "@/stores/email-store";
import { useAuthStore } from "@/stores/auth-store";
import { isFilePreviewable, toInertBlob } from "@/lib/file-preview";
import { useWopiStatus, canWopiOpen } from "@/hooks/use-wopi-status";
import { useOwnDomainAddress } from "@/hooks/use-own-domain-address";
import { emitThreadExpand } from "@/lib/plugin-thread-expand";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import { ReaderSelectionMenu, useReaderSelectionMenu, watchBodySelection } from "./reader-selection-menu";
import { PluginActions } from "@/components/plugins/plugin-actions";
import { usePluginSlotOffers } from "@/hooks/use-plugin-slot-offers";
import { useDeviceDetection } from "@/hooks/use-media-query";
import { usePluginRenderedBody } from "@/hooks/use-plugin-rendered-body";
import { emailToReadView } from "@/lib/plugin-projection";
import { AttachmentPluginMenu, ReaderAboveQuoteSlot } from "./reader-plugin-surfaces";

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
  onDownloadAttachment?: ConversationAttachmentHandler;
  /** Routing captured when this conversation was opened. */
  blobSource?: EmailBlobContext;
  onMarkAsRead?: (emailId: string, read: boolean) => void;
  /** Role of the folder the conversation was opened from, for plugin actions limited to some folders. */
  mailboxRole?: string | null;
}

// Helper function to get file icon based on mime type or extension
const getFileIcon = (name?: string, type?: string) => {
  const ext = name?.split('.').pop()?.toLowerCase();
  const mimeType = type?.toLowerCase();

  if (mimeType?.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext || '')) {
    return FileImage;
  }
  if (mimeType?.startsWith('video/') || ['mp4', 'avi', 'mov', 'wmv'].includes(ext || '')) {
    return FileVideo;
  }
  if (mimeType?.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac'].includes(ext || '')) {
    return FileAudio;
  }
  if (mimeType === 'application/pdf' || ext === 'pdf') {
    return FileText;
  }
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext || '')) {
    return FileArchive;
  }
  return File;
};

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

  const allow = useCallback((emailId: string) => {
    setAllowedIds(prev => new Set(prev).add(emailId));
  }, []);

  const isAllowed = (email: Email) => {
    const senderEmail = email.from?.[0]?.email?.toLowerCase();
    const senderIsTrusted = senderEmail
      ? isSenderTrusted(senderEmail) || (trustedSendersAddressBook && isTrustedAddressBookSender(senderEmail))
      : false;
    return externalContentPolicy === 'allow' || !!senderIsTrusted || allowedIds.has(email.id);
  };

  const trustSender = (email: Email) => {
    const senderEmail = email.from?.[0]?.email?.toLowerCase();
    if (!senderEmail) return undefined;
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
  onDownloadAttachment,
  blobSource,
  onMarkAsRead,
  mailboxRole,
}: ThreadConversationViewProps) {
  const t = useTranslations();
  const externalContent = useConversationExternalContent();
  const emailIdList = emails.map((email) => email.id).join(',');
  const { isMobile: summaryOnPhone, isTablet: summaryOnTablet } = useDeviceDetection();
  const threadSummaryProps = useMemo(
    () => ({ threadId: thread.latestEmail.threadId ?? null, emailIds: emailIdList ? emailIdList.split(',') : [], deviceType: summaryOnPhone ? 'mobile' : summaryOnTablet ? 'tablet' : 'desktop' }),
    [thread.latestEmail.threadId, emailIdList, summaryOnPhone, summaryOnTablet],
  );

  // Track which emails are expanded (most recent by default)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Auto-expand most recent email AND all unread emails when thread opens
  useEffect(() => {
    if (emails.length > 0) {
      const idsToExpand = new Set<string>();

      // Always expand most recent
      idsToExpand.add(emails[0].id);

      // Also expand all unread emails
      emails.forEach(email => {
        if (!email.keywords?.$seen) {
          idsToExpand.add(email.id);
        }
      });

      setExpandedIds(idsToExpand);
    }
  }, [emails]);

  const toggleExpanded = (emailId: string) => {
    const target = emails.find((e) => e.id === emailId);
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
    return (
      <div className="flex-1 flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t("threads.loading")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center px-4 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 sticky top-0 z-10" style={{ gap: 'var(--density-item-gap)', paddingBlock: 'var(--density-header-py)' }}>
        <button
          onClick={onBack}
          className="p-2 -ms-2 rounded-full hover:bg-muted transition-colors"
          aria-label={t('email_viewer.back_to_list')}
          title={t('email_viewer.back_to_list')}
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="font-semibold text-foreground break-words">
            {thread.latestEmail.subject || t("email_viewer.no_subject")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("threads.messages_other", { count: emails.length })}
          </p>
        </div>
      </div>

      {/* Email Cards */}
      <div className="flex-1 overflow-y-auto">
        <PluginSlot name="thread-summary" className="w-full" extraProps={threadSummaryProps} />
        <div className="space-y-3" style={{ padding: 'var(--density-card-p)' }}>
          {emails.map((email, index) => (
            <EmailCard
              key={email.id}
              email={email}
              isExpanded={expandedIds.has(email.id)}
              isLatest={index === 0}
              allowExternal={externalContent.isAllowed(email)}
              onToggleExpanded={() => toggleExpanded(email.id)}
              onAllowExternal={() => externalContent.allow(email.id)}
              onTrustSender={externalContent.trustSender(email)}
              onReply={onReply ? () => onReply(email) : undefined}
              onReplyAll={onReplyAll ? () => onReplyAll(email) : undefined}
              onForward={onForward ? () => onForward(email) : undefined}
              onDownloadAttachment={onDownloadAttachment}
            blobSource={blobSource}
              onMarkAsRead={onMarkAsRead}
              mailboxRole={mailboxRole}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// Individual email card component
interface EmailCardProps {
  email: Email;
  isExpanded: boolean;
  isLatest: boolean;
  allowExternal: boolean;
  onToggleExpanded: () => void;
  onAllowExternal: () => void;
  onTrustSender?: () => void;
  onReply?: () => void;
  onReplyAll?: () => void;
  onForward?: () => void;
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
  const { isMobile, isTablet } = useDeviceDetection();
  const deviceType = isMobile ? 'mobile' : isTablet ? 'tablet' : 'desktop';
  const emailProps = useMemo(() => ({ email: wantsView ? emailToReadView(email) : null, deviceType }), [email, wantsView, deviceType]);
  const idProps = useMemo(() => ({ emailId: email.id }), [email.id]);
  return { emailProps, idProps };
}

function EmailCard({
  email,
  isExpanded,
  isLatest: _isLatest,
  allowExternal,
  onToggleExpanded,
  onAllowExternal,
  onTrustSender,
  onReply,
  onReplyAll,
  onForward,
  onDownloadAttachment,
  blobSource,
  onMarkAsRead,
  mailboxRole,
}: EmailCardProps) {
  const t = useTranslations();
  const density = useSettingsStore((state) => state.density);
  const plugin = useConversationPluginProps(email);
  const sender = email.from?.[0];
  const formatAddress = useOwnDomainAddress();
  const isUnread = !email.keywords?.$seen;
  const isStarred = email.keywords?.$flagged;

  // Mark as read when email is expanded
  useMarkReadWhenShown(email, isExpanded, onMarkAsRead);

  return (
    <div className={cn(
      "rounded-lg border border-border overflow-hidden transition-all duration-200",
      isExpanded ? "bg-background shadow-sm" : "bg-muted/30",
      isUnread && !isExpanded && "border-s-2 border-l-primary"
    )}>
      {isExpanded && <PluginSlot name="reader-header" className="w-full" extraProps={plugin.emailProps} />}
      {/* Card Header - Always visible */}
      <button
        onClick={onToggleExpanded}
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
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={cn(
              "font-medium truncate",
              isUnread ? "text-foreground" : "text-muted-foreground"
            )}>
              {sender?.name || (sender?.email && formatAddress(sender.email)) || "Unknown"}
            </span>
            {isStarred && (
              <Star className="w-4 h-4 fill-amber-400 text-amber-400 flex-shrink-0" />
            )}
            {email.hasAttachment && (
              <Paperclip className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            )}
          </div>
          <div className="text-sm text-muted-foreground">
            {formatDate(emailDisplayDate(email))}
          </div>
          {!isExpanded && density !== 'extra-compact' && (
            <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
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
              in the single reader's More panel on phones. */}
          <div className="px-4 pb-4 flex gap-2">
            {onReply && (
              <Button
                variant="outline"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onReply();
                }}
                className="flex-1 min-w-0 px-2 whitespace-nowrap"
              >
                <Reply className="w-4 h-4 me-1.5 shrink-0" />
                <span className="truncate">{t("email_viewer.reply")}</span>
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
                className="flex-1 min-w-0 px-2 whitespace-nowrap"
              >
                <ReplyAll className="w-4 h-4 me-1.5 shrink-0" />
                <span className="truncate">{t("email_viewer.reply_all")}</span>
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
                className="flex-1 min-w-0 px-2 whitespace-nowrap"
              >
                <Forward className="w-4 h-4 me-1.5 shrink-0" />
                <span className="truncate">{t("email_viewer.forward")}</span>
              </Button>
            )}
            <PluginActions
              surface="reader-actions"
              context={plugin.idProps}
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
  allowExternal,
  onAllowExternal,
  onTrustSender,
  onDownloadAttachment,
  blobSource,
  bodyStyle,
  className,
}: ConversationEmailBodyProps) {
  const t = useTranslations();
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const mailAttachmentAction = useSettingsStore((state) => state.mailAttachmentAction);
  const wopiStatus = useWopiStatus(true);
  const hideInlineImageAttachments = useSettingsStore((state) => state.hideInlineImageAttachments);
  const emailAlwaysLightMode = useSettingsStore((state) => state.emailAlwaysLightMode);
  const isDark = resolvedTheme === 'dark' && !emailAlwaysLightMode;
  const plainTextFont = useSettingsStore((state) => state.plainTextFont);
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
  // Local CID URLs belong to a particular client/owner/message/part list.
  // Hide the previous set during render, before the new fetch's effect runs.
  const cidRequest = useMemo(() => ({ blobClient, accountId, emailId: email.id, attachments: email.attachments }),
    [blobClient, accountId, email.id, email.attachments]);
  const [cidResult, setCidResult] = useState<{ request: typeof cidRequest; urls: Record<string, string> } | null>(null);
  const cidBlobUrls = useMemo(() => cidResult?.request === cidRequest ? cidResult.urls : {}, [cidResult, cidRequest]);
  // A crypto plugin's decrypted body (PGP, S/MIME) replaces the message's own.
  const pluginBody = usePluginRenderedBody(email);
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
  const emailContent = useMemo(() => {
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

  // Parts the body embeds via cid: stay out of the attachment row while the
  // user hides inline images - the desktop viewer's rule, shared through
  // lib/attachment-visibility.ts so the two views cannot drift apart.
  const visibleAttachments = useMemo(() => {
    const attachments = email.attachments ?? [];
    if (!hideInlineImageAttachments) return attachments;
    const bodyCids = collectReferencedCids(getRenderableHtmlBody(email));
    return attachments.filter(att => !isEmbeddedInBody(att, bodyCids));
  }, [email, hideInlineImageAttachments]);

  // Render the sanitized HTML body inside a sandboxed iframe so a malicious
  // (or accidentally-bypassed) email cannot inject styles/scripts/forms into
  // the host page. CSP <meta> is defense-in-depth in case the sanitizer ever
  // emits a <script> tag through a parser quirk.
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const emailIframeSrcDoc = useMemo(() => {
    if (!emailContent.isHtml || !emailContent.html) return '';
    // Strict while external content is blocked: the network-level backstop
    // for whatever the DOM walk above cannot see.
    const csp = emailIframeCsp(!allowExternal);
    // Colours are rewritten after load (applyEmailDarkMode in handleIframeLoad).
    return `<!DOCTYPE html><html class="${isDark ? DARK_PENDING_CLASS : ''}"><head>
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
  body { overflow-x: auto; overflow-y: hidden; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 14px; line-height: 1.6; color: #1a1a1a; background: #ffffff; word-wrap: break-word; overflow-wrap: break-word; }
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
</style></head><body dir="auto">${emailContent.html}</body></html>`;
  }, [emailContent.isHtml, emailContent.html, allowExternal, isDark]);
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
      if (isDark) applyEmailDarkMode(doc, { remoteContentAllowed: allowExternal });
      const resize = () => {
        // Fit desktop-width mail to the screen before measuring: the transform
        // leaves the layout height untouched, so scale the box by hand.
        const scale = fitEmailBodyWidth(doc);
        const height = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
        iframe.style.height = Math.ceil(height * scale) + 'px';
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
      doc.addEventListener('click', (ev) => {
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
        void resolveExternalLink({ href, target: link.getAttribute('target') ?? undefined, emailId: email.id })
          .then((target) => { if (target) window.open(target, '_blank', 'noopener,noreferrer'); });
      }, true);
      // Selected text: the onTextSelectionChange hook and the right-click
      // menu plugins may add entries to.
      watchBodySelection(doc, iframe, {
        emailId: email.id,
        onContextMenu: (point, text) => selectionMenu.openRef.current(point, { emailId: email.id, text }),
      });
      setHtmlBodyEl(doc.body);
    } catch {
      // contentDocument may be inaccessible under stricter sandboxes; ignore.
    }
  }, [t, isDark, allowExternal, email.id, selectionMenu.openRef]);

  return (
    <div className={className}>
      {/* External content warning */}
      {hasBlockedContent && !allowExternal && (
        <div className="px-4 py-2 bg-muted/50 flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {t("email_viewer.external_content_warning")}
          </span>
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
        </div>
      )}

      {verificationCode && (
        <div className="flex" style={{ paddingInline: 'var(--density-card-p)', paddingTop: 'var(--density-card-p)' }}>
          <VerificationCodeChip code={verificationCode} className="py-1 text-sm" />
        </div>
      )}

      {/* Email Body */}
      <div className="relative" style={bodyStyle ?? { padding: 'var(--density-card-p)' }}>
        {emailContent.isHtml ? (
          <iframe
            ref={iframeRef}
            srcDoc={emailIframeSrcDoc}
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            title="Email content"
            className="w-full border-0 block"
            scrolling="no"
            style={{ minHeight: '60px' }}
            onLoad={handleIframeLoad}
          />
        ) : (
          <div
            ref={setPlainBodyEl}
            className={cn(
              "prose prose-sm max-w-none",
              !emailAlwaysLightMode && "dark:prose-invert",
              "prose-p:my-2 prose-headings:my-3",
              "prose-a:text-primary prose-a:no-underline hover:prose-a:underline",
              "[&_table]:border-collapse [&_td]:p-2 [&_th]:p-2",
              "[&_img]:max-w-full [&_img]:h-auto"
            )}
            style={{ whiteSpace: 'pre-wrap', ...(plainTextFont === 'mono' && { fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace' }), fontSize: '13px' }}
            data-plugin-source="email-body"
            data-email-id={email.id}
            onContextMenu={(e) => selectionMenu.onElementContextMenu(e, email.id)}
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
              const Icon = getFileIcon(attachment.name, attachment.type);
              const isPreviewable = isFilePreviewable(attachment.name, attachment.type)
                || (!!attachment.blobId && canWopiOpen(wopiStatus, attachment.name));
              const opensPreview = isPreviewable && mailAttachmentAction === 'preview';
              return (
                <React.Fragment key={idx}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDownloadAttachment?.(attachment.blobId, attachment.name || 'attachment', attachment.type, source);
                  }}
                  title={opensPreview ? t('files.preview') : t('email_viewer.download')}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted hover:bg-muted/80 transition-colors text-sm"
                >
                  <Icon className="w-4 h-4 text-muted-foreground" />
                  <span className="truncate max-w-[150px]">{attachment.name ? stripBidiControls(attachment.name) : 'Attachment'}</span>
                  <span className="text-muted-foreground text-xs">
                    {formatFileSize(attachment.size)}
                  </span>
                  {opensPreview ? (
                    <Eye className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <Download className="w-4 h-4 text-muted-foreground" />
                  )}
                </button>
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
