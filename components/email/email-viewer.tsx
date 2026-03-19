"use client";

import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from "react";
import ReactDOM from "react-dom";
import DOMPurify from "dompurify";
import { Email, ContactCard, Mailbox } from "@/lib/jmap/types";
import { EMAIL_SANITIZE_CONFIG, collapseBlockedImageContainers } from "@/lib/email-sanitization";
import { hasMeaningfulHtmlBody } from "@/lib/signature-utils";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { formatFileSize, cn, buildMailboxTree, MailboxNode, formatDateTime } from "@/lib/utils";
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
  ChevronRight,
  Download,
  Mail,
  MailOpen,
  Clock,
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
  FolderInput,
  Inbox,
  Folder,
  Sun,
  Upload,
  Moon,
  HelpCircle,
  EditIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { Attachment as PostalMimeAttachment } from 'postal-mime';
import { useSettingsStore, KEYWORD_PALETTE } from "@/stores/settings-store";
import { useUIStore } from "@/stores/ui-store";
import { useContactStore, getContactDisplayName, getContactPrimaryEmail } from "@/stores/contact-store";
import { toast } from "@/stores/toast-store";
import { useDeviceDetection } from "@/hooks/use-media-query";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useThemeStore } from "@/stores/theme-store";
import { EmailIdentityBadge } from "./email-identity-badge";
import { UnsubscribeBanner } from "./unsubscribe-banner";
import { CalendarInvitationBanner } from "./calendar-invitation-banner";
import { SmimePassphraseDialog } from "@/components/settings/smime-passphrase-dialog";
import { findCalendarAttachment } from "@/lib/calendar-invitation";
import { RecipientPopover } from "./recipient-popover";
import { isFilePreviewable } from "@/lib/file-preview";
import { SmimeStatusBanner } from "./smime-status-banner";
import { detectSmime } from "@/lib/smime/smime-detect";
import { smimeDecrypt, SmimeKeyLockedError, normalizeCmsBytes } from "@/lib/smime/smime-decrypt";
import { smimeVerify } from "@/lib/smime/smime-verify";
import { useSmimeStore } from "@/stores/smime-store";
import type { SmimeStatus } from "@/lib/smime/types";
import { parseTnef, isTnefAttachment } from "@/lib/tnef";
import { debug } from "@/lib/debug";
import type { TnefAttachment } from "@/lib/tnef";

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

function parseMimeHeaders(headerText: string): Map<string, string> {
  const headers = new Map<string, string>();
  const lines = headerText.split(/\r?\n/);
  let currentKey: string | null = null;

  for (const line of lines) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && currentKey) {
      headers.set(currentKey, `${headers.get(currentKey) || ''} ${line.trim()}`.trim());
      continue;
    }

    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) continue;

    currentKey = line.slice(0, separatorIndex).trim().toLowerCase();
    headers.set(currentKey, line.slice(separatorIndex + 1).trim());
  }

  return headers;
}

function getMimeBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  return match?.[1] || match?.[2] || null;
}

function decodeQuotedPrintableUtf8(input: string): string {
  const normalized = input.replace(/=(\r?\n)/g, '');
  const bytes: number[] = [];

  for (let index = 0; index < normalized.length; index++) {
    if (normalized[index] === '=' && /^[0-9A-Fa-f]{2}$/.test(normalized.slice(index + 1, index + 3))) {
      bytes.push(parseInt(normalized.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    bytes.push(normalized.charCodeAt(index) & 0xff);
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

function decodeBase64Utf8(input: string): string {
  const cleaned = input.replace(/\s/g, '');
  if (!cleaned) return '';
  try {
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return input;
  }
}

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

function splitMimeHeadersAndBody(rawText: string): { headerText: string; bodyText: string } {
  const separatorMatch = rawText.match(/\r?\n\r?\n/);
  const separatorIndex = separatorMatch?.index ?? -1;
  const separator = separatorMatch?.[0] ?? '';

  if (separatorIndex < 0) {
    return { headerText: '', bodyText: rawText };
  }

  return {
    headerText: rawText.slice(0, separatorIndex),
    bodyText: rawText.slice(separatorIndex + separator.length),
  };
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

function extractNestedSignedDataCandidate(
  parsed: { attachments?: Array<unknown>; headers?: Array<{ key: string; value: string }> },
  rawBytes: Uint8Array,
): { source: string; bytes: ArrayBuffer } | null {
  const topLevelContentType = (parsed.headers?.find(h => h.key === 'content-type')?.value || '').toLowerCase();
  if (topLevelContentType.includes('application/pkcs7-mime') && topLevelContentType.includes('signed-data')) {
    const rawText = new TextDecoder().decode(rawBytes);
    const { bodyText } = splitMimeHeadersAndBody(rawText);
    const topLevelTransferEncoding = (
      parsed.headers?.find(h => h.key === 'content-transfer-encoding')?.value || ''
    ).toLowerCase();

    if (topLevelTransferEncoding.includes('base64')) {
      const decoded = decodeBase64Bytes(bodyText);
      if (decoded) {
        return {
          source: 'top-level-content-type-body',
          bytes: decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as ArrayBuffer,
        };
      }
    }

    const bodyBytes = new TextEncoder().encode(bodyText);
    return {
      source: 'top-level-content-type-body-text',
      bytes: bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength) as ArrayBuffer,
    };
  }

  const rawText = new TextDecoder().decode(rawBytes);
  const messageContent = splitMimeHeadersAndBody(rawText).bodyText;
  const { headerText, bodyText } = splitMimeHeadersAndBody(messageContent);
  const bodyHeaders = parseMimeHeaders(headerText);
  const bodyContentType = (bodyHeaders.get('content-type') || '').toLowerCase();
  const bodyTransferEncoding = (bodyHeaders.get('content-transfer-encoding') || '').toLowerCase();

  if (bodyContentType.includes('application/pkcs7-mime') && bodyContentType.includes('signed-data')) {
    if (bodyTransferEncoding.includes('base64')) {
      const decoded = decodeBase64Bytes(bodyText);
      if (decoded) {
        return {
          source: 'message-body-signed-data',
          bytes: decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as ArrayBuffer,
        };
      }
    }

    const bodyBytes = new TextEncoder().encode(bodyText);
    return {
      source: 'message-body-signed-data-text',
      bytes: bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength) as ArrayBuffer,
    };
  }

  const nestedAttachment = parsed.attachments?.find(attachment => {
    const mimeType = ((attachment as { mimeType?: string }).mimeType || '').toLowerCase();
    const filename = ((attachment as { filename?: string | null }).filename || '').toLowerCase();
    return mimeType.includes('application/pkcs7-mime') || filename.endsWith('.p7m');
  }) as {
    filename?: string | null;
    mimeType?: string;
    encoding?: 'base64' | 'utf8';
    content?: ArrayBuffer | Uint8Array | string;
  } | undefined;

  if (!nestedAttachment) {
    return null;
  }

  const attachmentBytes = getAttachmentContentBytes(nestedAttachment);
  if (!attachmentBytes) {
    return null;
  }

  return {
    source: nestedAttachment.mimeType || nestedAttachment.filename || 'attachment-signed-data',
    bytes: attachmentBytes.buffer.slice(
      attachmentBytes.byteOffset,
      attachmentBytes.byteOffset + attachmentBytes.byteLength,
    ) as ArrayBuffer,
  };
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

function extractMimePartContent(rawText: string, depth = 0): { html: string | null; text: string | null } {
  if (depth > 6) {
    const trimmed = rawText.trim();
    return { html: null, text: trimmed || null };
  }

  const separatorMatch = rawText.match(/\r?\n\r?\n/);
  const separatorIndex = separatorMatch?.index ?? -1;
  const separator = separatorMatch?.[0] ?? '';

  const headerText = separatorIndex >= 0 ? rawText.slice(0, separatorIndex) : '';
  const bodyText = separatorIndex >= 0 ? rawText.slice(separatorIndex + separator.length) : rawText;
  const headers = parseMimeHeaders(headerText);
  const contentType = (headers.get('content-type') || '').toLowerCase();
  const transferEncoding = (headers.get('content-transfer-encoding') || '').toLowerCase();

  if (contentType.includes('multipart/')) {
    const boundary = getMimeBoundary(contentType);
    if (boundary) {
      const boundaryMarker = `--${boundary}`;
      const sections = bodyText.split(boundaryMarker);
      let bestHtml: string | null = null;
      let bestText: string | null = null;

      for (const section of sections) {
        const trimmedSection = section.trim();
        if (!trimmedSection || trimmedSection === '--') continue;
        const normalizedSection = trimmedSection.endsWith('--')
          ? trimmedSection.slice(0, -2).trim()
          : trimmedSection;
        const extracted = extractMimePartContent(normalizedSection, depth + 1);
        if (extracted.html && !bestHtml) {
          bestHtml = extracted.html;
        }
        if (extracted.text && !bestText) {
          bestText = extracted.text;
        }
        if (bestHtml && bestText) break;
      }

      return { html: bestHtml, text: bestText };
    }
  }

  if (contentType.includes('message/rfc822')) {
    return extractMimePartContent(bodyText, depth + 1);
  }

  let decodedBody = bodyText;
  if (transferEncoding.includes('quoted-printable')) {
    decodedBody = decodeQuotedPrintableUtf8(bodyText);
  } else if (transferEncoding.includes('base64')) {
    decodedBody = decodeBase64Utf8(bodyText);
  }

  const trimmedBody = decodedBody.trim();
  if (!trimmedBody) {
    return { html: null, text: null };
  }

  if (contentType.includes('text/html')) {
    return { html: decodedBody, text: null };
  }

  if (contentType.includes('text/plain')) {
    return { html: null, text: decodedBody };
  }

  if (/^\s*</.test(trimmedBody) && /<html|<body|<div|<p|<table|<br/i.test(trimmedBody)) {
    return { html: decodedBody, text: null };
  }

  return { html: null, text: decodedBody };
}

function getRenderableSmimeContent(
  parsed: { html?: string; text?: string; attachments?: Array<unknown> },
  rawBytes: Uint8Array,
): { html: string | null; text: string | null; fallbackUsed: boolean } {
  const parsedHtml = parsed.html?.trim() ? parsed.html : null;
  const parsedText = parsed.text?.trim() ? parsed.text : null;

  if (parsedHtml || parsedText) {
    return { html: parsedHtml, text: parsedText, fallbackUsed: false };
  }

  const rawText = new TextDecoder().decode(rawBytes);
  const fallback = extractMimePartContent(rawText);
  if (fallback.html || fallback.text) {
    return { html: fallback.html, text: fallback.text, fallbackUsed: true };
  }

  const trimmed = rawText.trim();
  return {
    html: null,
    text: trimmed || null,
    fallbackUsed: !!trimmed,
  };
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
function ContactSidebarPanel({
  email,
  contact,
  senderName,
  onClose,
  onAddToContacts,
}: {
  email: string;
  contact: ContactCard | null;
  senderName?: string;
  onClose: () => void;
  onAddToContacts?: (email: string, name?: string) => void;
}) {
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
          <div className="px-4 pb-4 text-center space-y-3">
            <p className="text-xs text-muted-foreground">
              Not in your contacts
            </p>
            {onAddToContacts && (
              <button
                onClick={() => onAddToContacts(email, senderName)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80 px-3 py-2 rounded-md hover:bg-muted transition-colors border border-border"
              >
                <Mail className="w-3.5 h-3.5" />
                Add to contacts
              </button>
            )}
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

function InfoTooltip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const show = () => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.top - 8, left: rect.left + rect.width / 2 });
    }
    setOpen(true);
  };
  const hide = () => setOpen(false);

  return (
    <span className="inline-flex">
      <button
        ref={btnRef}
        type="button"
        className="text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        onMouseEnter={show}
        onMouseLeave={hide}
        onClick={(e) => { e.stopPropagation(); if (open) { hide(); } else { show(); } }}
        aria-label="More info"
      >
        <HelpCircle className="w-3 h-3" />
      </button>
      {open && pos && ReactDOM.createPortal(
        <span
          className="fixed w-56 px-3 py-2 text-xs leading-relaxed rounded-lg shadow-lg border border-border bg-background text-foreground z-[9999] pointer-events-none animate-in fade-in zoom-in-95 duration-150"
          style={{ top: pos.top, left: pos.left, transform: 'translate(-50%, -100%)' }}
        >
          {text}
        </span>,
        document.body
      )}
    </span>
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
  currentUserEmail,
  currentUserName,
  currentMailboxRole,
  mailboxes = [],
  selectedMailbox = "",
  className,
}: EmailViewerProps) {
  const t = useTranslations('email_viewer');
  const tNotifications = useTranslations('notifications');
  const tCommon = useTranslations('common');
  const tSmime = useTranslations('smime');
  const tFiles = useTranslations('files');
  const externalContentPolicy = useSettingsStore((state) => state.externalContentPolicy);
  const mailAttachmentAction = useSettingsStore((state) => state.mailAttachmentAction);
  const attachmentPosition = useSettingsStore((state) => state.attachmentPosition);
  const addTrustedSender = useSettingsStore((state) => state.addTrustedSender);
  const isSenderTrusted = useSettingsStore((state) => state.isSenderTrusted);
  const emailKeywords = useSettingsStore((state) => state.emailKeywords);
  const toolbarPosition = useSettingsStore((state) => state.toolbarPosition);
  const showToolbarLabels = useSettingsStore((state) => state.showToolbarLabels);
  const calendarInvitationParsingEnabled = useSettingsStore((state) => state.calendarInvitationParsingEnabled);
  const timeFormat = useSettingsStore((state) => state.timeFormat);

  // Detect if current mailbox is Junk folder
  const isInJunkFolder = currentMailboxRole === 'junk';

  // Detect if the email is a draft
  const isDraft = email?.keywords?.['$draft'] === true;

  // Color options for email tags (from user-defined keyword settings)
  const colorOptions = emailKeywords.map((kw) => ({
    name: kw.label,
    value: kw.id,
    color: KEYWORD_PALETTE[kw.color]?.dot || 'bg-gray-500',
  }));

  // Tablet list visibility
  const { isTablet, isMobile } = useDeviceDetection();
  const { tabletListVisible } = useUIStore();
  const { identities, client } = useAuthStore();
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const [showFullHeaders, setShowFullHeaders] = useState(false);
  const [showAllBesideAttachments, setShowAllBesideAttachments] = useState(false);
  const [showAllMobileAttachments, setShowAllMobileAttachments] = useState(false);
  const [allowExternalContent, setAllowExternalContent] = useState(false);
  const [hasBlockedContent, setHasBlockedContent] = useState(false);
  const [cidBlobUrls, setCidBlobUrls] = useState<Record<string, string>>({});
  const [quickReplyText, setQuickReplyText] = useState("");
  const [isQuickReplyFocused, setIsQuickReplyFocused] = useState(false);
  const [isSendingQuickReply, setIsSendingQuickReply] = useState(false);
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
  const currentColor = getCurrentColor(email?.keywords);

  // S/MIME state
  const [smimeStatus, setSmimeStatus] = useState<SmimeStatus | null>(null);
  const [smimeDecryptedHtml, setSmimeDecryptedHtml] = useState<string | null>(null);
  const [smimeDecryptedText, setSmimeDecryptedText] = useState<string | null>(null);
  const [smimeDecryptedAttachments, setSmimeDecryptedAttachments] = useState<PostalMimeAttachment[]>([]);
  const [smimeUnlockDialogOpen, setSmimeUnlockDialogOpen] = useState(false);
  const [smimeUnlockTargetId, setSmimeUnlockTargetId] = useState<string | null>(null);
  const [smimeUnlockError, setSmimeUnlockError] = useState<string | null>(null);
  const smimeStore = useSmimeStore();

  // TNEF (winmail.dat) support
  const [tnefHtml, setTnefHtml] = useState<string | null>(null);
  const [tnefText, setTnefText] = useState<string | null>(null);
  const [tnefAttachments, setTnefAttachments] = useState<TnefAttachment[]>([]);

  // Embedded message/rfc822 unwrapping (Outlook forward-as-attachment)
  const [embeddedEmailHtml, setEmbeddedEmailHtml] = useState<string | null>(null);
  const [embeddedEmailText, setEmbeddedEmailText] = useState<string | null>(null);
  const [embeddedEmailAttachments, setEmbeddedEmailAttachments] = useState<PostalMimeAttachment[]>([]);
  const [embeddedEmailUnwrapped, setEmbeddedEmailUnwrapped] = useState(false);

  // Ensure S/MIME key records are loaded from IndexedDB
  useLayoutEffect(() => {
    smimeStore.load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setEmailViewDarkOverride(null);
    setSmimeStatus(null);
    setSmimeDecryptedHtml(null);
    setSmimeDecryptedText(null);
    setSmimeDecryptedAttachments([]);
    setSmimeUnlockDialogOpen(false);
    setSmimeUnlockTargetId(null);
    setSmimeUnlockError(null);
    setTnefHtml(null);
    setTnefText(null);
    setTnefAttachments([]);
    setEmbeddedEmailHtml(null);
    setEmbeddedEmailText(null);
    setEmbeddedEmailAttachments([]);
    setEmbeddedEmailUnwrapped(false);
  }, [email?.id, externalContentPolicy]);

  const prepareSmimeUnlock = useCallback((keyRecordId: string) => {
    setSmimeUnlockTargetId(keyRecordId);
    setSmimeUnlockError(null);
  }, []);

  const openSmimeUnlockDialog = useCallback(() => {
    if (!smimeUnlockTargetId) {
      return;
    }

    setSmimeUnlockDialogOpen(true);
  }, [smimeUnlockTargetId]);

  const handleSmimeUnlockSubmit = useCallback(async (passphrase: string) => {
    if (!smimeUnlockTargetId) {
      return;
    }

    try {
      await smimeStore.unlockKey(smimeUnlockTargetId, passphrase);
      setSmimeUnlockDialogOpen(false);
      setSmimeUnlockTargetId(null);
      setSmimeUnlockError(null);
    } catch (error) {
      setSmimeUnlockError(error instanceof Error ? error.message : 'Unlock failed');
    }
  }, [smimeStore, smimeUnlockTargetId]);

  // S/MIME detection and processing
  useEffect(() => {
    if (!email || !client) return;

    const smimeDebug = (...args: unknown[]) => {
      if (useSettingsStore.getState().debugMode) {
        console.debug(...args);
      }
    };

    const smimeWarn = (...args: unknown[]) => {
      if (useSettingsStore.getState().debugMode) {
        console.warn(...args);
      }
    };

    const smimeError = (...args: unknown[]) => {
      console.error(...args);
    };

    const rawContentType = email.headers?.['content-type'] || email.headers?.['Content-Type'];
    const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
    const detection = detectSmime(
      contentType,
      email.bodyStructure as Parameters<typeof detectSmime>[1],
      email.attachments as Parameters<typeof detectSmime>[2],
    );

    smimeDebug('[S/MIME] detection:', { contentType, bodyStructure: email.bodyStructure, attachments: email.attachments, detection });

    if (!detection.type) return;

    // Unsupported type (e.g., detached signature)
    if (!detection.supported) {
      setSmimeStatus({
        isSigned: detection.type === 'detached-sig',
        isEncrypted: false,
        unsupportedReason: 'Detached S/MIME signatures are not yet supported',
      });
      return;
    }

    if (!detection.blobId) return;

    let cancelled = false;

    async function processSmime() {
      try {
        const toHex = (bytes: Uint8Array, count: number) =>
          Array.from(bytes.slice(0, count)).map(b => b.toString(16).padStart(2, '0')).join(' ');

        const toAsciiPreview = (bytes: Uint8Array, count: number) => {
          try {
            return new TextDecoder().decode(bytes.slice(0, count));
          } catch {
            return '';
          }
        };

        const toExactArrayBuffer = (view: Uint8Array): ArrayBuffer =>
          view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;

        const cmsCandidates: Array<{ source: string; raw: ArrayBuffer }> = [];

        const findPartById = (
          part: Parameters<typeof detectSmime>[1],
          targetPartId: string,
        ): Parameters<typeof detectSmime>[1] | undefined => {
          if (!part) return undefined;
          if (part.partId === targetPartId) return part;
          if (part.subParts) {
            for (const sub of part.subParts) {
              const found = findPartById(sub as Parameters<typeof detectSmime>[1], targetPartId);
              if (found) return found;
            }
          }
          return undefined;
        };

        const detectedPart = detection.partId
          ? findPartById(email!.bodyStructure as Parameters<typeof detectSmime>[1], detection.partId)
          : undefined;
        const detectedPartName = detectedPart?.name || 'smime.p7m';
        const detectedPartType = detectedPart?.type || 'application/pkcs7-mime';

        const detectedPartSize = (detectedPart as { size?: number } | undefined)?.size;
        if (detectedPartSize === 0) {
          smimeWarn('[S/MIME] detected part has size=0; trying multiple blob fetch variants', {
            partId: detection.partId,
            blobId: detection.blobId,
            name: detectedPartName,
            type: detectedPartType,
          });
        }

        // Primary source: Blob/download endpoint
        try {
          const blobBytes = await client!.fetchBlobArrayBuffer(detection.blobId!);
          if (blobBytes.byteLength > 0) {
            cmsCandidates.push({ source: 'blob-default', raw: blobBytes });
          }
          smimeWarn('[S/MIME] blob-default fetch result:', {
            byteLength: blobBytes.byteLength,
          });
        } catch (error) {
          smimeWarn('[S/MIME] blob fetch failed:', error);
          // Fallback sources below may still work
        }

        // Variant source: same blob with explicit part name/type in URL template
        try {
          const typedBlobBytes = await client!.fetchBlobArrayBuffer(
            detection.blobId!,
            detectedPartName,
            detectedPartType,
          );
          if (typedBlobBytes.byteLength > 0) {
            cmsCandidates.push({ source: 'blob-typed', raw: typedBlobBytes });
          }
          smimeWarn('[S/MIME] blob-typed fetch result:', {
            byteLength: typedBlobBytes.byteLength,
            name: detectedPartName,
            type: detectedPartType,
          });
        } catch (error) {
          smimeWarn('[S/MIME] typed blob fetch failed:', error);
        }

        // Fallback source: bodyValues entry for the detected S/MIME part
        const bodyValue = detection.partId ? email!.bodyValues?.[detection.partId]?.value : undefined;
        const bodyValueMeta = detection.partId ? email!.bodyValues?.[detection.partId] : undefined;
        smimeWarn('[S/MIME] bodyValues candidate:', {
          partId: detection.partId,
          exists: !!bodyValueMeta,
          valueLength: bodyValue?.length ?? 0,
          isTruncated: bodyValueMeta?.isTruncated ?? false,
          isEncodingProblem: bodyValueMeta?.isEncodingProblem ?? false,
        });
        if (bodyValue) {
          const bodyValueBytes = new TextEncoder().encode(bodyValue);
          cmsCandidates.push({ source: 'bodyValues', raw: toExactArrayBuffer(bodyValueBytes) });
        }

        // Fallback source: fetch full RFC822 blob and extract CMS bytes from message body
        // Some servers return empty bytes for part blobId=0 while Email.blobId still has full content.
        if (email!.blobId) {
          try {
            const fullMessageBytes = await client!.fetchBlobArrayBuffer(
              email!.blobId,
              'message.eml',
              'message/rfc822',
            );
            if (fullMessageBytes.byteLength > 0) {
              cmsCandidates.push({ source: 'email-blob', raw: fullMessageBytes });
            }
            smimeWarn('[S/MIME] email-blob fetch result:', {
              blobId: email!.blobId,
              byteLength: fullMessageBytes.byteLength,
            });
          } catch (error) {
            smimeWarn('[S/MIME] email-blob fetch failed:', error);
          }
        } else {
          smimeWarn('[S/MIME] email-blob unavailable: Email.blobId not present');
        }

        if (cmsCandidates.length === 0) {
          throw new Error('No usable CMS bytes found (blob-default/blob-typed/bodyValues/email-blob all empty)');
        }

        const expandedCandidates: Array<{ source: string; raw: ArrayBuffer }> = [];

        for (const candidate of cmsCandidates) {
          expandedCandidates.push(candidate);

          if (candidate.source === 'email-blob') {
            // Candidate 1: raw message body (strip RFC822 headers)
            try {
              const fullText = new TextDecoder().decode(candidate.raw);
              const headerEnd = fullText.search(/\r?\n\r?\n/);
              if (headerEnd >= 0) {
                const headerSep = fullText.slice(headerEnd).match(/^\r?\n\r?\n/)?.[0] ?? '\r\n\r\n';
                const bodyText = fullText.slice(headerEnd + headerSep.length);
                if (bodyText.trim().length > 0) {
                  const bodyBytes = new TextEncoder().encode(bodyText);
                  expandedCandidates.push({
                    source: 'email-blob-body',
                    raw: toExactArrayBuffer(bodyBytes),
                  });
                }
              }
            } catch {
              // ignore extraction failures
            }

            // Candidate 2: parse MIME and extract pkcs7 attachment content
            try {
              const { default: PostalMime } = await import('postal-mime');
              const parser = new PostalMime();
              const parsedFull = await parser.parse(candidate.raw);
              const smimeAttachment = parsedFull.attachments?.find(att => {
                const mimeType = ((att as { mimeType?: string }).mimeType || '').toLowerCase();
                const filename = ((att as { filename?: string }).filename || '').toLowerCase();
                return mimeType.includes('application/pkcs7-mime') || filename.endsWith('.p7m');
              });

              if (smimeAttachment) {
                const content = (smimeAttachment as { content?: unknown }).content;
                if (content instanceof Uint8Array) {
                  expandedCandidates.push({
                    source: 'email-blob-attachment',
                    raw: toExactArrayBuffer(content),
                  });
                } else if (content instanceof ArrayBuffer) {
                  expandedCandidates.push({
                    source: 'email-blob-attachment',
                    raw: content,
                  });
                } else if (typeof content === 'string') {
                  const contentBytes = new TextEncoder().encode(content);
                  expandedCandidates.push({
                    source: 'email-blob-attachment',
                    raw: toExactArrayBuffer(contentBytes),
                  });
                }
              }
            } catch (error) {
              smimeWarn('[S/MIME] email-blob MIME parse/extract failed:', error);
            }
          }
        }

        const normalizedCandidates = expandedCandidates.map(candidate => ({
          source: candidate.source,
          raw: candidate.raw,
          normalized: normalizeCmsBytes(candidate.raw),
        }));

        const candidateSummaries = normalizedCandidates.map((candidate, index) => {
          const rawBytes = new Uint8Array(candidate.raw);
          const normalizedBytes = new Uint8Array(candidate.normalized);
          return {
            index,
            source: candidate.source,
            rawLength: candidate.raw.byteLength,
            normalizedLength: candidate.normalized.byteLength,
            rawFirstBytesHex: toHex(rawBytes, 24),
            normalizedFirstBytesHex: toHex(normalizedBytes, 24),
            rawAsciiPreview: toAsciiPreview(rawBytes, 180),
          };
        });

        smimeWarn('[S/MIME] CMS candidates:', {
          detection,
          candidateCount: candidateSummaries.length,
          candidates: candidateSummaries,
        });

        if (useSettingsStore.getState().debugMode && typeof window !== 'undefined') {
          const debugPayload = {
            emailId: email!.id,
            detection,
            generatedAt: new Date().toISOString(),
            candidates: candidateSummaries,
          };

          const exportCandidate = (index = 0, normalized = true) => {
            const candidate = normalizedCandidates[index];
            if (!candidate) {
              throw new Error(`Invalid candidate index: ${index}`);
            }
            const bytes = normalized ? candidate.normalized : candidate.raw;
            const mode = normalized ? 'normalized' : 'raw';
            const filename = `smime-${email!.id}-${candidate.source}-${index}-${mode}.p7m`;
            const blob = new Blob([bytes], { type: 'application/pkcs7-mime' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = filename;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            return { filename, byteLength: bytes.byteLength, source: candidate.source, mode };
          };

          (window as unknown as {
            __smimeDebugLast?: unknown;
            __smimeDebugExport?: (index?: number, normalized?: boolean) => unknown;
          }).__smimeDebugLast = debugPayload;
          (window as unknown as {
            __smimeDebugLast?: unknown;
            __smimeDebugExport?: (index?: number, normalized?: boolean) => unknown;
          }).__smimeDebugExport = exportCandidate;

          smimeWarn('[S/MIME] debug helpers ready: window.__smimeDebugLast, window.__smimeDebugExport(index, normalized=true)');
        }

        const isCmsParseError = (error: unknown) => {
          if (!(error instanceof Error)) return false;
          return (
            error.message.includes('Invalid ASN.1 data') ||
            error.message.includes('Unexpected CMS content type') ||
            error.message.includes('Object\'s schema was not verified against input data for ContentInfo')
          );
        };

        const fromEmail = email!.from?.[0]?.email;

        if (detection.type === 'enveloped-data') {
          // Encrypted message
            const { keyRecords, unlockedDecryptionKeys } = smimeStore;
            smimeDebug('[S/MIME] decrypt attempt:', { keyRecordCount: keyRecords.length, unlockedKeyCount: unlockedDecryptionKeys.size, keyRecordIds: keyRecords.map(k => k.id) });
          try {
            let result: Awaited<ReturnType<typeof smimeDecrypt>> | null = null;
            let lastError: unknown = null;

            for (const candidate of normalizedCandidates) {
              try {
                result = await smimeDecrypt({
                  cmsBytes: candidate.normalized,
                  keyRecords,
                    unlockedKeys: unlockedDecryptionKeys,
                });
                smimeDebug('[S/MIME] decrypt success with candidate:', {
                  source: candidate.source,
                  byteLength: candidate.normalized.byteLength,
                });
                break;
              } catch (error) {
                lastError = error;
                smimeWarn('[S/MIME] decrypt candidate failed:', {
                  source: candidate.source,
                  error: error instanceof Error ? error.message : String(error),
                });
                // SmimeKeyLockedError should bubble up immediately so the UI can prompt for passphrase
                if (error instanceof SmimeKeyLockedError) {
                  throw error;
                }
                // For other errors (CMS parse, decrypt failure), try the next candidate
              }
            }

            if (!result) {
              throw lastError instanceof Error ? lastError : new Error('Decryption failed');
            }

            if (cancelled) return;

            // Parse inner MIME
            const { default: PostalMime } = await import('postal-mime');
            const parser = new PostalMime();
            const parsed = await parser.parse(result.mimeBytes);
            if (cancelled) return;
            const parsedContent = getRenderableSmimeContent(parsed, result.mimeBytes);
            smimeDebug('[S/MIME] decrypted MIME parsed:', {
              subject: parsed.subject,
              htmlLength: parsed.html?.length ?? 0,
              textLength: parsed.text?.length ?? 0,
              attachmentCount: parsed.attachments?.length ?? 0,
              fallbackUsed: parsedContent.fallbackUsed,
              renderHtmlLength: parsedContent.html?.length ?? 0,
              renderTextLength: parsedContent.text?.length ?? 0,
            });

            // Check if inner content is also signed
            const nestedSignedData = extractNestedSignedDataCandidate(parsed, result.mimeBytes);
            if (nestedSignedData) {
              // Nested sign-then-encrypt — verify inner signature
              const innerBytes = normalizeCmsBytes(nestedSignedData.bytes);
              smimeDebug('[S/MIME] nested signed-data candidate:', {
                source: nestedSignedData.source,
                byteLength: innerBytes.byteLength,
              });
              try {
                const verifyResult = await smimeVerify(innerBytes, fromEmail);
                if (cancelled) return;
                // Parse the verified inner content
                const innerParsed = await new PostalMime().parse(verifyResult.mimeBytes);
                if (cancelled) return;
                const innerParsedContent = getRenderableSmimeContent(innerParsed, verifyResult.mimeBytes);
                smimeDebug('[S/MIME] verified inner MIME parsed:', {
                  subject: innerParsed.subject,
                  htmlLength: innerParsed.html?.length ?? 0,
                  textLength: innerParsed.text?.length ?? 0,
                  attachmentCount: innerParsed.attachments?.length ?? 0,
                  fallbackUsed: innerParsedContent.fallbackUsed,
                  renderHtmlLength: innerParsedContent.html?.length ?? 0,
                  renderTextLength: innerParsedContent.text?.length ?? 0,
                });
                setSmimeDecryptedHtml(innerParsedContent.html);
                setSmimeDecryptedText(innerParsedContent.text);
                setSmimeDecryptedAttachments(innerParsed.attachments ?? []);
                setSmimeStatus({
                  ...verifyResult.status,
                  isEncrypted: true,
                  decryptionSuccess: true,
                });
                // Auto-import signer cert if enabled
                if (smimeStore.autoImportSignerCerts && verifyResult.status.signatureValid && verifyResult.status.signerCert) {
                  const existing = smimeStore.getPublicCertForEmail(verifyResult.status.signerCert.email);
                  if (!existing) {
                    try {
                      await smimeStore.importPublicCert(verifyResult.status.signerCert.certificate, 'signed-email');
                    } catch { /* ignore import errors */ }
                  }
                }
              } catch (error) {
                smimeError('[S/MIME] nested signature verify failed:', {
                  source: nestedSignedData.source,
                  error: error instanceof Error ? error.message : String(error),
                });
                // Verification failed but decryption worked
                setSmimeDecryptedHtml(parsedContent.html);
                setSmimeDecryptedText(parsedContent.text);
                setSmimeDecryptedAttachments((parsed.attachments ?? []) as PostalMimeAttachment[]);
                setSmimeStatus({
                  isSigned: false,
                  isEncrypted: true,
                  decryptionSuccess: true,
                });
              }
            } else {
              setSmimeDecryptedHtml(parsedContent.html);
              setSmimeDecryptedText(parsedContent.text);
              setSmimeDecryptedAttachments((parsed.attachments ?? []) as PostalMimeAttachment[]);
              setSmimeStatus({
                isSigned: false,
                isEncrypted: true,
                decryptionSuccess: true,
              });
            }
          } catch (err) {
            if (cancelled) return;
            smimeError('[S/MIME] decrypt error:', err);
            if (err instanceof SmimeKeyLockedError) {
              prepareSmimeUnlock(err.keyRecordId);
              setSmimeStatus({
                isSigned: false,
                isEncrypted: true,
                decryptionError: 'locked',
              });
            } else {
              setSmimeStatus({
                isSigned: false,
                isEncrypted: true,
                decryptionError: err instanceof Error ? err.message : 'Decryption failed',
              });
            }
          }
        } else if (detection.type === 'signed-data') {
          // Signed message
          try {
            let result: Awaited<ReturnType<typeof smimeVerify>> | null = null;
            let lastError: unknown = null;

            for (const candidate of normalizedCandidates) {
              try {
                result = await smimeVerify(candidate.normalized, fromEmail);
                smimeDebug('[S/MIME] verify success with candidate:', {
                  source: candidate.source,
                  byteLength: candidate.normalized.byteLength,
                });
                break;
              } catch (error) {
                lastError = error;
                smimeWarn('[S/MIME] verify candidate failed:', {
                  source: candidate.source,
                  error: error instanceof Error ? error.message : String(error),
                });
                if (!isCmsParseError(error)) {
                  throw error;
                }
              }
            }

            if (!result) {
              throw lastError instanceof Error ? lastError : new Error('Verification failed');
            }

            if (cancelled) return;

            // Parse inner MIME
            const { default: PostalMime } = await import('postal-mime');
            const parser = new PostalMime();
            const parsed = await parser.parse(result.mimeBytes);
            if (cancelled) return;
            const parsedContent = getRenderableSmimeContent(parsed, result.mimeBytes);
            smimeDebug('[S/MIME] verified MIME parsed:', {
              subject: parsed.subject,
              htmlLength: parsed.html?.length ?? 0,
              textLength: parsed.text?.length ?? 0,
              attachmentCount: parsed.attachments?.length ?? 0,
              fallbackUsed: parsedContent.fallbackUsed,
              renderHtmlLength: parsedContent.html?.length ?? 0,
              renderTextLength: parsedContent.text?.length ?? 0,
            });

            setSmimeDecryptedHtml(parsedContent.html);
            setSmimeDecryptedText(parsedContent.text);
            setSmimeDecryptedAttachments((parsed.attachments ?? []) as PostalMimeAttachment[]);
            setSmimeStatus(result.status);
            // Auto-import signer cert if enabled
            if (smimeStore.autoImportSignerCerts && result.status.signatureValid && result.status.signerCert) {
              const existing = smimeStore.getPublicCertForEmail(result.status.signerCert.email);
              if (!existing) {
                try {
                  await smimeStore.importPublicCert(result.status.signerCert.certificate, 'signed-email');
                } catch { /* ignore import errors */ }
              }
            }
          } catch (err) {
            if (cancelled) return;
            setSmimeStatus({
              isSigned: true,
              isEncrypted: false,
              signatureValid: false,
              signatureError: err instanceof Error ? err.message : 'Verification failed',
            });
          }
        }
      } catch (err) {
        if (cancelled) return;
        smimeError('[S/MIME] processing failed before decrypt/verify:', err);
        // Failed to fetch CMS blob
        setSmimeStatus({
          isSigned: false,
          isEncrypted: detection.type === 'enveloped-data',
          decryptionError: err instanceof Error ? err.message : 'Failed to fetch encrypted content',
        });
      }
    }

    processSmime();
    return () => { cancelled = true; };
  }, [
    email,
    client,
    prepareSmimeUnlock,
    smimeStore.autoImportSignerCerts,
    smimeStore.keyRecords,
    smimeStore.unlockedDecryptionKeys,
  ]);

  // TNEF (winmail.dat) detection and processing
  useEffect(() => {
    if (!email?.attachments || !client) return;

    const tnefAtt = email.attachments.find(att => isTnefAttachment(att.name, att.type));
    if (!tnefAtt?.blobId) {
      debug.log('TNEF: No winmail.dat attachment found in email', email?.id);
      return;
    }

    debug.group('TNEF Processing');
    debug.log('Found TNEF attachment:', tnefAtt.name, 'type:', tnefAtt.type, 'blobId:', tnefAtt.blobId, 'size:', tnefAtt.size);

    // Check if the email already has a usable HTML body with real content
    // Outlook often forwards TNEF emails with an HTML body that's just Word
    // boilerplate (CSS + &nbsp;) — treat these as effectively empty.
    const htmlPartId = email.htmlBody?.[0]?.partId;
    const htmlValue = htmlPartId ? email.bodyValues?.[htmlPartId]?.value?.trim() : '';
    let hasRealHtmlBody = !!htmlValue;
    if (hasRealHtmlBody && htmlValue && isHtmlBodyEffectivelyEmpty(htmlValue)) {
      hasRealHtmlBody = false;
      debug.log('TNEF: Email HTML body is effectively empty (only boilerplate/whitespace), treating as no body');
    }
    if (hasRealHtmlBody) {
      debug.log('TNEF: Email has real HTML body, will extract attachments only');
    } else {
      debug.log('TNEF: Email has no usable HTML body, proceeding with full TNEF extraction');
    }

    let cancelled = false;

    async function processTnef() {
      try {
        debug.time('TNEF fetch blob');
        const blobBytes = await client!.fetchBlobArrayBuffer(tnefAtt!.blobId!);
        debug.timeEnd('TNEF fetch blob');
        debug.log('TNEF: Fetched blob, size:', blobBytes.byteLength, 'bytes');

        if (cancelled) {
          debug.log('TNEF: Processing cancelled after fetch');
          debug.groupEnd();
          return;
        }
        if (blobBytes.byteLength === 0) {
          debug.warn('TNEF: Fetched blob is empty (0 bytes)');
          debug.groupEnd();
          return;
        }

        const tnefData = new Uint8Array(blobBytes);
        debug.time('TNEF parse');
        const parsed = parseTnef(tnefData);
        debug.timeEnd('TNEF parse');

        if (cancelled) {
          debug.log('TNEF: Processing cancelled after parse');
          debug.groupEnd();
          return;
        }

        debug.log('TNEF parse result — htmlBody:', !!parsed.htmlBody, '(' + (parsed.htmlBody?.length ?? 0) + ' chars)', ', body:', !!parsed.body, '(' + (parsed.body?.length ?? 0) + ' chars)', ', attachments:', parsed.attachments.length);

        if (parsed.htmlBody && !hasRealHtmlBody) {
          setTnefHtml(parsed.htmlBody);
        }
        if (parsed.body && !hasRealHtmlBody) {
          setTnefText(parsed.body);
        }
        if (parsed.attachments.length > 0) {
          setTnefAttachments(parsed.attachments);
          debug.log('TNEF extracted attachments:', parsed.attachments.map(a => a.name + ' (' + a.mimeType + ', ' + a.data.byteLength + ' bytes)').join(', '));
        }

        if (!parsed.htmlBody && !parsed.body && parsed.attachments.length === 0) {
          debug.warn('TNEF: Parsing succeeded but no content was extracted — the winmail.dat may use an unsupported format');
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
      debug.log('Embedded RFC822: Outer email has real body content, not unwrapping');
      return;
    }

    debug.group('Embedded RFC822 Unwrapping');
    debug.log('Found message/rfc822 attachment:', rfc822Att.name, 'blobId:', rfc822Att.blobId, 'size:', rfc822Att.size);
    debug.log('Outer email body is empty, will unwrap embedded email');

    let cancelled = false;

    async function unwrapEmbedded() {
      try {
        const blobBytes = await client!.fetchBlobArrayBuffer(rfc822Att!.blobId!);
        if (cancelled) { debug.groupEnd(); return; }
        if (blobBytes.byteLength === 0) {
          debug.warn('Embedded RFC822: Fetched blob is empty');
          debug.groupEnd();
          return;
        }

        const { default: PostalMime } = await import('postal-mime');
        const parser = new PostalMime();
        const parsed = await parser.parse(new Uint8Array(blobBytes));
        if (cancelled) { debug.groupEnd(); return; }

        debug.log('Embedded RFC822 parsed — html:', !!parsed.html, '(' + (parsed.html?.length ?? 0) + ' chars)',
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
          debug.log('Embedded RFC822 attachments:', parsed.attachments.map(
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

    const decryptedCidAttachments = smimeDecryptedAttachments.filter(att => att.contentId);
    if (decryptedCidAttachments.length > 0) {
      const urls: Record<string, string> = {};

      decryptedCidAttachments.forEach((att, index) => {
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
  }, [client, email?.id, smimeDecryptedAttachments]);

  const effectiveAttachments = useMemo<EffectiveAttachment[]>(() => {
    if (smimeDecryptedAttachments.length > 0) {
      return smimeDecryptedAttachments.map((attachment, index) => ({
        id: `smime-${index}-${attachment.filename || attachment.mimeType}`,
        name: attachment.filename,
        type: attachment.mimeType || 'application/octet-stream',
        size: getPostalMimeAttachmentSize(attachment),
        cid: attachment.contentId,
        decryptedAttachment: attachment,
      }));
    }

    const jmapAttachments = (email?.attachments ?? [])
      // Hide winmail.dat when we have successfully extracted TNEF content or attachments
      .filter(att => !(tnefHtml || tnefText || tnefAttachments.length > 0) || !isTnefAttachment(att.name, att.type))
      // Hide message/rfc822 when we have unwrapped the embedded email
      .filter(att => !embeddedEmailUnwrapped || att.type !== 'message/rfc822')
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
  }, [email?.attachments, smimeDecryptedAttachments, tnefHtml, tnefText, tnefAttachments, embeddedEmailUnwrapped, embeddedEmailAttachments]);

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
        // Prefer textBody when HTML is auto-generated minimal wrapper (no rich formatting).
        // Server-generated HTML from text/plain emails often lacks <br> tags, collapsing newlines.
        const hasTextBody = email.textBody?.[0]?.partId && email.bodyValues[email.textBody[0].partId];
        if (hasTextBody && htmlContent) {
          useHtmlVersion = hasMeaningfulHtmlBody(htmlContent);
        } else {
          useHtmlVersion = !!htmlContent;
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
          isHtml: true
        };
      }

      // Use text content if available (either as fallback or when HTML is minimal)
      if (email.textBody?.[0]?.partId && email.bodyValues[email.textBody[0].partId]) {
        const textContent = email.bodyValues[email.textBody[0].partId].value;

        // Convert plain text to HTML with proper formatting
        // Uses white-space: pre-wrap on the container to preserve newlines/whitespace
        const htmlFromText = textContent
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
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
        .replace(/>/g, '&gt;');

      return {
        html: `<div style="color: var(--color-muted-foreground); font-style: italic;">${previewHtml}</div>`,
        isHtml: false
      };
    }

    return {
      html: '<p style="color: var(--color-muted-foreground);">No content available</p>',
      isHtml: false
    };
  }, [email, allowExternalContent, hasBlockedContent, externalContentPolicy, isSenderTrusted, cidBlobUrls]);

  // Override email content with S/MIME decrypted content when available
  const effectiveEmailContent = useMemo(() => {
    if (smimeDecryptedHtml) {
      const htmlWithCidUrls = smimeDecryptedHtml.replace(
        /\bcid:([^"'\s)]+)/gi,
        (_match, cidRef) => {
          return cidBlobUrls[cidRef] || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        }
      );
      const cleanHtml = DOMPurify.sanitize(htmlWithCidUrls, EMAIL_SANITIZE_CONFIG);
      return { html: cleanHtml, isHtml: true };
    }
    if (smimeDecryptedText) {
      const htmlFromText = smimeDecryptedText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
      return { html: htmlFromText, isHtml: false };
    }
    // TNEF (winmail.dat) extracted content
    if (tnefHtml) {
      const cleanHtml = DOMPurify.sanitize(tnefHtml, EMAIL_SANITIZE_CONFIG);
      return { html: cleanHtml, isHtml: true };
    }
    if (tnefText) {
      const htmlFromText = tnefText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
      return { html: htmlFromText, isHtml: false };
    }
    // Embedded message/rfc822 unwrapped content
    if (embeddedEmailHtml) {
      const cleanHtml = DOMPurify.sanitize(embeddedEmailHtml, EMAIL_SANITIZE_CONFIG);
      return { html: cleanHtml, isHtml: true };
    }
    if (embeddedEmailText) {
      const htmlFromText = embeddedEmailText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
      return { html: htmlFromText, isHtml: false };
    }
    return emailContent;
  }, [cidBlobUrls, emailContent, smimeDecryptedHtml, smimeDecryptedText, tnefHtml, tnefText, embeddedEmailHtml, embeddedEmailText]);

  const handleEffectiveAttachmentOpen = useCallback((attachment: EffectiveAttachment) => {
    const isPreviewable = isFilePreviewable(attachment.name || undefined, attachment.type);
    const opensPreview = isPreviewable && mailAttachmentAction === 'preview';

    if (attachment.blobId && onDownloadAttachment) {
      onDownloadAttachment(attachment.blobId, attachment.name || 'download', attachment.type);
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
        window.open(objectUrl, '_blank', 'noopener,noreferrer');
      } else {
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = attachment.name || 'download';
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
      window.open(objectUrl, '_blank', 'noopener,noreferrer');
    } else {
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = attachment.name || 'download';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }

    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }, [mailAttachmentAction, onDownloadAttachment]);

  const handleEffectiveAttachmentDownload = useCallback((attachment: EffectiveAttachment) => {
    if (attachment.blobId && onDownloadAttachment) {
      onDownloadAttachment(attachment.blobId, attachment.name || 'download', attachment.type, true);
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
      anchor.download = attachment.name || 'download';
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
    anchor.download = attachment.name || 'download';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }, [onDownloadAttachment]);

  // Iframe for rendering HTML emails true-to-life
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Detect if the email HTML has native dark mode support
  const emailHasNativeDarkMode = useMemo(() => {
    if (!effectiveEmailContent.isHtml) return false;
    return /prefers-color-scheme\s*:\s*dark/i.test(effectiveEmailContent.html);
  }, [effectiveEmailContent.html, effectiveEmailContent.isHtml]);

  const emailAlwaysLightMode = useSettingsStore((state) => state.emailAlwaysLightMode);
  const [emailViewDarkOverride, setEmailViewDarkOverride] = useState<boolean | null>(null);
  const isDark = emailAlwaysLightMode ? false : (emailViewDarkOverride !== null ? emailViewDarkOverride : resolvedTheme === 'dark');

  const emailIframeSrcDoc = useMemo(() => {
    if (!effectiveEmailContent.isHtml) return '';

    // If email has native dark mode, let it handle its own theming
    // Otherwise, use CSS filter inversion for dark mode (preserves layout)
    const darkModeCSS = isDark && !emailHasNativeDarkMode ? `
      html { background: #1a1a1a; }
      body { filter: invert(1) hue-rotate(180deg); }
      img, video, picture, svg, canvas, object, embed,
      [style*="background-image"], [style*="background:"],
      [background], [bgcolor],
      td[background], table[background],
      img[src], input[type="image"] {
        filter: invert(1) hue-rotate(180deg);
      }
    ` : '';

    const colorScheme = isDark && emailHasNativeDarkMode ? 'light dark' : 'light';

    return `<!DOCTYPE html>
<html style="color-scheme: ${colorScheme};"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; padding: 16px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 14px; line-height: 1.6; color: #1a1a1a; background: #ffffff; word-wrap: break-word; overflow-wrap: break-word; }
  img { max-width: 100% !important; height: auto !important; }
  a { color: #1a73e8; }
  table { max-width: 100% !important; table-layout: auto; overflow-wrap: break-word; }
  td, th { word-break: break-word; }
  pre { white-space: pre-wrap; word-wrap: break-word; }
  ${darkModeCSS}
</style></head><body>${effectiveEmailContent.html}</body></html>`;
  }, [effectiveEmailContent.html, effectiveEmailContent.isHtml, isDark, emailHasNativeDarkMode]);

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
        });
        resizeObserver.observe(doc.body);
        iframe.style.height = doc.documentElement.scrollHeight + 'px';

        // Make links open in new tab
        doc.querySelectorAll('a').forEach(a => {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        });
      }
    } catch {
      // Cross-origin restrictions - iframe will still display content
    }
  }, []);

  // Export email as .eml file
  const handleExportEmail = async () => {
    if (!email?.blobId || !client) return;
    try {
      const subject = (email.subject || 'email').replace(/[<>:"/\\|?*]+/g, '_').slice(0, 100);
      await client.downloadBlob(email.blobId, `${subject}.eml`, 'message/rfc822');
    } catch {
      toast.error(tNotifications('export_email_error'));
    }
  };

  // Import email from .eml file
  const handleImportEmail = () => {
    if (!client) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.eml,message/rfc822';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const { selectedMailbox, mailboxes, fetchEmails } = useEmailStore.getState();
        const mailbox = mailboxes.find(mb => mb.id === selectedMailbox);
        const mailboxId = mailbox?.originalId || selectedMailbox;
        if (!mailboxId) {
          toast.error(tNotifications('import_email_error'));
          return;
        }
        const blob = new Blob([await file.arrayBuffer()], { type: 'message/rfc822' });
        await client.importRawEmail(blob, { [mailboxId]: true }, { '$seen': true });
        toast.success(tNotifications('import_email_success'));
        await fetchEmails(client);
      } catch {
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
  .body img { max-width: 100% !important; height: auto !important; }
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
<div class="body">${effectiveEmailContent.html}</div>
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
  const isUnread = !email.keywords?.$seen;
  const isImportant = email.keywords?.["$important"];

  // Shared toolbar items used by both 'top' and 'below-subject' positions
  const renderToolbarItems = (showBackButton: boolean) => (
    <>
      {/* Left: Reply actions */}
      <div className={cn("flex items-center gap-0", showBackButton ? "sm:gap-1" : "sm:gap-0.5")}>
        {showBackButton && isTablet && !tabletListVisible && onBack && (
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
        {isDraft && onEditDraft && (
          <Button
            variant="default"
            size="sm"
            onClick={onEditDraft}
            className="sm:flex sm:flex-row sm:h-8 sm:gap-1.5 sm:py-0"
            title={t('tooltips.edit_draft')}
          >
            <EditIcon className="w-4 h-4" />
            <span className="text-sm">{t('edit_draft')}</span>
          </Button>
        )}
        {!isDraft && (<>
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
      </div>

      {/* Right: Organize actions — order: archive, delete, move, star, tag, spam, read state, print, view source */}
      <div className="flex items-center gap-0 sm:gap-0.5">
        {isLoading && (
          <div className="mr-2 flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
          </div>
        )}
        {/* Archive */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onArchive}
          data-overflow-item
          data-overflow-priority="4"
          className="hidden sm:inline-flex h-8 gap-1.5"
          title={t('tooltips.archive')}
        >
          <Archive className="w-4 h-4" />
          {showToolbarLabels && <span className="hidden sm:inline text-sm">{t('archive')}</span>}
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
          <div ref={moveMenuRef} data-overflow-item data-overflow-priority="5" className="relative hidden sm:block">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setMoveMenuOpen(!moveMenuOpen); setMoreMenuOpen(false); setTagMenuOpen(false); }}
              className="h-8 gap-1.5"
              title={t('move_to')}
            >
              <FolderInput className="w-4 h-4" />
              {showToolbarLabels && <span className="text-sm">{t('move_to')}</span>}
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
        {/* Star/Flag toggle */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleStar}
          className="flex-col items-center gap-0.5 h-auto py-1.5 px-2 sm:flex-row sm:h-8 sm:w-auto sm:gap-1.5 sm:py-0 sm:px-2"
          title={isStarred ? t('tooltips.unstar') : t('tooltips.star')}
        >
          <Star className={cn(
            "w-4 h-4 transition-colors",
            isStarred ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground"
          )} />
          <span className="text-[10px] leading-tight sm:hidden">{isStarred ? t('tooltips.unstar') : t('tooltips.star')}</span>
        </Button>

        {/* Tag Picker — hidden on mobile, overflows to More menu */}
        <div data-overflow-item data-overflow-priority="6" className="hidden sm:flex items-center">
        <div className="w-px h-5 bg-border mx-0.5" />
        <div ref={tagMenuRef} className="relative">
          <button
            onClick={() => { setTagMenuOpen(!tagMenuOpen); setMoreMenuOpen(false); setMoveMenuOpen(false); }}
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
                  {showToolbarLabels && <span className="text-xs font-medium text-foreground">{kw!.label}</span>}
                </>
              ) : (
                <>
                  <Tag className="w-4 h-4 text-muted-foreground" />
                  {showToolbarLabels && <span className="text-xs text-muted-foreground">{t('tag')}</span>}
                </>
              );
            })()}
          </button>
          {tagMenuOpen && (
            <div className="absolute right-0 top-full mt-1 py-1 w-40 bg-background rounded-lg shadow-lg border border-border z-10">
              {colorOptions.map((option) => (
                <button
                  key={option.value}
                  onClick={() => { if (email) onSetColorTag?.(email.id, option.value); setTagMenuOpen(false); }}
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

        {/* Spam — hidden on mobile, overflows to More menu */}
        {(onMarkAsSpam || onUndoSpam) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={isInJunkFolder ? onUndoSpam : onMarkAsSpam}
            data-overflow-item
            data-overflow-priority="7"
            className={cn(
              "hidden sm:inline-flex h-8 gap-1.5",
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

        {/* Toggle read state — hidden on mobile, overflows to More menu */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onMarkAsRead?.(email.id, isUnread)}
          data-overflow-item
          data-overflow-priority="8"
          className="hidden sm:inline-flex h-8 gap-1.5"
          title={isUnread ? t('mark_read') : t('mark_unread')}
        >
          {isUnread ? <MailOpen className="w-4 h-4" /> : <Mail className="w-4 h-4" />}
        </Button>

        {/* Print — hidden on mobile, overflows to More menu */}
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

        {/* View source — hidden on mobile, overflows to More menu */}
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

        {/* More menu — click-based */}
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
              {/* Overflow: move to folder — submenu */}
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
              {/* Overflow: tag — submenu */}
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
                      {colorOptions.map((option) => (
                        <button
                          key={option.value}
                          onClick={() => { if (email) onSetColorTag?.(email.id, option.value); setMoreMenuOpen(false); setMoreMenuSub(null); }}
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
              {(onMarkAsSpam || onUndoSpam) && (
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
    </>
  );

  return (
    <div
      key={email.id}
      className={cn("flex-1 flex flex-row h-full bg-background overflow-hidden animate-in fade-in duration-300 relative", className)}
    >
    {/* Mobile More menu sidebar overlay */}
    {isMobile && moreMenuOpen && (
      <div
        className="fixed inset-0 bg-black/50 z-[60] sm:hidden"
        onClick={() => setMoreMenuOpen(false)}
      />
    )}
    {isMobile && (
      <div className={cn(
        "fixed inset-y-0 right-0 w-72 bg-background border-l border-border z-[70] sm:hidden",
        "transform transition-transform duration-300 ease-in-out",
        "flex flex-col",
        moreMenuOpen ? "translate-x-0" : "translate-x-full"
      )}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-sm font-semibold text-foreground">{t('more_actions')}</span>
          <Button variant="ghost" size="icon" onClick={() => setMoreMenuOpen(false)} className="h-9 w-9">
            <X className="w-5 h-5" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          <button
            onClick={() => { onArchive?.(); setMoreMenuOpen(false); }}
            className="w-full px-4 py-3 min-h-[44px] text-sm text-left hover:bg-muted text-foreground flex items-center gap-3"
          >
            <Archive className="w-5 h-5" />
            {t('archive')}
          </button>
          {/* Move to folder */}
          {moveTree.length > 0 && onMoveToMailbox && (
            <>
              <div className="h-px bg-border my-1" />
              <div className="px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('move_to')}</div>
              {(() => {
                const renderMobileNodes = (nodes: MailboxNode[], depth = 0) => {
                  return nodes.map((node) => {
                    const Icon = getMoveMailboxIcon(node.role);
                    const isTarget = moveTargetIds.has(node.id);
                    return (
                      <div key={node.id}>
                        {isTarget ? (
                          <button
                            onClick={() => { onMoveToMailbox(node.id); setMoreMenuOpen(false); }}
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
              <div className="h-px bg-border my-1" />
            </>
          )}
          {/* Tags */}
          {colorOptions.length > 0 && (
            <>
              <div className="h-px bg-border my-1" />
              <div className="px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('tag')}</div>
              {colorOptions.map((option) => (
                <button
                  key={option.value}
                  onClick={() => { if (email) onSetColorTag?.(email.id, option.value); setMoreMenuOpen(false); }}
                  className={cn(
                    "w-full px-4 py-2.5 min-h-[44px] text-sm text-left hover:bg-muted flex items-center gap-3",
                    currentColor === option.value && "bg-accent font-medium"
                  )}
                >
                  <span className={cn("w-3.5 h-3.5 rounded-full flex-shrink-0", option.color)} />
                  <span className="truncate">{option.name}</span>
                  {currentColor === option.value && <Check className="w-4 h-4 ml-auto flex-shrink-0 text-foreground" />}
                </button>
              ))}
              {currentColor && (
                <button
                  onClick={() => { if (email) onSetColorTag?.(email.id, null); setMoreMenuOpen(false); }}
                  className="w-full px-4 py-2.5 min-h-[44px] text-sm text-left hover:bg-muted flex items-center gap-3 text-muted-foreground"
                >
                  <X className="w-4 h-4 flex-shrink-0" />
                  <span>{t('remove_color')}</span>
                </button>
              )}
              <div className="h-px bg-border my-1" />
            </>
          )}
          {/* Spam */}
          {(onMarkAsSpam || onUndoSpam) && (
            <button
              onClick={() => { (isInJunkFolder ? onUndoSpam : onMarkAsSpam)?.(); setMoreMenuOpen(false); }}
              className="w-full px-4 py-3 min-h-[44px] text-sm text-left hover:bg-muted text-foreground flex items-center gap-3"
            >
              {isInJunkFolder ? (
                <ShieldCheck className="h-5 w-5 text-green-600 dark:text-green-400" />
              ) : (
                <ShieldAlert className="h-5 w-5 text-red-600 dark:text-red-400" />
              )}
              {isInJunkFolder ? t('spam.not_spam_title') : t('spam.button_title')}
            </button>
          )}
          {/* Toggle read state */}
          <button
            onClick={() => { onMarkAsRead?.(email.id, isUnread); setMoreMenuOpen(false); }}
            className="w-full px-4 py-3 min-h-[44px] text-sm text-left hover:bg-muted text-foreground flex items-center gap-3"
          >
            {isUnread ? <MailOpen className="w-5 h-5" /> : <Mail className="w-5 h-5" />}
            {isUnread ? t('mark_read') : t('mark_unread')}
          </button>
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
        </div>
      </div>
    )}
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
          <div className="px-2 sm:px-4 lg:px-6 py-1 sm:py-2">
            <div ref={toolbarRef} className="flex items-center justify-between gap-0.5 sm:gap-2">
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
                {/* Color tag dot */}
                {currentColor && (() => {
                  const kw = emailKeywords.find(k => k.id === currentColor);
                  const dotClass = kw ? KEYWORD_PALETTE[kw.color]?.dot : null;
                  return dotClass ? (
                    <span className={cn("w-2.5 h-2.5 rounded-full flex-shrink-0", dotClass)} title={kw!.label} />
                  ) : null;
                })()}
                {isImportant && (
                  <span className="px-1.5 lg:px-2 py-0.5 bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-full text-xs font-medium whitespace-nowrap flex-shrink-0 self-center">
                    {t('important')}
                  </span>
                )}
              </div>
            </div>
            {/* Date/time on the right of subject row */}
            <div className="flex-shrink-0 text-right">
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
      <div className={cn("flex-1 overflow-auto bg-muted/30", isMobile && "pb-16")}>

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
                    <button
                      onClick={() => sender?.email && handleViewContactSidebar(null, sender.email)}
                      className="font-semibold text-foreground hover:text-primary hover:underline transition-colors cursor-pointer text-left"
                      title={t('view_contact')}
                    >
                      {sender?.name || sender?.email || t('unknown_sender')}
                    </button>
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
                            displayLabel={sender?.name && sender?.email ? `${sender.name} <${sender.email}>` : undefined}
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
                          {formatDateTime(email.receivedAt, timeFormat, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', second: '2-digit', timeZoneName: 'short' })}
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
                                  <div className="flex-1">
                                    <div className="text-xs font-medium text-gray-900 dark:text-gray-100 flex items-center gap-1">
                                      SPF
                                      <InfoTooltip text="Sender Policy Framework: Verifies that the sending server is authorized to send email on behalf of the domain" />
                                    </div>
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
                                  <div className="flex-1">
                                    <div className="text-xs font-medium text-gray-900 dark:text-gray-100 flex items-center gap-1">
                                      DKIM
                                      <InfoTooltip text="DomainKeys Identified Mail: Confirms the email was not altered in transit using a cryptographic signature" />
                                    </div>
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
                                  <div className="flex-1">
                                    <div className="text-xs font-medium text-gray-900 dark:text-gray-100 flex items-center gap-1">
                                      DMARC
                                      <InfoTooltip text="Domain-based Message Authentication, Reporting & Conformance: Ensures SPF and DKIM align with the sender's domain and sets a policy for failures" />
                                    </div>
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
                                  <div className="flex-1">
                                    <div className="text-xs font-medium text-gray-900 dark:text-gray-100 flex items-center gap-1">
                                      Spam Score
                                      <InfoTooltip text="A score assigned by the server based on spam analysis. Lower is better — scores above 5 are likely spam" />
                                    </div>
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
              {/* Attachments on the right (beside-sender mode) */}
              {attachmentPosition === 'beside-sender' && effectiveAttachments.length > 0 && (
                <div className="relative flex flex-col items-end justify-start gap-1 flex-shrink-0 max-w-[50%]">
                  {effectiveAttachments.slice(0, 2).map((attachment) => {
                    const FileIcon = getFileIcon(attachment.name || undefined, attachment.type);
                    const isPreviewable = isFilePreviewable(attachment.name || undefined, attachment.type);
                    const opensPreview = isPreviewable && mailAttachmentAction === 'preview';
                    return (
                      <div
                        key={attachment.id}
                        className="inline-flex items-center gap-1.5 px-2 py-1 bg-muted/60 rounded-md border border-border/50 group relative cursor-default"
                      >
                        <FileIcon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                        <span className="text-xs text-foreground truncate max-w-[140px]">
                          {getAttachmentDisplayName(attachment.name, attachment.type)}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {formatFileSize(attachment.size)}
                        </span>
                        <div className="absolute inset-y-0 right-0 rounded-r-md bg-background/95 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1 px-1.5">
                          <button
                            className="p-1 hover:bg-accent rounded transition-colors"
                            title={t('download')}
                            onClick={() => handleEffectiveAttachmentDownload(attachment)}
                          >
                            <Download className="w-3.5 h-3.5 text-foreground" />
                          </button>
                          {opensPreview && (
                            <button
                              className="p-1 hover:bg-accent rounded transition-colors"
                              title={tFiles('preview')}
                              onClick={() => handleEffectiveAttachmentOpen(attachment)}
                            >
                              <Eye className="w-3.5 h-3.5 text-foreground" />
                            </button>
                          )}
                        </div>
                      </div>
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
                            <div
                              key={attachment.id}
                              className="flex items-center gap-1.5 px-2 py-1 rounded-md group relative cursor-default w-full"
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
                                  onClick={() => { handleEffectiveAttachmentDownload(attachment); setShowAllBesideAttachments(false); }}
                                >
                                  <Download className="w-3.5 h-3.5 text-foreground" />
                                </button>
                                {opensPreview && (
                                  <button
                                    className="p-1 hover:bg-accent rounded transition-colors"
                                    title={tFiles('preview')}
                                    onClick={() => { handleEffectiveAttachmentOpen(attachment); setShowAllBesideAttachments(false); }}
                                  >
                                    <Eye className="w-3.5 h-3.5 text-foreground" />
                                  </button>
                                )}
                              </div>
                            </div>
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

      {/* === ATTACHMENTS below header (below-header mode, desktop only) === */}
      {attachmentPosition === 'below-header' && effectiveAttachments.length > 0 && (
        <div className="hidden lg:block bg-background border-b border-border px-4 lg:px-6 py-2">
          <div className="flex items-center gap-2 flex-wrap">
            {effectiveAttachments.map((attachment) => {
              const FileIcon = getFileIcon(attachment.name || undefined, attachment.type);
              const isPreviewable = isFilePreviewable(attachment.name || undefined, attachment.type);
              const opensPreview = isPreviewable && mailAttachmentAction === 'preview';
              return (
                <div
                  key={attachment.id}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/60 rounded-md border border-border/50 group relative cursor-default"
                >
                  <FileIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <span className="text-sm text-foreground truncate max-w-[200px]">
                    {getAttachmentDisplayName(attachment.name, attachment.type)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatFileSize(attachment.size)}
                  </span>
                  <div className="absolute inset-y-0 right-0 rounded-r-md bg-background/95 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1 px-1.5">
                    <button
                      className="p-1 hover:bg-accent rounded transition-colors"
                      title={t('download')}
                      onClick={() => handleEffectiveAttachmentDownload(attachment)}
                    >
                      <Download className="w-4 h-4 text-foreground" />
                    </button>
                    {opensPreview && (
                      <button
                        className="p-1 hover:bg-accent rounded transition-colors"
                        title={tFiles('preview')}
                        onClick={() => handleEffectiveAttachmentOpen(attachment)}
                      >
                        <Eye className="w-4 h-4 text-foreground" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
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
                return (
                  <div
                    key={attachment.id}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/60 rounded-md border border-border/50 group relative cursor-default"
                  >
                    <FileIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <span className="text-sm text-foreground truncate max-w-[200px]">
                      {getAttachmentDisplayName(attachment.name, attachment.type)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatFileSize(attachment.size)}
                    </span>
                    <div className="absolute inset-y-0 right-0 rounded-r-md bg-background/95 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1 px-1.5">
                      <button
                        className="p-1 hover:bg-accent rounded transition-colors"
                        title={t('download')}
                        onClick={() => handleEffectiveAttachmentDownload(attachment)}
                      >
                        <Download className="w-4 h-4 text-foreground" />
                      </button>
                      {opensPreview && (
                        <button
                          className="p-1 hover:bg-accent rounded transition-colors"
                          title={tFiles('preview')}
                          onClick={() => handleEffectiveAttachmentOpen(attachment)}
                        >
                          <Eye className="w-4 h-4 text-foreground" />
                        </button>
                      )}
                    </div>
                  </div>
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
              {showAllMobileAttachments && effectiveAttachments.length > 2 && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowAllMobileAttachments(false)} />
                  <div className="absolute top-full left-0 mt-1 z-50 bg-background border border-border rounded-lg shadow-lg p-2 flex flex-col gap-1 min-w-[220px]">
                    {effectiveAttachments.slice(2).map((attachment) => {
                      const FileIcon = getFileIcon(attachment.name || undefined, attachment.type);
                      const isPreviewable = isFilePreviewable(attachment.name || undefined, attachment.type);
                      const opensPreview = isPreviewable && mailAttachmentAction === 'preview';
                      return (
                        <div
                          key={attachment.id}
                          className="flex items-center gap-1.5 px-2 py-1 rounded-md group relative cursor-default w-full"
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
                              onClick={() => { handleEffectiveAttachmentDownload(attachment); setShowAllMobileAttachments(false); }}
                            >
                              <Download className="w-3.5 h-3.5 text-foreground" />
                            </button>
                            {opensPreview && (
                              <button
                                className="p-1 hover:bg-accent rounded transition-colors"
                                title={tFiles('preview')}
                                onClick={() => { handleEffectiveAttachmentOpen(attachment); setShowAllMobileAttachments(false); }}
                              >
                                <Eye className="w-3.5 h-3.5 text-foreground" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

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
                <button
                  onClick={() => sender?.email && handleViewContactSidebar(null, sender.email)}
                  className="text-sm font-semibold text-foreground hover:text-primary hover:underline transition-colors cursor-pointer text-left"
                >
                  {sender?.name || sender?.email || t('unknown_sender')}
                </button>
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
              </div>
            </div>
          </div>
        </div>

        {/* S/MIME Status Banner */}
        {smimeStatus && (
          <div className="border-b border-border bg-muted/30">
            <div className="max-w-4xl mx-auto px-6 py-1.5">
              <SmimeStatusBanner
                status={smimeStatus}
                onUnlockKey={smimeUnlockTargetId ? openSmimeUnlockDialog : undefined}
              />
            </div>
          </div>
        )}

        {/* Draft Banner */}
        {isDraft && (
          <div className="border-b border-border bg-amber-50 dark:bg-amber-950/30">
            <div className="max-w-4xl mx-auto px-6 py-2.5 flex items-center justify-between">
              <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
                <File className="w-4 h-4" />
                <span className="text-sm font-medium">{t('draft_banner')}</span>
              </div>
              {onEditDraft && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onEditDraft}
                  className="gap-1.5"
                >
                  <EditIcon className="w-3.5 h-3.5" />
                  {t('edit_draft')}
                </Button>
              )}
            </div>
          </div>
        )}

        <SmimePassphraseDialog
          isOpen={smimeUnlockDialogOpen}
          onClose={() => {
            setSmimeUnlockDialogOpen(false);
            setSmimeUnlockError(null);
          }}
          onSubmit={handleSmimeUnlockSubmit}
          title={tSmime('unlock_key')}
          description={tSmime('unlock_key_desc')}
          error={smimeUnlockError}
        />

        {/* Unified Notification Banner - External Content + Calendar Invitation */}
        {((hasBlockedContent && !allowExternalContent && externalContentPolicy !== 'allow') ||
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

        <div>

          {/* Email Body */}
          <div className="email-content-wrapper overflow-x-auto">
            {effectiveEmailContent.isHtml ? (
              <iframe
                ref={iframeRef}
                srcDoc={emailIframeSrcDoc}
                sandbox="allow-same-origin allow-popups"
                title="Email content"
                className="w-full border-0 rounded"
                style={{ minHeight: '100px', colorScheme: isDark && emailHasNativeDarkMode ? 'light dark' : 'light' }}
                onLoad={handleIframeLoad}
              />
            ) : (
              <div
                className="email-content-text text-foreground"
                dangerouslySetInnerHTML={{ __html: effectiveEmailContent.html }}
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

          {/* Quick Reply Section - hidden for drafts */}
          {!isDraft && (<div className={cn(
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
          </div>)}
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
      <nav className="fixed bottom-0 left-0 right-0 z-[50] bg-background border-t border-border sm:hidden">
        <div className="flex items-center justify-around">
          <button
            onClick={onNavigatePrev}
            disabled={!onNavigatePrev}
            className={cn(
              "flex flex-col items-center justify-center gap-1 py-2 px-3 min-w-[64px] min-h-[44px] transition-colors duration-150",
              onNavigatePrev ? "text-muted-foreground active:text-foreground" : "text-muted-foreground/30"
            )}
            aria-label={t('tooltips.previous')}
          >
            <ChevronLeft className="w-5 h-5" />
            <span className="text-[10px] font-medium leading-tight">{t('previous')}</span>
          </button>
          {isDraft && onEditDraft ? (
            <button
              onClick={onEditDraft}
              className="flex flex-col items-center justify-center gap-1 py-2 px-3 min-w-[64px] min-h-[44px] text-primary active:text-primary/80 transition-colors duration-150"
              aria-label={t('tooltips.edit_draft')}
            >
              <EditIcon className="w-5 h-5" />
              <span className="text-[10px] font-medium leading-tight">{t('edit_draft')}</span>
            </button>
          ) : (
          <>
          <button
            onClick={() => onReply?.()}
            className="flex flex-col items-center justify-center gap-1 py-2 px-3 min-w-[64px] min-h-[44px] text-muted-foreground active:text-foreground transition-colors duration-150"
            aria-label={t('tooltips.reply')}
          >
            <Reply className="w-5 h-5" />
            <span className="text-[10px] font-medium leading-tight">{t('reply')}</span>
          </button>
          <button
            onClick={onReplyAll}
            className="flex flex-col items-center justify-center gap-1 py-2 px-3 min-w-[64px] min-h-[44px] text-muted-foreground active:text-foreground transition-colors duration-150"
            aria-label={t('tooltips.reply_all')}
          >
            <ReplyAll className="w-5 h-5" />
            <span className="text-[10px] font-medium leading-tight">{t('reply_all')}</span>
          </button>
          <button
            onClick={onForward}
            className="flex flex-col items-center justify-center gap-1 py-2 px-3 min-w-[64px] min-h-[44px] text-muted-foreground active:text-foreground transition-colors duration-150"
            aria-label={t('tooltips.forward')}
          >
            <Forward className="w-5 h-5" />
            <span className="text-[10px] font-medium leading-tight">{t('forward')}</span>
          </button>
          </>)}
          <button
            onClick={onNavigateNext}
            disabled={!onNavigateNext}
            className={cn(
              "flex flex-col items-center justify-center gap-1 py-2 px-3 min-w-[64px] min-h-[44px] transition-colors duration-150",
              onNavigateNext ? "text-muted-foreground active:text-foreground" : "text-muted-foreground/30"
            )}
            aria-label={t('tooltips.next')}
          >
            <ChevronRight className="w-5 h-5" />
            <span className="text-[10px] font-medium leading-tight">{t('next')}</span>
          </button>
        </div>
      </nav>
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
            addLocalContact({ id: `local-${crypto.randomUUID()}`, addressBookIds: {}, ...contactData } as ContactCard);
            toast.success('Contact added');
          }
        }}
      />
    )}
    </div>
  );
}