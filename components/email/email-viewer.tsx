"use client";

import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from "react";
import DOMPurify from "dompurify";
import { Email, ContactCard, Mailbox } from "@/lib/jmap/types";
import { emailExportFilename, attachmentDownloadFilename, attachmentsBundleFilename, DEFAULT_EMAIL_TEMPLATE, DEFAULT_ATTACHMENT_TEMPLATE } from "@/lib/download-filename";
import { EML_IMPORT_ACCEPT, expandImportableEmails } from "@/lib/eml-import";
import { EMAIL_IFRAME_SANITIZE_CONFIG, blockExternalResourcesOnNode, collapseBlockedImageContainers, escapeHtml, plainTextToSafeHtml, sanitizeEmailHtml, sanitizePlainTextRenderedHtml } from "@/lib/email-sanitization";
import { hasMeaningfulHtmlBody } from "@/lib/signature-utils";
import { withBasePath } from "@/lib/browser-navigation";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { formatFileSize, cn, buildMailboxTree, MailboxNode, formatDateTime, generateUUID } from "@/lib/utils";
import { getSecurityStatus, extractListHeaders } from "@/lib/email-headers";
import { emailToReadView } from "@/lib/plugin-projection";
import { generateEmailSource } from "@/lib/email-source";
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
  ChevronRight,
  Download,
  Mail,
  MailOpen,
  Loader2,
  Printer,
  FileText,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  File,
  Eye,
  Shield,
  Image,
  Tag,
  X,
  Check,
  AlertTriangle,
  Minus,
  ShieldCheck,
  ShieldAlert,
  Code,
  Copy,
  Brain,
  Keyboard,
  Phone,
  Building,
  MapPin,
  StickyNote,
  PanelRightClose,
  PanelRightOpen,
  Send,
  FolderInput,
  Inbox,
  Folder,
  Sun,
  Upload,
  Moon,
  EditIcon,
  PlayCircle,
  PenSquare,
  CalendarClock,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import type { Attachment as PostalMimeAttachment } from 'postal-mime';
import { useSettingsStore, KEYWORD_PALETTE } from "@/stores/settings-store";
import { useUIStore } from "@/stores/ui-store";
import { useContactStore, getContactDisplayName, getContactPrimaryEmail } from "@/stores/contact-store";
import { toast } from "@/stores/toast-store";
import { useDeviceDetection } from "@/hooks/use-media-query";
import { useAuthStore } from "@/stores/auth-store";
import { useAccountStore } from "@/stores/account-store";
import { useEmailStore } from "@/stores/email-store";
import { useThemeStore } from "@/stores/theme-store";
import { EmailIdentityBadge } from "./email-identity-badge";
import { UnsubscribeBanner } from "./unsubscribe-banner";
import { CalendarInvitationBanner } from "./calendar-invitation-banner";
import { ReadReceiptBanner } from "./read-receipt-banner";
import { stripCrossAccountIdentityPrefix } from "@/hooks/use-pro-multi-account-identities";
import { useTour } from "@/components/tour/tour-provider";
import { useIsEmbedded } from "@/hooks/use-is-embedded";
import { findCalendarAttachment, isCalendarMimeType } from "@/lib/calendar-invitation";
import { RecipientPopover } from "./recipient-popover";
import { isFilePreviewable, isMimeTypeSafeForInlinePreview } from "@/lib/file-preview";
import { parseTnef, isTnefAttachment } from "@/lib/tnef";
import { debug } from "@/lib/debug";
import type { TnefAttachment } from "@/lib/tnef";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import { usePluginSlotOffers } from "@/hooks/use-plugin-slot-offers";
import { ResizeHandle } from "@/components/layout/resize-handle";
import { emailHooks, uiHooks, renderHooks } from "@/lib/plugin-hooks";
import type { AttachmentInfo, AttachmentPreview } from "@/lib/plugin-types";
import { useAttachmentDrag, isDragOutSupported, type AttachmentDragSource } from "@/hooks/use-attachment-drag";
import type { IJMAPClient } from "@/lib/jmap/client-interface";

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
  onDownloadAttachment?: (blobId: string, name: string, type?: string, forceDownload?: boolean) => void;
  onQuickReply?: (body: string) => Promise<void>;
  onMarkAsSpam?: () => void;
  onUndoSpam?: () => void;
  onMoveToMailbox?: (mailboxId: string) => void;
  onBack?: () => void;
  onNavigateNext?: () => void;
  onNavigatePrev?: () => void;
  onShowShortcuts?: () => void;
  onEditDraft?: () => void;
  onCancelScheduled?: () => void;
  onCancelScheduledForEdit?: () => void;
  onRescheduleScheduled?: (delayedUntil: string) => void;
  onCompose?: () => void;
  currentUserEmail?: string;
  currentUserName?: string;
  currentMailboxRole?: string;
  mailboxes?: Mailbox[];
  selectedMailbox?: string;
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

const MIME_TYPE_LABELS: Record<string, string> = {
  'application/pdf': 'Document.pdf',
  'application/zip': 'Archive.zip',
  'application/x-zip-compressed': 'Archive.zip',
  'application/gzip': 'Archive.gz',
  'application/x-rar-compressed': 'Archive.rar',
  'application/x-7z-compressed': 'Archive.7z',
  'application/msword': 'Document.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Document.docx',
  'application/vnd.ms-excel': 'Spreadsheet.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Spreadsheet.xlsx',
  'application/vnd.ms-powerpoint': 'Presentation.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'Presentation.pptx',
  'text/plain': 'Text.txt',
  'text/html': 'Document.html',
  'text/csv': 'Data.csv',
  'application/json': 'Data.json',
  'application/xml': 'Data.xml',
  'application/octet-stream': 'Attachment',
  'message/rfc822': 'Email.eml',
};

const getAttachmentDisplayName = (name: string | null | undefined, mimeType?: string): string => {
  if (name) return name;
  if (mimeType) {
    const label = MIME_TYPE_LABELS[mimeType.toLowerCase()];
    if (label) return label;
    const sub = mimeType.split('/')[1];
    if (sub) {
      const clean = sub.replace(/^x-/, '').replace(/^vnd\./, '');
      return `Attachment.${clean}`;
    }
  }
  return 'Attachment';
};

const getCurrentColors = (keywords: Record<string, boolean> | undefined): string[] => {
  if (!keywords) return [];
  const tags: string[] = [];
  for (const key of Object.keys(keywords)) {
    if ((key.startsWith("$label:") || key.startsWith("$color:")) && keywords[key] === true) {
      tags.push(
        key.startsWith("$label:") ? key.slice("$label:".length) : key.slice("$color:".length)
      );
    }
  }
  return tags;
};

// Helper function to format recipients with contextual display
const _formatRecipients = (
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

function decodeBase64Bytes(input: string): Uint8Array | null {
  const cleaned = input.replace(/\s/g, '');
  if (!cleaned) return null;

  try {
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function getAttachmentContentBytes(attachment: {
  content?: ArrayBuffer | Uint8Array | string;
  encoding?: 'base64' | 'utf8';
}): Uint8Array | null {
  const { content, encoding } = attachment;

  if (content instanceof Uint8Array) {
    return content;
  }

  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }

  if (typeof content === 'string') {
    if (encoding === 'base64') {
      return decodeBase64Bytes(content);
    }
    return new TextEncoder().encode(content);
  }

  return null;
}

/**
 * Check if an HTML body string is effectively empty (just boilerplate/whitespace).
 * Outlook often generates HTML bodies with Word CSS + &nbsp; but no real text.
 */
function isHtmlBodyEffectivelyEmpty(html: string): boolean {
  const textContent = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/\s+/g, '')
    .trim();
  return textContent.length === 0;
}

interface EffectiveAttachment {
  id: string;
  name: string | null;
  type: string;
  size: number;
  blobId?: string;
  cid?: string;
  decryptedAttachment?: PostalMimeAttachment;
  tnefData?: Uint8Array;
}

function getPostalMimeAttachmentSize(attachment: PostalMimeAttachment): number {
  const bytes = getAttachmentContentBytes(attachment);
  return bytes?.byteLength ?? 0;
}

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
export function ContactSidebarPanel({
  email,
  contact,
  senderName,
  onClose,
  onAddToContacts,
  onEditContact,
}: {
  email: string;
  contact: ContactCard | null;
  senderName?: string;
  onClose: () => void;
  onAddToContacts?: (email: string, name?: string) => void;
  onEditContact?: () => void;
}) {
  const t = useTranslations('email_viewer');
  const tCommon = useTranslations('common');
  const name = contact ? getContactDisplayName(contact) : senderName || null;
  const primaryEmail = contact ? getContactPrimaryEmail(contact) : email;
  const emails = contact?.emails ? Object.values(contact.emails) : [];
  const phones = contact?.phones ? Object.values(contact.phones) : [];
  const orgs = contact?.organizations ? Object.values(contact.organizations) : [];
  const addresses = contact?.addresses ? Object.values(contact.addresses) : [];
  const notes = contact?.notes ? Object.values(contact.notes) : [];

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('contact_sidebar.copied'));
    } catch {
      toast.error(t('contact_sidebar.copy_failed'));
    }
  };

  return (
    <div className="w-[320px] shrink-0 border-l border-border bg-background flex flex-col h-full animate-in slide-in-from-right-5 duration-200">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground truncate">{t('contact_sidebar.title')}</h3>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-muted transition-colors"
          aria-label={t('contact_sidebar.close')}
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
            title={t('contact_sidebar.action_email_title')}
          >
            <Send className="w-3.5 h-3.5" />
            {t('contact_sidebar.action_email')}
          </a>
          <button
            onClick={() => handleCopy(primaryEmail)}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground px-3 py-2 rounded-md hover:bg-muted transition-colors border border-border"
            title={t('contact_sidebar.action_copy_title')}
          >
            <Copy className="w-3.5 h-3.5" />
            {t('contact_sidebar.action_copy')}
          </button>
          {contact && onEditContact && (
            <button
              onClick={onEditContact}
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground px-3 py-2 rounded-md hover:bg-muted transition-colors border border-border"
              title={t('contact_sidebar.action_edit_title')}
            >
              <EditIcon className="w-3.5 h-3.5" />
              {tCommon('edit')}
            </button>
          )}
        </div>

        {/* Details sections */}
        {contact && (
          <div className="px-4 pb-4 space-y-4">
            {/* Emails */}
            {emails.length > 0 && (
              <SidebarSection icon={Mail} title={t('contact_sidebar.section_emails')}>
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
              <SidebarSection icon={Phone} title={t('contact_sidebar.section_phones')}>
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
              <SidebarSection icon={Building} title={t('contact_sidebar.section_organizations')}>
                {orgs.map((o, i) => (
                  <div key={i} className="text-sm">
                    {o.name}
                    {o.units && o.units.length > 0 && (
                      <span className="text-muted-foreground"> - {o.units.map(u => u.name).join(", ")}</span>
                    )}
                  </div>
                ))}
              </SidebarSection>
            )}

            {/* Addresses */}
            {addresses.length > 0 && (
              <SidebarSection icon={MapPin} title={t('contact_sidebar.section_addresses')}>
                {addresses.map((a, i) => (
                  <div key={i} className="text-sm text-muted-foreground">
                    {a.full || a.fullAddress
                      ? (a.full || a.fullAddress)
                      : a.components && a.components.length > 0
                        ? a.components.filter(c => c.kind !== 'separator').map(c => c.value).filter(Boolean).join(", ")
                        : [a.street, a.locality, a.region, a.postcode, a.country].filter(Boolean).join(", ")}
                  </div>
                ))}
              </SidebarSection>
            )}

            {/* Notes */}
            {notes.length > 0 && (
              <SidebarSection icon={StickyNote} title={t('contact_sidebar.section_notes')}>
                {notes.map((n, i) => (
                  <p key={i} className="text-sm text-muted-foreground whitespace-pre-wrap">{n.note}</p>
                ))}
              </SidebarSection>
            )}
          </div>
        )}

        {/* No contact found message */}
        {!contact && (
          <div className="px-4 pb-4 text-center space-y-3">
            <p className="text-xs text-muted-foreground">
              {t('contact_sidebar.not_in_contacts')}
            </p>
            {onAddToContacts && (
              <button
                onClick={() => onAddToContacts(email, senderName)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 px-3 py-2 rounded-md hover:bg-muted transition-colors border border-border"
              >
                <Mail className="w-3.5 h-3.5" />
                {t('contact_sidebar.add_to_contacts')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface DraggableAttachmentChipProps {
  attachment: EffectiveAttachment;
  client: IJMAPClient | null;
  enabled: boolean;
  downloadName?: string;
  children: (dragProps: {
    draggable: boolean;
    onPointerEnter: () => void;
    onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
    onDragEnd: (e: React.DragEvent<HTMLDivElement>) => void;
  }) => React.ReactNode;
}

function DraggableAttachmentChip({ attachment, client, enabled, downloadName, children }: DraggableAttachmentChipProps) {
  const source = useMemo<AttachmentDragSource>(() => ({
    name: downloadName || attachment.name || 'download',
    type: attachment.type || 'application/octet-stream',
    getBlobUrl: async () => {
      if (attachment.blobId && client) {
        try {
          return await client.fetchBlobAsObjectUrl(attachment.blobId, attachment.name || undefined, attachment.type);
        } catch {
          return null;
        }
      }
      if (attachment.tnefData) {
        const bytes = attachment.tnefData;
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        return URL.createObjectURL(new Blob([buffer], { type: attachment.type || 'application/octet-stream' }));
      }
      if (attachment.decryptedAttachment) {
        const bytes = getAttachmentContentBytes(attachment.decryptedAttachment);
        if (!bytes || bytes.byteLength === 0) return null;
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        return URL.createObjectURL(new Blob([buffer], { type: attachment.type || 'application/octet-stream' }));
      }
      return null;
    },
  }), [attachment, client, downloadName]);
  const drag = useAttachmentDrag(source, enabled);
  return <>{children(drag)}</>;
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
  onMoveToMailbox,
  onBack,
  onNavigateNext,
  onNavigatePrev,
  onShowShortcuts,
  onEditDraft,
  onCancelScheduled,
  onCancelScheduledForEdit,
  onRescheduleScheduled,
  onCompose,
  currentUserEmail,
  currentUserName,
  currentMailboxRole,
  mailboxes = [],
  selectedMailbox = "",
  className,
}: EmailViewerProps) {
  const t = useTranslations('email_viewer');
  const tComposer = useTranslations('email_composer');
  const tNotifications = useTranslations('notifications');
  const tCommon = useTranslations('common');
  const tFiles = useTranslations('files');
  const tDemoWelcome = useTranslations('demo_welcome');
  const tWelcome = useTranslations('welcome');
  const externalContentPolicy = useSettingsStore((state) => state.externalContentPolicy);
  const mailAttachmentAction = useSettingsStore((state) => state.mailAttachmentAction);
  const attachmentPosition = useSettingsStore((state) => state.attachmentPosition);
  const addTrustedSender = useSettingsStore((state) => state.addTrustedSender);
  const isSenderTrusted = useSettingsStore((state) => state.isSenderTrusted);
  const trustedSendersAddressBook = useSettingsStore((state) => state.trustedSendersAddressBook);
  const isTrustedAddressBookSender = useContactStore((state) => state.isTrustedAddressBookSender);
  const addToTrustedSendersBook = useContactStore((state) => state.addToTrustedSendersBook);
  const emailKeywords = useSettingsStore((state) => state.emailKeywords);
  const toolbarPosition = useSettingsStore((state) => state.toolbarPosition);
  const showToolbarLabels = useSettingsStore((state) => state.showToolbarLabels);
  const mailLayout = useSettingsStore((state) => state.mailLayout);
  const calendarInvitationParsingEnabled = useSettingsStore((state) => state.calendarInvitationParsingEnabled);
  const readReceiptResponse = useSettingsStore((state) => state.readReceiptResponse);
  const hideInlineImageAttachments = useSettingsStore((state) => state.hideInlineImageAttachments);
  const attachmentImagePreviewsEnabled = useSettingsStore((state) => state.attachmentImagePreviewsEnabled);
  const dragOutActive = useMemo(() => isDragOutSupported(), []);
  const emailDownloadTemplate = useSettingsStore((state) => state.emailDownloadTemplate) || DEFAULT_EMAIL_TEMPLATE;
  const attachmentDownloadTemplate = useSettingsStore((state) => state.attachmentDownloadTemplate) || DEFAULT_ATTACHMENT_TEMPLATE;
  const filenameSpaceReplacement = useSettingsStore((state) => state.filenameSpaceReplacement);
  const filenameLowercase = useSettingsStore((state) => state.filenameLowercase);
  const filenameStripDiacritics = useSettingsStore((state) => state.filenameStripDiacritics);
  const filenameCollapseSeparators = useSettingsStore((state) => state.filenameCollapseSeparators);
  const emailFilenameOptions = useMemo(() => ({
    template: emailDownloadTemplate,
    spaceReplacement: filenameSpaceReplacement,
    lowercase: filenameLowercase,
    stripDiacritics: filenameStripDiacritics,
    collapseSeparators: filenameCollapseSeparators,
  }), [emailDownloadTemplate, filenameSpaceReplacement, filenameLowercase, filenameStripDiacritics, filenameCollapseSeparators]);
  const attachmentFilenameOptions = useMemo(() => ({
    template: attachmentDownloadTemplate,
    spaceReplacement: filenameSpaceReplacement,
    lowercase: filenameLowercase,
    stripDiacritics: filenameStripDiacritics,
    collapseSeparators: filenameCollapseSeparators,
  }), [attachmentDownloadTemplate, filenameSpaceReplacement, filenameLowercase, filenameStripDiacritics, filenameCollapseSeparators]);
  const timeFormat = useSettingsStore((state) => state.timeFormat);
  const isFocusedMailLayout = mailLayout === 'focus';

  // Detect if current mailbox is Junk folder
  const isInJunkFolder = currentMailboxRole === 'junk';
  // Marking your own outgoing mail as spam makes no sense - hide the action
  // in Sent, Drafts and Scheduled.
  const spamApplicable = !['sent', 'drafts', 'scheduled'].includes(currentMailboxRole || '');

  // Detect if the email is a draft
  const isDraft = email?.keywords?.['$draft'] === true;
  const isScheduled = email?.isScheduled === true;
  const canCancelScheduled = isScheduled && email?.scheduledUndoStatus === 'pending';

  // Color options for email tags (from user-defined keyword settings)
  const colorOptions = emailKeywords.map((kw) => ({
    name: kw.label,
    value: kw.id,
    color: KEYWORD_PALETTE[kw.color]?.dot || 'bg-gray-500',
  }));

  // Tablet list visibility
  const { isTablet, isMobile } = useDeviceDetection();
  const { tabletListVisible } = useUIStore();
  const { identities, client, isDemoMode, activeAccountId } = useAuthStore();
  const activeAccount = useAccountStore((s) => s.accounts.find((a) => a.id === activeAccountId));
  const promptForRescheduleDelayedUntil = useCallback((): string | null => {
    const value = window.prompt(t('reschedule_prompt'));
    if (!value) return null;
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) {
      toast.error(tComposer('schedule_send_invalid'));
      return null;
    }
    if (time <= Date.now()) {
      toast.error(tComposer('schedule_send_future'));
      return null;
    }
    if (!client?.hasDelayedSend()) {
      toast.error(tComposer('schedule_send_unsupported'));
      return null;
    }
    const maxDelayedSend = client.getMaxDelayedSend();
    if (maxDelayedSend > 0 && time > Date.now() + maxDelayedSend * 1000) {
      toast.error(tComposer('schedule_send_too_late'));
      return null;
    }
    return new Date(time).toISOString();
  }, [client, t, tComposer]);
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const { startTour } = useTour();
  const isEmbedded = useIsEmbedded();
  const [showFullHeaders, setShowFullHeaders] = useState(false);
  const [showAllBesideAttachments, setShowAllBesideAttachments] = useState(false);
  const [showAllMobileAttachments, setShowAllMobileAttachments] = useState(false);
  const [showAllBelowHeaderAttachments, setShowAllBelowHeaderAttachments] = useState(false);
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);
  const [visibleBelowHeaderCount, setVisibleBelowHeaderCount] = useState<number | null>(null);
  const belowHeaderRowRef = useRef<HTMLDivElement>(null);
  const belowHeaderGhostRef = useRef<HTMLDivElement>(null);
  const [imageThumbUrls, setImageThumbUrls] = useState<Record<string, string>>({});
  const [allowExternalContent, setAllowExternalContent] = useState(false);
  const [hasBlockedContent, setHasBlockedContent] = useState(false);
  const [cidBlobUrls, setCidBlobUrls] = useState<Record<string, string>>({});
  const [quickReplyText, setQuickReplyText] = useState("");
  const [isQuickReplyFocused, setIsQuickReplyFocused] = useState(false);
  const [isSendingQuickReply, setIsSendingQuickReply] = useState(false);
  const handleSendQuickReply = async () => {
    if (!quickReplyText.trim() || !onQuickReply || isSendingQuickReply) return;
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
  };
  const [showSourceModal, setShowSourceModal] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [moreMenuSub, setMoreMenuSub] = useState<'move' | 'tag' | null>(null);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const tagMenuRef = useRef<HTMLDivElement>(null);
  const moveMenuRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [hiddenPriorities, setHiddenPriorities] = useState<Set<number>>(new Set());
  const currentColors = getCurrentColors(email?.keywords);
  const currentColor = currentColors[0] ?? null;

  // Crypto-plugin rendered body (S/MIME, PGP, …) — populated by the generic
  // onRenderEmailBody hook. Verification/decryption status UI is provided by the
  // crypto plugin's own email-banner slot, so the host keeps no S/MIME state.
  const [pluginRenderedHtml, setPluginRenderedHtml] = useState<string | null>(null);
  const [pluginRenderedText, setPluginRenderedText] = useState<string | null>(null);
  const [pluginRenderedAttachments, setPluginRenderedAttachments] = useState<PostalMimeAttachment[]>([]);

  // TNEF (winmail.dat) support
  const [tnefHtml, setTnefHtml] = useState<string | null>(null);
  const [tnefText, setTnefText] = useState<string | null>(null);
  const [tnefAttachments, setTnefAttachments] = useState<TnefAttachment[]>([]);

  // Embedded message/rfc822 unwrapping (Outlook forward-as-attachment)
  const [embeddedEmailHtml, setEmbeddedEmailHtml] = useState<string | null>(null);
  const [embeddedEmailText, setEmbeddedEmailText] = useState<string | null>(null);
  const [embeddedEmailAttachments, setEmbeddedEmailAttachments] = useState<PostalMimeAttachment[]>([]);
  const [embeddedEmailUnwrapped, setEmbeddedEmailUnwrapped] = useState(false);

  // Plugin detail sidebar state. Collapsed/width persist across opens and
  // sessions so the panel reopens the way the user last left it.
  const detailSlots = usePluginSlotOffers('email-detail-sidebar');
  const hasDetailSidebar = detailSlots.length > 0;
  // Whether any plugin offers a "more details" section, so we only render the
  // bottom plugin category wrapper when something will fill it.
  const hasDetailsSlotOffers = usePluginSlotOffers('email-details-section').length > 0;
  const [detailSidebarCollapsed, setDetailSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try { return localStorage.getItem('emailDetailSidebarCollapsed') === '1'; } catch { return false; }
  });
  const [detailSidebarWidth, setDetailSidebarWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 280;
    try {
      const n = parseInt(localStorage.getItem('emailDetailSidebarWidth') ?? '', 10);
      return Number.isFinite(n) ? Math.max(200, Math.min(500, n)) : 280;
    } catch { return 280; }
  });
  const detailSidebarWidthRef = useRef(detailSidebarWidth);

  useEffect(() => {
    try { localStorage.setItem('emailDetailSidebarCollapsed', detailSidebarCollapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [detailSidebarCollapsed]);
  useEffect(() => {
    try { localStorage.setItem('emailDetailSidebarWidth', String(detailSidebarWidth)); } catch { /* ignore */ }
  }, [detailSidebarWidth]);


  // Build mailbox tree for move-to dropdown
  const moveTargetIds = useMemo(() => new Set(
    mailboxes
      .filter(
        (m) =>
          m.id !== selectedMailbox &&
          m.role !== "drafts" &&
          !m.id.startsWith("shared-") &&
          m.myRights?.mayAddItems
      )
      .map((m) => m.id)
  ), [mailboxes, selectedMailbox]);

  const moveTree = useMemo(() => {
    const tree = buildMailboxTree(mailboxes);
    const filterTree = (nodes: MailboxNode[]): MailboxNode[] => {
      return nodes.reduce<MailboxNode[]>((acc, node) => {
        const filteredChildren = filterTree(node.children);
        if (moveTargetIds.has(node.id) || filteredChildren.length > 0) {
          acc.push({ ...node, children: filteredChildren });
        }
        return acc;
      }, []);
    };
    return filterTree(tree);
  }, [mailboxes, moveTargetIds]);

  // Get mailbox icon based on role
  const getMoveMailboxIcon = (role?: string) => {
    switch (role) {
      case "inbox": return Inbox;
      case "sent": return Send;
      case "drafts": return File;
      case "trash": return Trash2;
      case "archive": return Archive;
      default: return Folder;
    }
  };

  // Close dropdown menus on click outside
  useEffect(() => {
    if (!moreMenuOpen && !tagMenuOpen && !moveMenuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (moreMenuOpen && moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
        setMoreMenuSub(null);
      }
      if (tagMenuOpen && tagMenuRef.current && !tagMenuRef.current.contains(e.target as Node)) {
        setTagMenuOpen(false);
      }
      if (moveMenuOpen && moveMenuRef.current && !moveMenuRef.current.contains(e.target as Node)) {
        setMoveMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [moreMenuOpen, tagMenuOpen, moveMenuOpen]);

  // Close dropdowns when email changes
  useEffect(() => {
    setMoreMenuOpen(false);
    setTagMenuOpen(false);
    setMoveMenuOpen(false);
  }, [email?.id]);

  // Dynamically detect which toolbar items overflow and should move to the More menu
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;

    let rafId: number | null = null;

    const calculate = () => {
      rafId = null;
      const items = Array.from(el.querySelectorAll<HTMLElement>('[data-overflow-item]'));
      if (items.length === 0) {
        setHiddenPriorities(prev => prev.size === 0 ? prev : new Set());
        return;
      }
      // Sort descending by priority so highest number (least important) is hidden first
      items.sort((a, b) =>
        Number(b.dataset.overflowPriority || 0) - Number(a.dataset.overflowPriority || 0)
      );
      // Show all items to measure their natural widths
      items.forEach(item => { item.style.display = ''; });
      const containerWidth = el.clientWidth;
      const leftGroup = el.firstElementChild as HTMLElement;
      const rightGroup = el.lastElementChild as HTMLElement;
      const mainGap = parseFloat(getComputedStyle(el).gap) || 0;
      // Temporarily prevent flex shrinking so we can measure natural widths
      leftGroup.style.flexShrink = '0';
      rightGroup.style.flexShrink = '0';
      el.style.overflow = 'hidden';
      // Iteratively hide items until content fits
      const hidden = new Set<number>();
      const isOverflowing = () =>
        leftGroup.scrollWidth + rightGroup.scrollWidth + mainGap > containerWidth + 1;
      for (const item of items) {
        if (!isOverflowing()) break;
        // Skip items already hidden by CSS (e.g., on mobile)
        if (item.offsetWidth === 0) continue;
        item.style.display = 'none';
        hidden.add(Number(item.dataset.overflowPriority));
      }
      // Restore layout
      leftGroup.style.flexShrink = '';
      rightGroup.style.flexShrink = '';
      el.style.overflow = '';
      setHiddenPriorities(prev => {
        if (prev.size === hidden.size && [...hidden].every(p => prev.has(p))) return prev;
        return hidden;
      });
    };

    const scheduleCalculate = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(calculate);
    };

    // Recalculate on container resize
    const resizeObserver = new ResizeObserver(scheduleCalculate);
    resizeObserver.observe(el);

    // Recalculate when children change (conditional items, label visibility)
    const mutationObserver = new MutationObserver(scheduleCalculate);
    mutationObserver.observe(el, { childList: true, subtree: true });

    // Initial synchronous calculation to avoid flash
    calculate();

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [
    toolbarPosition,
    email?.id,
    showToolbarLabels,
    isLoading,
    moveTree.length,
    colorOptions.length,
    currentColor,
    isInJunkFolder,
    isTablet,
    tabletListVisible,
    onBack,
    onMarkAsSpam,
    onUndoSpam,
  ]);

  // Contact sidebar state
  const [contactSidebarEmail, setContactSidebarEmail] = useState<string | null>(null);
  const contacts = useContactStore((s) => s.contacts);
  const { isMobile: isMobileDevice } = useDeviceDetection();
  const router = useRouter();

  const handleViewContactSidebar = (contact: ContactCard | null, recipientEmail: string) => {
    if (isMobileDevice) {
      // No room for a sidebar on mobile - send the user to the contacts page
      // with params describing what to show. The `from=email` flag turns the
      // page's mobile back button into a router.back() that returns here.
      const allRecipients = [
        ...(email?.from || []),
        ...(email?.to || []),
        ...(email?.cc || []),
        ...(email?.bcc || []),
        ...(email?.replyTo || []),
      ];
      const recipientName = allRecipients.find(
        (r) => r.email.toLowerCase() === recipientEmail.toLowerCase()
      )?.name;
      const params = new URLSearchParams();
      if (contact) {
        params.set('contactId', contact.id);
      } else {
        params.set('addEmail', recipientEmail);
        if (recipientName) params.set('addName', recipientName);
      }
      params.set('from', 'email');
      router.push(`/contacts?${params.toString()}`);
      return;
    }
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

  const autoMarkedEmailRef = useRef<string | null>(null);

  // Reset auto-mark tracking when email changes
  useEffect(() => {
    autoMarkedEmailRef.current = null;
  }, [email?.id]);

  useEffect(() => {
    // Mark as read when email is viewed, respecting the delay setting
    if (!email || !onMarkAsRead) {
      return;
    }

    // Already read - record that so manual unread toggle won't re-trigger auto-mark
    if (email.keywords?.$seen) {
      autoMarkedEmailRef.current = email.id;
      return;
    }

    // Don't re-trigger if we already auto-marked this email (user may have toggled it back to unread)
    if (autoMarkedEmailRef.current === email.id) {
      return;
    }

    const markAsReadDelay = useSettingsStore.getState().markAsReadDelay;

    // Never auto-mark
    if (markAsReadDelay === -1) {
      return;
    }

    // Instant mark
    if (markAsReadDelay === 0) {
      autoMarkedEmailRef.current = email.id;
      onMarkAsRead(email.id, true);
      return;
    }

    // Delayed mark
    const timeout = setTimeout(() => {
      autoMarkedEmailRef.current = email.id;
      onMarkAsRead(email.id, true);
    }, markAsReadDelay);

    return () => clearTimeout(timeout);
    // Keyed to email id + $seen only: depending on the whole `email` object
    // would reset the mark-as-read delay timer whenever any unrelated email
    // field updates (e.g. a background re-fetch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setEmailViewDarkOverride(null);
    setPluginRenderedHtml(null);
    setPluginRenderedText(null);
    setPluginRenderedAttachments([]);
    setTnefHtml(null);
    setTnefText(null);
    setTnefAttachments([]);
    setEmbeddedEmailHtml(null);
    setEmbeddedEmailText(null);
    setEmbeddedEmailAttachments([]);
    setEmbeddedEmailUnwrapped(false);
  }, [email?.id, externalContentPolicy]);

  // Crypto-plugin body takeover (S/MIME, PGP, …). A privileged crypto plugin
  // can fetch the raw message via api.jmap.fetchBlob, decrypt/verify it, and
  // return a replaced body through the onRenderEmailBody hook. The host stays
  // crypto-agnostic; the plugin renders its own verification/encryption status
  // via its email-banner slot. Falls through to normal rendering otherwise.
  useEffect(() => {
    if (!email) return;
    let cancelled = false;

    const dataUrlToBytes = (dataUrl: string): Uint8Array | null => {
      try {
        const comma = dataUrl.indexOf(',');
        if (comma < 0) return null;
        const meta = dataUrl.slice(0, comma);
        const data = dataUrl.slice(comma + 1);
        if (meta.includes(';base64')) {
          const bin = atob(data);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          return u8;
        }
        return new TextEncoder().encode(decodeURIComponent(data));
      } catch {
        return null;
      }
    };

    (async () => {
      try {
        const rawContentType = email.headers?.['content-type'] || email.headers?.['Content-Type'];
        const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
        const initialBody = { html: '', text: '', attachments: [] as unknown[] };
        const ctx = {
          id: email.id,
          contentType,
          bodyStructure: email.bodyStructure,
          attachments: email.attachments,
          blobId: email.blobId,
          from: email.from,
        };
        const result = await renderHooks.onRenderEmailBody.transform(initialBody, ctx) as {
          html?: string;
          text?: string;
          attachments?: Array<{ name?: string; type?: string; size?: number; dataUrl?: string; cid?: string }>;
          handledBy?: string;
        };
        if (cancelled) return;
        if (!result || !result.handledBy) {
          setPluginRenderedHtml(null);
          setPluginRenderedText(null);
          setPluginRenderedAttachments([]);
          return;
        }
        setPluginRenderedHtml(typeof result.html === 'string' && result.html ? result.html : null);
        setPluginRenderedText(typeof result.text === 'string' && result.text ? result.text : null);
        // Normalise the plugin's attachment shape into the PostalMime-like shape
        // the viewer's download / inline-image machinery already understands.
        const atts = Array.isArray(result.attachments) ? result.attachments : [];
        const decoded = atts.map((a) => ({
          filename: a.name ?? null,
          mimeType: a.type || 'application/octet-stream',
          contentId: a.cid,
          content: (a.dataUrl ? dataUrlToBytes(a.dataUrl) : null) ?? new Uint8Array(0),
        } as unknown as PostalMimeAttachment));
        setPluginRenderedAttachments(decoded);
      } catch (err) {
        if (cancelled) return;
        debug.error('onRenderEmailBody hook failed:', err);
        setPluginRenderedHtml(null);
        setPluginRenderedText(null);
        setPluginRenderedAttachments([]);
      }
    })();

    return () => { cancelled = true; };
  }, [email]);

  // TNEF (winmail.dat) detection and processing
  useEffect(() => {
    if (!email?.attachments || !client) return;

    const tnefAtt = email.attachments.find(att => isTnefAttachment(att.name, att.type));
    if (!tnefAtt?.blobId) {
      debug.log('email', 'TNEF: No winmail.dat attachment found in email', email?.id);
      return;
    }

    debug.group('TNEF Processing', 'email');
    debug.log('email', 'Found TNEF attachment:', tnefAtt.name, 'type:', tnefAtt.type, 'blobId:', tnefAtt.blobId, 'size:', tnefAtt.size);

    // Check if the email already has a usable HTML body with real content
    // Outlook often forwards TNEF emails with an HTML body that's just Word
    // boilerplate (CSS + &nbsp;) - treat these as effectively empty.
    const htmlPartId = email.htmlBody?.[0]?.partId;
    const htmlValue = htmlPartId ? email.bodyValues?.[htmlPartId]?.value?.trim() : '';
    let hasRealHtmlBody = !!htmlValue;
    if (hasRealHtmlBody && htmlValue && isHtmlBodyEffectivelyEmpty(htmlValue)) {
      hasRealHtmlBody = false;
      debug.log('email', 'TNEF: Email HTML body is effectively empty (only boilerplate/whitespace), treating as no body');
    }
    if (hasRealHtmlBody) {
      debug.log('email', 'TNEF: Email has real HTML body, will extract attachments only');
    } else {
      debug.log('email', 'TNEF: Email has no usable HTML body, proceeding with full TNEF extraction');
    }

    let cancelled = false;

    async function processTnef() {
      try {
        debug.time('TNEF fetch blob', 'email');
        const blobBytes = await client!.fetchBlobArrayBuffer(tnefAtt!.blobId!);
        debug.timeEnd('TNEF fetch blob', 'email');
        debug.log('email', 'TNEF: Fetched blob, size:', blobBytes.byteLength, 'bytes');

        if (cancelled) {
          debug.log('email', 'TNEF: Processing cancelled after fetch');
          debug.groupEnd();
          return;
        }
        if (blobBytes.byteLength === 0) {
          debug.warn('email', 'TNEF: Fetched blob is empty (0 bytes)');
          debug.groupEnd();
          return;
        }

        const tnefData = new Uint8Array(blobBytes);
        debug.time('TNEF parse', 'email');
        const parsed = parseTnef(tnefData);
        debug.timeEnd('TNEF parse', 'email');

        if (cancelled) {
          debug.log('email', 'TNEF: Processing cancelled after parse');
          debug.groupEnd();
          return;
        }

        debug.log('email', 'TNEF parse result - htmlBody:', !!parsed.htmlBody, '(' + (parsed.htmlBody?.length ?? 0) + ' chars)', ', body:', !!parsed.body, '(' + (parsed.body?.length ?? 0) + ' chars)', ', attachments:', parsed.attachments.length);

        if (parsed.htmlBody && !hasRealHtmlBody) {
          setTnefHtml(parsed.htmlBody);
        }
        if (parsed.body && !hasRealHtmlBody) {
          setTnefText(parsed.body);
        }
        if (parsed.attachments.length > 0) {
          setTnefAttachments(parsed.attachments);
          debug.log('email', 'TNEF extracted attachments:', parsed.attachments.map(a => a.name + ' (' + a.mimeType + ', ' + a.data.byteLength + ' bytes)').join(', '));
        }

        if (!parsed.htmlBody && !parsed.body && parsed.attachments.length === 0) {
          debug.warn('email', 'TNEF: Parsing succeeded but no content was extracted - the winmail.dat may use an unsupported format');
        }

        debug.groupEnd();
      } catch (err) {
        debug.error('TNEF processing failed for email', email?.id, err);
        debug.groupEnd();
      }
    }

    processTnef();

    return () => { cancelled = true; };
  }, [email, client]);

  // Embedded message/rfc822 unwrapping
  // When Outlook forwards an email as an attachment, the outer email body is
  // often empty Word boilerplate and the real content is inside a message/rfc822
  // attachment. Detect this pattern and unwrap the embedded email.
  useEffect(() => {
    if (!email?.attachments || !client) return;

    // Find message/rfc822 attachment
    const rfc822Att = email.attachments.find(
      att => att.type === 'message/rfc822' && att.blobId
    );
    if (!rfc822Att?.blobId) return;

    // Only unwrap if the outer body is effectively empty
    const htmlPartId = email.htmlBody?.[0]?.partId;
    const htmlValue = htmlPartId ? email.bodyValues?.[htmlPartId]?.value?.trim() : '';
    const textPartId = email.textBody?.[0]?.partId;
    const textValue = textPartId ? email.bodyValues?.[textPartId]?.value?.trim() : '';

    const hasRealHtml = !!htmlValue && !isHtmlBodyEffectivelyEmpty(htmlValue);
    const hasRealText = !!textValue;

    if (hasRealHtml || hasRealText) {
      debug.log('email', 'Embedded RFC822: Outer email has real body content, not unwrapping');
      return;
    }

    debug.group('Embedded RFC822 Unwrapping', 'email');
    debug.log('email', 'Found message/rfc822 attachment:', rfc822Att.name, 'blobId:', rfc822Att.blobId, 'size:', rfc822Att.size);
    debug.log('email', 'Outer email body is empty, will unwrap embedded email');

    let cancelled = false;

    async function unwrapEmbedded() {
      try {
        const blobBytes = await client!.fetchBlobArrayBuffer(rfc822Att!.blobId!);
        if (cancelled) { debug.groupEnd(); return; }
        if (blobBytes.byteLength === 0) {
          debug.warn('email', 'Embedded RFC822: Fetched blob is empty');
          debug.groupEnd();
          return;
        }

        const { default: PostalMime } = await import('postal-mime');
        const parser = new PostalMime();
        const parsed = await parser.parse(new Uint8Array(blobBytes));
        if (cancelled) { debug.groupEnd(); return; }

        debug.log('email', 'Embedded RFC822 parsed - html:', !!parsed.html, '(' + (parsed.html?.length ?? 0) + ' chars)',
          ', text:', !!parsed.text, '(' + (parsed.text?.length ?? 0) + ' chars)',
          ', attachments:', parsed.attachments?.length ?? 0);

        if (parsed.html) {
          setEmbeddedEmailHtml(parsed.html);
        }
        if (parsed.text) {
          setEmbeddedEmailText(parsed.text);
        }
        if (parsed.attachments && parsed.attachments.length > 0) {
          setEmbeddedEmailAttachments(parsed.attachments as PostalMimeAttachment[]);
          debug.log('email', 'Embedded RFC822 attachments:', parsed.attachments.map(
            a => (a.filename || 'unnamed') + ' (' + a.mimeType + ')'
          ).join(', '));
        }
        setEmbeddedEmailUnwrapped(true);
        debug.groupEnd();
      } catch (err) {
        debug.error('Embedded RFC822 unwrapping failed:', err);
        debug.groupEnd();
      }
    }

    unwrapEmbedded();

    return () => { cancelled = true; };
  }, [email, client]);

  // Fetch inline CID images with authentication to prevent browser auth dialogs
  useEffect(() => {
    let cancelled = false;
    const objectUrls: string[] = [];

    const decryptedCidAttachments = pluginRenderedAttachments.filter(att => att.contentId);
    if (decryptedCidAttachments.length > 0) {
      const urls: Record<string, string> = {};

      decryptedCidAttachments.forEach((att) => {
        const bytes = getAttachmentContentBytes(att);
        if (!bytes) return;
        const cidValue = att.contentId!.replace(/^<|>$/g, '');
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const blob = new Blob([buffer], { type: att.mimeType || 'application/octet-stream' });
        const objectUrl = URL.createObjectURL(blob);
        urls[cidValue] = objectUrl;
        objectUrls.push(objectUrl);
      });

      setCidBlobUrls(urls);

      return () => {
        cancelled = true;
        objectUrls.forEach(url => URL.revokeObjectURL(url));
      };
    }

    if (!client || !email?.attachments) {
      setCidBlobUrls({});
      return;
    }

    const cidAttachments = email.attachments.filter(att => att.cid && att.blobId);
    if (cidAttachments.length === 0) {
      setCidBlobUrls({});
      return;
    }

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
  }, [client, email?.id, pluginRenderedAttachments, email?.attachments]);

  const effectiveAttachments = useMemo<EffectiveAttachment[]>(() => {
    if (pluginRenderedAttachments.length > 0) {
      return pluginRenderedAttachments
        .filter(att => !(hideInlineImageAttachments && att.contentId && (att.mimeType || '').startsWith('image/')))
        .map((attachment, index) => ({
          id: `smime-${index}-${attachment.filename || attachment.mimeType}`,
          name: attachment.filename,
          type: attachment.mimeType || 'application/octet-stream',
          size: getPostalMimeAttachmentSize(attachment),
          cid: attachment.contentId,
          decryptedAttachment: attachment,
        }));
    }

    const hasCalInvitation = calendarInvitationParsingEnabled && !!email && !!findCalendarAttachment(email);
    const jmapAttachments = (email?.attachments ?? [])
      // Hide winmail.dat when we have successfully extracted TNEF content or attachments
      .filter(att => !(tnefHtml || tnefText || tnefAttachments.length > 0) || !isTnefAttachment(att.name, att.type))
      // Hide message/rfc822 when we have unwrapped the embedded email
      .filter(att => !embeddedEmailUnwrapped || att.type !== 'message/rfc822')
      // Hide calendar MIME parts (text/calendar, application/ics) when the invitation
      // banner is shown - prevents raw ICS files appearing as spurious attachments.
      .filter(att => !hasCalInvitation || !isCalendarMimeType(att.type))
      // Hide inline cid-referenced images when the user has opted to keep them
      // out of the attachment list (default on): these are embedded in the body.
      .filter(att => !(hideInlineImageAttachments && att.cid && att.disposition === 'inline' && (att.type || '').startsWith('image/')))
      // Hide machine-readable report parts (MDN read-receipts, DSN bounce
      // reports). These are required MIME parts, not real user attachments.
      .filter(att => att.type !== 'message/disposition-notification' && att.type !== 'message/delivery-status')
      .map((attachment, index) => ({
        id: attachment.blobId || `${attachment.name || 'attachment'}-${index}`,
        name: attachment.name || null,
        type: attachment.type || 'application/octet-stream',
        size: attachment.size,
        blobId: attachment.blobId,
        cid: attachment.cid,
      }));

    // Append attachments extracted from TNEF
    const tnefExtracted: EffectiveAttachment[] = tnefAttachments.map((att, index) => ({
      id: `tnef-${index}-${att.name}`,
      name: att.name,
      type: att.mimeType,
      size: att.data.byteLength,
      tnefData: att.data,
    }));

    // Append attachments extracted from embedded message/rfc822
    const embeddedExtracted: EffectiveAttachment[] = embeddedEmailAttachments
      .filter(att => !att.contentId) // Skip inline CID images
      .map((att, index) => ({
        id: `embedded-${index}-${att.filename || att.mimeType}`,
        name: att.filename || null,
        type: att.mimeType || 'application/octet-stream',
        size: getPostalMimeAttachmentSize(att),
        decryptedAttachment: att,
      }));

    return [...jmapAttachments, ...tnefExtracted, ...embeddedExtracted];
    // The memo derives only from `email.attachments` (findCalendarAttachment
    // scans that array); depending on the whole `email` object would rebuild the
    // attachment list — and its downstream layout measurement — on every email
    // field change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email?.attachments, pluginRenderedAttachments, tnefHtml, tnefText, tnefAttachments, embeddedEmailUnwrapped, embeddedEmailAttachments, calendarInvitationParsingEnabled, hideInlineImageAttachments]);

  // Measure attachment chips in the below-header row to determine how many fit
  // on a single line; the rest collapse into a "+N attachments" overflow pill.
  useLayoutEffect(() => {
    if (attachmentPosition !== 'below-header' || effectiveAttachments.length === 0) {
      setVisibleBelowHeaderCount(null);
      return;
    }
    const container = belowHeaderRowRef.current;
    const ghost = belowHeaderGhostRef.current;
    if (!container || !ghost) return;

    const measure = () => {
      const containerWidth = container.clientWidth;
      const chips = Array.from(ghost.children) as HTMLElement[];
      if (chips.length === 0) return;
      const ghostLeft = ghost.getBoundingClientRect().left;
      // Reserve space for the "+N attachments" overflow pill
      const RESERVED = 140;
      let count = chips.length;
      for (let i = 0; i < chips.length; i++) {
        const right = chips[i].getBoundingClientRect().right - ghostLeft;
        const isLast = i === chips.length - 1;
        const limit = isLast ? containerWidth : containerWidth - RESERVED;
        if (right > limit) {
          count = i;
          break;
        }
      }
      setVisibleBelowHeaderCount(count >= chips.length ? null : Math.max(1, count));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    return () => ro.disconnect();
  }, [effectiveAttachments, attachmentPosition, imageThumbUrls]);

  // Generate email source for viewing
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
    if (!email) return { html: "", isHtml: false, hasStyleTag: false, externalBlocked: false };

    // Check if we have body values
    if (email.bodyValues) {
      // Check if HTML content exists and if it's actually rich HTML or just plain text wrapper
      let useHtmlVersion = false;
      let htmlContent = '';

      if (email.htmlBody?.[0]?.partId && email.bodyValues[email.htmlBody[0].partId]) {
        htmlContent = email.bodyValues[email.htmlBody[0].partId].value;
        // Per RFC 8621 § 4.1.4, when a message has only one alternative the server
        // exposes the same part in both htmlBody and textBody. The shared part may
        // actually be text/plain (plain-text-only mail) - rendering that as HTML
        // collapses newlines and skips linkification, so route by the part's type.
        const htmlPart = email.htmlBody[0];
        if (htmlPart.type && htmlPart.type.toLowerCase() !== 'text/html') {
          useHtmlVersion = false;
        } else {
          // Prefer textBody when HTML is auto-generated minimal wrapper (no rich formatting).
          // Server-generated HTML from text/plain emails often lacks <br> tags, collapsing newlines.
          const textPartId = email.textBody?.[0]?.partId;
          const htmlPartId = htmlPart.partId;
          const hasDistinctTextBody = !!textPartId && textPartId !== htmlPartId && !!email.bodyValues[textPartId];
          if (hasDistinctTextBody && htmlContent) {
            useHtmlVersion = hasMeaningfulHtmlBody(htmlContent);
          } else {
            useHtmlVersion = !!htmlContent;
          }
        }
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
        const sanitizeConfig = { ...EMAIL_IFRAME_SANITIZE_CONFIG };

        // Check if sender is trusted (localStorage list or address book)
        const senderEmail = email.from?.[0]?.email?.toLowerCase();
        const senderIsTrusted = senderEmail
          ? isSenderTrusted(senderEmail) || (trustedSendersAddressBook && isTrustedAddressBookSender(senderEmail))
          : false;

        // Block external content based on policy:
        // 'allow' = never block, 'block' = always block (unless trusted), 'ask' = block until user allows or trusted
        const shouldBlockExternal = !senderIsTrusted && (
          externalContentPolicy === 'block' ||
          (externalContentPolicy === 'ask' && !allowExternalContent)
        );

        if (shouldBlockExternal) {
          sanitizeConfig.FORBID_TAGS = [...sanitizeConfig.FORBID_TAGS, 'link'];
        }

        DOMPurify.addHook('afterSanitizeAttributes', (node) => {
          if (shouldBlockExternal) {
            // Blocks every external-resource vector (img src incl.
            // whitespace/newline tricks, srcset, <source>, <video poster>,
            // media src, background attr, inline style url() incl. CSS
            // escapes). The strict iframe CSP below is the network backstop.
            if (blockExternalResourcesOnNode(node)) {
              blockedExternalContent = true;
            }
          }

          if (node.tagName === 'A') {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
          }

          // No dark mode color transforms - emails render true-to-life in iframe
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
          isHtml: true,
          hasStyleTag: /<style[\s>]/i.test(htmlContent),
          // Drives the strict iframe CSP: when we're in blocking mode the
          // iframe forbids external img/media/font fetches entirely, so any
          // vector the DOM walk above missed (e.g. <style>-tag url()) still
          // can't phone home. Cleared once the user allows / trusts.
          externalBlocked: shouldBlockExternal,
        };
      }

      // Use text content if available (either as fallback or when HTML is minimal)
      if (email.textBody?.[0]?.partId && email.bodyValues[email.textBody[0].partId]) {
        const textContent = email.bodyValues[email.textBody[0].partId].value;

        return {
          html: plainTextToSafeHtml(textContent),
          isHtml: false,
          hasStyleTag: false,
          externalBlocked: false,
        };
      }
    }

    // If no body content is available, show the preview or a message
    if (email.preview) {
      const previewHtml = email.preview
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      return {
        html: `<div style="color: var(--color-muted-foreground); font-style: italic;">${previewHtml}</div>`,
        isHtml: false,
        hasStyleTag: false,
        externalBlocked: false,
      };
    }

    return {
      html: `<p style="color: var(--color-muted-foreground); font-style: italic;">${t('no_body_content')}</p>`,
      isHtml: false,
      hasStyleTag: false,
      externalBlocked: false,
    };
    // Recompute when permission changes so the srcDoc rebuilds with the
    // unblocked content AND the permissive CSP. The strict blocking-mode CSP
    // can't be relaxed in place (a document's CSP is fixed at load), so the
    // "Load images" / "Trust sender" buttons (both flip allowExternalContent)
    // intentionally trigger a fresh srcDoc. Trust selectors are read inside and
    // re-read on that rebuild, so they're deliberately omitted from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, externalContentPolicy, allowExternalContent, cidBlobUrls, t]);

  // Override email content with S/MIME decrypted content when available
  const effectiveEmailContent = useMemo(() => {
    if (pluginRenderedHtml) {
      const htmlWithCidUrls = pluginRenderedHtml.replace(
        /\bcid:([^"'\s)]+)/gi,
        (_match, cidRef) => {
          return cidBlobUrls[cidRef] || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        }
      );
      const cleanHtml = DOMPurify.sanitize(htmlWithCidUrls, EMAIL_IFRAME_SANITIZE_CONFIG);
      return { html: cleanHtml, isHtml: true, hasStyleTag: /<style[\s>]/i.test(pluginRenderedHtml), externalBlocked: false };
    }
    if (pluginRenderedText) {
      return { html: plainTextToSafeHtml(pluginRenderedText), isHtml: false, hasStyleTag: false, externalBlocked: false };
    }
    // TNEF (winmail.dat) extracted content
    if (tnefHtml) {
      const cleanHtml = DOMPurify.sanitize(tnefHtml, EMAIL_IFRAME_SANITIZE_CONFIG);
      return { html: cleanHtml, isHtml: true, hasStyleTag: /<style[\s>]/i.test(tnefHtml), externalBlocked: false };
    }
    if (tnefText) {
      return { html: plainTextToSafeHtml(tnefText), isHtml: false, hasStyleTag: false, externalBlocked: false };
    }
    // Embedded message/rfc822 unwrapped content
    if (embeddedEmailHtml) {
      const cleanHtml = DOMPurify.sanitize(embeddedEmailHtml, EMAIL_IFRAME_SANITIZE_CONFIG);
      return { html: cleanHtml, isHtml: true, hasStyleTag: /<style[\s>]/i.test(embeddedEmailHtml), externalBlocked: false };
    }
    if (embeddedEmailText) {
      return { html: plainTextToSafeHtml(embeddedEmailText), isHtml: false, hasStyleTag: false, externalBlocked: false };
    }
    return emailContent;
  }, [cidBlobUrls, emailContent, pluginRenderedHtml, pluginRenderedText, tnefHtml, tnefText, embeddedEmailHtml, embeddedEmailText]);

  const resolveAttachmentName = useCallback(
    (attachment: EffectiveAttachment) => {
      const fallback = attachment.name || 'download';
      if (!email) return fallback;
      return attachmentDownloadFilename(email, { name: attachment.name, type: attachment.type }, attachmentFilenameOptions) || fallback;
    },
    [email, attachmentFilenameOptions],
  );

  const handleEffectiveAttachmentOpen = useCallback(async (attachment: EffectiveAttachment) => {
    const isPreviewable = isFilePreviewable(attachment.name || undefined, attachment.type);
    // Blob URLs inherit our origin; script-bearing MIME types (text/html,
    // image/svg+xml, etc.) would execute as the webmail origin if opened
    // top-level. Force the download path for anything not on the inert allowlist.
    const opensPreview = isPreviewable
      && mailAttachmentAction === 'preview'
      && isMimeTypeSafeForInlinePreview(attachment.type);

    const downloadName = resolveAttachmentName(attachment);

    const info: AttachmentInfo = {
      name: attachment.name || '',
      type: attachment.type,
      size: attachment.size,
      blobId: attachment.blobId,
      emailId: email?.id,
    };

    if (attachment.blobId && onDownloadAttachment) {
      emailHooks.onAttachmentDownload.emit(info);
      onDownloadAttachment(attachment.blobId, downloadName, attachment.type);
      return;
    }

    // Handle TNEF-extracted attachments
    if (attachment.tnefData) {
      const buffer = attachment.tnefData.buffer.slice(
        attachment.tnefData.byteOffset,
        attachment.tnefData.byteOffset + attachment.tnefData.byteLength,
      ) as ArrayBuffer;
      const blob = new Blob([buffer], { type: attachment.type || 'application/octet-stream' });
      const objectUrl = URL.createObjectURL(blob);

      if (opensPreview) {
        const transformed = await emailHooks.onAttachmentPreview.transform({ previewUrl: objectUrl } as AttachmentPreview, info);
        window.open(transformed.previewUrl || objectUrl, '_blank', 'noopener,noreferrer');
      } else {
        emailHooks.onAttachmentDownload.emit(info);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = downloadName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }

      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      return;
    }

    if (!attachment.decryptedAttachment) {
      return;
    }

    const bytes = getAttachmentContentBytes(attachment.decryptedAttachment);
    if (!bytes || bytes.byteLength === 0) {
      return;
    }

    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const blob = new Blob([buffer], { type: attachment.type || 'application/octet-stream' });
    const objectUrl = URL.createObjectURL(blob);

    if (opensPreview) {
      const transformed = await emailHooks.onAttachmentPreview.transform({ previewUrl: objectUrl } as AttachmentPreview, info);
      window.open(transformed.previewUrl || objectUrl, '_blank', 'noopener,noreferrer');
    } else {
      emailHooks.onAttachmentDownload.emit(info);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = downloadName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }

    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }, [mailAttachmentAction, onDownloadAttachment, email, resolveAttachmentName]);

  const handleEffectiveAttachmentDownload = useCallback((attachment: EffectiveAttachment) => {
    const downloadName = resolveAttachmentName(attachment);
    const info: AttachmentInfo = {
      name: attachment.name || '',
      type: attachment.type,
      size: attachment.size,
      blobId: attachment.blobId,
      emailId: email?.id,
    };
    emailHooks.onAttachmentDownload.emit(info);
    if (attachment.blobId && onDownloadAttachment) {
      onDownloadAttachment(attachment.blobId, downloadName, attachment.type, true);
      return;
    }

    if (attachment.tnefData) {
      const buffer = attachment.tnefData.buffer.slice(
        attachment.tnefData.byteOffset,
        attachment.tnefData.byteOffset + attachment.tnefData.byteLength,
      ) as ArrayBuffer;
      const blob = new Blob([buffer], { type: attachment.type || 'application/octet-stream' });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = downloadName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      return;
    }

    if (!attachment.decryptedAttachment) return;
    const bytes = getAttachmentContentBytes(attachment.decryptedAttachment);
    if (!bytes || bytes.byteLength === 0) return;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const blob = new Blob([buffer], { type: attachment.type || 'application/octet-stream' });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = downloadName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }, [onDownloadAttachment, email?.id, resolveAttachmentName]);

  // Bundle every attachment of this email into a single .zip and download it.
  // Fetches blob-backed attachments through the JMAP client and reuses already
  // decoded bytes for S/MIME-decrypted and TNEF-extracted ones. Individual
  // failures are skipped so a single bad blob doesn't sink the whole archive.
  const handleDownloadAllAttachments = useCallback(async () => {
    if (isDownloadingAll || effectiveAttachments.length === 0) return;
    setIsDownloadingAll(true);
    try {
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      const used = new Set<string>();
      // Zip entries must be unique; suffix collisions with " (n)" before the
      // extension so duplicates stay recognisable.
      const uniqueName = (raw: string): string => {
        const base = raw || 'attachment';
        if (!used.has(base)) { used.add(base); return base; }
        const dot = base.lastIndexOf('.');
        const stem = dot > 0 ? base.slice(0, dot) : base;
        const ext = dot > 0 ? base.slice(dot) : '';
        let i = 1;
        let candidate = `${stem} (${i})${ext}`;
        while (used.has(candidate)) { i++; candidate = `${stem} (${i})${ext}`; }
        used.add(candidate);
        return candidate;
      };

      let added = 0;
      for (const attachment of effectiveAttachments) {
        const entryName = uniqueName(getAttachmentDisplayName(attachment.name, attachment.type));
        try {
          if (attachment.blobId && client) {
            const blob = await client.fetchBlob(attachment.blobId, attachment.name || entryName, attachment.type);
            zip.file(entryName, blob);
            added++;
          } else if (attachment.tnefData) {
            zip.file(entryName, attachment.tnefData);
            added++;
          } else if (attachment.decryptedAttachment) {
            const bytes = getAttachmentContentBytes(attachment.decryptedAttachment);
            if (bytes && bytes.byteLength > 0) {
              zip.file(entryName, bytes);
              added++;
            }
          }
        } catch {
          // Skip individual failures; remaining attachments still bundle.
        }
      }

      if (added === 0) return;

      const zipBlob = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' });
      const objectUrl = URL.createObjectURL(zipBlob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = attachmentsBundleFilename(email);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } finally {
      setIsDownloadingAll(false);
    }
  }, [isDownloadingAll, effectiveAttachments, client, email]);

  // Shared "Download all" chip, shown only when bundling is worthwhile (2+).
  const downloadAllButton = effectiveAttachments.length > 1 ? (
    <button
      onClick={(e) => { e.stopPropagation(); handleDownloadAllAttachments(); }}
      disabled={isDownloadingAll}
      title={t('download_all')}
      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-md border border-border/50 transition-colors flex-shrink-0 disabled:opacity-60 disabled:cursor-wait"
    >
      {isDownloadingAll
        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
        : <FileArchive className="w-3.5 h-3.5" />}
      {t('download_all')}
    </button>
  ) : null;

  // Pre-fetch object URLs for image attachments so their actual contents can be
  // rendered as thumbnails inside the chip. Skips images larger than 10 MB.
  useEffect(() => {
    let cancelled = false;
    const createdUrls: string[] = [];

    if (!attachmentImagePreviewsEnabled) {
      setImageThumbUrls({});
      return;
    }

    const imageAttachments = effectiveAttachments.filter(
      (att) => (att.type || '').startsWith('image/') && att.size <= 10_000_000,
    );

    if (imageAttachments.length === 0) {
      setImageThumbUrls({});
      return;
    }

    (async () => {
      const next: Record<string, string> = {};
      await Promise.all(imageAttachments.map(async (att) => {
        let url: string | undefined;
        try {
          if (att.blobId && client) {
            url = await client.fetchBlobAsObjectUrl(att.blobId, att.name || 'thumb', att.type);
          } else if (att.decryptedAttachment) {
            const bytes = getAttachmentContentBytes(att.decryptedAttachment);
            if (!bytes || bytes.byteLength === 0) return;
            const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
            url = URL.createObjectURL(new Blob([buffer], { type: att.type || 'application/octet-stream' }));
          } else if (att.tnefData) {
            const buffer = att.tnefData.buffer.slice(
              att.tnefData.byteOffset,
              att.tnefData.byteOffset + att.tnefData.byteLength,
            ) as ArrayBuffer;
            url = URL.createObjectURL(new Blob([buffer], { type: att.type || 'application/octet-stream' }));
          }
        } catch {
          return;
        }
        if (!url) return;
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        createdUrls.push(url);
        next[att.id] = url;
      }));
      if (!cancelled) setImageThumbUrls(next);
    })();

    return () => {
      cancelled = true;
      createdUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [effectiveAttachments, client, attachmentImagePreviewsEnabled]);

  // Iframe for rendering HTML emails true-to-life
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Detect if the email HTML has native dark mode support
  const emailHasNativeDarkMode = useMemo(() => {
    if (!effectiveEmailContent.isHtml) return false;
    return /prefers-color-scheme\s*:\s*dark/i.test(effectiveEmailContent.html);
  }, [effectiveEmailContent.html, effectiveEmailContent.isHtml]);

  const emailAlwaysLightMode = useSettingsStore((state) => state.emailAlwaysLightMode);
  const [emailViewDarkOverride, setEmailViewDarkOverride] = useState<boolean | null>(null);
  const isDark = emailViewDarkOverride !== null
    ? emailViewDarkOverride
    : (emailAlwaysLightMode ? false : resolvedTheme === 'dark');

  const emailIframeSrcDoc = useMemo(() => {
    if (!effectiveEmailContent.isHtml) return '';

    // If email has native dark mode, let it handle its own theming
    // Otherwise, use CSS filter inversion for dark mode (preserves layout)
    // Re-invert leaf media elements so they appear normal.
    //
    // Background-COLOR containers (bgcolor, background: shorthand) are
    // re-inverted so their fill flips to a dark tone, but skipped when they
    // wrap media: the inner image already gets its own re-invert, and a filter
    // on the container would double-invert it. Nested color containers must NOT
    // stack another invert either - each filter toggles the inversion, so an
    // odd number of stacked filters (body + outer + inner) lands back on
    // light-on-light; the descendant rule disables filter on a color container
    // nested inside another.
    //
    // Background-IMAGE containers are different: a real photo and whatever is
    // composited over it (headline text, logos) was designed by the sender to
    // read together, so the whole subtree should return to its original
    // light-mode appearance - even when it wraps media. We therefore re-invert
    // these unconditionally (no :has guard) and cancel the per-image re-invert
    // for media inside them, otherwise those images would flip back to inverted.
    const darkModeCSS = isDark && !emailHasNativeDarkMode ? `
      html { background: #121212; }
      body { filter: invert(1) hue-rotate(180deg); background: #ededed; }
      img, video, svg, canvas, object, embed, input[type="image"] {
        filter: invert(1) hue-rotate(180deg);
      }
      [style*="background:"]:not(:has(img, video, svg, canvas, object, embed)),
      [bgcolor]:not(:has(img, video, svg, canvas, object, embed)) {
        filter: invert(1) hue-rotate(180deg);
      }
      :where([style*="background:"], [bgcolor])
        :where([style*="background:"], [bgcolor]):not(:has(img, video, svg, canvas, object, embed)) {
        filter: none !important;
      }
      [style*="background-image"],
      [background] {
        filter: invert(1) hue-rotate(180deg);
      }
      [style*="background-image"] :where(img, video, svg, canvas, object, embed, input[type="image"]),
      [background] :where(img, video, svg, canvas, object, embed, input[type="image"]) {
        filter: none;
      }
    ` : '';

    const colorScheme = isDark && emailHasNativeDarkMode ? 'light dark' : 'light';

    // Bare HTML emails (no <style>) tend to be plain prose without their own
    // layout - give them the same padding as plain-text mails (.email-content-text).
    // Word/Outlook HTML emails ship a <style> block but put their gutter in
    // @page margins (print-only), so they need a fallback body padding too.
    const isWordHtml = /class=["']?(?:Mso|WordSection)|<o:p[\s>/]|urn:schemas-microsoft-com:office:office/i.test(effectiveEmailContent.html);
    const hasOwnLayout = effectiveEmailContent.hasStyleTag && !isWordHtml;
    const bodyPadding = hasOwnLayout ? '0' : '1rem 1.25rem';
    const mobileBodyPaddingX = hasOwnLayout ? '0' : '0.75rem';

    // Word emails rely on empty <p class=MsoNormal>&nbsp;</p> spacers for vertical
    // rhythm. With our default line-height: 1.6 these stack into oversized gaps;
    // tighten to match how Outlook/Gmail render the same source.
    const wordHtmlCSS = isWordHtml ? `
      body { line-height: 1.15; }
      p.MsoNormal, li.MsoNormal, div.MsoNormal { margin: 0 0 6px; }
    ` : '';

    // Defense-in-depth CSP inside srcDoc. default-src 'none' forbids script
    // execution even if the sanitizer ever lets a <script> through.
    //
    // When external content is blocked, img/media/font are restricted to
    // data:/blob: only — this is the network-level backstop for every tracking
    // vector, including ones the DOM-walk blocker can't see (CSS escapes,
    // <style>-tag url(), @font-face). When the user loads/trusts the sender the
    // srcDoc is rebuilt (see emailContent) with the permissive variant so real
    // images, web fonts and media load. cid:/inline images are pre-rewritten to
    // blob: URLs, so they survive the strict variant.
    const iframeCsp = effectiveEmailContent.externalBlocked
      ? "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'; frame-src 'none'"
      : "default-src 'none'; img-src data: blob: http: https:; style-src 'unsafe-inline'; font-src data: http: https:; media-src data: blob: http: https:; base-uri 'none'; form-action 'none'; frame-src 'none'";

    return `<!DOCTYPE html>
<html style="color-scheme: ${colorScheme};"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${iframeCsp}">
<meta name="referrer" content="no-referrer">
<meta http-equiv="x-dns-prefetch-control" content="off">
<style>
  /* Force content height: some emails set html/body { height: 100% }, which -
     combined with overflow:hidden and our scrollHeight-based auto-resize -
     collapses the measured height and clips everything below the fold. The
     height reset is repeated in a trailing <style> after the body content
     (see below): the email's own <style> is injected inside our <body> and so
     lands later in source order, where - at equal specificity and !important -
     it would otherwise win the cascade. */
  /* overflow-y stays hidden so our scrollHeight-based height measurement works;
     overflow-x is auto on the body so an intrinsically wide table (e.g. a
     20-column data table) can scroll horizontally instead of being crushed to
     fit - the latter wraps header text to one character per line, which reads
     as 90deg-rotated vertical headers (issue #409). */
  html { overflow: hidden; height: auto !important; }
  body { margin: 0; padding: ${bodyPadding}; overflow-x: auto; overflow-y: hidden; height: auto !important; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 14px; line-height: 1.6; color: #1a1a1a; background: #ffffff; word-wrap: break-word; overflow-wrap: break-word; }
  @media (max-width: 640px) { body { padding-left: ${mobileBodyPaddingX}; padding-right: ${mobileBodyPaddingX}; } }
  img { max-width: 100% !important; height: auto !important; }
  a { color: #1a73e8; }
  table { max-width: 100% !important; table-layout: auto; overflow-wrap: break-word; }
  /* break-word (not anywhere): break only over-long single words, and keep each
     word's min-content width so columns are not collapsed to a single char. */
  td, th { overflow-wrap: break-word; }
  pre { white-space: pre-wrap; word-wrap: break-word; }
  ${wordHtmlCSS}
  ${darkModeCSS}
</style></head><body>${effectiveEmailContent.html}<style>html,body{height:auto!important;min-height:0!important;max-height:none!important}</style></body></html>`;
  }, [effectiveEmailContent.html, effectiveEmailContent.isHtml, effectiveEmailContent.hasStyleTag, effectiveEmailContent.externalBlocked, isDark, emailHasNativeDarkMode]);

  // Unblocking external content is handled by rebuilding the iframe srcDoc:
  // toggling allowExternalContent (both "Load images" and "Trust sender" set
  // it) recomputes emailContent without blocking and swaps the strict CSP for
  // the permissive one. In-place restore isn't possible because a document's
  // CSP is fixed at load — the strict blocking-mode CSP would keep refusing the
  // restored URLs.

  // Tracks the last rendered body height so the loading skeleton can hold
  // the same size - avoids the body shrink/expand flash when switching emails.
  const lastBodyHeightRef = useRef<number>(300);

  // True while the new email's body is still being fetched. Catches the
  // window between selectedEmail changing and isLoading flipping true, so the
  // quick reply / body don't flicker through a partial render.
  // An empty bodyValues with no referenced parts means the email has no body
  // (e.g. calendar-only invites) - not "still loading".
  const hasBodyParts = (email?.textBody?.length ?? 0) > 0 || (email?.htmlBody?.length ?? 0) > 0;
  const isBodyLoading = isLoading || (hasBodyParts && (!email?.bodyValues || Object.keys(email.bodyValues).length === 0));

  // Gates the quick reply on the iframe having loaded the current srcDoc, so
  // it doesn't flash in below a still-resizing iframe.
  const [iframeReady, setIframeReady] = useState(false);
  useLayoutEffect(() => {
    setIframeReady(false);
  }, [emailIframeSrcDoc]);

  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      const doc = iframe.contentDocument;
      if (doc?.body) {
        // Auto-resize iframe to fit content
        const resizeObserver = new ResizeObserver(() => {
          const height = doc.documentElement.scrollHeight;
          iframe.style.height = height + 'px';
          lastBodyHeightRef.current = height;
        });
        resizeObserver.observe(doc.body);
        const initialHeight = doc.documentElement.scrollHeight;
        iframe.style.height = initialHeight + 'px';
        lastBodyHeightRef.current = initialHeight;
        setIframeReady(true);

        // Hide images that fail to load (dead/mixed-content/unreachable external
        // URLs) rather than leaving the browser's broken-image placeholder and
        // alt text, which read as stray label text in an otherwise image-only
        // email (e.g. a blocked "logo" alt). Blocked images already carry a 1x1
        // transparent pixel (naturalWidth 1) and display:none, so they're skipped.
        const hideIfBroken = (img: HTMLImageElement) => {
          if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) {
            img.style.display = 'none';
          }
        };
        doc.querySelectorAll('img').forEach((el) => {
          const img = el as HTMLImageElement;
          if (img.complete) {
            hideIfBroken(img);
          } else {
            img.addEventListener('error', () => { img.style.display = 'none'; }, { once: true });
            img.addEventListener('load', () => hideIfBroken(img), { once: true });
          }
        });

        // Make links open in new tab
        doc.querySelectorAll('a').forEach(a => {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        });

        // Plugin intercept: let plugins cancel or rewrite external links inside
        // the email body before navigation happens. Bound on the iframe doc so
        // it survives DOM mutations from dark-mode pass below.
        const onLinkClick = async (ev: Event) => {
          const targetEl = (ev.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
          if (!targetEl) return;
          const href = targetEl.getAttribute('href') || '';
          if (!href || href.startsWith('#') || href.startsWith('mailto:')) return;
          ev.preventDefault();
          ev.stopPropagation();
          const ctx = {
            href,
            target: targetEl.getAttribute('target') ?? undefined,
            emailId: email?.id,
          };
          const ok = await uiHooks.onBeforeExternalLink.intercept(ctx);
          if (!ok) return;
          window.open(ctx.href, '_blank', 'noopener,noreferrer');
        };
        doc.addEventListener('click', onLinkClick, true);

        // Dark mode: re-invert elements with stylesheet-defined background images
        // (CSS attribute selectors only catch inline styles, not <style> block rules)
        if (isDark && !emailHasNativeDarkMode) {
          const win = doc.defaultView;
          if (win) {
            doc.body.querySelectorAll('*').forEach(el => {
              const htmlEl = el as HTMLElement;
              // Skip elements already handled by CSS attribute selectors
              if (htmlEl.style.backgroundImage || htmlEl.style.background ||
                  htmlEl.hasAttribute('background') || htmlEl.hasAttribute('bgcolor')) return;
              // Skip leaf media elements (already re-inverted by CSS)
              const tag = htmlEl.tagName;
              if (['IMG', 'VIDEO', 'SVG', 'CANVAS', 'OBJECT', 'EMBED'].includes(tag)) return;
              const computed = win.getComputedStyle(htmlEl);
              if (computed.backgroundImage && computed.backgroundImage !== 'none') {
                // Re-invert so the background image returns to its original
                // appearance. Matches the CSS background-image rules: re-invert
                // even when media is nested, then cancel the per-image
                // re-invert on that media so it isn't left double-inverted.
                htmlEl.style.filter = 'invert(1) hue-rotate(180deg)';
                htmlEl.querySelectorAll('img, video, svg, canvas, object, embed, input[type="image"]')
                  .forEach(m => { (m as HTMLElement).style.filter = 'none'; });
              }
            });

            // Re-invert emoji glyphs so they keep their original colors. The
            // body's invert filter flips colored emoji (yellow smiley → blue,
            // red heart → cyan, etc.). Wrap each emoji run in a span that
            // re-inverts. Only act when the ancestor invert depth is odd -
            // emojis inside a double-inverted bgcolor container already render
            // at their original colors.
            let emojiRe: RegExp;
            try {
              emojiRe = new RegExp('\\p{RGI_Emoji}', 'gv');
            } catch {
              emojiRe = /\p{Extended_Pictographic}(?:\uFE0F)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F)?)*/gu;
            }
            const emojiTestRe = /\p{Extended_Pictographic}/u;
            const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'IFRAME']);

            const isOddInvertDepth = (start: Element | null) => {
              let count = 0;
              let n: Element | null = start;
              while (n) {
                if (n === doc.body) { count++; break; }
                const cs = win.getComputedStyle(n);
                if (cs.filter && cs.filter.includes('invert')) count++;
                n = n.parentElement;
              }
              return count % 2 === 1;
            };

            const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
              acceptNode(node) {
                let p = node.parentElement;
                while (p) {
                  if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
                  p = p.parentElement;
                }
                return emojiTestRe.test(node.nodeValue || '')
                  ? NodeFilter.FILTER_ACCEPT
                  : NodeFilter.FILTER_REJECT;
              },
            });

            const emojiTextNodes: Text[] = [];
            let cur: Node | null;
            while ((cur = walker.nextNode())) emojiTextNodes.push(cur as Text);

            emojiTextNodes.forEach((textNode) => {
              const parent = textNode.parentElement;
              if (!parent || !isOddInvertDepth(parent)) return;
              const text = textNode.nodeValue || '';
              emojiRe.lastIndex = 0;
              const frag = doc.createDocumentFragment();
              let lastIndex = 0;
              let m: RegExpExecArray | null;
              while ((m = emojiRe.exec(text)) !== null) {
                if (m.index > lastIndex) {
                  frag.appendChild(doc.createTextNode(text.slice(lastIndex, m.index)));
                }
                const span = doc.createElement('span');
                span.style.cssText = 'filter:invert(1) hue-rotate(180deg)';
                span.textContent = m[0];
                frag.appendChild(span);
                lastIndex = m.index + m[0].length;
              }
              if (lastIndex === 0) return;
              if (lastIndex < text.length) {
                frag.appendChild(doc.createTextNode(text.slice(lastIndex)));
              }
              parent.replaceChild(frag, textNode);
            });
          }
        }
      }
    } catch {
      // Cross-origin restrictions - iframe will still display content
    }
  }, [isDark, emailHasNativeDarkMode, email?.id]);

  // Export email as .eml file
  const handleExportEmail = async () => {
    if (!email?.blobId || !client) return;
    try {
      await client.downloadBlob(email.blobId, emailExportFilename(email, emailFilenameOptions), 'message/rfc822');
    } catch {
      toast.error(tNotifications('export_email_error'));
      return;
    }
    const action = useSettingsStore.getState().postExportAction;
    if (action === 'archive') onArchive?.();
    else if (action === 'trash') onDelete?.();
  };

  // Import email from .eml file or .zip archive containing .eml files
  const handleImportEmail = () => {
    if (!client) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = EML_IMPORT_ACCEPT;
    input.multiple = true;
    input.onchange = async (e) => {
      const files = Array.from((e.target as HTMLInputElement).files ?? []);
      if (files.length === 0) return;
      const { selectedMailbox, mailboxes, fetchEmails } = useEmailStore.getState();
      const mailbox = mailboxes.find(mb => mb.id === selectedMailbox);
      const mailboxId = mailbox?.originalId || selectedMailbox;
      if (!mailboxId) {
        toast.error(tNotifications('import_email_error'));
        return;
      }

      let emails;
      try {
        emails = await expandImportableEmails(files);
      } catch {
        toast.error(tNotifications('import_email_error'));
        return;
      }

      let imported = 0;
      let failed = 0;
      for (const { blob } of emails) {
        try {
          await client.importRawEmail(blob, { [mailboxId]: true }, { '$seen': true });
          imported++;
        } catch {
          failed++;
        }
      }

      if (imported > 0) {
        toast.success(tNotifications('import_email_success'));
        await fetchEmails(client);
      }
      if (failed > 0 || emails.length === 0) {
        toast.error(tNotifications('import_email_error'));
      }
    };
    input.click();
  };

  // Print only the email content in a new window
  const handlePrint = () => {
    if (!email) return;
    const printSender = email.from?.[0];
    const date = email.sentAt ? formatDateTime(email.sentAt, timeFormat, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : '';
    const formatRecipient = (r: { name?: string | null; email: string }) =>
      r.name ? `${escapeHtml(r.name)} &lt;${escapeHtml(r.email)}&gt;` : escapeHtml(r.email);
    const toList = email.to?.map(formatRecipient).join(', ') || '';
    const ccList = email.cc?.map(formatRecipient).join(', ') || '';
    const subjectText = email.subject || t('no_subject');
    const senderText = printSender?.name
      ? `${printSender.name} <${printSender.email}>`
      : printSender?.email || t('unknown_sender');
    // The body was sanitized with EMAIL_IFRAME_SANITIZE_CONFIG which permits
    // <style>. The print window has no iframe isolation, so re-sanitize with
    // the stricter config that forbids <style> before injecting into the DOM.
    const printableBody = effectiveEmailContent.isHtml
      ? sanitizeEmailHtml(effectiveEmailContent.html)
      : effectiveEmailContent.html;

    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    printWindow.document.write(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(subjectText)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 40px; color: #000; }
  .header { border-bottom: 1px solid #ccc; padding-bottom: 16px; margin-bottom: 16px; }
  .subject { font-size: 20px; font-weight: bold; margin-bottom: 12px; }
  .meta { font-size: 13px; color: #555; line-height: 1.6; }
  .meta strong { color: #000; }
  .body { font-size: 14px; line-height: 1.6; }
  .body img { max-width: 100% !important; height: auto !important; }
  @media print { body { margin: 20px; } }
</style></head><body>
<div class="header">
  <div class="subject">${escapeHtml(subjectText)}</div>
  <div class="meta">
    <div><strong>${escapeHtml(t('from'))}:</strong> ${escapeHtml(senderText)}</div>
    ${toList ? `<div><strong>${escapeHtml(t('to'))}:</strong> ${toList}</div>` : ''}
    ${ccList ? `<div><strong>CC:</strong> ${ccList}</div>` : ''}
    ${date ? `<div><strong>${escapeHtml(t('date'))}:</strong> ${escapeHtml(date)}</div>` : ''}
  </div>
</div>
<div class="body">${printableBody}</div>
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

  const hasCalendarInvitation = email
    ? calendarInvitationParsingEnabled && !!findCalendarAttachment(email)
    : false;

  // ── Read receipt (MDN, RFC 8098) ──────────────────────────────
  // Detect a Disposition-Notification-To request on the open message. The
  // header is parsed into email.headers by the client; look it up
  // case-insensitively and extract the bare address.
  const readReceiptRequestedBy = useMemo(() => {
    const headers = email?.headers as Record<string, string | string[]> | undefined;
    if (!headers) return null;
    let raw: string | undefined;
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'disposition-notification-to') {
        const v = headers[key];
        raw = Array.isArray(v) ? v[0] : v;
        break;
      }
    }
    if (!raw) return null;
    const m = raw.match(/<([^>]+)>/);
    const addr = (m ? m[1] : raw).trim();
    return addr || null;
  }, [email?.headers]);

  // The identity whose address received the original message — the MDN is sent
  // "from" that address. Falls back to the primary identity.
  const receiptIdentity = useMemo(() => {
    if (!identities?.length) return null;
    const recipients = [...(email?.to || []), ...(email?.cc || [])]
      .map(r => r.email?.toLowerCase())
      .filter(Boolean);
    return identities.find(i => recipients.includes(i.email?.toLowerCase())) || identities[0];
  }, [identities, email?.to, email?.cc]);

  const mdnAlreadyHandled = email?.keywords?.['$mdnsent'] === true;
  const [mdnHandledLocally, setMdnHandledLocally] = useState(false);
  useEffect(() => { setMdnHandledLocally(false); }, [email?.id]);

  // Only offer the receipt for mail you're actually reading in a "received"
  // location. Suppress your own copies (sent/drafts), discarded mail (trash),
  // and spam (junk) - never confirm your address to spammers. Inbox, Archive
  // and user folders all qualify.
  const inReceiptEligibleFolder = !['sent', 'drafts', 'trash', 'junk'].includes(currentMailboxRole || '');

  const shouldOfferReadReceipt =
    !!readReceiptRequestedBy &&
    !mdnAlreadyHandled &&
    !mdnHandledLocally &&
    readReceiptResponse !== 'never' &&
    inReceiptEligibleFolder &&
    !isDraft &&
    !!receiptIdentity;

  const sendReadReceiptNow = useCallback(async (automatic: boolean) => {
    if (!client || !email || !readReceiptRequestedBy || !receiptIdentity) return;
    const { rawId } = stripCrossAccountIdentityPrefix(receiptIdentity.id);
    try {
      await client.sendReadReceipt({
        to: readReceiptRequestedBy,
        fromEmail: receiptIdentity.email,
        fromName: receiptIdentity.name,
        identityId: rawId ?? receiptIdentity.id,
        originalMessageId: email.messageId,
        originalSubject: email.subject,
        originalRecipient: receiptIdentity.email,
        automatic,
        subject: t('read_receipt.mdn_subject', { subject: email.subject || '' }),
        humanText: t('read_receipt.mdn_body', { recipient: receiptIdentity.email }),
      });
      await client.setKeyword(email.id, '$mdnsent');
    } catch (err) {
      // Surface the failure instead of silently resetting the banner so we can
      // see which step (upload / import / submission) failed.
      console.error('Read-receipt (MDN) send failed:', err);
      toast.error(t('read_receipt.send_failed'), {
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }, [client, email, readReceiptRequestedBy, receiptIdentity, t]);

  const ignoreReadReceipt = useCallback(async () => {
    setMdnHandledLocally(true);
    if (client && email) {
      // $MDNSent is the RFC 3503 flag every IMAP/JMAP client honours, so the
      // request is suppressed everywhere - not just locally.
      try { await client.setKeyword(email.id, '$mdnsent'); } catch { /* best effort */ }
    }
  }, [client, email]);

  // "always" mode: auto-send the MDN once when the message is opened.
  const autoMdnRef = useRef<string | null>(null);
  useEffect(() => {
    if (readReceiptResponse !== 'always') return;
    if (!shouldOfferReadReceipt || !email) return;
    if (autoMdnRef.current === email.id) return;
    autoMdnRef.current = email.id;
    sendReadReceiptNow(true).catch(() => { autoMdnRef.current = null; });
    // email is already captured via email?.id and sendReadReceiptNow (which
    // depends on `email`); the autoMdnRef guard prevents a double send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readReceiptResponse, shouldOfferReadReceipt, email?.id, sendReadReceiptNow]);

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
    if (isDemoMode) {
      const logoSrc = withBasePath(resolvedTheme === 'dark'
        ? '/branding/Bulwark_Logo_with_Lettering_White_and_Color.svg'
        : '/branding/Bulwark_Logo_with_Lettering_Dark_Color.svg');
      return (
        <div className={cn("flex-1 flex flex-col items-center justify-center bg-gradient-to-br from-muted/30 to-muted/50", className)}>
          <div className="text-center p-8 max-w-md">
            <img
              src={logoSrc}
              alt="Bulwark Mail"
              className="h-12 mx-auto mb-6"
            />
            <h3 className="text-xl font-semibold text-foreground mb-3">{tDemoWelcome('title')}</h3>
            <p className="text-sm text-muted-foreground mb-6 leading-relaxed">{tDemoWelcome('description')}</p>
            <div className="flex flex-col gap-3 items-center">
              <div className="grid grid-cols-2 gap-3 text-left text-sm text-muted-foreground w-full">
                <div className="flex items-center gap-2">
                  <Mail className="w-4 h-4 text-primary shrink-0" />
                  <span>{tDemoWelcome('feature_email')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Star className="w-4 h-4 text-primary shrink-0" />
                  <span>{tDemoWelcome('feature_organize')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Keyboard className="w-4 h-4 text-primary shrink-0" />
                  <span>{tDemoWelcome('feature_shortcuts')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-primary shrink-0" />
                  <span>{tDemoWelcome('feature_privacy')}</span>
                </div>
              </div>
              <button
                onClick={startTour}
                className="mt-4 inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-sm font-medium"
              >
                <PlayCircle className="w-4 h-4" />
                {tWelcome('start_tour')}
              </button>
              <p className="text-xs text-muted-foreground/60 mt-2">{tDemoWelcome('hint')}</p>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className={cn("flex-1 flex flex-col items-center justify-center bg-gradient-to-br from-muted/30 to-muted/50", className)}>
        {!isEmbedded && (
          <div className="text-center p-8">
            <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-background shadow-lg flex items-center justify-center">
              <Mail className="w-10 h-10 text-muted-foreground" />
            </div>
            <h3 className="text-xl font-semibold text-foreground mb-2">{t('no_conversation_selected')}</h3>
            <p className="text-muted-foreground">{t('no_conversation_description')}</p>
            {onCompose && (
              <Button onClick={onCompose} className="mt-6" title={t('compose_hint')}>
                <PenSquare className="w-4 h-4 mr-2" />
                {t('compose')}
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }

  const sender = email.from?.[0];
  const isStarred = email.keywords?.$flagged;
  const isUnread = !email.keywords?.$seen;
  const isImportant = email.keywords?.["$important"];

  // Shared toolbar items used by both 'top' and 'below-subject' positions
  const renderToolbarItems = (showBackButton: boolean) => (
    <>
      {/* Left: Reply actions */}
      <div className={cn("flex items-center gap-0", showBackButton ? "sm:gap-1" : "sm:gap-0.5")}>
        {showBackButton && (isMobile || (isTablet && !tabletListVisible) || (isFocusedMailLayout && !isMobile)) && onBack && (
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
        {isScheduled && canCancelScheduled && (
          <>
            <Button
              variant="default"
              size="sm"
              onClick={() => onRescheduleScheduled?.(new Date(Date.now() + 1000).toISOString())}
              className="sm:flex sm:h-8"
              title={t('send_now')}
            >
              <Send className="w-4 h-4" />
              {showToolbarLabels && <span className="hidden sm:inline text-sm">{t('send_now')}</span>}
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancelScheduled} className="sm:flex sm:h-8" title={t('cancel_scheduled_send')}>
              <X className="w-4 h-4" />
              {showToolbarLabels && <span className="hidden sm:inline text-sm">{t('cancel_scheduled_send')}</span>}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const delayedUntil = promptForRescheduleDelayedUntil();
                if (delayedUntil) onRescheduleScheduled?.(delayedUntil);
              }}
              className="hidden sm:flex sm:h-8"
              title={t('reschedule_send')}
            >
              <CalendarClock className="w-4 h-4" />
              {showToolbarLabels && <span className="hidden sm:inline text-sm">{t('reschedule_send')}</span>}
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancelScheduledForEdit} className="hidden sm:flex sm:h-8" title={email.isSmimeScheduled ? t('cancel_and_compose_again') : t('cancel_and_edit')}>
              <EditIcon className="w-4 h-4" />
              {showToolbarLabels && <span className="hidden sm:inline text-sm">{email.isSmimeScheduled ? t('cancel_and_compose_again') : t('cancel_and_edit')}</span>}
            </Button>
          </>
        )}
        {!isScheduled && isDraft && onEditDraft && (
          <Button
            variant="default"
            size="sm"
            onClick={() => onEditDraft()}
            className="sm:flex sm:flex-row sm:h-8 sm:gap-1.5 sm:py-0"
            title={t('tooltips.edit_draft')}
          >
            <EditIcon className="w-4 h-4" />
            <span className="text-sm">{t('edit_draft')}</span>
          </Button>
        )}
        {!isScheduled && !isDraft && (<>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onReply?.()}
          data-overflow-item
          data-overflow-priority="1"
          className="hidden sm:flex sm:flex-row sm:h-8 sm:gap-1.5 sm:py-0"
          title={t('tooltips.reply')}
        >
          <Reply className="w-4 h-4" />
          {showToolbarLabels && <span className="hidden sm:inline text-sm">{t('reply')}</span>}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onReplyAll}
          data-overflow-item
          data-overflow-priority="2"
          className="hidden sm:flex sm:flex-row sm:h-8 sm:gap-1.5 sm:py-0 sm:px-3"
          title={t('tooltips.reply_all')}
        >
          <ReplyAll className="w-4 h-4" />
          {showToolbarLabels && <span className="hidden sm:inline text-sm">{t('reply_all')}</span>}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onForward}
          data-overflow-item
          data-overflow-priority="3"
          className="hidden sm:flex sm:flex-row sm:h-8 sm:gap-1.5 sm:py-0"
          title={t('tooltips.forward')}
        >
          <Forward className="w-4 h-4" />
          {showToolbarLabels && <span className="hidden sm:inline text-sm">{t('forward')}</span>}
        </Button>
        </>)}
        <PluginSlot name="toolbar-actions" />
      </div>

      {/* Right: Organize actions - order: archive, delete, move, tag, spam, read state, print, view source */}
      {!isScheduled && (
      <div className="flex items-center gap-0 sm:gap-0.5">
        {/* Archive */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onArchive}
          data-overflow-item
          data-overflow-priority="4"
          className="flex-col items-center gap-0.5 h-auto py-1.5 px-2 sm:flex-row sm:h-8 sm:gap-1.5 sm:py-0"
          title={t('tooltips.archive')}
        >
          <Archive className="w-4 h-4" />
          {showToolbarLabels && <span className="text-[10px] leading-tight sm:text-sm">{t('archive')}</span>}
        </Button>
        {/* Delete */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          className="flex-col items-center gap-0.5 h-auto py-1.5 px-2 sm:flex-row sm:h-8 sm:gap-1.5 sm:py-0"
          title={t('tooltips.delete')}
        >
          <Trash2 className="w-4 h-4" />
          {showToolbarLabels && <span className="text-[10px] leading-tight sm:text-sm">{t('delete')}</span>}
        </Button>
        {/* Move to folder */}
        {moveTree.length > 0 && onMoveToMailbox && (
          <div ref={moveMenuRef} data-overflow-item data-overflow-priority="5" className="relative">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setMoveMenuOpen(!moveMenuOpen); setMoreMenuOpen(false); setTagMenuOpen(false); }}
              className="flex-col items-center gap-0.5 h-auto py-1.5 px-2 sm:flex-row sm:h-8 sm:gap-1.5 sm:py-0"
              title={t('move_to')}
            >
              <FolderInput className="w-4 h-4" />
              {showToolbarLabels && <span className="text-[10px] leading-tight sm:text-sm">{t('move')}</span>}
            </Button>
            {moveMenuOpen && (
              <div className="absolute right-0 top-full mt-1 py-1 w-48 max-h-72 overflow-y-auto bg-background rounded-lg shadow-lg border border-border z-10">
                {(() => {
                  const renderNodes = (nodes: MailboxNode[], depth = 0) => {
                    return nodes.map((node) => {
                      const Icon = getMoveMailboxIcon(node.role);
                      const isTarget = moveTargetIds.has(node.id);
                      return (
                        <div key={node.id}>
                          {isTarget ? (
                            <button
                              onClick={() => { onMoveToMailbox(node.id); setMoveMenuOpen(false); }}
                              className="w-full px-3 py-1.5 text-sm text-left hover:bg-muted flex items-center gap-2"
                              style={{ paddingLeft: `${0.75 + depth * 1}rem` }}
                            >
                              <Icon className="w-4 h-4 flex-shrink-0" />
                              <span className="truncate">{node.name}</span>
                            </button>
                          ) : (
                            <div
                              className="px-3 py-1.5 text-sm flex items-center gap-2 text-muted-foreground"
                              style={{ paddingLeft: `${0.75 + depth * 1}rem` }}
                            >
                              <Icon className="w-4 h-4 flex-shrink-0" />
                              <span>{node.name}</span>
                            </div>
                          )}
                          {node.children.length > 0 && renderNodes(node.children, depth + 1)}
                        </div>
                      );
                    });
                  };
                  return renderNodes(moveTree);
                })()}
              </div>
            )}
          </div>
        )}
        {/* Tag Picker - hidden on mobile, overflows to More menu */}
        <div data-overflow-item data-overflow-priority="6" className="hidden sm:flex items-center">
        <div className="w-px h-5 bg-border mx-0.5" />
        <div ref={tagMenuRef} className="relative">
          <button
            onClick={() => { setTagMenuOpen(!tagMenuOpen); setMoreMenuOpen(false); setMoveMenuOpen(false); }}
            className={cn(
              "h-8 rounded hover:bg-muted flex items-center gap-1.5 px-2",
              currentColors.length > 0 && "bg-muted/50"
            )}
            title={t('set_color')}
          >
            {currentColors.length > 0 ? (
              <>
                <span className="flex items-center gap-0.5">
                  {currentColors.slice(0, 3).map((tagId) => {
                    const kw = emailKeywords.find(k => k.id === tagId) ?? { id: tagId, label: tagId, color: 'gray' };
                    return <span key={tagId} className={cn("w-3 h-3 rounded-full", KEYWORD_PALETTE[kw.color]?.dot || 'bg-gray-500')} />;
                  })}
                </span>
                {showToolbarLabels && currentColors.length === 1 && (
                  <span className="text-xs font-medium text-foreground">
                    {emailKeywords.find(k => k.id === currentColors[0])?.label ?? currentColors[0]}
                  </span>
                )}
              </>
            ) : (
              <>
                <Tag className="w-4 h-4 text-muted-foreground" />
                {showToolbarLabels && <span className="text-xs text-muted-foreground">{t('tag')}</span>}
              </>
            )}
          </button>
          {tagMenuOpen && (
            <div className="absolute right-0 top-full mt-1 py-1 w-40 bg-background rounded-lg shadow-lg border border-border z-10">
              {colorOptions.map((option) => {
                const isActive = currentColors.includes(option.value);
                return (
                  <button
                    key={option.value}
                    onClick={() => { if (email) onSetColorTag?.(email.id, option.value); setTagMenuOpen(false); }}
                    className={cn(
                      "w-full px-3 py-1.5 text-sm text-left hover:bg-muted flex items-center gap-2",
                      isActive && "bg-accent font-medium"
                    )}
                  >
                    <span className={cn("w-3 h-3 rounded-full flex-shrink-0", option.color)} />
                    <span className="truncate">{option.name}</span>
                    {isActive && <Check className="w-3 h-3 ml-auto flex-shrink-0 text-foreground" />}
                  </button>
                );
              })}
              {currentColors.length > 0 && (
                <>
                  <div className="h-px bg-border my-1" />
                  <button
                    onClick={() => { if (email) onSetColorTag?.(email.id, null); setTagMenuOpen(false); }}
                    className="w-full px-3 py-1.5 text-sm text-left hover:bg-muted flex items-center gap-2 text-muted-foreground"
                  >
                    <X className="w-3 h-3 flex-shrink-0" />
                    <span>{t('remove_color')}</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        </div>

        {/* Spam */}
        {spamApplicable && (onMarkAsSpam || onUndoSpam) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={isInJunkFolder ? onUndoSpam : onMarkAsSpam}
            data-overflow-item
            data-overflow-priority="7"
            className={cn(
              "flex-col items-center gap-0.5 h-auto py-1.5 px-2 sm:flex-row sm:h-8 sm:gap-1.5 sm:py-0",
              isInJunkFolder ? "hover:bg-green-50 dark:hover:bg-green-950/30" : "hover:bg-red-50 dark:hover:bg-red-950/30"
            )}
            title={isInJunkFolder ? t('spam.not_spam_title') : t('spam.button_title')}
          >
            {isInJunkFolder ? (
              <ShieldCheck className="h-4 w-4 text-green-600 dark:text-green-400" />
            ) : (
              <ShieldAlert className="h-4 w-4 text-red-600 dark:text-red-400" />
            )}
            {showToolbarLabels && <span className="text-[10px] leading-tight sm:text-sm">{isInJunkFolder ? t('not_spam_short') : t('spam_short')}</span>}
          </Button>
        )}

        {/* Toggle read state */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onMarkAsRead?.(email.id, isUnread)}
          data-overflow-item
          data-overflow-priority="8"
          className="flex-col items-center gap-0.5 h-auto py-1.5 px-2 sm:flex-row sm:h-8 sm:gap-1.5 sm:py-0"
          title={isUnread ? t('mark_read') : t('mark_unread')}
        >
          {isUnread ? <MailOpen className="w-4 h-4" /> : <Mail className="w-4 h-4" />}
          {showToolbarLabels && <span className="text-[10px] leading-tight sm:text-sm">{isUnread ? t('read') : t('unread')}</span>}
        </Button>

        {/* Print - hidden on mobile, overflows to More menu */}
        <Button
          variant="ghost"
          size="sm"
          onClick={handlePrint}
          data-overflow-item
          data-overflow-priority="9"
          className="hidden sm:inline-flex h-8 gap-1.5"
          title={t('print')}
        >
          <Printer className="w-4 h-4" />
          {showToolbarLabels && <span className="hidden sm:inline text-sm">{t('print')}</span>}
        </Button>

        {/* View source - hidden on mobile, overflows to More menu */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowSourceModal(true)}
          data-overflow-item
          data-overflow-priority="10"
          className="hidden sm:inline-flex h-8 gap-1.5"
          title={t('view_source')}
        >
          <Code className="w-4 h-4" />
        </Button>

        {/* Dark/light mode toggle for HTML emails */}
        {effectiveEmailContent.isHtml && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setEmailViewDarkOverride(prev => prev === null ? !(resolvedTheme === 'dark') : !prev)}
          data-overflow-item
          data-overflow-priority="11"
          className="hidden sm:inline-flex h-8 gap-1.5"
          title={isDark ? 'View in light mode' : 'View in dark mode'}
        >
          {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </Button>
        )}

        {/* More menu - click-based */}
        <div ref={moreMenuRef} className="relative">
          <Button
            variant="ghost"
            size="sm"
            className="flex-col items-center gap-0.5 h-auto py-1.5 px-2 sm:flex-row sm:h-8 sm:w-8 sm:gap-0 sm:py-0 sm:px-0"
            title={t('more_actions')}
            onClick={() => { setMoreMenuOpen(!moreMenuOpen); setMoreMenuSub(null); setTagMenuOpen(false); setMoveMenuOpen(false); }}
          >
            <MoreVertical className="w-4 h-4 text-muted-foreground" />
            <span className="text-[10px] leading-tight sm:hidden">{t('more_actions')}</span>
          </Button>
          {moreMenuOpen && !isMobile && (
            <div className="absolute right-0 top-full mt-1 w-48 bg-background rounded-md shadow-lg border border-border z-10 py-1">
              {/* Star toggle */}
              <button
                onClick={() => { onToggleStar?.(); setMoreMenuOpen(false); setMoreMenuSub(null); }}
                className="w-full px-3 py-1.5 text-sm text-left hover:bg-muted text-foreground flex items-center gap-2"
              >
                <Star className={cn("w-4 h-4", isStarred && "fill-yellow-400 text-yellow-400")} />
                {isStarred ? t('tooltips.unstar') : t('tooltips.star')}
              </button>
              {/* Overflow: reply */}
              <button
                onClick={() => { onReply?.(); setMoreMenuOpen(false); setMoreMenuSub(null); }}
                className={cn("w-full px-3 py-1.5 text-sm text-left hover:bg-muted text-foreground flex items-center gap-2", hiddenPriorities.has(1) ? "" : "sm:hidden")}
              >
                <Reply className="w-4 h-4" />
                {t('reply')}
              </button>
              {/* Overflow: reply all */}
              <button
                onClick={() => { onReplyAll?.(); setMoreMenuOpen(false); setMoreMenuSub(null); }}
                className={cn("w-full px-3 py-1.5 text-sm text-left hover:bg-muted text-foreground flex items-center gap-2", hiddenPriorities.has(2) ? "" : "sm:hidden")}
              >
                <ReplyAll className="w-4 h-4" />
                {t('reply_all')}
              </button>
              {/* Overflow: forward */}
              <button
                onClick={() => { onForward?.(); setMoreMenuOpen(false); setMoreMenuSub(null); }}
                className={cn("w-full px-3 py-1.5 text-sm text-left hover:bg-muted text-foreground flex items-center gap-2", hiddenPriorities.has(3) ? "" : "sm:hidden")}
              >
                <Forward className="w-4 h-4" />
                {t('forward')}
              </button>
              {/* Overflow: archive */}
              <button
                onClick={() => { onArchive?.(); setMoreMenuOpen(false); setMoreMenuSub(null); }}
                className={cn("w-full px-3 py-1.5 text-sm text-left hover:bg-muted text-foreground flex items-center gap-2", hiddenPriorities.has(4) ? "" : "sm:hidden")}
              >
                <Archive className="w-4 h-4" />
                {t('archive')}
              </button>
              {/* Overflow: move to folder - submenu */}
              {moveTree.length > 0 && onMoveToMailbox && (
                <div className={cn("relative", hiddenPriorities.has(5) ? "" : "sm:hidden")}
                  onMouseEnter={() => setMoreMenuSub('move')}
                  onMouseLeave={() => setMoreMenuSub(null)}
                >
                  <button
                    onClick={() => setMoreMenuSub(moreMenuSub === 'move' ? null : 'move')}
                    className="w-full px-3 py-1.5 text-sm text-left hover:bg-muted text-foreground flex items-center gap-2"
                  >
                    <FolderInput className="w-4 h-4" />
                    <span className="flex-1">{t('move_to')}</span>
                    <ChevronRight className="w-3 h-3 text-muted-foreground" />
                  </button>
                  {moreMenuSub === 'move' && (
                    <div className="absolute right-full top-0 mr-1 py-1 w-48 max-h-72 overflow-y-auto bg-background rounded-md shadow-lg border border-border z-10">
                      {(() => {
                        const renderMobileNodes = (nodes: MailboxNode[], depth = 0) => {
                          return nodes.map((node) => {
                            const Icon = getMoveMailboxIcon(node.role);
                            const isTarget = moveTargetIds.has(node.id);
                            return (
                              <div key={node.id}>
                                {isTarget ? (
                                  <button
                                    onClick={() => { onMoveToMailbox(node.id); setMoreMenuOpen(false); setMoreMenuSub(null); }}
                                    className="w-full px-3 py-1.5 text-sm text-left hover:bg-muted flex items-center gap-2"
                                    style={{ paddingLeft: `${0.75 + depth * 1}rem` }}
                                  >
                                    <Icon className="w-4 h-4 flex-shrink-0" />
                                    <span className="truncate">{node.name}</span>
                                  </button>
                                ) : (
                                  <div
                                    className="px-3 py-1.5 text-sm flex items-center gap-2 text-muted-foreground"
                                    style={{ paddingLeft: `${0.75 + depth * 1}rem` }}
                                  >
                                    <Icon className="w-4 h-4 flex-shrink-0" />
                                    <span>{node.name}</span>
                                  </div>
                                )}
                                {node.children.length > 0 && renderMobileNodes(node.children, depth + 1)}
                              </div>
                            );
                          });
                        };
                        return renderMobileNodes(moveTree);
                      })()}
                    </div>
                  )}
                </div>
              )}
              {/* Overflow: tag - submenu */}
              {colorOptions.length > 0 && (
                <div className={cn("relative", hiddenPriorities.has(6) ? "" : "sm:hidden")}
                  onMouseEnter={() => setMoreMenuSub('tag')}
                  onMouseLeave={() => setMoreMenuSub(null)}
                >
                  <button
                    onClick={() => setMoreMenuSub(moreMenuSub === 'tag' ? null : 'tag')}
                    className="w-full px-3 py-1.5 text-sm text-left hover:bg-muted text-foreground flex items-center gap-2"
                  >
                    <Tag className="w-4 h-4" />
                    <span className="flex-1">{t('tag')}</span>
                    <ChevronRight className="w-3 h-3 text-muted-foreground" />
                  </button>
                  {moreMenuSub === 'tag' && (
                    <div className="absolute right-full top-0 mr-1 py-1 w-40 bg-background rounded-md shadow-lg border border-border z-10">
                      {colorOptions.map((option) => {
                        const isActive = currentColors.includes(option.value);
                        return (
                          <button
                            key={option.value}
                            onClick={() => { if (email) onSetColorTag?.(email.id, option.value); setMoreMenuOpen(false); setMoreMenuSub(null); }}
                            className={cn(
                              "w-full px-3 py-1.5 text-sm text-left hover:bg-muted flex items-center gap-2",
                              isActive && "bg-accent font-medium"
                            )}
                          >
                            <span className={cn("w-3 h-3 rounded-full flex-shrink-0", option.color)} />
                            <span className="truncate">{option.name}</span>
                            {isActive && <Check className="w-3 h-3 ml-auto flex-shrink-0 text-foreground" />}
                          </button>
                        );
                      })}
                      {currentColors.length > 0 && (
                        <>
                          <div className="h-px bg-border my-1" />
                          <button
                            onClick={() => { if (email) onSetColorTag?.(email.id, null); setMoreMenuOpen(false); setMoreMenuSub(null); }}
                            className="w-full px-3 py-1.5 text-sm text-left hover:bg-muted flex items-center gap-2 text-muted-foreground"
                          >
                            <X className="w-3 h-3 flex-shrink-0" />
                            <span>{t('remove_color')}</span>
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
              {/* Overflow: spam */}
              {spamApplicable && (onMarkAsSpam || onUndoSpam) && (
                <button
                  onClick={() => { (isInJunkFolder ? onUndoSpam : onMarkAsSpam)?.(); setMoreMenuOpen(false); setMoreMenuSub(null); }}
                  className={cn("w-full px-3 py-1.5 text-sm text-left hover:bg-muted text-foreground flex items-center gap-2", hiddenPriorities.has(7) ? "" : "sm:hidden")}
                >
                  {isInJunkFolder ? (
                    <ShieldCheck className="h-4 w-4 text-green-600 dark:text-green-400" />
                  ) : (
                    <ShieldAlert className="h-4 w-4 text-red-600 dark:text-red-400" />
                  )}
                  {isInJunkFolder ? t('spam.not_spam_title') : t('spam.button_title')}
                </button>
              )}
              {/* Overflow: toggle read */}
              <button
                onClick={() => { onMarkAsRead?.(email.id, isUnread); setMoreMenuOpen(false); setMoreMenuSub(null); }}
                className={cn("w-full px-3 py-1.5 text-sm text-left hover:bg-muted text-foreground flex items-center gap-2", hiddenPriorities.has(8) ? "" : "sm:hidden")}
              >
                {isUnread ? <MailOpen className="w-4 h-4" /> : <Mail className="w-4 h-4" />}
                {isUnread ? t('mark_read') : t('mark_unread')}
              </button>
              {/* Overflow: print */}
              <button
                onClick={() => { handlePrint(); setMoreMenuOpen(false); setMoreMenuSub(null); }}
                className={cn("w-full px-3 py-1.5 text-sm text-left hover:bg-muted text-foreground flex items-center gap-2", hiddenPriorities.has(9) ? "" : "sm:hidden")}
              >
                <Printer className="w-4 h-4" />
                {t('print')}
              </button>
              {/* Overflow: view source */}
              <button
                onClick={() => { setShowSourceModal(true); setMoreMenuOpen(false); setMoreMenuSub(null); }}
                className={cn("w-full px-3 py-1.5 text-sm text-left hover:bg-muted text-foreground flex items-center gap-2", hiddenPriorities.has(10) ? "" : "sm:hidden")}
              >
                <Code className="w-4 h-4" />
                {t('view_source')}
              </button>
              {/* Overflow: dark/light mode toggle */}
              {effectiveEmailContent.isHtml && (
                <button
                  onClick={() => { setEmailViewDarkOverride(prev => prev === null ? !(resolvedTheme === 'dark') : !prev); setMoreMenuOpen(false); setMoreMenuSub(null); }}
                  className={cn("w-full px-3 py-1.5 text-sm text-left hover:bg-muted text-foreground flex items-center gap-2", hiddenPriorities.has(11) ? "" : "sm:hidden")}
                >
                  {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                  {isDark ? 'View in light mode' : 'View in dark mode'}
                </button>
              )}
              <div className="h-px bg-border my-1" />
              {/* Export email */}
              <button
                onClick={() => { handleExportEmail(); setMoreMenuOpen(false); setMoreMenuSub(null); }}
                className="w-full px-3 py-1.5 text-sm text-left hover:bg-muted text-foreground flex items-center gap-2"
              >
                <Download className="w-4 h-4" />
                {t('export_email')}
              </button>
              {/* Import email */}
              <button
                onClick={() => { handleImportEmail(); setMoreMenuOpen(false); setMoreMenuSub(null); }}
                className="w-full px-3 py-1.5 text-sm text-left hover:bg-muted text-foreground flex items-center gap-2"
              >
                <Upload className="w-4 h-4" />
                {t('import_email')}
              </button>
              {onShowShortcuts && (
                <button
                  onClick={() => { onShowShortcuts(); setMoreMenuOpen(false); setMoreMenuSub(null); }}
                  className="w-full px-3 py-1.5 text-sm text-left hover:bg-muted text-foreground flex items-center gap-2"
                >
                  <Keyboard className="w-4 h-4" />
                  {t('keyboard_shortcuts')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      )}
    </>
  );

  return (
    <div
      data-tour="email-viewer"
      className={cn("flex-1 flex flex-row h-full bg-background overflow-hidden relative", className)}
    >
    {/* Mobile More menu sidebar overlay */}
    {!isScheduled && isMobile && moreMenuOpen && (
      <div
        className="fixed inset-0 bg-black/50 z-[60] sm:hidden"
        onClick={() => setMoreMenuOpen(false)}
      />
    )}
    {!isScheduled && isMobile && (
      <div className={cn(
        "fixed inset-y-0 right-0 w-72 bg-background border-l border-border z-[70] sm:hidden",
        "transform transition-transform duration-300 ease-in-out",
        "flex flex-col",
        moreMenuOpen ? "translate-x-0" : "translate-x-full"
      )}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          {moreMenuSub ? (
            <button
              onClick={() => setMoreMenuSub(null)}
              className="flex items-center gap-1 -ml-2 px-2 py-1 rounded hover:bg-muted text-sm font-semibold text-foreground"
            >
              <ChevronLeft className="w-5 h-5" />
              {moreMenuSub === 'move' ? t('move_to') : t('tag')}
            </button>
          ) : (
            <span className="text-sm font-semibold text-foreground">{t('more_actions')}</span>
          )}
          <Button variant="ghost" size="icon" onClick={() => { setMoreMenuOpen(false); setMoreMenuSub(null); }} className="h-9 w-9">
            <X className="w-5 h-5" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {moreMenuSub === null && (
            <>
              {/* Star toggle */}
              <button
                onClick={() => { onToggleStar?.(); setMoreMenuOpen(false); }}
                className="w-full px-4 py-3 min-h-[44px] text-sm text-left hover:bg-muted text-foreground flex items-center gap-3"
              >
                <Star className={cn("w-5 h-5", isStarred && "fill-yellow-400 text-yellow-400")} />
                {isStarred ? t('tooltips.unstar') : t('tooltips.star')}
              </button>
              {/* Tag (opens sub-view) */}
              {colorOptions.length > 0 && (
                <button
                  onClick={() => setMoreMenuSub('tag')}
                  className="w-full px-4 py-3 min-h-[44px] text-sm text-left hover:bg-muted text-foreground flex items-center gap-3"
                >
                  <Tag className="w-5 h-5" />
                  <span className="flex-1">{t('tag')}</span>
                  {currentColors.length > 0 && (
                    <div className="flex -space-x-1 mr-1">
                      {currentColors.slice(0, 3).map((c) => {
                        const opt = colorOptions.find((o) => o.value === c);
                        return opt ? <span key={c} className={cn("w-3 h-3 rounded-full border border-background", opt.color)} /> : null;
                      })}
                    </div>
                  )}
                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                </button>
              )}
              <button
                onClick={() => { handlePrint(); setMoreMenuOpen(false); }}
                className="w-full px-4 py-3 min-h-[44px] text-sm text-left hover:bg-muted text-foreground flex items-center gap-3"
              >
                <Printer className="w-5 h-5" />
                {t('print')}
              </button>
              <button
                onClick={() => { setShowSourceModal(true); setMoreMenuOpen(false); }}
                className="w-full px-4 py-3 min-h-[44px] text-sm text-left hover:bg-muted text-foreground flex items-center gap-3"
              >
                <Code className="w-5 h-5" />
                {t('view_source')}
              </button>
              {effectiveEmailContent.isHtml && (
                <button
                  onClick={() => { setEmailViewDarkOverride(prev => prev === null ? !(resolvedTheme === 'dark') : !prev); setMoreMenuOpen(false); }}
                  className="w-full px-4 py-3 min-h-[44px] text-sm text-left hover:bg-muted text-foreground flex items-center gap-3"
                >
                  {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
                  {isDark ? 'View in light mode' : 'View in dark mode'}
                </button>
              )}
              <div className="h-px bg-border my-1" />
              <button
                onClick={() => { handleExportEmail(); setMoreMenuOpen(false); }}
                className="w-full px-4 py-3 min-h-[44px] text-sm text-left hover:bg-muted text-foreground flex items-center gap-3"
              >
                <Download className="w-5 h-5" />
                {t('export_email')}
              </button>
              <button
                onClick={() => { handleImportEmail(); setMoreMenuOpen(false); }}
                className="w-full px-4 py-3 min-h-[44px] text-sm text-left hover:bg-muted text-foreground flex items-center gap-3"
              >
                <Upload className="w-5 h-5" />
                {t('import_email')}
              </button>
              {onShowShortcuts && (
                <button
                  onClick={() => { onShowShortcuts(); setMoreMenuOpen(false); }}
                  className="w-full px-4 py-3 min-h-[44px] text-sm text-left hover:bg-muted text-foreground flex items-center gap-3"
                >
                  <Keyboard className="w-5 h-5" />
                  {t('keyboard_shortcuts')}
                </button>
              )}
            </>
          )}
          {moreMenuSub === 'move' && moveTree.length > 0 && onMoveToMailbox && (() => {
            const renderMobileNodes = (nodes: MailboxNode[], depth = 0) => {
              return nodes.map((node) => {
                const Icon = getMoveMailboxIcon(node.role);
                const isTarget = moveTargetIds.has(node.id);
                return (
                  <div key={node.id}>
                    {isTarget ? (
                      <button
                        onClick={() => { onMoveToMailbox(node.id); setMoreMenuOpen(false); setMoreMenuSub(null); }}
                        className="w-full px-4 py-2.5 min-h-[44px] text-sm text-left hover:bg-muted flex items-center gap-3"
                        style={{ paddingLeft: `${1 + depth * 1}rem` }}
                      >
                        <Icon className="w-5 h-5 flex-shrink-0" />
                        <span className="truncate">{node.name}</span>
                      </button>
                    ) : (
                      <div
                        className="px-4 py-2.5 min-h-[44px] text-sm flex items-center gap-3 text-muted-foreground"
                        style={{ paddingLeft: `${1 + depth * 1}rem` }}
                      >
                        <Icon className="w-5 h-5 flex-shrink-0" />
                        <span>{node.name}</span>
                      </div>
                    )}
                    {node.children.length > 0 && renderMobileNodes(node.children, depth + 1)}
                  </div>
                );
              });
            };
            return renderMobileNodes(moveTree);
          })()}
          {moreMenuSub === 'tag' && colorOptions.length > 0 && (
            <>
              {colorOptions.map((option) => {
                const isActive = currentColors.includes(option.value);
                return (
                  <button
                    key={option.value}
                    onClick={() => { if (email) onSetColorTag?.(email.id, option.value); setMoreMenuOpen(false); setMoreMenuSub(null); }}
                    className={cn(
                      "w-full px-4 py-2.5 min-h-[44px] text-sm text-left hover:bg-muted flex items-center gap-3",
                      isActive && "bg-accent font-medium"
                    )}
                  >
                    <span className={cn("w-3.5 h-3.5 rounded-full flex-shrink-0", option.color)} />
                    <span className="truncate">{option.name}</span>
                    {isActive && <Check className="w-4 h-4 ml-auto flex-shrink-0 text-foreground" />}
                  </button>
                );
              })}
              {currentColors.length > 0 && (
                <button
                  onClick={() => { if (email) onSetColorTag?.(email.id, null); setMoreMenuOpen(false); setMoreMenuSub(null); }}
                  className="w-full px-4 py-2.5 min-h-[44px] text-sm text-left hover:bg-muted flex items-center gap-3 text-muted-foreground"
                >
                  <X className="w-4 h-4 flex-shrink-0" />
                  <span>{t('remove_color')}</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>
    )}
    {/* Main email content */}
    <div className="flex-1 flex flex-col h-full overflow-hidden min-w-0">
      {/* === TOOLBAR (top position) === */}
      {toolbarPosition === 'top' && (
        <div className={cn(
          "bg-background border-b border-border",
          "max-lg:sticky max-lg:top-0 max-lg:z-10"
        )}>
          <div className="px-2 sm:px-4 lg:px-6 h-14 flex items-center">
            <div ref={toolbarRef} className="flex items-center justify-between gap-0.5 sm:gap-2 w-full">
              {renderToolbarItems(true)}
            </div>
          </div>
        </div>
      )}

      {/* === SUBJECT BLOCK === */}
      <div className={cn(
        "bg-background border-b border-border",
        toolbarPosition === 'below-subject' && "max-lg:sticky max-lg:top-0 max-lg:z-10"
      )}>
        <div className="px-4 lg:px-6" style={{ paddingBlock: 'var(--density-header-py)' }}>
          <div className="flex items-start justify-between gap-2 lg:gap-4">
            {/* Back button (for below-subject mode on tablet) */}
            {toolbarPosition === 'below-subject' && (isMobile || (isTablet && !tabletListVisible) || (isFocusedMailLayout && !isMobile)) && onBack && (
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
              <div className="flex items-start gap-2">
                <h1 className="text-lg lg:text-xl font-bold text-foreground tracking-tight break-words min-w-0">
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
                {/* Color tag dots */}
                {currentColors.length > 0 && (
                  <span className="flex items-center gap-0.5">
                    {currentColors.map((tagId) => {
                      const kw = emailKeywords.find(k => k.id === tagId) ?? { id: tagId, label: tagId, color: 'gray' };
                      const dotClass = KEYWORD_PALETTE[kw.color]?.dot || 'bg-gray-500';
                      return (
                        <span key={tagId} className={cn("w-2.5 h-2.5 rounded-full flex-shrink-0", dotClass)} title={kw.label} />
                      );
                    })}
                  </span>
                )}
                {isImportant && (
                  <span className="px-1.5 lg:px-2 py-0.5 bg-warning/15 text-warning rounded-full text-xs font-medium whitespace-nowrap flex-shrink-0 self-center">
                    {t('important')}
                  </span>
                )}
              </div>
            </div>
            {/* Date/time on the right of subject row - hidden on mobile, shown next to sender */}
            <div className="hidden sm:block flex-shrink-0 text-right">
              <span className="text-xs lg:text-sm text-muted-foreground whitespace-nowrap">
                {formatDateTime(email.receivedAt, timeFormat, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
              </span>
              {email.size > 0 && (
                <div className="text-xs text-muted-foreground/60">
                  {formatFileSize(email.size)}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* === TOOLBAR (below-subject position) === */}
      {toolbarPosition === 'below-subject' && (
        <div className="bg-background border-b border-border">
          <div className="px-2 sm:px-4 lg:px-6 py-1 sm:py-1.5">
            <div ref={toolbarRef} className="flex items-center justify-between gap-0.5 sm:gap-2">
              {renderToolbarItems(false)}
            </div>
          </div>
        </div>
      )}

      {/* Email Content Area */}
      <div className={cn("flex-1 overflow-auto overscroll-contain bg-muted/30", isMobile && "pb-[calc(3.25rem+env(safe-area-inset-bottom)/2)] sm:pb-0")}>
      <div className="min-h-full flex flex-col">

      {/* === SENDER INFO (Desktop) === */}
      <div className="hidden lg:block bg-background border-b border-border px-6" style={{ paddingBlock: 'var(--density-header-py)' }}>
          <div className="flex items-start" style={{ gap: 'var(--density-item-gap)' }}>
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

            <div className="flex-1 min-w-0 flex gap-4">
              <div className="flex-1 min-w-0">
              {/* Row 1: Sender name + badges */}
              <div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {sender?.email ? (
                      <RecipientPopover
                        name={sender?.name}
                        email={sender.email}
                        onViewContact={handleViewContactSidebar}
                        className="font-semibold text-left"
                      />
                    ) : (
                      <span className="font-semibold text-foreground">{t('unknown_sender')}</span>
                    )}
                    <EmailIdentityBadge email={email} identities={identities} />
                    {shouldShowUnsubBanner && listHeaders?.listUnsubscribe && (
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
                    )}
                  </div>
                  {/* Email address under name */}
                  {sender?.email && sender?.name && (
                    <div className="text-sm text-muted-foreground mt-0.5 truncate">{sender.email}</div>
                  )}
                </div>
              </div>

              {/* Row 2: Recipients + Show details */}
              <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
                {email.to && email.to.length > 0 && (
                  <>
                    <span>{t('recipient_to_prefix')}</span>
                    {renderClickableRecipients(email.to, currentUserEmail, t, handleViewContactSidebar)}
                    {email.to.length > 2 && (
                      <button
                        onClick={() => setShowFullHeaders(!showFullHeaders)}
                        className="text-blue-600 dark:text-blue-400 hover:underline text-sm"
                      >
                        {t('more_count', { count: email.to.length - 2 })}
                      </button>
                    )}
                  </>
                )}
                {email.cc && email.cc.length > 0 && (
                  <>
                    <span className="text-muted-foreground/50">|</span>
                    <span>CC:</span>
                    {renderClickableRecipients(email.cc, currentUserEmail, t, handleViewContactSidebar)}
                    {email.cc.length > 2 && (
                      <span className="text-muted-foreground">+{email.cc.length - 2}</span>
                    )}
                  </>
                )}
                {email.bcc && email.bcc.length > 0 && (
                  <>
                    <span className="text-muted-foreground/50">|</span>
                    <span>{t('bcc')}:</span>
                    {renderClickableRecipients(email.bcc, currentUserEmail, t, handleViewContactSidebar)}
                    {email.bcc.length > 2 && (
                      <span className="text-muted-foreground">+{email.bcc.length - 2}</span>
                    )}
                  </>
                )}
                <button
                  onClick={() => setShowFullHeaders(!showFullHeaders)}
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-0.5 transition-colors ml-1"
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
              </div>


              </div>
              {/* Attachments on the right (beside-sender mode) */}
              {attachmentPosition === 'beside-sender' && effectiveAttachments.length > 0 && (
                <div className="relative flex flex-col items-end justify-start gap-1 flex-shrink-0 max-w-[50%]">
                  {effectiveAttachments.slice(0, 2).map((attachment) => {
                    const FileIcon = getFileIcon(attachment.name || undefined, attachment.type);
                    const isPreviewable = isFilePreviewable(attachment.name || undefined, attachment.type);
                    const opensPreview = isPreviewable && mailAttachmentAction === 'preview';
                    const thumbUrl = imageThumbUrls[attachment.id];
                    return (
                      <DraggableAttachmentChip key={attachment.id} attachment={attachment} client={client} enabled={dragOutActive} downloadName={resolveAttachmentName(attachment)}>
                        {(dragProps) => (
                      <div
                        className={cn(
                          "bg-muted/60 hover:bg-muted rounded-md border border-border/50 group relative cursor-pointer overflow-hidden",
                          thumbUrl
                            ? "inline-flex flex-col w-40"
                            : "inline-flex items-center gap-1.5 px-2 py-1",
                        )}
                        title={`${opensPreview ? tFiles('preview') : t('download')} ${getAttachmentDisplayName(attachment.name, attachment.type)}`}
                        onClick={() => handleEffectiveAttachmentOpen(attachment)}
                        draggable={dragProps.draggable}
                        onPointerEnter={dragProps.onPointerEnter}
                        onDragStart={dragProps.onDragStart}
                        onDragEnd={dragProps.onDragEnd}
                      >
                        {thumbUrl && (
                          <div className="w-full h-16 bg-background/40 flex items-center justify-center overflow-hidden">
                            <img src={thumbUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                          </div>
                        )}
                        <div className={cn(
                          "flex items-center gap-1.5",
                          thumbUrl && "px-2 py-1 border-t border-border/50 w-full",
                        )}>
                          <FileIcon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                          <span className={cn(
                            "text-xs text-foreground truncate",
                            thumbUrl ? "flex-1 min-w-0" : "max-w-[140px]",
                          )}>
                            {getAttachmentDisplayName(attachment.name, attachment.type)}
                          </span>
                          <span className="text-[10px] text-muted-foreground flex-shrink-0">
                            {formatFileSize(attachment.size)}
                          </span>
                        </div>
                        <div className={cn(
                          "absolute bg-background/95 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1 px-1.5 rounded-md",
                          thumbUrl ? "top-1 right-1" : "inset-y-0 right-0 rounded-l-none rounded-r-md",
                        )}>
                          <button
                            className="p-1 hover:bg-accent rounded transition-colors"
                            title={t('download')}
                            onClick={(e) => { e.stopPropagation(); handleEffectiveAttachmentDownload(attachment); }}
                          >
                            <Download className="w-3.5 h-3.5 text-foreground" />
                          </button>
                          {opensPreview && (
                            <button
                              className="p-1 hover:bg-accent rounded transition-colors"
                              title={tFiles('preview')}
                              onClick={(e) => { e.stopPropagation(); handleEffectiveAttachmentOpen(attachment); }}
                            >
                              <Eye className="w-3.5 h-3.5 text-foreground" />
                            </button>
                          )}
                        </div>
                      </div>
                        )}
                      </DraggableAttachmentChip>
                    );
                  })}
                  {effectiveAttachments.length > 2 && (
                    <button
                      onClick={() => setShowAllBesideAttachments(!showAllBesideAttachments)}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-0.5"
                    >
                      +{effectiveAttachments.length - 2} {t('more')}
                    </button>
                  )}
                  {downloadAllButton}
                  {/* Floating popup for remaining attachments */}
                  {showAllBesideAttachments && effectiveAttachments.length > 2 && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setShowAllBesideAttachments(false)} />
                      <div className="absolute top-full right-0 mt-1 z-50 bg-background border border-border rounded-lg shadow-lg p-2 flex flex-col gap-1 min-w-[220px]">
                        {effectiveAttachments.slice(2).map((attachment) => {
                          const FileIcon = getFileIcon(attachment.name || undefined, attachment.type);
                          const isPreviewable = isFilePreviewable(attachment.name || undefined, attachment.type);
                          const opensPreview = isPreviewable && mailAttachmentAction === 'preview';
                          return (
                            <DraggableAttachmentChip key={attachment.id} attachment={attachment} client={client} enabled={dragOutActive} downloadName={resolveAttachmentName(attachment)}>
                              {(dragProps) => (
                            <div
                              className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-muted/60 group relative cursor-pointer w-full"
                              title={`${opensPreview ? tFiles('preview') : t('download')} ${getAttachmentDisplayName(attachment.name, attachment.type)}`}
                              onClick={() => { handleEffectiveAttachmentOpen(attachment); setShowAllBesideAttachments(false); }}
                              draggable={dragProps.draggable}
                              onPointerEnter={dragProps.onPointerEnter}
                              onDragStart={dragProps.onDragStart}
                              onDragEnd={dragProps.onDragEnd}
                            >
                              <FileIcon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                              <span className="text-xs text-foreground truncate max-w-[180px]">
                                {getAttachmentDisplayName(attachment.name, attachment.type)}
                              </span>
                              <span className="text-[10px] text-muted-foreground ml-auto flex-shrink-0">
                                {formatFileSize(attachment.size)}
                              </span>
                              <div className="absolute inset-y-0 right-0 rounded-r-md bg-background/95 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1 px-1.5">
                                <button
                                  className="p-1 hover:bg-accent rounded transition-colors"
                                  title={t('download')}
                                  onClick={(e) => { e.stopPropagation(); handleEffectiveAttachmentDownload(attachment); setShowAllBesideAttachments(false); }}
                                >
                                  <Download className="w-3.5 h-3.5 text-foreground" />
                                </button>
                                {opensPreview && (
                                  <button
                                    className="p-1 hover:bg-accent rounded transition-colors"
                                    title={tFiles('preview')}
                                    onClick={(e) => { e.stopPropagation(); handleEffectiveAttachmentOpen(attachment); setShowAllBesideAttachments(false); }}
                                  >
                                    <Eye className="w-3.5 h-3.5 text-foreground" />
                                  </button>
                                )}
                              </div>
                            </div>
                              )}
                            </DraggableAttachmentChip>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
      </div>

        {/* Mobile/Tablet Sender Info - scrolls with content */}
        <div className="lg:hidden bg-background border-b border-border px-4" style={{ paddingBlock: 'var(--density-header-py)' }}>
          <div className="flex items-start" style={{ gap: 'var(--density-item-gap)' }}>
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
              {/* Row 1: Sender name + badges */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {sender?.email ? (
                  <RecipientPopover
                    name={sender?.name}
                    email={sender.email}
                    onViewContact={handleViewContactSidebar}
                    className="text-sm font-semibold text-left"
                  />
                ) : (
                  <span className="text-sm font-semibold text-foreground">{t('unknown_sender')}</span>
                )}
                <EmailIdentityBadge email={email} identities={identities} />
                {shouldShowUnsubBanner && listHeaders?.listUnsubscribe && (
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
                )}
              </div>
              {/* Email address under name */}
              {sender?.email && sender?.name && (
                <div className="text-xs text-muted-foreground mt-0.5 truncate">{sender.email}</div>
              )}
              {/* Row 2: Recipients */}
              <div className="mt-0.5 flex items-center gap-1 text-sm text-muted-foreground flex-wrap">
                {email.to && email.to.length > 0 && (
                  <>
                    <span>→ {t('recipient_to_prefix')}</span>
                    {renderClickableRecipients(email.to, currentUserEmail, t, handleViewContactSidebar)}
                  </>
                )}
                {email.cc && email.cc.length > 0 && (
                  <>
                    <span className="text-muted-foreground/50">|</span>
                    <span>CC:</span>
                    {renderClickableRecipients(email.cc, currentUserEmail, t, handleViewContactSidebar)}
                    {email.cc.length > 2 && (
                      <span>+{email.cc.length - 2}</span>
                    )}
                  </>
                )}
                <button
                  onClick={() => setShowFullHeaders(!showFullHeaders)}
                  className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-0.5 transition-colors ml-1"
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
              </div>
            </div>
            {/* Date/time + size on the right (mobile) */}
            <div className="sm:hidden flex-shrink-0 text-right ml-2">
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {formatDateTime(email.receivedAt, timeFormat, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
              </span>
              {email.size > 0 && (
                <div className="text-xs text-muted-foreground/60">
                  {formatFileSize(email.size)}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Expandable Details (shared across mobile/tablet/desktop) */}
        {showFullHeaders && (() => {
          const translateAuthResult = (result?: string) => {
            const r = (result || '').toLowerCase();
            switch (r) {
              case 'pass': return t('authentication.result.pass');
              case 'fail': return t('authentication.result.fail');
              case 'softfail': return t('authentication.result.softfail');
              case 'neutral': return t('authentication.result.neutral');
              case 'permerror': return t('authentication.result.permerror');
              case 'temperror': return t('authentication.result.temperror');
              case 'none': return t('authentication.result.none');
              default: return result || '';
            }
          };
          const replyToDifferent = !!email.replyTo?.length &&
            (!email.from || email.replyTo[0].email !== email.from[0]?.email);
          const deliveryDeltaMs = email.sentAt && email.receivedAt
            ? Math.abs(new Date(email.receivedAt).getTime() - new Date(email.sentAt).getTime())
            : 0;
          const formatDelta = (diff: number) => {
            const minutes = Math.floor(diff / 60000);
            const hours = Math.floor(minutes / 60);
            const days = Math.floor(hours / 24);
            const dayUnit = days > 1 ? t('time.days') : t('time.day');
            const hourUnit = (hours % 24) > 1 ? t('time.hours') : t('time.hour');
            const minuteUnit = (minutes % 60) > 1 ? t('time.minutes') : t('time.minute');
            const minuteUnitSingle = minutes > 1 ? t('time.minutes') : t('time.minute');
            if (days > 0) return `${days} ${dayUnit} ${hours % 24} ${hourUnit}`;
            if (hours > 0) return `${hours} ${hourUnit} ${minutes % 60} ${minuteUnit}`;
            return `${minutes} ${minuteUnitSingle}`;
          };
          const fullDate = (iso?: string) => iso
            ? formatDateTime(iso, timeFormat, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', second: '2-digit', timeZoneName: 'short' })
            : '-';
          const auth = email.authenticationResults;
          const totalAttachmentSize = effectiveAttachments.reduce((s, a) => s + (a.size || 0), 0);
          const topMimeType = email.bodyStructure?.type;
          const SectionHeader = ({ children }: { children: React.ReactNode }) => (
            <div className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase mb-1.5">
              {children}
            </div>
          );
          const Row = ({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) => (
            <>
              <dt className="text-muted-foreground text-xs pt-1">{label}</dt>
              <dd className={cn(
                "text-sm text-foreground min-w-0 break-words",
                mono && "font-mono text-xs",
              )}>{children}</dd>
            </>
          );
          const AuthChip = ({ name, result, extra, tooltip }: { name: string; result?: string; extra?: React.ReactNode; tooltip?: string }) => {
            if (!result) return null;
            const status = getSecurityStatus(result);
            const Icon = status.icon === 'check' ? Check
              : status.icon === 'x' ? X
              : status.icon === 'alert' ? AlertTriangle
              : Minus;
            return (
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs",
                  tooltip && "cursor-help",
                  status.icon === 'check' && "bg-green-500/[0.07] border-green-500/30",
                  status.icon === 'x' && "bg-red-500/[0.07] border-red-500/30",
                  status.icon === 'alert' && "bg-amber-500/[0.07] border-amber-500/30",
                  status.icon === 'minus' && "bg-muted/40 border-border",
                )}
                title={tooltip}
              >
                <Icon className={cn("w-3.5 h-3.5 flex-shrink-0", status.color)} />
                <span className="font-medium text-foreground">{name}</span>
                <span className={cn("text-[10px] uppercase tracking-wider", status.color)}>
                  {translateAuthResult(result)}
                </span>
                {extra && (
                  <>
                    <span className="text-muted-foreground/50">·</span>
                    <span className="text-muted-foreground">{extra}</span>
                  </>
                )}
              </span>
            );
          };

          const hasIdentifiers = !!(email.messageId || email.inReplyTo?.length || email.references?.length || email.threadId);
          const hasListInfo = !!(listHeaders?.listId || listHeaders?.listUnsubscribe || listHeaders?.listHelp || listHeaders?.listPost);
          const hasAuthSection = !!(auth?.spf || auth?.dkim || auth?.dmarc || auth?.iprev || email.spamScore !== undefined || email.spamLLM);

          // Projected, read-only view handed to plugins that render in the
          // "more details" panel. Includes the parsed `headers` map and full
          // `source` so plugins can inspect raw headers / message source.
          // Built lazily here - only when the details panel is expanded.
          const detailsView = emailToReadView(email);
          // Lets a plugin add rows under an existing category. The plugin's
          // own `shouldShow({ email, category })` decides which category it
          // appears under (or `category === null` for the new bottom section).
          const CategorySlot = ({ category }: { category: string }) => (
            <PluginSlot
              name="email-details-section"
              className="mt-2 empty:mt-0"
              extraProps={{ email: detailsView, category }}
            />
          );

          return (
            <div className="bg-background border-b border-border px-4 lg:px-6" style={{ paddingBlock: 'var(--density-header-py)' }}>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-10 gap-y-5">
                <section className="min-w-0">
                  <SectionHeader>{t('details.recipients_routing')}</SectionHeader>
                  <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1.5">
                    <Row label={t('from')}>
                      <div className="flex flex-wrap items-center gap-1">
                        <RecipientPopover
                          name={sender?.name}
                          email={sender?.email || ''}
                          displayLabel={sender?.name && sender?.email ? `${sender.name} <${sender.email}>` : undefined}
                          onViewContact={handleViewContactSidebar}
                          className="text-sm text-left"
                        />
                      </div>
                    </Row>
                    {replyToDifferent && (
                      <Row label={t('reply_to_label').replace(':', '')}>
                        <div className="flex flex-wrap items-center gap-1">
                          {email.replyTo!.map((r, i) => (
                            <RecipientPopover key={r.email + i} name={r.name} email={r.email} onViewContact={handleViewContactSidebar} className="text-sm" />
                          ))}
                        </div>
                      </Row>
                    )}
                    {email.to && email.to.length > 0 && (
                      <Row label={t('to')}>
                        <div className="flex flex-wrap items-center gap-1">
                          {renderClickableRecipients(email.to, currentUserEmail, t, handleViewContactSidebar, 100)}
                        </div>
                      </Row>
                    )}
                    {email.cc && email.cc.length > 0 && (
                      <Row label={t('cc')}>
                        <div className="flex flex-wrap items-center gap-1">
                          {renderClickableRecipients(email.cc, currentUserEmail, t, handleViewContactSidebar, 100)}
                        </div>
                      </Row>
                    )}
                    {email.bcc && email.bcc.length > 0 && (
                      <Row label={t('bcc')}>
                        <div className="flex flex-wrap items-center gap-1">
                          {renderClickableRecipients(email.bcc, currentUserEmail, t, handleViewContactSidebar, 100)}
                        </div>
                      </Row>
                    )}
                    {email.sentAt && (
                      <Row label={t('details.sent')}>{fullDate(email.sentAt)}</Row>
                    )}
                    <Row label={t('details.received')}>
                      {fullDate(email.receivedAt)}
                      {deliveryDeltaMs > 60000 && (
                        <span className="text-muted-foreground"> · {formatDelta(deliveryDeltaMs)} {t('details.delivery_time').toLowerCase()}</span>
                      )}
                    </Row>
                  </dl>
                  <CategorySlot category="recipients_routing" />
                </section>

                {hasAuthSection && (
                  <section className="min-w-0">
                    <SectionHeader>{t('details.authentication_security')}</SectionHeader>
                    <div className="flex flex-wrap gap-1.5">
                      {auth?.spf && (() => {
                        // When multiple identities (HELO + MAIL FROM) were
                        // evaluated, list each result in the tooltip for full
                        // transparency; the chip itself shows the most severe.
                        const breakdown = auth.spf.all && auth.spf.all.length > 1
                          ? auth.spf.all
                              .map((r) => {
                                const label = r.identity === 'mailfrom' ? 'MAIL FROM' : r.identity === 'helo' ? 'HELO' : 'SPF';
                                return `${label}: ${translateAuthResult(r.result)}${r.domain ? ` (${r.domain})` : ''}`;
                              })
                              .join('\n')
                          : null;
                        return (
                          <AuthChip
                            name="SPF"
                            result={auth.spf.result}
                            extra={auth.spf.domain}
                            tooltip={breakdown ? `${t('authentication.tooltip_spf')}\n\n${breakdown}` : t('authentication.tooltip_spf')}
                          />
                        );
                      })()}
                      {auth?.dkim && (
                        <AuthChip name="DKIM" result={auth.dkim.result} extra={auth.dkim.domain} tooltip={t('authentication.tooltip_dkim')} />
                      )}
                      {auth?.dmarc && (
                        <AuthChip name="DMARC" result={auth.dmarc.result} extra={auth.dmarc.policy ? `${t('authentication.policy').toLowerCase()}: ${auth.dmarc.policy}` : undefined} tooltip={t('authentication.tooltip_dmarc')} />
                      )}
                      {auth?.iprev && (
                        <AuthChip name={t('details.iprev')} result={auth.iprev.result} extra={auth.iprev.ip} />
                      )}
                      {email.spamScore !== undefined && (
                        <span className={cn(
                          "inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs",
                          email.spamScore > 5 ? "bg-red-500/[0.07] border-red-500/30" :
                          email.spamScore > 2 ? "bg-amber-500/[0.07] border-amber-500/30" :
                          "bg-green-500/[0.07] border-green-500/30",
                        )}>
                          <Shield className={cn(
                            "w-3.5 h-3.5",
                            email.spamScore > 5 ? "text-red-700 dark:text-red-400" :
                            email.spamScore > 2 ? "text-amber-700 dark:text-amber-400" :
                            "text-green-700 dark:text-green-400",
                          )} />
                          <span className="font-medium text-foreground">{t('authentication.spam_score')}</span>
                          <span className={cn(
                            "text-[10px] uppercase tracking-wider",
                            email.spamScore > 5 ? "text-red-700 dark:text-red-400" :
                            email.spamScore > 2 ? "text-amber-700 dark:text-amber-400" :
                            "text-green-700 dark:text-green-400",
                          )}>
                            {email.spamScore.toFixed(1)}
                          </span>
                          {email.spamStatus && (
                            <>
                              <span className="text-muted-foreground/50">·</span>
                              <span className="text-muted-foreground">{email.spamStatus}</span>
                            </>
                          )}
                        </span>
                      )}
                    </div>
                    {email.spamLLM && (
                      <div className="mt-2 flex items-start gap-2 text-sm">
                        {email.spamLLM.verdict === 'LEGITIMATE' ? <Brain className="w-4 h-4 mt-0.5 flex-shrink-0 text-green-700 dark:text-green-400" /> :
                         email.spamLLM.verdict === 'SPAM' ? <ShieldAlert className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-700 dark:text-red-400" /> :
                         <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-700 dark:text-amber-400" />}
                        <div className="min-w-0">
                          <span className={cn(
                            "font-medium",
                            email.spamLLM.verdict === 'LEGITIMATE' ? "text-green-700 dark:text-green-400" :
                            email.spamLLM.verdict === 'SPAM' ? "text-red-700 dark:text-red-400" :
                            "text-amber-700 dark:text-amber-400",
                          )}>
                            {email.spamLLM.verdict}
                          </span>
                          <span className="text-muted-foreground"> · {email.spamLLM.explanation}</span>
                        </div>
                      </div>
                    )}
                    <CategorySlot category="authentication_security" />
                  </section>
                )}

                {hasIdentifiers && (
                  <section className="min-w-0">
                    <SectionHeader>{t('details.identifiers_threading')}</SectionHeader>
                    <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1.5">
                      {email.messageId && (
                        <Row label={t('headers.message_id')} mono>{email.messageId}</Row>
                      )}
                      {email.inReplyTo && email.inReplyTo.length > 0 && (
                        <Row label={t('details.in_reply_to')} mono>
                          <div className="space-y-0.5">
                            {email.inReplyTo.map((id, i) => <div key={i} className="break-all">{id}</div>)}
                          </div>
                        </Row>
                      )}
                      {email.references && email.references.length > 0 && (
                        <Row label={t('details.references')}>
                          <details className="group">
                            <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground transition-colors list-none flex items-center gap-1">
                              <ChevronDown className="w-3 h-3 group-open:rotate-180 transition-transform" />
                              {t(email.references.length === 1 ? 'previous_messages' : 'previous_messages_plural', { count: email.references.length })}
                            </summary>
                            <div className="mt-1 space-y-0.5 font-mono text-xs">
                              {email.references.map((id, i) => <div key={i} className="break-all">{id}</div>)}
                            </div>
                          </details>
                        </Row>
                      )}
                      {email.threadId && (
                        <Row label={t('details.thread_id')} mono>{email.threadId}</Row>
                      )}
                    </dl>
                    <CategorySlot category="identifiers_threading" />
                  </section>
                )}

                <section className="min-w-0">
                  <SectionHeader>{t('details.message_properties')}</SectionHeader>
                  <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1.5">
                    {email.subject !== undefined && (
                      <Row label={t('subject')}>{email.subject || <span className="italic text-muted-foreground">{t('details.no_subject')}</span>}</Row>
                    )}
                    <Row label={t('details.size')}>
                      {formatFileSize(email.size)}
                      {topMimeType && (
                        <span className="text-muted-foreground"> · <span className="font-mono text-xs">{topMimeType}</span></span>
                      )}
                    </Row>
                    {effectiveAttachments.length > 0 && (
                      <Row label={t('attachments')}>
                        {t('details.attachments_summary', {
                          count: effectiveAttachments.length,
                          size: formatFileSize(totalAttachmentSize),
                        })}
                      </Row>
                    )}
                    {email.accountLabel && (
                      <Row label={t('details.account')}>{email.accountLabel}</Row>
                    )}
                  </dl>
                  <CategorySlot category="message_properties" />
                </section>

                {hasListInfo && (
                  <section className="lg:col-span-2 min-w-0">
                    <SectionHeader>{t('details.mailing_list')}</SectionHeader>
                    <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1.5">
                      {listHeaders?.listId && (
                        <Row label={t('details.list_id')} mono>{listHeaders.listId}</Row>
                      )}
                      {listHeaders?.listUnsubscribe?.preferred && (
                        <Row label={t('details.list_unsubscribe')}>
                          <span className="break-all">
                            {listHeaders.listUnsubscribe.preferred === 'http'
                              ? listHeaders.listUnsubscribe.http
                              : listHeaders.listUnsubscribe.mailto}
                          </span>
                        </Row>
                      )}
                      {listHeaders?.listHelp && (
                        <Row label={t('details.list_help')}><span className="break-all">{listHeaders.listHelp}</span></Row>
                      )}
                      {listHeaders?.listPost && (
                        <Row label={t('details.list_post')}><span className="break-all">{listHeaders.listPost}</span></Row>
                      )}
                    </dl>
                    <CategorySlot category="mailing_list" />
                  </section>
                )}

                {/* Plugin-supplied category. Plugins whose shouldShow accepts
                    `category === null` render their own titled section here. */}
                {hasDetailsSlotOffers && (
                  <section className="lg:col-span-2 min-w-0">
                    <PluginSlot
                      name="email-details-section"
                      extraProps={{ email: detailsView, category: null }}
                    />
                  </section>
                )}
              </div>
            </div>
          );
        })()}

        {/* Scheduled Banner */}
        {isScheduled && (
          <div className="border-b border-border bg-primary/10">
            <div className="max-w-4xl mx-auto px-6 py-2.5 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-primary">
                <CalendarClock className="w-4 h-4" />
                <span className="text-sm font-medium">
                  {t('scheduled_banner', { date: email.scheduledSendAt ? formatDateTime(email.scheduledSendAt, timeFormat) : '' })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {canCancelScheduled && (
                  <>
                    <Button size="sm" variant="default" onClick={() => onRescheduleScheduled?.(new Date(Date.now() + 1000).toISOString())}>{t('send_now')}</Button>
                    <Button size="sm" variant="outline" onClick={onCancelScheduled}>{t('cancel_scheduled_send')}</Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        const delayedUntil = promptForRescheduleDelayedUntil();
                        if (delayedUntil) onRescheduleScheduled?.(delayedUntil);
                      }}
                    >
                      {t('reschedule_send')}
                    </Button>
                    <Button size="sm" variant="outline" onClick={onCancelScheduledForEdit}>
                      {email.isSmimeScheduled ? t('cancel_and_compose_again') : t('cancel_and_edit')}
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Draft Banner */}
        {isDraft && (
          <div className="border-b border-border bg-warning/10">
            <div className="px-6 py-2.5 flex items-center justify-between">
              <div className="flex items-center gap-2 text-warning">
                <File className="w-4 h-4" />
                <span className="text-sm font-medium">{t('draft_banner')}</span>
              </div>
              {onEditDraft && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onEditDraft()}
                  className="gap-1.5"
                >
                  <EditIcon className="w-3.5 h-3.5" />
                  {t('edit_draft')}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Unified Notification Banner - External Content + Calendar Invitation + Read Receipt */}
        {((hasBlockedContent && !allowExternalContent && externalContentPolicy !== 'allow') ||
          hasCalendarInvitation ||
          (readReceiptResponse === 'ask' && shouldOfferReadReceipt)) && (
          <div className="border-b border-border bg-muted/30 isolate">
            <div className="px-6 py-1.5">
              <div className="flex flex-col gap-3 isolate">
                {/* External Content Controls */}
                {hasBlockedContent && !allowExternalContent && externalContentPolicy !== 'allow' && (
                  <div className="flex items-start gap-3 py-1">
                    <div className="w-10 h-10 rounded-full bg-info/15 text-info flex items-center justify-center flex-shrink-0 shadow-sm">
                      <Image className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0 space-y-2">
                      <div>
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          External Content
                        </div>
                        <div className="text-sm font-medium text-foreground break-words">
                          {t('external_content_warning')}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                        {externalContentPolicy === 'ask' && (
                          <button
                            onClick={() => setAllowExternalContent(true)}
                            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors min-h-[36px]"
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
                                if (trustedSendersAddressBook && client) {
                                  addToTrustedSendersBook(client, senderEmail).catch(console.error);
                                } else {
                                  addTrustedSender(senderEmail);
                                }
                                setAllowExternalContent(true);
                              }
                            }}
                            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors min-h-[36px]"
                          >
                            <ShieldCheck className="w-3.5 h-3.5" />
                            {t('trust_sender')}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}



                {/* Read-receipt (MDN) request banner — only in "ask" mode */}
                {readReceiptResponse === 'ask' && shouldOfferReadReceipt && readReceiptRequestedBy && (
                  <div className="py-1">
                    <ReadReceiptBanner
                      requestedBy={readReceiptRequestedBy}
                      onSend={() => sendReadReceiptNow(false)}
                      onIgnore={ignoreReadReceipt}
                    />
                  </div>
                )}

                {/* Calendar Invitation Banner */}
                {hasCalendarInvitation && (
                  <div className="py-1">
                    <CalendarInvitationBanner email={email} />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <PluginSlot name="email-banner" extraProps={{ email: emailToReadView(email) }} />

      {/* === ATTACHMENTS below header (below-header mode, desktop only) === */}
      {attachmentPosition === 'below-header' && effectiveAttachments.length > 0 && (
        <div className="hidden lg:block bg-background border-b border-border px-4 lg:px-6 py-2">
          <div className="relative flex items-center gap-2">
          <div ref={belowHeaderRowRef} className="relative flex items-center gap-2 overflow-hidden flex-1 min-w-0">
            {/* Hidden ghost row used purely for measuring chip widths */}
            <div
              ref={belowHeaderGhostRef}
              aria-hidden="true"
              className="absolute inset-y-0 left-0 right-0 flex items-center gap-2 invisible pointer-events-none whitespace-nowrap"
            >
              {effectiveAttachments.map((attachment) => {
                const FileIcon = getFileIcon(attachment.name || undefined, attachment.type);
                const hasThumb = !!imageThumbUrls[attachment.id];
                if (hasThumb) {
                  // Image chip is a fixed-width vertical card; only its width
                  // matters for the row-fit measurement.
                  return (
                    <div
                      key={`ghost-${attachment.id}`}
                      className="inline-block w-44 rounded-md border border-border/50 flex-shrink-0"
                      style={{ height: 1 }}
                    />
                  );
                }
                return (
                  <div
                    key={`ghost-${attachment.id}`}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border/50 flex-shrink-0"
                  >
                    <FileIcon className="w-4 h-4" />
                    <span className="text-sm truncate max-w-[200px]">
                      {getAttachmentDisplayName(attachment.name, attachment.type)}
                    </span>
                    <span className="text-xs">
                      {formatFileSize(attachment.size)}
                    </span>
                  </div>
                );
              })}
            </div>
            {effectiveAttachments
              .slice(0, visibleBelowHeaderCount ?? effectiveAttachments.length)
              .map((attachment) => {
              const FileIcon = getFileIcon(attachment.name || undefined, attachment.type);
              const isPreviewable = isFilePreviewable(attachment.name || undefined, attachment.type);
              const opensPreview = isPreviewable && mailAttachmentAction === 'preview';
              const thumbUrl = imageThumbUrls[attachment.id];
              return (
                <DraggableAttachmentChip key={attachment.id} attachment={attachment} client={client} enabled={dragOutActive} downloadName={resolveAttachmentName(attachment)}>
                  {(dragProps) => (
                <div
                  className={cn(
                    "bg-muted/60 hover:bg-muted rounded-md border border-border/50 group relative cursor-pointer flex-shrink-0 overflow-hidden",
                    thumbUrl
                      ? "inline-flex flex-col w-44"
                      : "inline-flex items-center gap-1.5 px-2.5 py-1.5",
                  )}
                  title={`${opensPreview ? tFiles('preview') : t('download')} ${getAttachmentDisplayName(attachment.name, attachment.type)}`}
                  onClick={() => handleEffectiveAttachmentOpen(attachment)}
                  draggable={dragProps.draggable}
                  onPointerEnter={dragProps.onPointerEnter}
                  onDragStart={dragProps.onDragStart}
                  onDragEnd={dragProps.onDragEnd}
                >
                  {thumbUrl && (
                    <div className="w-full h-20 bg-background/40 flex items-center justify-center overflow-hidden">
                      <img
                        src={thumbUrl}
                        alt=""
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </div>
                  )}
                  <div className={cn(
                    "flex items-center gap-1.5",
                    thumbUrl && "px-2 py-1.5 border-t border-border/50 w-full",
                  )}>
                    <FileIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <span className={cn(
                      "text-sm text-foreground truncate",
                      thumbUrl ? "flex-1 min-w-0" : "max-w-[200px]",
                    )}>
                      {getAttachmentDisplayName(attachment.name, attachment.type)}
                    </span>
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      {formatFileSize(attachment.size)}
                    </span>
                  </div>
                  <div className={cn(
                    "absolute rounded-md bg-background/95 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1 px-1.5",
                    thumbUrl ? "top-1 right-1" : "inset-y-0 right-0 rounded-r-md rounded-l-none",
                  )}>
                    <button
                      className="p-1 hover:bg-accent rounded transition-colors"
                      title={t('download')}
                      onClick={(e) => { e.stopPropagation(); handleEffectiveAttachmentDownload(attachment); }}
                    >
                      <Download className="w-4 h-4 text-foreground" />
                    </button>
                    {opensPreview && (
                      <button
                        className="p-1 hover:bg-accent rounded transition-colors"
                        title={tFiles('preview')}
                        onClick={(e) => { e.stopPropagation(); handleEffectiveAttachmentOpen(attachment); }}
                      >
                        <Eye className="w-4 h-4 text-foreground" />
                      </button>
                    )}
                  </div>
                </div>
                  )}
                </DraggableAttachmentChip>
              );
            })}
            {visibleBelowHeaderCount !== null && effectiveAttachments.length > visibleBelowHeaderCount && (
              <button
                onClick={() => setShowAllBelowHeaderAttachments(!showAllBelowHeaderAttachments)}
                className="inline-flex items-center px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-md border border-border/50 transition-colors flex-shrink-0"
              >
                +{effectiveAttachments.length - visibleBelowHeaderCount} {t('attachments').toLowerCase()}
              </button>
            )}
          </div>
            {downloadAllButton}
            {showAllBelowHeaderAttachments && visibleBelowHeaderCount !== null && effectiveAttachments.length > visibleBelowHeaderCount && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowAllBelowHeaderAttachments(false)} />
                <div className="absolute top-full right-0 mt-1 z-50 bg-background border border-border rounded-lg shadow-lg p-2 flex flex-col gap-1 min-w-[260px] max-h-[60vh] overflow-y-auto">
                  {effectiveAttachments.slice(visibleBelowHeaderCount).map((attachment) => {
                    const FileIcon = getFileIcon(attachment.name || undefined, attachment.type);
                    const isPreviewable = isFilePreviewable(attachment.name || undefined, attachment.type);
                    const opensPreview = isPreviewable && mailAttachmentAction === 'preview';
                    return (
                      <DraggableAttachmentChip key={attachment.id} attachment={attachment} client={client} enabled={dragOutActive} downloadName={resolveAttachmentName(attachment)}>
                        {(dragProps) => (
                      <div
                        className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-muted/60 group relative cursor-pointer w-full"
                        title={`${opensPreview ? tFiles('preview') : t('download')} ${getAttachmentDisplayName(attachment.name, attachment.type)}`}
                        onClick={() => { handleEffectiveAttachmentOpen(attachment); setShowAllBelowHeaderAttachments(false); }}
                        draggable={dragProps.draggable}
                        onPointerEnter={dragProps.onPointerEnter}
                        onDragStart={dragProps.onDragStart}
                        onDragEnd={dragProps.onDragEnd}
                      >
                        <FileIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                        <span className="text-sm text-foreground truncate max-w-[220px]">
                          {getAttachmentDisplayName(attachment.name, attachment.type)}
                        </span>
                        <span className="text-xs text-muted-foreground ml-auto flex-shrink-0">
                          {formatFileSize(attachment.size)}
                        </span>
                        <div className="absolute inset-y-0 right-0 rounded-r-md bg-background/95 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1 px-1.5">
                          <button
                            className="p-1 hover:bg-accent rounded transition-colors"
                            title={t('download')}
                            onClick={(e) => { e.stopPropagation(); handleEffectiveAttachmentDownload(attachment); setShowAllBelowHeaderAttachments(false); }}
                          >
                            <Download className="w-4 h-4 text-foreground" />
                          </button>
                          {opensPreview && (
                            <button
                              className="p-1 hover:bg-accent rounded transition-colors"
                              title={tFiles('preview')}
                              onClick={(e) => { e.stopPropagation(); handleEffectiveAttachmentOpen(attachment); setShowAllBelowHeaderAttachments(false); }}
                            >
                              <Eye className="w-4 h-4 text-foreground" />
                            </button>
                          )}
                        </div>
                      </div>
                        )}
                      </DraggableAttachmentChip>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}

        {/* Mobile/Tablet Attachments */}
        {effectiveAttachments.length > 0 && (
          <div className="lg:hidden bg-background border-b border-border px-4 py-2">
            <div className="relative flex items-center gap-1.5 flex-wrap">
              {effectiveAttachments.slice(0, 2).map((attachment) => {
                const FileIcon = getFileIcon(attachment.name || undefined, attachment.type);
                const isPreviewable = isFilePreviewable(attachment.name || undefined, attachment.type);
                const opensPreview = isPreviewable && mailAttachmentAction === 'preview';
                const thumbUrl = imageThumbUrls[attachment.id];
                return (
                  <DraggableAttachmentChip key={attachment.id} attachment={attachment} client={client} enabled={dragOutActive} downloadName={resolveAttachmentName(attachment)}>
                    {(dragProps) => (
                  <div
                    className={cn(
                      "bg-muted/60 hover:bg-muted rounded-md border border-border/50 group relative cursor-pointer overflow-hidden",
                      thumbUrl
                        ? "inline-flex flex-col w-44"
                        : "inline-flex items-center gap-1.5 px-2.5 py-1.5",
                    )}
                    title={`${opensPreview ? tFiles('preview') : t('download')} ${getAttachmentDisplayName(attachment.name, attachment.type)}`}
                    onClick={() => handleEffectiveAttachmentOpen(attachment)}
                    draggable={dragProps.draggable}
                    onPointerEnter={dragProps.onPointerEnter}
                    onDragStart={dragProps.onDragStart}
                    onDragEnd={dragProps.onDragEnd}
                  >
                    {thumbUrl && (
                      <div className="w-full h-20 bg-background/40 flex items-center justify-center overflow-hidden">
                        <img src={thumbUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                      </div>
                    )}
                    <div className={cn(
                      "flex items-center gap-1.5",
                      thumbUrl && "px-2 py-1.5 border-t border-border/50 w-full",
                    )}>
                      <FileIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      <span className={cn(
                        "text-sm text-foreground truncate",
                        thumbUrl ? "flex-1 min-w-0" : "max-w-[200px]",
                      )}>
                        {getAttachmentDisplayName(attachment.name, attachment.type)}
                      </span>
                      <span className="text-xs text-muted-foreground flex-shrink-0">
                        {formatFileSize(attachment.size)}
                      </span>
                    </div>
                    <div className={cn(
                      "absolute bg-background/95 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1 px-1.5 rounded-md",
                      thumbUrl ? "top-1 right-1" : "inset-y-0 right-0 rounded-l-none rounded-r-md",
                    )}>
                      <button
                        className="p-1 hover:bg-accent rounded transition-colors"
                        title={t('download')}
                        onClick={(e) => { e.stopPropagation(); handleEffectiveAttachmentDownload(attachment); }}
                      >
                        <Download className="w-4 h-4 text-foreground" />
                      </button>
                      {opensPreview && (
                        <button
                          className="p-1 hover:bg-accent rounded transition-colors"
                          title={tFiles('preview')}
                          onClick={(e) => { e.stopPropagation(); handleEffectiveAttachmentOpen(attachment); }}
                        >
                          <Eye className="w-4 h-4 text-foreground" />
                        </button>
                      )}
                    </div>
                  </div>
                    )}
                  </DraggableAttachmentChip>
                );
              })}
              {effectiveAttachments.length > 2 && (
                <button
                  onClick={() => setShowAllMobileAttachments(!showAllMobileAttachments)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-0.5"
                >
                  +{effectiveAttachments.length - 2} {t('more')}
                </button>
              )}
              {downloadAllButton}
              {showAllMobileAttachments && effectiveAttachments.length > 2 && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowAllMobileAttachments(false)} />
                  <div className="absolute top-full left-0 mt-1 z-50 bg-background border border-border rounded-lg shadow-lg p-2 flex flex-col gap-1 min-w-[220px]">
                    {effectiveAttachments.slice(2).map((attachment) => {
                      const FileIcon = getFileIcon(attachment.name || undefined, attachment.type);
                      const isPreviewable = isFilePreviewable(attachment.name || undefined, attachment.type);
                      const opensPreview = isPreviewable && mailAttachmentAction === 'preview';
                      return (
                        <DraggableAttachmentChip key={attachment.id} attachment={attachment} client={client} enabled={dragOutActive} downloadName={resolveAttachmentName(attachment)}>
                          {(dragProps) => (
                        <div
                          className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-muted/60 group relative cursor-pointer w-full"
                          title={`${opensPreview ? tFiles('preview') : t('download')} ${getAttachmentDisplayName(attachment.name, attachment.type)}`}
                          onClick={() => { handleEffectiveAttachmentOpen(attachment); setShowAllMobileAttachments(false); }}
                          draggable={dragProps.draggable}
                          onPointerEnter={dragProps.onPointerEnter}
                          onDragStart={dragProps.onDragStart}
                          onDragEnd={dragProps.onDragEnd}
                        >
                          <FileIcon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                          <span className="text-xs text-foreground truncate max-w-[180px]">
                            {getAttachmentDisplayName(attachment.name, attachment.type)}
                          </span>
                          <span className="text-[10px] text-muted-foreground ml-auto flex-shrink-0">
                            {formatFileSize(attachment.size)}
                          </span>
                          <div className="absolute inset-y-0 right-0 rounded-r-md bg-background/95 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1 px-1.5">
                            <button
                              className="p-1 hover:bg-accent rounded transition-colors"
                              title={t('download')}
                              onClick={(e) => { e.stopPropagation(); handleEffectiveAttachmentDownload(attachment); setShowAllMobileAttachments(false); }}
                            >
                              <Download className="w-3.5 h-3.5 text-foreground" />
                            </button>
                            {opensPreview && (
                              <button
                                className="p-1 hover:bg-accent rounded transition-colors"
                                title={tFiles('preview')}
                                onClick={(e) => { e.stopPropagation(); handleEffectiveAttachmentOpen(attachment); setShowAllMobileAttachments(false); }}
                              >
                                <Eye className="w-3.5 h-3.5 text-foreground" />
                              </button>
                            )}
                          </div>
                        </div>
                          )}
                        </DraggableAttachmentChip>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <div className="grow shrink-0 flex flex-col">

          {/* Email Body */}
          <div className={cn(
            "email-content-wrapper overflow-x-auto",
            !isDark && resolvedTheme === 'dark' ? "bg-white email-content-light" : "bg-background"
          )}
          style={isDark ? { backgroundColor: '#121212' } : undefined}>
            {isBodyLoading ? (
              <div
                className="space-y-3 px-6 py-4 animate-pulse"
                style={{ minHeight: `${lastBodyHeightRef.current}px` }}
              >
                <div className="h-2 bg-muted/15 rounded w-full"></div>
                <div className="h-2 bg-muted/15 rounded w-5/6"></div>
                <div className="h-2 bg-muted/15 rounded w-4/6"></div>
                <div className="h-2 bg-muted/15 rounded w-full"></div>
                <div className="h-2 bg-muted/15 rounded w-3/4"></div>
              </div>
            ) : effectiveEmailContent.isHtml ? (
              <iframe
                ref={iframeRef}
                srcDoc={emailIframeSrcDoc}
                sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                title="Email content"
                className="w-full border-0 block"
                scrolling="no"
                style={{ minHeight: '100px', colorScheme: isDark && emailHasNativeDarkMode ? 'light dark' : 'light' }}
                onLoad={handleIframeLoad}
              />
            ) : (
              <div
                className="email-content-text text-foreground"
                dangerouslySetInnerHTML={{ __html: sanitizePlainTextRenderedHtml(effectiveEmailContent.html) }}
                style={{
                  fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
                  fontSize: '14px',
                  lineHeight: '1.6',
                  wordBreak: 'break-word',
                  whiteSpace: 'pre-wrap',
                }}
              />
            )}
          </div>

          <PluginSlot name="email-footer" />

          {/* Quick Reply Section - hidden for drafts and while loading a new email */}
          {!isDraft && !isScheduled && !isBodyLoading && (effectiveEmailContent.isHtml ? iframeReady : true) && (<div className="bg-background border-t border-border px-6 mt-auto" style={{ paddingBlock: 'var(--density-header-py)' }}>
            <div className="flex items-start" style={{ gap: 'var(--density-item-gap)' }}>
              <div className="flex-shrink-0">
                <Avatar
                  name={activeAccount?.displayName || currentUserName || "You"}
                  email={activeAccount?.email || activeAccount?.username || currentUserEmail || ""}
                  size="lg"
                  className="shadow-sm w-10 h-10"
                  disableFavicon
                  fallbackColor={activeAccount?.avatarColor}
                />
              </div>
              <div className="flex-1 min-w-0 space-y-3">
                  <textarea
                    value={quickReplyText}
                    onChange={(e) => setQuickReplyText(e.target.value)}
                    onFocus={() => setIsQuickReplyFocused(true)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        void handleSendQuickReply();
                      }
                    }}
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
                          onClick={handleSendQuickReply}
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
          </div>)}
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

    {/* Mobile bottom action bar */}
    {isMobile && (
      <nav className="fixed bottom-0 left-0 right-0 z-50 bg-background border-t border-border sm:hidden overflow-hidden pb-[calc(env(safe-area-inset-bottom)/2)]">
        <div className="flex items-center overflow-x-auto mobile-scroll-hidden">
          <button
            onClick={onNavigatePrev}
            disabled={!onNavigatePrev}
            className={cn(
              "flex flex-col items-center justify-center gap-1 py-2 px-1 min-h-[44px] grow shrink-0 basis-[64px] transition-colors duration-150",
              onNavigatePrev ? "text-muted-foreground active:text-foreground" : "text-muted-foreground/30"
            )}
            aria-label={t('tooltips.previous')}
          >
            <ChevronLeft className="w-5 h-5" />
            <span className="text-[10px] font-medium leading-tight truncate max-w-full">{t('previous')}</span>
          </button>
          {isDraft && onEditDraft ? (
            <button
              onClick={() => onEditDraft()}
              className="flex flex-col items-center justify-center gap-1 py-2 px-1 min-h-[44px] grow shrink-0 basis-[64px] text-primary active:text-primary/80 transition-colors duration-150"
              aria-label={t('tooltips.edit_draft')}
            >
              <EditIcon className="w-5 h-5" />
              <span className="text-[10px] font-medium leading-tight truncate max-w-full">{t('edit_draft')}</span>
            </button>
          ) : (
          <>
          <button
            onClick={() => onReply?.()}
            className="flex flex-col items-center justify-center gap-1 py-2 px-1 min-h-[44px] grow shrink-0 basis-[64px] text-muted-foreground active:text-foreground transition-colors duration-150"
            aria-label={t('tooltips.reply')}
          >
            <Reply className="w-5 h-5" />
            <span className="text-[10px] font-medium leading-tight truncate max-w-full">{t('reply')}</span>
          </button>
          <button
            onClick={onReplyAll}
            className="flex flex-col items-center justify-center gap-1 py-2 px-1 min-h-[44px] grow shrink-0 basis-[64px] text-muted-foreground active:text-foreground transition-colors duration-150"
            aria-label={t('tooltips.reply_all')}
          >
            <ReplyAll className="w-5 h-5" />
            <span className="text-[10px] font-medium leading-tight truncate max-w-full">{t('reply_all')}</span>
          </button>
          <button
            onClick={onForward}
            className="flex flex-col items-center justify-center gap-1 py-2 px-1 min-h-[44px] grow shrink-0 basis-[64px] text-muted-foreground active:text-foreground transition-colors duration-150"
            aria-label={t('tooltips.forward')}
          >
            <Forward className="w-5 h-5" />
            <span className="text-[10px] font-medium leading-tight truncate max-w-full">{t('forward')}</span>
          </button>
          </>)}
          <button
            onClick={onNavigateNext}
            disabled={!onNavigateNext}
            className={cn(
              "flex flex-col items-center justify-center gap-1 py-2 px-1 min-h-[44px] grow shrink-0 basis-[64px] transition-colors duration-150",
              onNavigateNext ? "text-muted-foreground active:text-foreground" : "text-muted-foreground/30"
            )}
            aria-label={t('tooltips.next')}
          >
            <ChevronRight className="w-5 h-5" />
            <span className="text-[10px] font-medium leading-tight truncate max-w-full">{t('next')}</span>
          </button>
        </div>
      </nav>
    )}

    {/* Plugin Detail Sidebar - resizable, collapsible */}
    {hasDetailSidebar && !isMobile && (
      <>
        {/* Collapse toggle when sidebar is collapsed */}
        {detailSidebarCollapsed && (
          <div className="flex flex-col items-center border-l border-border bg-background">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDetailSidebarCollapsed(false)}
              className="h-8 w-8 m-1"
              aria-label="Expand panel"
            >
              <PanelRightOpen className="w-4 h-4" />
            </Button>
          </div>
        )}
        {!detailSidebarCollapsed && (
          <>
            <ResizeHandle
              onResizeStart={() => { detailSidebarWidthRef.current = detailSidebarWidth; }}
              onResize={(delta) => {
                const newWidth = Math.max(200, Math.min(500, detailSidebarWidthRef.current - delta));
                setDetailSidebarWidth(newWidth);
              }}
              onResizeEnd={() => { detailSidebarWidthRef.current = detailSidebarWidth; }}
              onDoubleClick={() => setDetailSidebarWidth(280)}
            />
            <div
              className="flex flex-col h-full border-l border-border bg-background overflow-hidden"
              style={{ width: detailSidebarWidth, minWidth: detailSidebarWidth }}
            >
              <div className="flex items-center justify-end px-1 py-1 border-b border-border shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setDetailSidebarCollapsed(true)}
                  className="h-7 w-7"
                  aria-label="Collapse panel"
                >
                  <PanelRightClose className="w-4 h-4" />
                </Button>
              </div>
              <div className="flex-1 overflow-y-auto">
                <PluginSlot name="email-detail-sidebar" extraProps={{ email }} />
              </div>
            </div>
          </>
        )}
      </>
    )}

    {/* Contact Detail Sidebar - desktop only */}
    {contactSidebarEmail && !isMobileDevice && (
      <ContactSidebarPanel
        email={contactSidebarEmail}
        contact={sidebarContact}
        senderName={(() => {
          const allRecipients = [...(email?.from || []), ...(email?.to || []), ...(email?.cc || []), ...(email?.bcc || []), ...(email?.replyTo || [])];
          return allRecipients.find(r => r.email.toLowerCase() === contactSidebarEmail.toLowerCase())?.name;
        })()}
        onClose={() => setContactSidebarEmail(null)}
        onEditContact={sidebarContact ? () => {
          router.push(`/contacts?contactId=${sidebarContact.id}&view=edit`);
          setContactSidebarEmail(null);
        } : undefined}
        onAddToContacts={(addr, name) => {
          const { createContact, addLocalContact, supportsSync } = useContactStore.getState();
          const client = useAuthStore.getState().client;
          const contactData: Partial<ContactCard> = {
            emails: { email: { address: addr } },
            ...(name ? { name: { components: name.includes(' ')
              ? [{ kind: 'given' as const, value: name.split(' ')[0] }, { kind: 'surname' as const, value: name.split(' ').slice(1).join(' ') }]
              : [{ kind: 'given' as const, value: name }]
            }} : {}),
          };
          if (client && supportsSync) {
            createContact(client, contactData).then(() => toast.success('Contact added'));
          } else {
            addLocalContact({ id: `local-${generateUUID()}`, addressBookIds: {}, ...contactData } as ContactCard);
            toast.success('Contact added');
          }
        }}
      />
    )}

    </div>
  );
}
