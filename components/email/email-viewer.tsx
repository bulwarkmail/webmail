"use client";

import { useState, useEffect, useMemo } from "react";
import DOMPurify from "dompurify";
import { Email, ContactCard } from "@/lib/jmap/types";
import { EMAIL_SANITIZE_CONFIG, collapseBlockedImageContainers } from "@/lib/email-sanitization";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { formatFileSize, cn } from "@/lib/utils";
import { getSecurityStatus, extractListHeaders } from "@/lib/email-headers";
import {
  Reply,
  ReplyAll,
  Forward,
  Trash2,
  Archive,
  Star,
  MoreVertical,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  Download,
  Mail,
  Clock,
  Loader2,
  Printer,
  FileText,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  File,
  Shield,
  Image,
  Tag,
  X,
  Check,
  AlertTriangle,
  Minus,
  ShieldCheck,
  ShieldAlert,
  Network,
  Hash,
  List,
  Code,
  Copy,
  Brain,
  Sparkles,
  Keyboard,
  Phone,
  Building,
  MapPin,
  StickyNote,
  PanelRightClose,
  Send,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useSettingsStore, KEYWORD_PALETTE } from "@/stores/settings-store";
import { useUIStore } from "@/stores/ui-store";
import { useContactStore, getContactDisplayName, getContactPrimaryEmail } from "@/stores/contact-store";
import { toast } from "@/stores/toast-store";
import { useDeviceDetection } from "@/hooks/use-media-query";
import { useAuthStore } from "@/stores/auth-store";
import { useThemeStore } from "@/stores/theme-store";
import { transformInlineStyles, transformColorForDarkMode, transformBgColorForDarkMode } from "@/lib/color-transform";
import { EmailIdentityBadge } from "./email-identity-badge";
import { UnsubscribeBanner } from "./unsubscribe-banner";
import { CalendarInvitationBanner } from "./calendar-invitation-banner";
import { findCalendarAttachment } from "@/lib/calendar-invitation";
import { RecipientPopover } from "./recipient-popover";

interface EmailViewerProps {
  email: Email | null;
  isLoading?: boolean;
  onReply?: (draftText?: string) => void;
  onReplyAll?: () => void;
  onForward?: () => void;
  onDelete?: () => void;
  onArchive?: () => void;
  onToggleStar?: () => void;
  onMarkAsRead?: (emailId: string, read: boolean) => void;
  onSetColorTag?: (emailId: string, color: string | null) => void;
  onDownloadAttachment?: (blobId: string, name: string, type?: string) => void;
  onQuickReply?: (body: string) => Promise<void>;
  onMarkAsSpam?: () => void;
  onUndoSpam?: () => void;
  onBack?: () => void;
  onShowShortcuts?: () => void;
  currentUserEmail?: string;
  currentUserName?: string;
  currentMailboxRole?: string;
  className?: string;
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
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext || '')) {
    return FileText;
  }
  return File;
};

const getCurrentColor = (keywords: Record<string, boolean> | undefined) => {
  if (!keywords) return null;
  for (const key of Object.keys(keywords)) {
    if ((key.startsWith("$label:") || key.startsWith("$color:")) && keywords[key] === true) {
      return key.startsWith("$label:")
        ? key.slice("$label:".length)
        : key.slice("$color:".length);
    }
  }
  return null;
};

// Helper function to format recipients with contextual display
const formatRecipients = (
  recipients: Array<{ name?: string; email: string }> | undefined,
  currentUserEmail: string | undefined,
  t: (key: string, params?: Record<string, string | number>) => string
): string => {
  if (!recipients || recipients.length === 0) return '';

  // Check if the first recipient is the current user
  const firstRecipient = recipients[0];
  const isFirstRecipientMe = currentUserEmail &&
    (firstRecipient.email.toLowerCase() === currentUserEmail.toLowerCase() ||
     firstRecipient.email.toLowerCase().startsWith(currentUserEmail.toLowerCase().split('@')[0] + '+'));

  // If only one recipient and it's the current user, show "me"
  if (recipients.length === 1 && isFirstRecipientMe) {
    return t('recipient_me');
  }

  // Format up to 2 recipients by name (or email if no name)
  const displayRecipients = recipients.slice(0, 2).map((r, index) => {
    if (index === 0 && isFirstRecipientMe) {
      return t('recipient_me');
    }
    return r.name || r.email;
  });

  // If more than 2 recipients, add count
  if (recipients.length > 2) {
    const displayName = displayRecipients[0];
    return t('recipient_and_others', { name: displayName, count: recipients.length - 1 });
  }

  return displayRecipients.join(', ');
};

// Helper to render clickable recipient elements with popovers
function renderClickableRecipients(
  recipients: Array<{ name?: string; email: string }>,
  currentUserEmail: string | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
  onViewContact?: (contact: ContactCard | null, email: string) => void,
  maxVisible: number = 2
) {
  const visible = recipients.slice(0, maxVisible);
  return visible.map((r, index) => {
    const isMe = currentUserEmail &&
      (r.email.toLowerCase() === currentUserEmail.toLowerCase() ||
       r.email.toLowerCase().startsWith(currentUserEmail.toLowerCase().split('@')[0] + '+'));

    return (
      <span key={r.email + index} className="inline-flex items-center">
        {index > 0 && <span className="text-muted-foreground mr-1">,</span>}
        <RecipientPopover
          name={r.name}
          email={r.email}
          displayLabel={isMe ? t('recipient_me') : undefined}
          onViewContact={onViewContact}
          className="text-sm"
        />
      </span>
    );
  });
}

// Contact sidebar panel that slides in from the right on desktop
function ContactSidebarPanel({
  email,
  contact,
  onClose,
}: {
  email: string;
  contact: ContactCard | null;
  onClose: () => void;
}) {
  const name = contact ? getContactDisplayName(contact) : null;
  const primaryEmail = contact ? getContactPrimaryEmail(contact) : email;
  const emails = contact?.emails ? Object.values(contact.emails) : [];
  const phones = contact?.phones ? Object.values(contact.phones) : [];
  const orgs = contact?.organizations ? Object.values(contact.organizations) : [];
  const addresses = contact?.addresses ? Object.values(contact.addresses) : [];
  const notes = contact?.notes ? Object.values(contact.notes) : [];

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied!");
    } catch {
      toast.error("Failed to copy");
    }
  };

  return (
    <div className="w-[320px] shrink-0 border-l border-border bg-background flex flex-col h-full animate-in slide-in-from-right-5 duration-200">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground truncate">Contact</h3>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-muted transition-colors"
          aria-label="Close sidebar"
        >
          <PanelRightClose className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Profile section */}
        <div className="px-4 pt-5 pb-4 flex flex-col items-center text-center">
          <Avatar
            name={name || email}
            email={primaryEmail}
            size="lg"
          />
          <div className="mt-3 min-w-0 w-full">
            <div className="font-semibold text-base truncate">
              {name || email}
            </div>
            {name && (
              <div className="text-sm text-muted-foreground truncate mt-0.5">
                {primaryEmail}
              </div>
            )}
            {orgs.length > 0 && orgs[0].name && (
              <div className="text-sm text-muted-foreground flex items-center justify-center gap-1 mt-1">
                <Building className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{orgs[0].name}</span>
              </div>
            )}
          </div>
        </div>

        {/* Quick actions */}
        <div className="px-4 pb-4 flex items-center justify-center gap-2">
          <a
            href={`mailto:${primaryEmail}`}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground px-3 py-2 rounded-md hover:bg-muted transition-colors border border-border"
            title="Send email"
          >
            <Send className="w-3.5 h-3.5" />
            Email
          </a>
          <button
            onClick={() => handleCopy(primaryEmail)}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground px-3 py-2 rounded-md hover:bg-muted transition-colors border border-border"
            title="Copy email"
          >
            <Copy className="w-3.5 h-3.5" />
            Copy
          </button>
        </div>

        {/* Details sections */}
        {contact && (
          <div className="px-4 pb-4 space-y-4">
            {/* Emails */}
            {emails.length > 0 && (
              <SidebarSection icon={Mail} title="Emails">
                {emails.map((e, i) => (
                  <div key={i} className="flex items-center gap-2 group">
                    <a href={`mailto:${e.address}`} className="text-sm text-primary hover:underline truncate">
                      {e.address}
                    </a>
                    <button
                      onClick={() => handleCopy(e.address)}
                      className="p-1 rounded hover:bg-muted transition-colors opacity-0 group-hover:opacity-100 shrink-0"
                      title="Copy"
                    >
                      <Copy className="w-3 h-3 text-muted-foreground" />
                    </button>
                  </div>
                ))}
              </SidebarSection>
            )}

            {/* Phones */}
            {phones.length > 0 && (
              <SidebarSection icon={Phone} title="Phones">
                {phones.map((p, i) => (
                  <div key={i} className="flex items-center gap-2 group">
                    <a href={`tel:${p.number}`} className="text-sm text-primary hover:underline">
                      {p.number}
                    </a>
                    <button
                      onClick={() => handleCopy(p.number)}
                      className="p-1 rounded hover:bg-muted transition-colors opacity-0 group-hover:opacity-100 shrink-0"
                      title="Copy"
                    >
                      <Copy className="w-3 h-3 text-muted-foreground" />
                    </button>
                  </div>
                ))}
              </SidebarSection>
            )}

            {/* Organizations */}
            {orgs.length > 1 && (
              <SidebarSection icon={Building} title="Organizations">
                {orgs.map((o, i) => (
                  <div key={i} className="text-sm">
                    {o.name}
                    {o.units && o.units.length > 0 && (
                      <span className="text-muted-foreground"> — {o.units.map(u => u.name).join(", ")}</span>
                    )}
                  </div>
                ))}
              </SidebarSection>
            )}

            {/* Addresses */}
            {addresses.length > 0 && (
              <SidebarSection icon={MapPin} title="Addresses">
                {addresses.map((a, i) => (
                  <div key={i} className="text-sm text-muted-foreground">
                    {[a.street, a.locality, a.region, a.postcode, a.country].filter(Boolean).join(", ")}
                  </div>
                ))}
              </SidebarSection>
            )}

            {/* Notes */}
            {notes.length > 0 && (
              <SidebarSection icon={StickyNote} title="Notes">
                {notes.map((n, i) => (
                  <p key={i} className="text-sm text-muted-foreground whitespace-pre-wrap">{n.note}</p>
                ))}
              </SidebarSection>
            )}
          </div>
        )}

        {/* No contact found message */}
        {!contact && (
          <div className="px-4 pb-4 text-center">
            <p className="text-xs text-muted-foreground">
              Not in your contacts
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function SidebarSection({ icon: Icon, title, children }: { icon: React.ComponentType<{ className?: string }>; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <Icon className="w-3.5 h-3.5 text-muted-foreground" />
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{title}</h4>
      </div>
      <div className="space-y-1 pl-5.5">{children}</div>
    </div>
  );
}

export function EmailViewer({
  email,
  isLoading = false,
  onReply,
  onReplyAll,
  onForward,
  onDelete,
  onArchive,
  onToggleStar,
  onMarkAsRead,
  onSetColorTag,
  onDownloadAttachment,
  onQuickReply,
  onMarkAsSpam,
  onUndoSpam,
  onBack,
  onShowShortcuts,
  currentUserEmail,
  currentUserName,
  currentMailboxRole,
  className,
}: EmailViewerProps) {
  const t = useTranslations('email_viewer');
  const tNotifications = useTranslations('notifications');
  const tCommon = useTranslations('common');
  const externalContentPolicy = useSettingsStore((state) => state.externalContentPolicy);
  const addTrustedSender = useSettingsStore((state) => state.addTrustedSender);
  const isSenderTrusted = useSettingsStore((state) => state.isSenderTrusted);
  const emailKeywords = useSettingsStore((state) => state.emailKeywords);
  const toolbarPosition = useSettingsStore((state) => state.toolbarPosition);

  // Detect if current mailbox is Junk folder
  const isInJunkFolder = currentMailboxRole === 'junk';

  // Color options for email tags (from user-defined keyword settings)
  const colorOptions = emailKeywords.map((kw) => ({
    name: kw.label,
    value: kw.id,
    color: KEYWORD_PALETTE[kw.color]?.dot || 'bg-gray-500',
  }));

  // Tablet list visibility
  const { isTablet } = useDeviceDetection();
  const { tabletListVisible } = useUIStore();
  const { identities, client } = useAuthStore();
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const [showFullHeaders, setShowFullHeaders] = useState(false);
  const [allowExternalContent, setAllowExternalContent] = useState(false);
  const [hasBlockedContent, setHasBlockedContent] = useState(false);
  const [cidBlobUrls, setCidBlobUrls] = useState<Record<string, string>>({});
  const [quickReplyText, setQuickReplyText] = useState("");
  const [isQuickReplyFocused, setIsQuickReplyFocused] = useState(false);
  const [isSendingQuickReply, setIsSendingQuickReply] = useState(false);
  const [showSourceModal, setShowSourceModal] = useState(false);
  const currentColor = getCurrentColor(email?.keywords);

  // Contact sidebar state
  const [contactSidebarEmail, setContactSidebarEmail] = useState<string | null>(null);
  const contacts = useContactStore((s) => s.contacts);
  const { isMobile: isMobileDevice } = useDeviceDetection();

  const handleViewContactSidebar = (contact: ContactCard | null, recipientEmail: string) => {
    if (isMobileDevice) return; // no sidebar on mobile
    setContactSidebarEmail(recipientEmail);
  };

  const sidebarContact = contactSidebarEmail
    ? contacts.find((c) => {
        if (!c.emails) return false;
        return Object.values(c.emails).some(
          (e) => e.address.toLowerCase() === contactSidebarEmail.toLowerCase()
        );
      }) ?? null
    : null;

  // Close contact sidebar when email changes
  useEffect(() => {
    setContactSidebarEmail(null);
  }, [email?.id]);

  const [dismissedUnsubBanners, setDismissedUnsubBanners] = useState<Set<string>>(
    () => {
      if (typeof window === 'undefined') return new Set();
      const saved = localStorage.getItem('dismissed-unsub-banners');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    }
  );

  useEffect(() => {
    // Mark as read when email is viewed
    if (email && !email.keywords?.$seen && onMarkAsRead) {
      onMarkAsRead(email.id, true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- email?.id changes when email changes, which is the intended trigger
  }, [email?.id, email?.keywords?.$seen, onMarkAsRead]);

  // Reset external content permission and quick reply when email changes
  // Initialize allowExternalContent based on externalContentPolicy setting
  useEffect(() => {
    // 'allow' = always allow, 'block' = always block, 'ask' = user decides per email
    setAllowExternalContent(externalContentPolicy === 'allow');
    setHasBlockedContent(false);
    setQuickReplyText("");
    setIsQuickReplyFocused(false);
    setShowSourceModal(false);
  }, [email?.id, externalContentPolicy]);

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

  // Generate email source for viewing
  const generateEmailSource = (email: Email): string => {
    let source = '';

    // Headers
    source += '=== EMAIL HEADERS ===\n\n';
    if (email.messageId) source += `Message-ID: ${email.messageId}\n`;
    if (email.from) source += `From: ${email.from.map(a => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')}\n`;
    if (email.to) source += `To: ${email.to.map(a => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')}\n`;
    if (email.cc) source += `Cc: ${email.cc.map(a => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')}\n`;
    if (email.bcc) source += `Bcc: ${email.bcc.map(a => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')}\n`;
    if (email.replyTo) source += `Reply-To: ${email.replyTo.map(a => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')}\n`;
    if (email.subject) source += `Subject: ${email.subject}\n`;
    if (email.sentAt) source += `Date: ${new Date(email.sentAt).toUTCString()}\n`;
    if (email.receivedAt) source += `Received-At: ${new Date(email.receivedAt).toUTCString()}\n`;
    if (email.inReplyTo) source += `In-Reply-To: ${email.inReplyTo.join(', ')}\n`;
    if (email.references) source += `References: ${email.references.join(', ')}\n`;

    // Additional headers
    if (email.headers) {
      source += '\n--- Additional Headers ---\n';
      // Headers should now always be a Record after client processing
      Object.entries(email.headers).forEach(([key, value]) => {
        const val = Array.isArray(value) ? value.join('\n    ') : String(value);
        source += `${key}: ${val}\n`;
      });
    }

    // Authentication results
    if (email.authenticationResults) {
      source += '\n--- Authentication Results ---\n';
      if (email.authenticationResults.spf) {
        source += `SPF: ${email.authenticationResults.spf.result}`;
        if (email.authenticationResults.spf.domain) source += ` (${email.authenticationResults.spf.domain})`;
        source += '\n';
      }
      if (email.authenticationResults.dkim) {
        source += `DKIM: ${email.authenticationResults.dkim.result}`;
        if (email.authenticationResults.dkim.domain) source += ` (${email.authenticationResults.dkim.domain})`;
        source += '\n';
      }
      if (email.authenticationResults.dmarc) {
        source += `DMARC: ${email.authenticationResults.dmarc.result}`;
        if (email.authenticationResults.dmarc.policy) source += ` policy=${email.authenticationResults.dmarc.policy}`;
        source += '\n';
      }
    }

    if (email.spamScore !== undefined) {
      source += `Spam Score: ${email.spamScore}`;
      if (email.spamStatus) source += ` (${email.spamStatus})`;
      source += '\n';
    }

    // Metadata
    source += '\n=== EMAIL METADATA ===\n\n';
    source += `Email ID: ${email.id}\n`;
    source += `Thread ID: ${email.threadId}\n`;
    source += `Size: ${formatFileSize(email.size)}\n`;
    source += `Has Attachment: ${email.hasAttachment ? 'Yes' : 'No'}\n`;
    if (email.keywords) {
      const keywords = Object.entries(email.keywords)
        .filter(([_, v]) => v)
        .map(([k]) => k)
        .join(', ');
      if (keywords) source += `Keywords: ${keywords}\n`;
    }

    // Attachments
    if (email.attachments && email.attachments.length > 0) {
      source += '\n=== ATTACHMENTS ===\n\n';
      email.attachments.forEach((att, i) => {
        source += `[${i + 1}] ${att.name || 'Unnamed'}\n`;
        source += `    Type: ${att.type}\n`;
        source += `    Size: ${formatFileSize(att.size)}\n`;
        source += `    Blob ID: ${att.blobId}\n`;
        if (att.cid) source += `    Content-ID: ${att.cid}\n`;
        source += '\n';
      });
    }

    // Body content
    source += '\n=== EMAIL BODY ===\n\n';

    let hasBodyContent = false;

    // Text version
    if (email.textBody?.[0]?.partId && email.bodyValues?.[email.textBody[0].partId]) {
      const textValue = email.bodyValues[email.textBody[0].partId].value;
      if (textValue && textValue.trim()) {
        source += '--- Plain Text Version ---\n\n';
        source += textValue;
        source += '\n\n';
        hasBodyContent = true;
      }
    }

    // HTML version
    if (email.htmlBody?.[0]?.partId && email.bodyValues?.[email.htmlBody[0].partId]) {
      const htmlValue = email.bodyValues[email.htmlBody[0].partId].value;
      if (htmlValue && htmlValue.trim()) {
        source += '--- HTML Version ---\n\n';
        source += htmlValue;
        source += '\n\n';
        hasBodyContent = true;
      }
    }

    // All body values if we haven't found content yet
    if (!hasBodyContent && email.bodyValues) {
      const bodyKeys = Object.keys(email.bodyValues);
      if (bodyKeys.length > 0) {
        source += '--- Body Parts ---\n\n';
        bodyKeys.forEach((key, index) => {
          const bodyValue = email.bodyValues![key].value;
          if (bodyValue && bodyValue.trim()) {
            source += `Part ${index + 1} (${key}):\n`;
            source += bodyValue;
            source += '\n\n';
            hasBodyContent = true;
          }
        });
      }
    }

    // Preview if no body
    if (!hasBodyContent && email.preview) {
      source += '--- Preview Only ---\n\n';
      source += email.preview;
      source += '\n';
    }

    if (!hasBodyContent && !email.preview) {
      source += '(No body content available)\n';
    }

    return source;
  };

  const copySourceToClipboard = async () => {
    if (!email) return;

    try {
      const source = generateEmailSource(email);
      await navigator.clipboard.writeText(source);
      // Could add a toast notification here
      console.log(tNotifications('source_copied'));
    } catch (err) {
      console.error('Failed to copy source:', err);
    }
  };

  // Sanitize and prepare email HTML content
  const emailContent = useMemo(() => {
    if (!email) return { html: "", isHtml: false };

    // Check if we have body values
    if (email.bodyValues) {
      // Check if HTML content exists and if it's actually rich HTML or just plain text wrapper
      let useHtmlVersion = false;
      let htmlContent = '';

      if (email.htmlBody?.[0]?.partId && email.bodyValues[email.htmlBody[0].partId]) {
        htmlContent = email.bodyValues[email.htmlBody[0].partId].value;
        useHtmlVersion = !!htmlContent;
      }

      // If we should use HTML version and it exists
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

        // Create a custom DOMPurify hook to handle external content
        let blockedExternalContent = false;

        // Use shared sanitization config as base (more secure)
        const sanitizeConfig = { ...EMAIL_SANITIZE_CONFIG };

        // Check if sender is trusted
        const senderEmail = email.from?.[0]?.email?.toLowerCase();
        const senderIsTrusted = senderEmail ? isSenderTrusted(senderEmail) : false;

        // Block external content based on policy:
        // 'allow' = never block, 'block' = always block (unless trusted), 'ask' = block until user allows or trusted
        const shouldBlockExternal = !senderIsTrusted && (
          externalContentPolicy === 'block' ||
          (externalContentPolicy === 'ask' && !allowExternalContent)
        );

        if (shouldBlockExternal) {
          sanitizeConfig.FORBID_TAGS.push('link');
          sanitizeConfig.FORBID_ATTR.push('background');
        }

        DOMPurify.addHook('afterSanitizeAttributes', (node) => {
          const htmlNode = node as HTMLElement;

          if (shouldBlockExternal) {
            if (node.tagName === 'IMG') {
              const src = node.getAttribute('src');
              if (src && (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//'))) {
                node.setAttribute('data-blocked-src', src);
                node.setAttribute('src', 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMSIgaGVpZ2h0PSIxIiB2aWV3Qm94PSIwIDAgMSAxIiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPgo8cmVjdCB3aWR0aD0iMSIgaGVpZ2h0PSIxIiBmaWxsPSJ0cmFuc3BhcmVudCIvPgo8L3N2Zz4=');
                node.setAttribute('alt', '');
                htmlNode.style.display = 'none';
                blockedExternalContent = true;
              }
            }

            if (htmlNode.style) {
              const style = htmlNode.style.cssText;
              if (style && style.includes('url(')) {
                const urlMatch = style.match(/url\(['"]?(https?:\/\/[^'")\s]+)['"]?\)/gi);
                if (urlMatch) {
                  htmlNode.style.cssText = style.replace(/url\(['"]?https?:\/\/[^'")\s]+['"]?\)/gi, 'url()');
                  blockedExternalContent = true;
                }
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

        // Sanitize HTML to prevent XSS
        let cleanHtml = DOMPurify.sanitize(htmlContent, sanitizeConfig);

        // Remove the hook after sanitization
        DOMPurify.removeAllHooks();

        // Collapse empty containers left behind by blocked images
        if (shouldBlockExternal && blockedExternalContent) {
          cleanHtml = collapseBlockedImageContainers(cleanHtml);
        }

        // Update blocked content state
        if (blockedExternalContent && !hasBlockedContent) {
          setHasBlockedContent(true);
        }

        return {
          html: cleanHtml,
          isHtml: true
        };
      }

      // Use text content if available (either as fallback or when HTML is minimal)
      if (email.textBody?.[0]?.partId && email.bodyValues[email.textBody[0].partId]) {
        const textContent = email.bodyValues[email.textBody[0].partId].value;

        // Convert plain text to HTML with proper formatting
        const htmlFromText = textContent
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\r\n/g, '<br>')  // Windows line endings
          .replace(/\r/g, '<br>')    // Old Mac line endings
          .replace(/\n/g, '<br>')    // Unix line endings
          .replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;')  // Convert tabs to spaces
          .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

        return {
          html: htmlFromText,
          isHtml: false
        };
      }
    }

    // If no body content is available, show the preview or a message
    if (email.preview) {
      const previewHtml = email.preview
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\r\n/g, '<br>')
        .replace(/\r/g, '<br>')
        .replace(/\n/g, '<br>');

      return {
        html: `<div style="color: var(--color-muted-foreground); font-style: italic;">${previewHtml}</div>`,
        isHtml: false
      };
    }

    return {
      html: '<p style="color: var(--color-muted-foreground);">No content available</p>',
      isHtml: false
    };
  }, [email, allowExternalContent, hasBlockedContent, externalContentPolicy, isSenderTrusted, resolvedTheme, cidBlobUrls]);

  // Print only the email content in a new window
  const handlePrint = () => {
    if (!email) return;
    const printSender = email.from?.[0];
    const date = email.sentAt ? new Date(email.sentAt).toLocaleString() : '';
    const toList = email.to?.map(r => r.name ? `${r.name} &lt;${r.email}&gt;` : r.email).join(', ') || '';
    const ccList = email.cc?.map(r => r.name ? `${r.name} &lt;${r.email}&gt;` : r.email).join(', ') || '';

    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    printWindow.document.write(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${DOMPurify.sanitize(email.subject || t('no_subject'))}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 40px; color: #000; }
  .header { border-bottom: 1px solid #ccc; padding-bottom: 16px; margin-bottom: 16px; }
  .subject { font-size: 20px; font-weight: bold; margin-bottom: 12px; }
  .meta { font-size: 13px; color: #555; line-height: 1.6; }
  .meta strong { color: #000; }
  .body { font-size: 14px; line-height: 1.6; }
  .body img { max-width: 100%; }
  @media print { body { margin: 20px; } }
</style></head><body>
<div class="header">
  <div class="subject">${DOMPurify.sanitize(email.subject || t('no_subject'))}</div>
  <div class="meta">
    <div><strong>${t('from')}:</strong> ${DOMPurify.sanitize(printSender?.name ? `${printSender.name} <${printSender.email}>` : printSender?.email || t('unknown_sender'))}</div>
    ${toList ? `<div><strong>${t('to')}:</strong> ${toList}</div>` : ''}
    ${ccList ? `<div><strong>CC:</strong> ${ccList}</div>` : ''}
    ${date ? `<div><strong>${t('date')}:</strong> ${DOMPurify.sanitize(date)}</div>` : ''}
  </div>
</div>
<div class="body">${emailContent.html}</div>
</body></html>`);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  };

  // Detect List-Unsubscribe header for newsletter banners
  const listHeaders = useMemo(() => {
    if (!email?.headers) return null;
    return extractListHeaders(email.headers);
  }, [email?.headers]);

  const shouldShowUnsubBanner =
    listHeaders?.listUnsubscribe?.preferred &&
    !dismissedUnsubBanners.has(email?.messageId || '');

  const hasCalendarInvitation = email ? !!findCalendarAttachment(email) : false;

  // Show loading skeleton while email is being fetched
  if (isLoading && !email) {
    return (
      <div className={cn("flex-1 flex flex-col h-full bg-background overflow-hidden animate-in fade-in duration-200", className)}>
        {/* Loading Header Skeleton - gentler animation */}
        <div className="bg-background border-b border-border">
          <div className="px-4 lg:px-6 py-3 lg:py-4">
            <div className="flex items-start justify-between gap-2 lg:gap-4">
              <div className="flex-1 min-w-0 space-y-2 lg:space-y-3">
                <div className="h-6 lg:h-8 bg-muted/60 rounded-md w-3/4"></div>
                <div className="flex items-center gap-2 lg:gap-3">
                  <div className="h-3 lg:h-4 bg-muted/60 rounded w-24 lg:w-32"></div>
                  <div className="h-3 lg:h-4 bg-muted/60 rounded w-16 lg:w-24"></div>
                </div>
              </div>
              <div className="flex items-center gap-1 lg:gap-2">
                <div className="h-8 w-8 lg:w-20 bg-muted/60 rounded"></div>
                <div className="h-8 w-8 bg-muted/60 rounded hidden lg:block"></div>
              </div>
            </div>
          </div>

          {/* Loading Sender Info Skeleton */}
          <div className="px-4 lg:px-6 pb-3 lg:pb-4">
            <div className="flex items-start gap-3 lg:gap-4">
              <div className="w-10 h-10 lg:w-12 lg:h-12 bg-muted/60 rounded-full"></div>
              <div className="flex-1 space-y-2">
                <div className="h-4 bg-muted/60 rounded w-48"></div>
                <div className="h-3 bg-muted/60 rounded w-64"></div>
              </div>
            </div>
          </div>
        </div>

        {/* Loading Content Skeleton */}
        <div className="flex-1 overflow-auto bg-muted/20">
          <div className="px-6 pt-4 pb-6">
            <div className="space-y-3">
              <div className="h-4 bg-muted/60 rounded w-full"></div>
              <div className="h-4 bg-muted/60 rounded w-5/6"></div>
              <div className="h-4 bg-muted/60 rounded w-4/6"></div>
              <div className="h-4 bg-muted/60 rounded w-full"></div>
              <div className="h-4 bg-muted/60 rounded w-3/4"></div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!email) {
    return (
      <div className={cn("flex-1 flex flex-col items-center justify-center bg-gradient-to-br from-muted/30 to-muted/50", className)}>
        <div className="text-center p-8">
          <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-background shadow-lg flex items-center justify-center">
            <Mail className="w-10 h-10 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-semibold text-foreground mb-2">{t('no_conversation_selected')}</h3>
          <p className="text-muted-foreground">{t('no_conversation_description')}</p>
        </div>
      </div>
    );
  }

  const sender = email.from?.[0];
  const isStarred = email.keywords?.$flagged;
  const isImportant = email.keywords?.["$important"];

  return (
    <div
      key={email.id}
      className={cn("flex-1 flex flex-row h-full bg-background overflow-hidden animate-in fade-in duration-300 relative", className)}
    >
    {/* Main email content */}
    <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0">
      {/* Loading overlay when fetching new email */}
      {isLoading && (
        <div className="absolute inset-0 bg-background/60 backdrop-blur-[2px] z-50 flex items-center justify-center animate-in fade-in duration-200">
          <div className="bg-background rounded-lg shadow-lg border border-border p-4 flex items-center gap-3">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
            <span className="text-sm font-medium text-foreground">{t('loading_email')}</span>
          </div>
        </div>
      )}
      {/* === TOOLBAR (top position) === */}
      {toolbarPosition === 'top' && (
        <div className={cn(
          "bg-background border-b border-border",
          "max-lg:sticky max-lg:top-0 max-lg:z-10"
        )}>
          <div className="px-4 lg:px-6 py-2">
            <div className="flex items-center justify-between gap-2">
              {/* Left: Back + Reply actions */}
              <div className="flex items-center gap-1">
                {isTablet && !tabletListVisible && onBack && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onBack}
                    className="h-9 w-9 flex-shrink-0 -ml-1"
                    aria-label={t('back_to_list')}
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onReply?.()}
                  className="h-8 gap-1.5"
                  title={t('tooltips.reply')}
                >
                  <Reply className="w-4 h-4" />
                  <span className="hidden sm:inline text-sm">{t('reply')}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onReplyAll}
                  className="h-8 gap-1.5"
                  title={t('tooltips.reply_all')}
                >
                  <ReplyAll className="w-4 h-4" />
                  <span className="hidden sm:inline text-sm">{t('reply_all')}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onForward}
                  className="h-8 gap-1.5"
                  title={t('tooltips.forward')}
                >
                  <Forward className="w-4 h-4" />
                  <span className="hidden sm:inline text-sm">{t('forward')}</span>
                </Button>
              </div>

              {/* Right: Organize actions */}
              <div className="flex items-center gap-0.5">
                {isLoading && (
                  <div className="mr-2 flex items-center gap-1.5 text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                  </div>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onArchive}
                  className="h-8 gap-1.5"
                  title={t('tooltips.archive')}
                >
                  <Archive className="w-4 h-4" />
                  <span className="hidden sm:inline text-sm">{t('archive')}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onDelete}
                  className="h-8 gap-1.5"
                  title={t('tooltips.delete')}
                >
                  <Trash2 className="w-4 h-4" />
                  <span className="hidden sm:inline text-sm">{t('delete')}</span>
                </Button>
                {(onMarkAsSpam || onUndoSpam) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={isInJunkFolder ? onUndoSpam : onMarkAsSpam}
                    className={cn(
                      "h-8 gap-1.5",
                      isInJunkFolder ? "hover:bg-green-50 dark:hover:bg-green-950/30" : "hover:bg-red-50 dark:hover:bg-red-950/30"
                    )}
                    title={isInJunkFolder ? t('spam.not_spam_title') : t('spam.button_title')}
                  >
                    {isInJunkFolder ? (
                      <ShieldCheck className="h-4 w-4 text-green-600 dark:text-green-400" />
                    ) : (
                      <ShieldAlert className="h-4 w-4 text-red-600 dark:text-red-400" />
                    )}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onToggleStar}
                  className="h-8 w-8"
                  title={isStarred ? t('tooltips.unstar') : t('tooltips.star')}
                >
                  <Star className={cn(
                    "w-4 h-4 transition-colors",
                    isStarred ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground"
                  )} />
                </Button>

                <div className="w-px h-5 bg-border mx-0.5" />

                {/* Tag Picker */}
                <div className="relative group hidden sm:block">
                  <button
                    className={cn(
                      "h-8 rounded hover:bg-muted flex items-center gap-1.5 px-2",
                      currentColor && "bg-muted/50"
                    )}
                    title={t('set_color')}
                  >
                    {(() => {
                      const kw = currentColor ? emailKeywords.find(k => k.id === currentColor) : null;
                      const dotClass = kw ? KEYWORD_PALETTE[kw.color]?.dot : null;
                      return dotClass ? (
                        <>
                          <span className={cn("w-3 h-3 rounded-full", dotClass)} />
                          <span className="text-xs font-medium text-foreground">{kw!.label}</span>
                        </>
                      ) : (
                        <>
                          <Tag className="w-4 h-4 text-muted-foreground" />
                          <span className="text-xs text-muted-foreground">{t('tag')}</span>
                        </>
                      );
                    })()}
                  </button>
                  <div className="absolute right-0 top-full mt-1 py-1 w-40 bg-background rounded-lg shadow-lg border border-border opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
                    {colorOptions.map((option) => (
                      <button
                        key={option.value}
                        onClick={() => { if (email) onSetColorTag?.(email.id, option.value); }}
                        className={cn(
                          "w-full px-3 py-1.5 text-sm text-left hover:bg-muted flex items-center gap-2",
                          currentColor === option.value && "bg-accent font-medium"
                        )}
                      >
                        <span className={cn("w-3 h-3 rounded-full flex-shrink-0", option.color)} />
                        <span className="truncate">{option.name}</span>
                        {currentColor === option.value && <Check className="w-3 h-3 ml-auto flex-shrink-0 text-foreground" />}
                      </button>
                    ))}
                    {currentColor && (
                      <>
                        <div className="h-px bg-border my-1" />
                        <button
                          onClick={() => { if (email) onSetColorTag?.(email.id, null); }}
                          className="w-full px-3 py-1.5 text-sm text-left hover:bg-muted flex items-center gap-2 text-muted-foreground"
                        >
                          <X className="w-3 h-3 flex-shrink-0" />
                          <span>{t('remove_color')}</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handlePrint}
                  className="h-8 gap-1.5"
                  title={t('print')}
                >
                  <Printer className="w-4 h-4" />
                  <span className="hidden sm:inline text-sm">{t('print')}</span>
                </Button>

                {/* More menu */}
                <div className="relative group">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    title={t('more_actions')}
                  >
                    <MoreVertical className="w-4 h-4 text-muted-foreground" />
                  </Button>
                  <div className="absolute right-0 top-full mt-1 w-44 bg-background rounded-md shadow-lg border border-border opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-10">
                    <button
                      onClick={() => setShowSourceModal(true)}
                      className="w-full px-3 py-2 text-sm text-left hover:bg-muted text-foreground flex items-center gap-2"
                    >
                      <Code className="w-4 h-4" />
                      {t('view_source')}
                    </button>
                    {onShowShortcuts && (
                      <button
                        onClick={onShowShortcuts}
                        className="w-full px-3 py-2 text-sm text-left hover:bg-muted text-foreground flex items-center gap-2"
                      >
                        <Keyboard className="w-4 h-4" />
                        {t('keyboard_shortcuts')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* === SUBJECT BLOCK === */}
      <div className={cn(
        "bg-background border-b border-border",
        toolbarPosition === 'below-subject' && "max-lg:sticky max-lg:top-0 max-lg:z-10"
      )}>
        <div className="px-4 lg:px-6 py-3 lg:py-4">
          <div className="flex items-start justify-between gap-2 lg:gap-4">
            {/* Back button (for below-subject mode on tablet) */}
            {toolbarPosition === 'below-subject' && isTablet && !tabletListVisible && onBack && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onBack}
                className="h-11 w-11 lg:h-10 lg:w-10 flex-shrink-0 -ml-2"
                aria-label={t('back_to_list')}
              >
                <ChevronLeft className="w-5 h-5" />
              </Button>
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-lg lg:text-2xl font-bold text-foreground tracking-tight truncate">
                  {email.subject || t('no_subject')}
                </h1>
                {/* Star inline with subject (top toolbar mode) */}
                {toolbarPosition === 'top' && (
                  <button
                    onClick={onToggleStar}
                    className="flex-shrink-0 p-1 rounded hover:bg-muted transition-colors"
                    title={isStarred ? t('tooltips.unstar') : t('tooltips.star')}
                  >
                    <Star className={cn(
                      "w-4 h-4 lg:w-5 lg:h-5 transition-colors",
                      isStarred ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground/40"
                    )} />
                  </button>
                )}
                {/* Color tag dot */}
                {currentColor && (() => {
                  const kw = emailKeywords.find(k => k.id === currentColor);
                  const dotClass = kw ? KEYWORD_PALETTE[kw.color]?.dot : null;
                  return dotClass ? (
                    <span className={cn("w-2.5 h-2.5 rounded-full flex-shrink-0", dotClass)} title={kw!.label} />
                  ) : null;
                })()}
              </div>
              <div className="flex items-center gap-2 lg:gap-3 mt-1 lg:mt-1.5 text-xs lg:text-sm text-muted-foreground">
                <span className="flex items-center gap-1 lg:gap-1.5 whitespace-nowrap">
                  <Clock className="w-3.5 h-3.5 lg:w-4 lg:h-4" />
                  {new Date(email.receivedAt).toLocaleString('en-US', {
                    weekday: 'short',
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </span>
                {isImportant && (
                  <span className="px-1.5 lg:px-2 py-0.5 bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-full text-xs font-medium whitespace-nowrap">
                    {t('important')}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* === TOOLBAR (below-subject position) === */}
      {toolbarPosition === 'below-subject' && (
        <div className="bg-background border-b border-border">
          <div className="px-4 lg:px-6 py-1.5">
            <div className="flex items-center justify-between gap-2">
              {/* Left: Reply actions */}
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onReply?.()}
                  className="h-8 gap-1.5"
                  title={t('tooltips.reply')}
                >
                  <Reply className="w-4 h-4" />
                  <span className="hidden sm:inline text-sm">{t('reply')}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onReplyAll}
                  className="h-8 gap-1.5"
                  title={t('tooltips.reply_all')}
                >
                  <ReplyAll className="w-4 h-4" />
                  <span className="hidden sm:inline text-sm">{t('reply_all')}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onForward}
                  className="h-8 gap-1.5"
                  title={t('tooltips.forward')}
                >
                  <Forward className="w-4 h-4" />
                  <span className="hidden sm:inline text-sm">{t('forward')}</span>
                </Button>
              </div>

              {/* Right: Organize actions */}
              <div className="flex items-center gap-0.5">
                {isLoading && (
                  <div className="mr-2 flex items-center gap-1.5 text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                  </div>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onArchive}
                  className="h-8 gap-1.5"
                  title={t('tooltips.archive')}
                >
                  <Archive className="w-4 h-4" />
                  <span className="hidden sm:inline text-sm">{t('archive')}</span>
                </Button>
                {(onMarkAsSpam || onUndoSpam) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={isInJunkFolder ? onUndoSpam : onMarkAsSpam}
                    className={cn(
                      "h-8 gap-1.5",
                      isInJunkFolder ? "hover:bg-green-50 dark:hover:bg-green-950/30" : "hover:bg-red-50 dark:hover:bg-red-950/30"
                    )}
                    title={isInJunkFolder ? t('spam.not_spam_title') : t('spam.button_title')}
                  >
                    {isInJunkFolder ? (
                      <ShieldCheck className="h-4 w-4 text-green-600 dark:text-green-400" />
                    ) : (
                      <ShieldAlert className="h-4 w-4 text-red-600 dark:text-red-400" />
                    )}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onDelete}
                  className="h-8 gap-1.5"
                  title={t('tooltips.delete')}
                >
                  <Trash2 className="w-4 h-4" />
                  <span className="hidden sm:inline text-sm">{t('delete')}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onToggleStar}
                  className="h-8 w-8"
                  title={isStarred ? t('tooltips.unstar') : t('tooltips.star')}
                >
                  <Star className={cn(
                    "w-4 h-4 transition-colors",
                    isStarred ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground"
                  )} />
                </Button>

                <div className="w-px h-5 bg-border mx-0.5" />

                {/* Tag Picker */}
                <div className="relative group hidden sm:block">
                  <button
                    className={cn(
                      "h-8 rounded hover:bg-muted flex items-center gap-1.5 px-2",
                      currentColor && "bg-muted/50"
                    )}
                    title={t('set_color')}
                  >
                    {(() => {
                      const kw = currentColor ? emailKeywords.find(k => k.id === currentColor) : null;
                      const dotClass = kw ? KEYWORD_PALETTE[kw.color]?.dot : null;
                      return dotClass ? (
                        <>
                          <span className={cn("w-3 h-3 rounded-full", dotClass)} />
                          <span className="text-xs font-medium text-foreground">{kw!.label}</span>
                        </>
                      ) : (
                        <>
                          <Tag className="w-4 h-4 text-muted-foreground" />
                          <span className="text-xs text-muted-foreground">{t('tag')}</span>
                        </>
                      );
                    })()}
                  </button>
                  <div className="absolute right-0 top-full mt-1 py-1 w-40 bg-background rounded-lg shadow-lg border border-border opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
                    {colorOptions.map((option) => (
                      <button
                        key={option.value}
                        onClick={() => { if (email) onSetColorTag?.(email.id, option.value); }}
                        className={cn(
                          "w-full px-3 py-1.5 text-sm text-left hover:bg-muted flex items-center gap-2",
                          currentColor === option.value && "bg-accent font-medium"
                        )}
                      >
                        <span className={cn("w-3 h-3 rounded-full flex-shrink-0", option.color)} />
                        <span className="truncate">{option.name}</span>
                        {currentColor === option.value && <Check className="w-3 h-3 ml-auto flex-shrink-0 text-foreground" />}
                      </button>
                    ))}
                    {currentColor && (
                      <>
                        <div className="h-px bg-border my-1" />
                        <button
                          onClick={() => { if (email) onSetColorTag?.(email.id, null); }}
                          className="w-full px-3 py-1.5 text-sm text-left hover:bg-muted flex items-center gap-2 text-muted-foreground"
                        >
                          <X className="w-3 h-3 flex-shrink-0" />
                          <span>{t('remove_color')}</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handlePrint}
                  className="h-8 gap-1.5"
                  title={t('print')}
                >
                  <Printer className="w-4 h-4" />
                  <span className="hidden sm:inline text-sm">{t('print')}</span>
                </Button>

                {/* More Actions */}
                <div className="relative group">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    title={t('more_actions')}
                  >
                    <MoreVertical className="w-4 h-4 text-muted-foreground" />
                  </Button>
                  <div className="absolute right-0 top-full mt-1 w-44 bg-background rounded-md shadow-lg border border-border opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-10">
                    <button
                      onClick={() => setShowSourceModal(true)}
                      className="w-full px-3 py-2 text-sm text-left hover:bg-muted text-foreground flex items-center gap-2"
                    >
                      <Code className="w-4 h-4" />
                      {t('view_source')}
                    </button>
                    {onShowShortcuts && (
                      <button
                        onClick={onShowShortcuts}
                        className="w-full px-3 py-2 text-sm text-left hover:bg-muted text-foreground flex items-center gap-2"
                      >
                        <Keyboard className="w-4 h-4" />
                        {t('keyboard_shortcuts')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* === SENDER INFO (Desktop) === */}
      <div className="hidden lg:block bg-background border-b border-border px-6 py-4">
          <div className="flex items-start gap-4">
            <button
              onClick={() => sender?.email && handleViewContactSidebar(null, sender.email)}
              className="cursor-pointer group flex-shrink-0"
              title={sender?.email || undefined}
            >
              <Avatar
                name={sender?.name}
                email={sender?.email}
                size="lg"
                className="shadow-sm w-12 h-12 group-hover:ring-2 group-hover:ring-primary/30 transition-all"
              />
            </button>

            <div className="flex-1 min-w-0">
              {/* Sender line with email and badges */}
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => sender?.email && handleViewContactSidebar(null, sender.email)}
                      className="font-semibold text-foreground hover:text-primary hover:underline transition-colors cursor-pointer text-left"
                      title={t('view_contact')}
                    >
                      {sender?.name || sender?.email || t('unknown_sender')}
                    </button>
                    <EmailIdentityBadge email={email} identities={identities} />
                  </div>
                  {sender?.email && (
                    <div className="text-sm text-muted-foreground mt-0.5 truncate">
                      {sender.email}
                    </div>
                  )}
                </div>
                {/* Date and size on the right */}
                <div className="text-right flex-shrink-0">
                  <div className="text-sm text-muted-foreground whitespace-nowrap">
                    {new Date(email.receivedAt).toLocaleString('en-US', {
                      weekday: 'short',
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </div>
                  {email.size > 0 && (
                    <div className="text-xs text-muted-foreground/70 mt-0.5">
                      {formatFileSize(email.size)}
                    </div>
                  )}
                </div>
              </div>

              {/* Recipient section - separate line */}
              <div className="mt-2 space-y-1">
                {email.to && email.to.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 text-sm">
                    <span className="text-muted-foreground">{t('recipient_to_prefix')}</span>
                    {renderClickableRecipients(email.to, currentUserEmail, t, handleViewContactSidebar)}
                    {email.to.length > 2 && (
                      <button
                        onClick={() => setShowFullHeaders(!showFullHeaders)}
                        className="ml-1 text-blue-600 dark:text-blue-400 hover:underline text-sm"
                      >
                        {t('more_count', { count: email.to.length - 2 })}
                      </button>
                    )}
                  </div>
                )}

                {email.cc && email.cc.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 text-sm">
                    <span className="text-muted-foreground">CC:</span>
                    {renderClickableRecipients(email.cc, currentUserEmail, t, handleViewContactSidebar)}
                    {email.cc.length > 2 && (
                      <span className="text-muted-foreground text-sm">+{email.cc.length - 2}</span>
                    )}
                  </div>
                )}

                {email.bcc && email.bcc.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 text-sm">
                    <span className="text-muted-foreground">{t('bcc')}:</span>
                    {renderClickableRecipients(email.bcc, currentUserEmail, t, handleViewContactSidebar)}
                    {email.bcc.length > 2 && (
                      <span className="text-muted-foreground text-sm">+{email.bcc.length - 2}</span>
                    )}
                  </div>
                )}
              </div>

              {/* Details toggle - stays in place when expanded */}
              <button
                onClick={() => setShowFullHeaders(!showFullHeaders)}
                className="mt-3 text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
              >
                {showFullHeaders ? (
                  <>
                    <ChevronUp className="w-3 h-3" />
                    {t('hide_details')}
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-3 h-3" />
                    {t('show_details')}
                  </>
                )}
              </button>

              {/* Expandable Details */}
              {showFullHeaders && (
                <div className="mt-3 space-y-3">
                  {/* Full Recipients Section */}
                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                    <div className="bg-gray-50 dark:bg-gray-800 px-4 py-2 border-b border-gray-200 dark:border-gray-700">
                      <h3 className="text-xs font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-wider flex items-center gap-2">
                        <Mail className="w-3.5 h-3.5" />
                        {t('message_details')}
                      </h3>
                    </div>
                    <div className="bg-background p-4 space-y-2 text-sm">
                      {/* From */}
                      <div className="flex items-start gap-2">
                        <span className="text-muted-foreground font-medium w-12 shrink-0">{t('from')}:</span>
                        <div className="flex flex-wrap items-center gap-1 min-w-0">
                          <RecipientPopover
                            name={sender?.name}
                            email={sender?.email || ''}
                            onViewContact={handleViewContactSidebar}
                            className="text-sm"
                          />
                        </div>
                      </div>
                      {/* To - show all */}
                      {email.to && email.to.length > 0 && (
                        <div className="flex items-start gap-2">
                          <span className="text-muted-foreground font-medium w-12 shrink-0">{t('to')}:</span>
                          <div className="flex flex-wrap items-center gap-1 min-w-0">
                            {renderClickableRecipients(email.to, currentUserEmail, t, handleViewContactSidebar, 100)}
                          </div>
                        </div>
                      )}
                      {/* CC - show all */}
                      {email.cc && email.cc.length > 0 && (
                        <div className="flex items-start gap-2">
                          <span className="text-muted-foreground font-medium w-12 shrink-0">{t('cc')}:</span>
                          <div className="flex flex-wrap items-center gap-1 min-w-0">
                            {renderClickableRecipients(email.cc, currentUserEmail, t, handleViewContactSidebar, 100)}
                          </div>
                        </div>
                      )}
                      {/* BCC - show all */}
                      {email.bcc && email.bcc.length > 0 && (
                        <div className="flex items-start gap-2">
                          <span className="text-muted-foreground font-medium w-12 shrink-0">{t('bcc')}:</span>
                          <div className="flex flex-wrap items-center gap-1 min-w-0">
                            {renderClickableRecipients(email.bcc, currentUserEmail, t, handleViewContactSidebar, 100)}
                          </div>
                        </div>
                      )}
                      {/* Date */}
                      <div className="flex items-start gap-2">
                        <span className="text-muted-foreground font-medium w-12 shrink-0">{t('date')}:</span>
                        <span className="text-foreground">
                          {new Date(email.receivedAt).toLocaleString('en-US', {
                            weekday: 'long',
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                            timeZoneName: 'short'
                          })}
                        </span>
                      </div>
                      {/* Reply-To if different */}
                      {email.replyTo && email.replyTo.length > 0 &&
                       (!email.from || email.replyTo[0].email !== email.from[0]?.email) && (
                        <div className="flex items-start gap-2">
                          <span className="text-muted-foreground font-medium w-12 shrink-0">{t('reply_to_label').replace(':', '')}</span>
                          <div className="flex flex-wrap items-center gap-1 min-w-0">
                            {email.replyTo.map((r, i) => (
                              <RecipientPopover
                                key={r.email + i}
                                name={r.name}
                                email={r.email}
                                onViewContact={handleViewContactSidebar}
                                className="text-sm"
                              />
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Security & Authentication Section */}
                  {(email.authenticationResults || email.spamScore !== undefined) && (
                    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                      <div className="bg-gray-50 dark:bg-gray-800 px-4 py-2 border-b border-gray-200 dark:border-gray-700">
                        <h3 className="text-xs font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-wider flex items-center gap-2">
                          <ShieldCheck className="w-3.5 h-3.5" />
                          {t('security_authentication')}
                        </h3>
                      </div>
                      <div className="bg-background p-4 space-y-3">
                        {/* Authentication Results */}
                        {email.authenticationResults && (
                          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                            {/* SPF Check */}
                            {email.authenticationResults.spf && (
                              <div className={cn(
                                "px-3 py-2 rounded-md",
                                getSecurityStatus(email.authenticationResults.spf.result).bgColor,
                                getSecurityStatus(email.authenticationResults.spf.result).borderColor
                              )}>
                                <div className="flex items-center gap-2">
                                  {getSecurityStatus(email.authenticationResults.spf.result).icon === 'check' &&
                                    <Check className={cn("w-4 h-4", getSecurityStatus(email.authenticationResults.spf.result).color)} />}
                                  {getSecurityStatus(email.authenticationResults.spf.result).icon === 'x' &&
                                    <X className={cn("w-4 h-4", getSecurityStatus(email.authenticationResults.spf.result).color)} />}
                                  {getSecurityStatus(email.authenticationResults.spf.result).icon === 'alert' &&
                                    <AlertTriangle className={cn("w-4 h-4", getSecurityStatus(email.authenticationResults.spf.result).color)} />}
                                  {getSecurityStatus(email.authenticationResults.spf.result).icon === 'minus' &&
                                    <Minus className={cn("w-4 h-4", getSecurityStatus(email.authenticationResults.spf.result).color)} />}
                                  <div>
                                    <div className="text-xs font-medium text-gray-900 dark:text-gray-100">SPF</div>
                                    <div className={cn("text-xs capitalize", getSecurityStatus(email.authenticationResults.spf.result).color)}>
                                      {email.authenticationResults.spf.result}
                                    </div>
                                  </div>
                                </div>
                                {email.authenticationResults.spf.domain && (
                                  <div className="text-xs text-gray-600 dark:text-gray-400 mt-1 truncate" title={email.authenticationResults.spf.domain}>
                                    {email.authenticationResults.spf.domain}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* DKIM Check */}
                            {email.authenticationResults.dkim && (
                              <div className={cn(
                                "px-3 py-2 rounded-md",
                                getSecurityStatus(email.authenticationResults.dkim.result).bgColor,
                                getSecurityStatus(email.authenticationResults.dkim.result).borderColor
                              )}>
                                <div className="flex items-center gap-2">
                                  {getSecurityStatus(email.authenticationResults.dkim.result).icon === 'check' &&
                                    <Check className={cn("w-4 h-4", getSecurityStatus(email.authenticationResults.dkim.result).color)} />}
                                  {getSecurityStatus(email.authenticationResults.dkim.result).icon === 'x' &&
                                    <X className={cn("w-4 h-4", getSecurityStatus(email.authenticationResults.dkim.result).color)} />}
                                  {getSecurityStatus(email.authenticationResults.dkim.result).icon === 'alert' &&
                                    <AlertTriangle className={cn("w-4 h-4", getSecurityStatus(email.authenticationResults.dkim.result).color)} />}
                                  {getSecurityStatus(email.authenticationResults.dkim.result).icon === 'minus' &&
                                    <Minus className={cn("w-4 h-4", getSecurityStatus(email.authenticationResults.dkim.result).color)} />}
                                  <div>
                                    <div className="text-xs font-medium text-gray-900 dark:text-gray-100">DKIM</div>
                                    <div className={cn("text-xs capitalize", getSecurityStatus(email.authenticationResults.dkim.result).color)}>
                                      {email.authenticationResults.dkim.result}
                                    </div>
                                  </div>
                                </div>
                                {email.authenticationResults.dkim.domain && (
                                  <div className="text-xs text-gray-600 dark:text-gray-400 mt-1 truncate" title={email.authenticationResults.dkim.domain}>
                                    {email.authenticationResults.dkim.domain}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* DMARC Check */}
                            {email.authenticationResults.dmarc && (
                              <div className={cn(
                                "px-3 py-2 rounded-md",
                                getSecurityStatus(email.authenticationResults.dmarc.result).bgColor,
                                getSecurityStatus(email.authenticationResults.dmarc.result).borderColor
                              )}>
                                <div className="flex items-center gap-2">
                                  {getSecurityStatus(email.authenticationResults.dmarc.result).icon === 'check' &&
                                    <Check className={cn("w-4 h-4", getSecurityStatus(email.authenticationResults.dmarc.result).color)} />}
                                  {getSecurityStatus(email.authenticationResults.dmarc.result).icon === 'x' &&
                                    <X className={cn("w-4 h-4", getSecurityStatus(email.authenticationResults.dmarc.result).color)} />}
                                  {getSecurityStatus(email.authenticationResults.dmarc.result).icon === 'alert' &&
                                    <AlertTriangle className={cn("w-4 h-4", getSecurityStatus(email.authenticationResults.dmarc.result).color)} />}
                                  {getSecurityStatus(email.authenticationResults.dmarc.result).icon === 'minus' &&
                                    <Minus className={cn("w-4 h-4", getSecurityStatus(email.authenticationResults.dmarc.result).color)} />}
                                  <div>
                                    <div className="text-xs font-medium text-gray-900 dark:text-gray-100">DMARC</div>
                                    <div className={cn("text-xs capitalize", getSecurityStatus(email.authenticationResults.dmarc.result).color)}>
                                      {email.authenticationResults.dmarc.result}
                                    </div>
                                  </div>
                                </div>
                                {email.authenticationResults.dmarc.policy && (
                                  <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                                    Policy: {email.authenticationResults.dmarc.policy}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Spam Score */}
                            {email.spamScore !== undefined && (
                              <div className={cn(
                                "px-3 py-2 rounded-md",
                                email.spamScore > 5 ? "bg-gray-50 dark:bg-gray-800 border-l-4 border-red-600 dark:border-red-500" :
                                email.spamScore > 2 ? "bg-gray-50 dark:bg-gray-800 border-l-4 border-amber-600 dark:border-amber-500" :
                                "bg-gray-50 dark:bg-gray-800 border-l-4 border-green-600 dark:border-green-500"
                              )}>
                                <div className="flex items-center gap-2">
                                  <Shield className={cn(
                                    "w-4 h-4",
                                    email.spamScore > 5 ? "text-red-700 dark:text-red-400" :
                                    email.spamScore > 2 ? "text-amber-700 dark:text-amber-400" :
                                    "text-green-700 dark:text-green-400"
                                  )} />
                                  <div>
                                    <div className="text-xs font-medium text-gray-900 dark:text-gray-100">Spam Score</div>
                                    <div className={cn(
                                      "text-xs",
                                      email.spamScore > 5 ? "text-red-700 dark:text-red-400" :
                                      email.spamScore > 2 ? "text-amber-700 dark:text-amber-400" :
                                      "text-green-700 dark:text-green-400"
                                    )}>
                                      {email.spamScore.toFixed(1)}
                                    </div>
                                  </div>
                                </div>
                                {email.spamStatus && (
                                  <div className="text-xs text-gray-600 dark:text-gray-400 mt-1 capitalize">
                                    {email.spamStatus}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {/* AI Analysis (X-Spam-LLM) - Full width card */}
                        {email.spamLLM && (
                          <div className={cn(
                            "mt-3 px-4 py-3 rounded-lg",
                            email.spamLLM.verdict === 'LEGITIMATE'
                              ? "bg-gray-50 dark:bg-gray-800 border-l-4 border-green-600 dark:border-green-500"
                              : email.spamLLM.verdict === 'SPAM'
                              ? "bg-gray-50 dark:bg-gray-800 border-l-4 border-red-600 dark:border-red-500"
                              : "bg-gray-50 dark:bg-gray-800 border-l-4 border-amber-600 dark:border-amber-500"
                          )}>
                            <div className="flex items-start gap-3">
                              <div className="flex-shrink-0 mt-0.5">
                                {email.spamLLM.verdict === 'LEGITIMATE' ? (
                                  <div className="flex items-center gap-1.5">
                                    <Brain className="w-4 h-4 text-green-700 dark:text-green-400" />
                                    <Sparkles className="w-3 h-3 text-green-700 dark:text-green-400" />
                                  </div>
                                ) : email.spamLLM.verdict === 'SPAM' ? (
                                  <ShieldAlert className="w-4 h-4 text-red-700 dark:text-red-400" />
                                ) : (
                                  <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-400" />
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <span className={cn(
                                    "text-xs font-semibold uppercase tracking-wide",
                                    email.spamLLM.verdict === 'LEGITIMATE'
                                      ? "text-green-700 dark:text-green-400"
                                      : email.spamLLM.verdict === 'SPAM'
                                      ? "text-red-700 dark:text-red-400"
                                      : "text-amber-700 dark:text-amber-400"
                                  )}>
                                    AI Analysis: {email.spamLLM.verdict}
                                  </span>
                                </div>
                                <p className="text-xs text-gray-700 dark:text-gray-300 leading-relaxed">
                                  {email.spamLLM.explanation}
                                </p>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Technical Details Section - Only show if we have useful technical info */}
                  {(email.messageId || email.replyTo?.length || (email.sentAt && email.receivedAt &&
                    Math.abs(new Date(email.sentAt).getTime() - new Date(email.receivedAt).getTime()) > 60000)) && (
                    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                      <div className="bg-gray-50 dark:bg-gray-800 px-4 py-2 border-b border-gray-200 dark:border-gray-700">
                        <h3 className="text-xs font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-wider flex items-center gap-2">
                          <Network className="w-3.5 h-3.5" />
                          {t('technical_details')}
                        </h3>
                      </div>
                      <div className="bg-background p-4">
                        <div className="space-y-3 text-xs">
                          {/* Message ID */}
                          {email.messageId && (
                            <div className="flex items-start gap-2">
                              <Hash className="w-3.5 h-3.5 text-muted-foreground mt-0.5" />
                              <div className="flex-1 min-w-0">
                                <span className="font-medium text-muted-foreground">{t('message_id_label')}</span>
                                <div className="text-foreground break-all font-mono text-xs mt-0.5">
                                  {email.messageId}
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Reply-To if different from sender */}
                          {email.replyTo && email.replyTo.length > 0 &&
                           (!email.from || email.replyTo[0].email !== email.from[0]?.email) && (
                            <div className="flex items-start gap-2">
                              <Mail className="w-3.5 h-3.5 text-muted-foreground mt-0.5" />
                              <div className="flex-1">
                                <span className="font-medium text-muted-foreground">{t('reply_to_label')}</span>
                                <div className="flex flex-wrap gap-2 mt-1">
                                  {email.replyTo.map((recipient, i) => (
                                    <span key={i} className="inline-flex items-center px-2 py-1 bg-accent/50 border border-accent rounded text-xs">
                                      {recipient.name && <span className="font-medium mr-1 text-accent-foreground">{recipient.name}</span>}
                                      <span className="text-accent-foreground/90">{recipient.email}</span>
                                    </span>
                                  ))}
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Time delay if significant (>1 minute difference) */}
                          {email.sentAt && email.receivedAt &&
                           Math.abs(new Date(email.sentAt).getTime() - new Date(email.receivedAt).getTime()) > 60000 && (
                            <div className="flex items-start gap-2">
                              <Clock className="w-3.5 h-3.5 text-muted-foreground mt-0.5" />
                              <div className="flex-1">
                                <span className="font-medium text-muted-foreground">{t('delivery_time_label')}</span>
                                <div className="text-foreground">
                                  {(() => {
                                    const diff = Math.abs(new Date(email.receivedAt).getTime() - new Date(email.sentAt).getTime());
                                    const minutes = Math.floor(diff / 60000);
                                    const hours = Math.floor(minutes / 60);
                                    const days = Math.floor(hours / 24);
                                    const dayUnit = days > 1 ? t('time.days') : t('time.day');
                                    const hourUnit = (hours % 24) > 1 ? t('time.hours') : t('time.hour');
                                    const minuteUnit = (minutes % 60) > 1 ? t('time.minutes') : t('time.minute');
                                    const minuteUnitSingle = minutes > 1 ? t('time.minutes') : t('time.minute');
                                    if (days > 0) return `${days} ${dayUnit} ${hours % 24} ${hourUnit}`;
                                    if (hours > 0) return `${hours} ${hours > 1 ? t('time.hours') : t('time.hour')} ${minutes % 60} ${minuteUnit}`;
                                    return `${minutes} ${minuteUnitSingle}`;
                                  })()}
                                </div>
                              </div>
                            </div>
                          )}

                          {/* Part of conversation */}
                          {email.references && email.references.length > 0 && (
                            <div className="flex items-start gap-2">
                              <List className="w-3.5 h-3.5 text-muted-foreground mt-0.5" />
                              <div className="flex-1 min-w-0">
                                <span className="font-medium text-muted-foreground">{t('conversation_part_label')}</span>
                                <div className="text-foreground text-xs mt-0.5">
                                  {t(email.references.length === 1 ? 'previous_messages' : 'previous_messages_plural', { count: email.references.length })}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

            </div>
          </div>
      </div>

      {/* === ATTACHMENTS (integrated into header) === */}
      {email.attachments && email.attachments.length > 0 && (
        <div className="bg-background border-b border-border px-4 lg:px-6 py-3">
          <div className="flex items-start gap-2 flex-wrap">
            {email.attachments.map((attachment, i) => {
              const FileIcon = getFileIcon(attachment.name, attachment.type);
              return (
                <button
                  key={i}
                  className="inline-flex items-center gap-2 px-3 py-2 bg-muted/60 hover:bg-accent rounded-lg transition-colors group border border-border/50"
                  title={`${t('download')} ${attachment.name} (${formatFileSize(attachment.size)})`}
                  onClick={() => {
                    if (attachment.blobId && onDownloadAttachment) {
                      onDownloadAttachment(attachment.blobId, attachment.name || 'download', attachment.type);
                    }
                  }}
                >
                  <FileIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <div className="flex flex-col items-start min-w-0">
                    <span className="text-sm text-foreground truncate max-w-[200px]">
                      {attachment.name || "Unnamed"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatFileSize(attachment.size)}
                    </span>
                  </div>
                  <Download className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Email Content Area */}
      <div className="flex-1 overflow-auto bg-muted/30">
        {/* Mobile/Tablet Sender Info - scrolls with content */}
        <div className="lg:hidden bg-background border-b border-border px-4 py-3">
          <div className="flex items-start gap-3">
            <button
              onClick={() => sender?.email && handleViewContactSidebar(null, sender.email)}
              className="cursor-pointer group flex-shrink-0"
              title={sender?.email || undefined}
            >
              <Avatar
                name={sender?.name}
                email={sender?.email}
                size="lg"
                className="shadow-sm w-10 h-10 group-hover:ring-2 group-hover:ring-primary/30 transition-all"
              />
            </button>
            <div className="flex-1 min-w-0">
              {/* Mobile 2-line layout */}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => sender?.email && handleViewContactSidebar(null, sender.email)}
                  className="text-sm font-semibold text-foreground hover:text-primary hover:underline transition-colors cursor-pointer text-left"
                >
                  {sender?.name || sender?.email || t('unknown_sender')}
                </button>
                <EmailIdentityBadge email={email} identities={identities} />
              </div>
              <div className="mt-1 flex items-center gap-1 text-sm text-muted-foreground flex-wrap">
                {sender?.email && sender?.name && (
                  <>
                    <span className="truncate">{sender.email}</span>
                    <span>·</span>
                  </>
                )}
                {email.to && email.to.length > 0 && (
                  <>
                    <span>→ {t('recipient_to_prefix')}</span>
                    {renderClickableRecipients(email.to, currentUserEmail, t, handleViewContactSidebar)}
                  </>
                )}
              </div>
              {/* CC line (mobile - only if present) */}
              {email.cc && email.cc.length > 0 && (
                <div className="mt-1 flex items-center gap-1 text-sm">
                  <span className="text-muted-foreground">CC:</span>
                  {renderClickableRecipients(email.cc, currentUserEmail, t, handleViewContactSidebar)}
                  {email.cc.length > 2 && (
                    <span className="text-muted-foreground">+{email.cc.length - 2}</span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Unified Notification Banner - External Content + Unsubscribe + Calendar Invitation */}
        {((hasBlockedContent && !allowExternalContent && externalContentPolicy !== 'allow') ||
          (shouldShowUnsubBanner && listHeaders?.listUnsubscribe) ||
          hasCalendarInvitation) && (
          <div className="border-b border-border bg-muted/30 isolate">
            <div className="max-w-4xl mx-auto px-6 py-1.5">
              <div className="flex flex-col gap-3 isolate">
                {/* External Content Controls */}
                {hasBlockedContent && !allowExternalContent && externalContentPolicy !== 'allow' && (
                  <div className="flex items-center gap-3 flex-wrap md:justify-center rounded-md px-3 py-1 bg-muted/50 dark:bg-muted/30">
                    {externalContentPolicy === 'ask' && (
                      <button
                        onClick={() => setAllowExternalContent(true)}
                        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground bg-transparent hover:bg-transparent transition-colors min-h-[44px] md:min-h-0"
                      >
                        <Image className="w-3.5 h-3.5" />
                        {t('load_external_content')}
                      </button>
                    )}
                    {email.from?.[0]?.email && (
                      <button
                        onClick={() => {
                          const senderEmail = email.from?.[0]?.email;
                          if (senderEmail) {
                            addTrustedSender(senderEmail);
                            setAllowExternalContent(true);
                          }
                        }}
                        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground bg-transparent hover:bg-transparent transition-colors min-h-[44px] md:min-h-0"
                      >
                        {t('trust_sender')}
                      </button>
                    )}
                  </div>
                )}

                {/* Unsubscribe Controls */}
                {shouldShowUnsubBanner && listHeaders?.listUnsubscribe && (
                  <div className="flex items-center md:justify-center rounded-md px-3 py-1 bg-blue-50/50 dark:bg-blue-950/20">
                    <UnsubscribeBanner
                      listUnsubscribe={listHeaders.listUnsubscribe}
                      senderEmail={email?.from?.[0]?.email || ''}
                      onDismiss={() => {
                        const messageId = email?.messageId || '';
                        const newSet = new Set(dismissedUnsubBanners).add(messageId);
                        setDismissedUnsubBanners(newSet);
                        localStorage.setItem('dismissed-unsub-banners', JSON.stringify([...newSet]));
                      }}
                    />
                  </div>
                )}

                {/* Calendar Invitation Banner */}
                {hasCalendarInvitation && (
                  <div className="rounded-md px-3 py-1 bg-amber-50/50 dark:bg-amber-950/20">
                    <CalendarInvitationBanner email={email} />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <div>

          {/* Email Body */}
          <div className="email-content-wrapper overflow-x-auto">
            {emailContent.isHtml ? (
              <div
                className="email-content prose dark:prose-invert max-w-none"
                dangerouslySetInnerHTML={{ __html: emailContent.html }}
                style={{
                  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                  fontSize: '14px',
                  lineHeight: '1.6',
                }}
              />
            ) : (
              <div
                className="email-content-text text-foreground"
                dangerouslySetInnerHTML={{ __html: emailContent.html }}
                style={{
                  fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
                  fontSize: '14px',
                  lineHeight: '1.6',
                  wordBreak: 'break-word',
                }}
              />
            )}
          </div>

          {/* Quick Reply Section */}
          <div className={cn(
            "mt-6 mx-6 mb-6 bg-background rounded-lg shadow-sm border transition-all",
            isQuickReplyFocused || quickReplyText ? "border-primary" : "border-border"
          )}>
            <div className="p-4">
              <div className="flex items-start gap-3">
                <Avatar
                  name={currentUserName || "You"}
                  email={currentUserEmail || ""}
                  size="sm"
                />
                <div className="flex-1 space-y-3">
                  <textarea
                    value={quickReplyText}
                    onChange={(e) => setQuickReplyText(e.target.value)}
                    onFocus={() => setIsQuickReplyFocused(true)}
                    placeholder={t('quick_reply_placeholder')}
                    className={cn(
                      "w-full px-3 py-2 text-sm border border-border bg-background text-foreground rounded-lg",
                      "hover:border-accent focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary transition-all",
                      "resize-none"
                    )}
                    rows={isQuickReplyFocused || quickReplyText ? 3 : 2}
                    disabled={isSendingQuickReply}
                  />

                  {/* Action buttons - show when focused or has text */}
                  {(isQuickReplyFocused || quickReplyText) && (
                    <div className="flex items-center justify-between gap-2 animate-in fade-in slide-in-from-top-1 duration-200">
                      <div className="text-xs text-muted-foreground">
                        {t('characters_count', { count: quickReplyText.length })}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setQuickReplyText("");
                            setIsQuickReplyFocused(false);
                          }}
                          disabled={isSendingQuickReply}
                        >
                          {tCommon('cancel')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            onReply?.(quickReplyText);
                            setQuickReplyText("");
                            setIsQuickReplyFocused(false);
                          }}
                          disabled={isSendingQuickReply}
                          className="text-muted-foreground"
                        >
                          <MoreVertical className="w-4 h-4 mr-1" />
                          {t('more_options')}
                        </Button>
                        <Button
                          size="sm"
                          onClick={async () => {
                            if (!quickReplyText.trim() || !onQuickReply) return;

                            setIsSendingQuickReply(true);
                            try {
                              await onQuickReply(quickReplyText);
                              setQuickReplyText("");
                              setIsQuickReplyFocused(false);
                            } catch (error) {
                              console.error("Failed to send quick reply:", error);
                            } finally {
                              setIsSendingQuickReply(false);
                            }
                          }}
                          disabled={!quickReplyText.trim() || isSendingQuickReply}
                        >
                          {isSendingQuickReply ? (
                            <>
                              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                              {t('sending')}
                            </>
                          ) : (
                            <>
                              <Reply className="w-4 h-4 mr-1" />
                              {t('send')}
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Email Source Modal */}
      {showSourceModal && email && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => setShowSourceModal(false)}
        >
          <div
            className="bg-background rounded-lg shadow-2xl border border-border w-full max-w-4xl max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div className="flex items-center gap-2">
                <Code className="w-5 h-5 text-primary" />
                <h2 className="text-lg font-semibold text-foreground">{t('email_source')}</h2>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={copySourceToClipboard}
                  className="flex items-center gap-1.5"
                >
                  <Copy className="w-4 h-4" />
                  {t('copy_source')}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowSourceModal(false)}
                  className="h-10 w-10 lg:h-8 lg:w-8"
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {/* Modal Content */}
            <div className="flex-1 overflow-auto p-4 bg-muted/30">
              <pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-words bg-background border border-border rounded-lg p-4">
                {generateEmailSource(email)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>

    {/* Contact Detail Sidebar - desktop only */}
    {contactSidebarEmail && !isMobileDevice && (
      <ContactSidebarPanel
        email={contactSidebarEmail}
        contact={sidebarContact}
        onClose={() => setContactSidebarEmail(null)}
      />
    )}
    </div>
  );
}