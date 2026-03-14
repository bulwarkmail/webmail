"use client";

import { useState, useEffect, useMemo } from "react";
import DOMPurify from "dompurify";
import { Email, ThreadGroup } from "@/lib/jmap/types";
import { EMAIL_SANITIZE_CONFIG, collapseBlockedImageContainers } from "@/lib/email-sanitization";
import { transformInlineStyles, transformColorForDarkMode, transformBgColorForDarkMode } from "@/lib/color-transform";
import { useThemeStore } from "@/stores/theme-store";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { formatDate, formatFileSize, cn } from "@/lib/utils";
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
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useSettingsStore } from "@/stores/settings-store";
import { useAuthStore } from "@/stores/auth-store";

interface ThreadConversationViewProps {
  thread: ThreadGroup;
  emails: Email[];
  isLoading?: boolean;
  onBack: () => void;
  onReply?: (email: Email) => void;
  onReplyAll?: (email: Email) => void;
  onForward?: (email: Email) => void;
  onDownloadAttachment?: (blobId: string, name: string, type?: string) => void;
  onMarkAsRead?: (emailId: string, read: boolean) => void;
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

export function ThreadConversationView({
  thread,
  emails,
  isLoading = false,
  onBack,
  onReply,
  onReplyAll,
  onForward,
  onDownloadAttachment,
  onMarkAsRead,
}: ThreadConversationViewProps) {
  const t = useTranslations();
  const externalContentPolicy = useSettingsStore((state) => state.externalContentPolicy);
  const addTrustedSender = useSettingsStore((state) => state.addTrustedSender);
  const isSenderTrusted = useSettingsStore((state) => state.isSenderTrusted);

  // Track which emails are expanded (most recent by default)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [allowExternalContent, setAllowExternalContent] = useState<Set<string>>(new Set());

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

  const toggleAllowExternal = (emailId: string) => {
    setAllowExternalContent(prev => {
      const next = new Set(prev);
      next.add(emailId);
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
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 sticky top-0 z-10">
        <button
          onClick={onBack}
          className="p-2 -ml-2 rounded-full hover:bg-muted transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="font-semibold text-foreground truncate">
            {thread.latestEmail.subject || t("email_viewer.no_subject")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("threads.messages_other", { count: emails.length })}
          </p>
        </div>
      </div>

      {/* Email Cards */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-3">
          {emails.map((email, index) => {
            const senderEmail = email.from?.[0]?.email?.toLowerCase();
            const senderIsTrusted = senderEmail ? isSenderTrusted(senderEmail) : false;
            return (
              <EmailCard
                key={email.id}
                email={email}
                isExpanded={expandedIds.has(email.id)}
                isLatest={index === 0}
                allowExternal={externalContentPolicy === 'allow' || senderIsTrusted || allowExternalContent.has(email.id)}
                onToggleExpanded={() => toggleExpanded(email.id)}
                onAllowExternal={() => toggleAllowExternal(email.id)}
                onTrustSender={senderEmail ? () => {
                  addTrustedSender(senderEmail);
                  toggleAllowExternal(email.id);
                } : undefined}
                onReply={onReply ? () => onReply(email) : undefined}
                onReplyAll={onReplyAll ? () => onReplyAll(email) : undefined}
                onForward={onForward ? () => onForward(email) : undefined}
                onDownloadAttachment={onDownloadAttachment}
                onMarkAsRead={onMarkAsRead}
              />
            );
          })}
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
  onDownloadAttachment?: (blobId: string, name: string, type?: string) => void;
  onMarkAsRead?: (emailId: string, read: boolean) => void;
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
  onMarkAsRead,
}: EmailCardProps) {
  const t = useTranslations();
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const sender = email.from?.[0];
  const isUnread = !email.keywords?.$seen;
  const isStarred = email.keywords?.$flagged;
  const [hasBlockedContent, setHasBlockedContent] = useState(false);
  const [cidBlobUrls, setCidBlobUrls] = useState<Record<string, string>>({});
  const { client } = useAuthStore();

  // Mark as read when email is expanded
  useEffect(() => {
    // Only trigger if expanded, email is unread, and we have a handler
    if (!isExpanded || !onMarkAsRead || email.keywords?.$seen) {
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
  }, [isExpanded, email.id, email.keywords?.$seen, onMarkAsRead]);

  // Fetch inline CID images with authentication to prevent browser auth dialogs
  useEffect(() => {
    if (!client || !email?.attachments) {
      setCidBlobUrls({});
      return;
    }

    const cidAttachments = email.attachments.filter(att => att.cid && att.blobId);
    if (cidAttachments.length === 0) {
      setCidBlobUrls({});
      return;
    }

    let cancelled = false;
    const objectUrls: string[] = [];

    async function fetchCidBlobs() {
      const urls: Record<string, string> = {};
      await Promise.all(cidAttachments.map(async (att) => {
        const cidValue = att.cid!.replace(/^<|>$/g, '');
        try {
          const objectUrl = await client!.fetchBlobAsObjectUrl(att.blobId, att.name || 'inline', att.type);
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
        setCidBlobUrls(urls);
      }
    }

    fetchCidBlobs();

    return () => {
      cancelled = true;
      objectUrls.forEach(url => URL.revokeObjectURL(url));
    };
  }, [client, email?.id]);

  // Sanitize and prepare email HTML content
  const emailContent = useMemo(() => {
    if (!email) return { html: "", isHtml: false };

    if (email.bodyValues) {
      let useHtmlVersion = false;
      let htmlContent = '';

      if (email.htmlBody?.[0]?.partId && email.bodyValues[email.htmlBody[0].partId]) {
        htmlContent = email.bodyValues[email.htmlBody[0].partId].value;
        useHtmlVersion = !!htmlContent;
      }

      if (useHtmlVersion && htmlContent) {
        // Replace cid: references with authenticated blob URLs (fetched via useEffect)
        // This prevents browser auth dialogs that occur when loading raw JMAP download URLs
        if (email.attachments) {
          htmlContent = htmlContent.replace(
            /\bcid:([^"'\s)]+)/gi,
            (_match, cidRef) => {
              return cidBlobUrls[cidRef] || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
            }
          );
        }

        let blockedExternalContent = false;

        // Use shared sanitization config as base (more secure)
        const sanitizeConfig = { ...EMAIL_SANITIZE_CONFIG };

        DOMPurify.addHook('afterSanitizeAttributes', (node) => {
          const htmlNode = node as HTMLElement;

          if (!allowExternal) {
            if (node.tagName === 'IMG') {
              const src = node.getAttribute('src');
              if (src && (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//'))) {
                node.setAttribute('data-blocked-src', src);
                node.removeAttribute('src');
                node.setAttribute('alt', '[Image blocked]');
                blockedExternalContent = true;
              }
            }
            if (node.hasAttribute('style')) {
              const style = node.getAttribute('style');
              if (style && /url\s*\(/i.test(style)) {
                const cleanStyle = style.replace(/url\s*\([^)]*\)/gi, 'none');
                node.setAttribute('style', cleanStyle);
                blockedExternalContent = true;
              }
            }
          }

          if (node.tagName === 'A') {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
          }

          if (resolvedTheme === 'dark') {
            if (htmlNode.style) {
              const originalStyles = htmlNode.style.cssText;
              const transformedStyles = transformInlineStyles(originalStyles, 'dark');
              if (transformedStyles !== originalStyles) {
                htmlNode.style.cssText = transformedStyles;
              }
            }

            const colorAttr = node.getAttribute('color');
            if (colorAttr) {
              node.setAttribute('color', transformColorForDarkMode(colorAttr));
            }

            const bgcolorAttr = node.getAttribute('bgcolor');
            if (bgcolorAttr) {
              node.setAttribute('bgcolor', transformBgColorForDarkMode(bgcolorAttr));
            }
          }
        });

        const sanitized = DOMPurify.sanitize(htmlContent, sanitizeConfig);
        DOMPurify.removeHook('afterSanitizeAttributes');

        let finalHtml = sanitized;
        if (blockedExternalContent) {
          setHasBlockedContent(true);
          finalHtml = collapseBlockedImageContainers(sanitized);
        }

        return { html: finalHtml, isHtml: true };
      }

      // Plain text fallback
      if (email.textBody?.[0]?.partId && email.bodyValues[email.textBody[0].partId]) {
        const text = email.bodyValues[email.textBody[0].partId].value;
        const htmlEscaped = text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\n/g, '<br>')
          .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline">$1</a>');
        return { html: htmlEscaped, isHtml: false };
      }
    }

    // Fallback to preview
    if (email.preview) {
      return { html: email.preview.replace(/\n/g, '<br>'), isHtml: false };
    }

    return { html: "", isHtml: false };
  }, [email, allowExternal, resolvedTheme, cidBlobUrls]);

  return (
    <div className={cn(
      "rounded-lg border border-border overflow-hidden transition-all duration-200",
      isExpanded ? "bg-background shadow-sm" : "bg-muted/30",
      isUnread && !isExpanded && "border-l-2 border-l-primary"
    )}>
      {/* Card Header - Always visible */}
      <button
        onClick={onToggleExpanded}
        className={cn(
          "w-full flex items-start gap-3 p-4 text-left transition-colors",
          !isExpanded && "hover:bg-muted/50"
        )}
      >
        <Avatar
          name={sender?.name}
          email={sender?.email}
          size="md"
          className="flex-shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={cn(
              "font-medium truncate",
              isUnread ? "text-foreground" : "text-muted-foreground"
            )}>
              {sender?.name || sender?.email || "Unknown"}
            </span>
            {isStarred && (
              <Star className="w-4 h-4 fill-amber-400 text-amber-400 flex-shrink-0" />
            )}
            {email.hasAttachment && (
              <Paperclip className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            )}
          </div>
          <div className="text-sm text-muted-foreground">
            {formatDate(email.receivedAt)}
          </div>
          {!isExpanded && (
            <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
              {email.preview || "No preview available"}
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

          {/* Email Body */}
          <div className="px-4 py-4">
            <div
              className={cn(
                "prose prose-sm max-w-none dark:prose-invert",
                "prose-p:my-2 prose-headings:my-3",
                "prose-a:text-primary prose-a:no-underline hover:prose-a:underline",
                "[&_table]:border-collapse [&_td]:p-2 [&_th]:p-2",
                "[&_img]:max-w-full [&_img]:h-auto"
              )}
              dangerouslySetInnerHTML={{ __html: emailContent.html }}
            />
          </div>

          {/* Attachments */}
          {email.attachments && email.attachments.length > 0 && (
            <div className="px-4 pb-4">
              <div className="flex flex-wrap gap-2">
                {email.attachments.map((attachment, idx) => {
                  const Icon = getFileIcon(attachment.name, attachment.type);
                  return (
                    <button
                      key={idx}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDownloadAttachment?.(attachment.blobId, attachment.name || 'attachment', attachment.type);
                      }}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted hover:bg-muted/80 transition-colors text-sm"
                    >
                      <Icon className="w-4 h-4 text-muted-foreground" />
                      <span className="truncate max-w-[150px]">{attachment.name || 'Attachment'}</span>
                      <span className="text-muted-foreground text-xs">
                        {formatFileSize(attachment.size)}
                      </span>
                      <Download className="w-4 h-4 text-muted-foreground" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="px-4 pb-4 flex gap-2">
            {onReply && (
              <Button
                variant="outline"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  onReply();
                }}
                className="flex-1"
              >
                <Reply className="w-4 h-4 mr-2" />
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
                className="flex-1"
              >
                <ReplyAll className="w-4 h-4 mr-2" />
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
                className="flex-1"
              >
                <Forward className="w-4 h-4 mr-2" />
                {t("email_viewer.forward")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
