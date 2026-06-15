"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Paperclip, Send, Save, Check, Loader2, AlertCircle, FileText, BookmarkPlus, ShieldCheck, Lock, CalendarClock, ChevronDown, MailCheck } from "lucide-react";
import { cn, formatFileSize, formatDateTime, generateUUID } from "@/lib/utils";
import { debug } from "@/lib/debug";
import { toast } from "@/stores/toast-store";
import { useContextMenu } from "@/hooks/use-context-menu";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { sanitizeSignatureHtml, sanitizeEmailHtml } from "@/lib/email-sanitization";
import { buildReplySubject, buildForwardSubject } from "@/lib/subject-prefix";
import { isFilePreviewable } from "@/lib/file-preview";
import { buildQuotedHtmlBlock, serializeEditorContent } from "@/components/email/quoted-html";
import { emailHooks, contactHooks } from "@/lib/plugin-hooks";
import type { OutgoingEmail, RecipientSuggestion } from "@/lib/plugin-types";
import { useAuthStore } from "@/stores/auth-store";
import { useIdentityStore } from "@/stores/identity-store";
import { useProMultiAccountIdentities, stripCrossAccountIdentityPrefix } from "@/hooks/use-pro-multi-account-identities";
import { useAccountStore } from "@/stores/account-store";
import { useSmimeStore } from "@/stores/smime-store";
import { useEmailStore } from "@/stores/email-store";
import { useSettingsStore } from "@/stores/settings-store";
import { buildMimeMessage, wrapCmsAsSmimeMessage } from "@/lib/smime/mime-builder";
import type { MimeAttachment } from "@/lib/smime/mime-builder";
import { smimeSign } from "@/lib/smime/smime-sign";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import { Avatar } from "@/components/ui/avatar";
import { FilePreviewModal } from "@/components/files/file-preview-modal";
import { smimeEncrypt } from "@/lib/smime/smime-encrypt";
import { useContactStore } from "@/stores/contact-store";
import { useTemplateStore } from "@/stores/template-store";
import { SubAddressHelper } from "@/components/identity/sub-address-helper";
import { generateSubAddress } from "@/lib/sub-addressing";
import { substitutePlaceholders } from "@/lib/template-utils";
import { TemplatePicker } from "@/components/templates/template-picker";
import { TemplateForm } from "@/components/templates/template-form";
import type { EmailTemplate } from "@/lib/template-types";
import { appendPlainTextSignature, getPlainTextSignature } from "@/lib/signature-utils";
import { resolveReplyFrom } from "@/lib/reply-identity";
import { computeReplyThreadingHeaders } from "@/lib/email-threading";
import {
  rewriteCidImagesForEditor,
  replaceInlineImagePlaceholders,
  removeChipFromFieldValue,
  addChipToFieldValue,
} from "@/lib/email-composer-utils";
import { RichTextEditor } from "@/components/email/rich-text-editor";
import type { Editor } from "@tiptap/react";

/** Strip HTML tags and decode entities to get a plain-text version */
function htmlToPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent || '';
}

export interface ComposerDraftData {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  showCc: boolean;
  showBcc: boolean;
  selectedIdentityId: string | null;
  subAddressTag: string;
  mode: 'compose' | 'reply' | 'replyAll' | 'forward';
  replyTo?: EmailComposerProps['replyTo'];
  draftId: string | null;
  /** When set, overrides the header From: - sent through the selected identity's envelope. */
  fromOverrideEmail?: string;
  fromOverrideName?: string;
  fromOverrideEnabled?: boolean;
}

interface EmailComposerProps {
  onSend?: (data: {
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
    envelopeMailFrom?: string;
    /** Local account ID owning the selected identity. Set when the user
     *  picked an identity from a non-active account in the Pro multi-
     *  account dropdown; parents should send through that account's
     *  client instead of the currently-active one. */
    localAccountId?: string;
    attachments?: Array<{ blobId: string; name: string; type: string; size: number; disposition?: 'attachment' | 'inline'; cid?: string }>;
    inReplyTo?: string[];
    references?: string[];
    delayedUntil?: string;
    requestReadReceipt?: boolean;
  }) => void | Promise<void>;
  onScheduledSendCreated?: () => void | Promise<void>;
  onClose?: () => void;
  onDiscardDraft?: (draftId: string) => void;
  onSaveState?: (data: ComposerDraftData) => void;
  className?: string;
  initialDraftText?: string;
  initialData?: ComposerDraftData | null;
  mode?: 'compose' | 'reply' | 'replyAll' | 'forward';
  replyTo?: {
    from?: { email?: string; name?: string }[];
    replyToAddresses?: { email?: string; name?: string }[];
    to?: { email?: string; name?: string }[];
    cc?: { email?: string; name?: string }[];
    bcc?: { email?: string; name?: string }[];
    subject?: string;
    body?: string;
    htmlBody?: string;
    receivedAt?: string;
    accountId?: string;
    attachments?: Array<{ blobId: string; name?: string; type: string; size: number; cid?: string; disposition?: string }>;
    // Threading: parent's Message-ID and References, used to set RFC 5322
    // In-Reply-To and References on outgoing replies. See #234.
    messageId?: string;
    inReplyTo?: string[];
    references?: string[];
    // Pre-built quote header block. Supplied by the composer opener after it
    // runs emailHooks.onBuildQuoteHeader through plugin transforms. When set,
    // the composer uses these verbatim instead of building its own default
    // "On X, Y wrote:" / "---------- Forwarded message ----------" block.
    quoteHeaderHtml?: string;
    quoteHeaderText?: string;
    /** Mirror of QuoteHeader.wrapInBlockquote. Defaults to true. */
    quoteWrapInBlockquote?: boolean;
  };
}

type ComposerAttachment = {
  file?: File;
  name: string;
  type: string;
  size: number;
  blobId?: string;
  uploading?: boolean;
  error?: boolean;
  abortController?: AbortController;
};

type SignatureIdentityLike = {
  htmlSignature?: string;
  textSignature?: string;
} | null | undefined;

// Render the embedded signature for "above quote" mode. Bracketed with
// `data-signature-block` marker paragraphs so we can swap the inner content
// when the user switches identity without losing the surrounding draft or
// quoted message. The markers are preserved through TipTap by the
// StyledParagraph extension.
function buildEmbeddedSignatureHtml(
  identity: SignatureIdentityLike,
  options: { embed: boolean; separator: boolean }
): string {
  if (!options.embed) return '';
  const startMarker = options.separator
    ? `<p data-signature-block="separator">-- </p>`
    : `<p data-signature-block="start"></p>`;
  const endMarker = `<p data-signature-block="end"></p>`;
  if (identity?.htmlSignature) {
    return `${startMarker}${sanitizeSignatureHtml(identity.htmlSignature)}${endMarker}`;
  }
  if (identity?.textSignature) {
    const escaped = identity.textSignature
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    return `${startMarker}<p>${escaped}</p>${endMarker}`;
  }
  return '';
}

function formatLocalDateTimeInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getDefaultScheduleValue(): string {
  const tomorrowAtEight = new Date();
  tomorrowAtEight.setDate(tomorrowAtEight.getDate() + 1);
  tomorrowAtEight.setHours(8, 0, 0, 0);
  return formatLocalDateTimeInput(tomorrowAtEight);
}

export function EmailComposer({
  onSend,
  onScheduledSendCreated,
  onClose,
  onDiscardDraft,
  onSaveState,
  className,
  initialDraftText,
  initialData,
  mode = 'compose',
  replyTo
}: EmailComposerProps) {
  const t = useTranslations('email_composer');
  const tCommon = useTranslations('common');
  const tQuote = useTranslations('quote_header');
  const timeFormat = useSettingsStore((state) => state.timeFormat);
  const plainTextMode = useSettingsStore((state) => state.plainTextMode);
  const subAddressDelimiter = useSettingsStore((state) => state.subAddressDelimiter);
  const autoSelectReplyIdentity = useSettingsStore((state) => state.autoSelectReplyIdentity);
  const attachmentReminderEnabled = useSettingsStore((state) => state.attachmentReminderEnabled);
  const attachmentReminderKeywords = useSettingsStore((state) => state.attachmentReminderKeywords);
  const sendDelaySeconds = useSettingsStore((state) => state.sendDelaySeconds);
  const signaturePosition = useSettingsStore((state) => state.signaturePosition);
  const signatureSeparatorEnabled = useSettingsStore((state) => state.signatureSeparatorEnabled);
  const requestReadReceiptDefault = useSettingsStore((state) => state.requestReadReceiptDefault);
  const activeIdentities = useIdentityStore((s) => s.identities);
  // Pro shell: surface identities from every connected account, grouped
  // for the From dropdown's <optgroup>s. Outside Pro this collapses to
  // the active account's identities only.
  const multiAccountIdentities = useProMultiAccountIdentities();
  const identities = multiAccountIdentities.enabled
    ? multiAccountIdentities.allIdentities
    : activeIdentities;
  const identityGroups = multiAccountIdentities.enabled
    ? multiAccountIdentities.groups
    : [];
  const primaryIdentity = activeIdentities[0] ?? null;

  // The signature identity used when embedding the signature into the initial
  // body for "above quote" mode. Mirrors the signatureIdentity derivation
  // below, but uses initialData (or primary) since selectedIdentityId state
  // does not exist yet at this point.
  const initialCurrentIdentityForSig = initialData?.selectedIdentityId
    ? identities.find((i) => i.id === initialData.selectedIdentityId) || primaryIdentity
    : primaryIdentity;
  const initialSignatureIdentity = (initialCurrentIdentityForSig?.htmlSignature || initialCurrentIdentityForSig?.textSignature)
    ? initialCurrentIdentityForSig
    : primaryIdentity;
  const hasInitialSignature = !!(initialSignatureIdentity?.htmlSignature || initialSignatureIdentity?.textSignature);
  const shouldEmbedSignatureAboveQuote =
    (mode === 'reply' || mode === 'replyAll' || mode === 'forward') &&
    signaturePosition === 'above_quote' &&
    hasInitialSignature;
  // New-mail composes always embed the signature into the editor body so it's
  // editable/removable (the previous read-only preview below the editor was
  // never spec-correct - see #329). Compose mode also ignores any leftover
  // `replyTo` from a still-selected email; getInitialBody short-circuits below.
  const shouldEmbedSignatureInNewMail = mode === 'compose' && hasInitialSignature;

  // Format a single EmailAddress for display in the composer input
  const formatAddr = (r: { name?: string; email?: string }) =>
    r.email ? (r.name && r.name !== r.email ? `${r.name} <${r.email}>` : r.email) : "";

  // Parse a recipient string that may be "Name <email>" or bare "email"
  const parseRecipient = (s: string): { name?: string; email: string } => {
    const trimmed = s.trim();
    const angleMatch = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
    if (angleMatch) {
      return { name: angleMatch[1].trim(), email: angleMatch[2].trim() };
    }
    return { email: trimmed };
  };

  // Initialize with reply/forward data if provided
  const getInitialTo = () => {
    if (!replyTo) return "";
    // RFC 5322: use Reply-To header if present, otherwise fall back to From
    const replyTarget = replyTo.replyToAddresses?.length
      ? replyTo.replyToAddresses.filter(r => r.email).map(formatAddr).join(", ")
      : (replyTo.from?.[0] ? formatAddr(replyTo.from[0]) : "");
    if (mode === 'reply') {
      return replyTarget ? replyTarget + ', ' : "";
    } else if (mode === 'replyAll') {
      const ownEmails = new Set(identities.map(i => i.email?.trim().toLowerCase()).filter(Boolean));
      const originalTo = replyTo.to
        ?.filter(r => r.email && !ownEmails.has(r.email.trim().toLowerCase()))
        .map(formatAddr).join(", ") || "";
      const combined = [replyTarget, originalTo].filter(Boolean).join(", ");
      return combined ? combined + ', ' : "";
    }
    return "";
  };

  const getInitialCc = () => {
    if (!replyTo || mode !== 'replyAll') return "";
    const ownEmails = new Set(identities.map(i => i.email?.trim().toLowerCase()).filter(Boolean));
    const cc = replyTo.cc
      ?.filter(r => r.email && !ownEmails.has(r.email.trim().toLowerCase()))
      .map(formatAddr).join(", ") || "";
    return cc ? cc + ', ' : "";
  };

  const getInitialSubject = () => {
    if (!replyTo?.subject) return "";
    if (mode === 'forward') {
      return buildForwardSubject(replyTo.subject, t('prefix.forward'));
    } else if (mode === 'reply' || mode === 'replyAll') {
      return buildReplySubject(replyTo.subject, t('prefix.reply'));
    }
    return "";
  };

  const getInitialBody = () => {
    if (plainTextMode) {
      // Plain text mode: produce plain text body with no HTML
      const prefix = initialDraftText || "";
      // Compose mode: ignore any leftover replyTo (e.g. a selected mail in the
      // viewer) and embed the signature directly into the body so it's
      // editable. Fixes #329 (A,B).
      if (mode === 'compose') {
        if (!shouldEmbedSignatureInNewMail) return prefix;
        const sep = signatureSeparatorEnabled ? '\n\n-- \n' : '\n\n';
        return `${prefix}${sep}${getPlainTextSignature(initialSignatureIdentity)}`;
      }
      if (!replyTo?.body && !replyTo?.htmlBody) return prefix;

      const date = replyTo.receivedAt ? formatDateTime(replyTo.receivedAt, timeFormat, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : "";
      const from = replyTo.from?.[0];
      const fromStr = from ? `${from.name || from.email}` : tCommon('unknown');
      // Forward "From:" shows the full sender incl. address; reply line keeps
      // the bare name (reads naturally in the localized "On … wrote:" line).
      const fromStrFull = from
        ? (from.name && from.email && from.name !== from.email
            ? `${from.name} <${from.email}>`
            : (from.email || from.name || tCommon('unknown')))
        : tCommon('unknown');

      const originalText = replyTo.body || (replyTo.htmlBody ? htmlToPlainText(replyTo.htmlBody) : '');
      const quotedText = originalText.split('\n').map(line => `> ${line}`).join('\n');

      // When "above quote" is configured, splice signature between the user's
      // drafting area and the quoted content so it reads naturally as a
      // closing for the reply body. Send-time append is skipped - see
      // shouldEmbedSignatureAboveQuote.
      const plainSep = signatureSeparatorEnabled ? '\n\n-- \n' : '\n\n';
      const signatureBlock = shouldEmbedSignatureAboveQuote
        ? `${plainSep}${getPlainTextSignature(initialSignatureIdentity)}`
        : '';

      // Plugin override (resolved at composer open via onBuildQuoteHeader).
      if (replyTo.quoteHeaderText !== undefined && (mode === 'reply' || mode === 'replyAll' || mode === 'forward')) {
        const body = mode === 'forward' ? originalText : quotedText;
        return `${prefix}${signatureBlock}\n\n${replyTo.quoteHeaderText}\n${body}`;
      }

      if (mode === 'forward') {
        return `${prefix}${signatureBlock}\n\n${tQuote('forwarded_separator')}\n${tQuote('from_label')}: ${fromStrFull}\n${tQuote('date_label')}: ${date}\n${tQuote('subject_label')}: ${replyTo.subject || ''}\n\n${originalText}`;
      } else if (mode === 'reply' || mode === 'replyAll') {
        return `${prefix}${signatureBlock}\n\n${tQuote('reply_line', { date, from: fromStr })}\n${quotedText}`;
      }
      return prefix;
    }

    const prefix = initialDraftText ? `<p>${initialDraftText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>` : "";
    // Compose mode: ignore any leftover replyTo and embed the signature
    // directly into the body so the user can edit/delete it. The leading
    // empty paragraph gives the cursor a place to land above the signature.
    if (mode === 'compose') {
      if (!shouldEmbedSignatureInNewMail) return prefix;
      const composePrefix = prefix || '<p></p>';
      const embedded = buildEmbeddedSignatureHtml(initialSignatureIdentity, {
        embed: true,
        separator: signatureSeparatorEnabled,
      });
      return `${composePrefix}${embedded}`;
    }
    if (!replyTo?.body && !replyTo?.htmlBody) return prefix;

    const date = replyTo.receivedAt ? formatDateTime(replyTo.receivedAt, timeFormat, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : "";
    const from = replyTo.from?.[0];
    const fromStr = from ? `${from.name || from.email}` : tCommon('unknown');
    const fromStrFull = from
      ? (from.name && from.email && from.name !== from.email
          ? `${from.name} <${from.email}>`
          : (from.email || from.name || tCommon('unknown')))
      : tCommon('unknown');

    const signatureBlock = buildEmbeddedSignatureHtml(initialSignatureIdentity, {
      embed: shouldEmbedSignatureAboveQuote,
      separator: signatureSeparatorEnabled,
    });

    // Plugin override (resolved at composer open via onBuildQuoteHeader).
    if (replyTo.quoteHeaderHtml !== undefined && (mode === 'reply' || mode === 'replyAll' || mode === 'forward')) {
      if (replyTo.htmlBody) {
        // Layout-heavy original: embed verbatim as a QuotedHtml island so
        // nested tables / MJML survive 1:1 (sanitize strips scripts/styles
        // first; cid rewrite runs after so its data-cid markers survive).
        const island = buildQuotedHtmlBlock(
          rewriteCidImagesForEditor(sanitizeEmailHtml(replyTo.htmlBody))
        );
        return `${prefix}${signatureBlock}<br>${replyTo.quoteHeaderHtml}${island}`;
      }
      const escaped = replyTo.body
        ? replyTo.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
        : '';
      const wrap = replyTo.quoteWrapInBlockquote !== false;
      const bodyHtml = wrap
        ? `<blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex">${escaped}</blockquote>`
        : escaped;
      return `${prefix}${signatureBlock}<br>${replyTo.quoteHeaderHtml}${bodyHtml}`;
    }

    // Build quoted content as HTML
    if (replyTo.htmlBody && (mode === 'reply' || mode === 'replyAll' || mode === 'forward')) {
      const quoteHeader = mode === 'forward'
        ? `${tQuote('forwarded_separator')}<br>${tQuote('from_label')}: ${fromStrFull}<br>${tQuote('date_label')}: ${date}<br>${tQuote('subject_label')}: ${replyTo.subject || ''}<br><br>`
        : `${tQuote('reply_line', { date, from: fromStr })}<br>`;
      // Embed the original as a QuotedHtml island (verbatim, schema-free) so
      // its layout survives the editor round-trip. Sanitize first to strip
      // scripts/styles/head; cid rewrite afterwards so data-cid markers
      // aren't dropped by the sanitizer's ALLOW_DATA_ATTR:false.
      const island = buildQuotedHtmlBlock(
        rewriteCidImagesForEditor(sanitizeEmailHtml(replyTo.htmlBody))
      );
      return `${prefix}${signatureBlock}<br><div>${quoteHeader}</div>${island}`;
    }

    if (replyTo.body) {
      const escapedOriginal = replyTo.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
      if (mode === 'forward') {
        return `${prefix}${signatureBlock}<br><br>${tQuote('forwarded_separator')}<br>${tQuote('from_label')}: ${fromStrFull}<br>${tQuote('date_label')}: ${date}<br>${tQuote('subject_label')}: ${replyTo.subject || ''}<br><br>${escapedOriginal}`;
      } else if (mode === 'reply' || mode === 'replyAll') {
        return `${prefix}${signatureBlock}<br><br>${tQuote('reply_line', { date, from: fromStr })}<br><blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex">${escapedOriginal}</blockquote>`;
      }
    }
    return prefix;
  };

  const [to, setTo] = useState(initialData?.to ?? getInitialTo());
  const [cc, setCc] = useState(initialData?.cc ?? getInitialCc());
  const [bcc, setBcc] = useState(initialData?.bcc ?? "");
  const [subject, setSubject] = useState(initialData?.subject ?? getInitialSubject());
  const [body, setBody] = useState(initialData?.body ?? getInitialBody());
  const [showCc, setShowCc] = useState(initialData?.showCc ?? !!getInitialCc());
  const [showBcc, setShowBcc] = useState(initialData?.showBcc ?? false);
  const [isDraggingChipOverCc, setIsDraggingChipOverCc] = useState(false);
  const [isDraggingChipOverBcc, setIsDraggingChipOverBcc] = useState(false);
  const [requestReadReceipt, setRequestReadReceipt] = useState(requestReadReceiptDefault);
  const [draftId, setDraftId] = useState<string | null>(initialData?.draftId ?? null);
  // Mirror of draftId for synchronous reads inside chained saves; React's
  // setDraftId is async, so a queued saveDraft would otherwise see the old
  // value and try to destroy a draft that was just replaced.
  const draftIdRef = useRef<string | null>(initialData?.draftId ?? null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedDataRef = useRef<string>("");
  // Tracks the currently-running saveDraft so concurrent callers (autosave
  // timer + send button) serialize instead of issuing parallel destroy/create
  // requests with the same draftId. See bug #303.
  const inflightSaveRef = useRef<Promise<string | null> | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(() => {
    if (mode === 'forward' && replyTo?.attachments?.length) {
      return replyTo.attachments
        // Skip inline cid-referenced images - they're embedded in the forwarded HTML body
        // (matches the viewer's hideInlineImageAttachments logic).
        .filter(att => !(att.cid && att.disposition === 'inline' && (att.type || '').startsWith('image/')))
        .map(att => ({
          name: att.name || 'attachment',
          type: att.type || 'application/octet-stream',
          size: att.size,
          blobId: att.blobId,
        }));
    }
    return [];
  });
  const inlineImagesRef = useRef<Array<{ cid: string; blobId: string; type: string; name: string; size: number; dataUrl: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [validationErrors, setValidationErrors] = useState<{ to?: boolean; subject?: boolean; body?: boolean }>({});
  const [shakeField, setShakeField] = useState<string | null>(null);
  const [selectedIdentityId, setSelectedIdentityId] = useState<string | null>(initialData?.selectedIdentityId ?? null);
  const [subAddressTag, setSubAddressTag] = useState<string>(initialData?.subAddressTag ?? '');
  const [fromOverrideEnabled, setFromOverrideEnabled] = useState<boolean>(initialData?.fromOverrideEnabled ?? false);
  const [fromOverrideEmail, setFromOverrideEmail] = useState<string>(initialData?.fromOverrideEmail ?? '');
  const [fromOverrideName, setFromOverrideName] = useState<string>(initialData?.fromOverrideName ?? '');
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [showSaveAsTemplate, setShowSaveAsTemplate] = useState(false);
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [showAllAttachments, setShowAllAttachments] = useState(false);
  const [previewAttachment, setPreviewAttachment] = useState<ComposerAttachment | null>(null);
  const [smimeSign_, setSmimeSign] = useState(false);
  const [smimeEncrypt_, setSmimeEncrypt] = useState(false);
  const [smimePassphrasePrompt, setSmimePassphrasePrompt] = useState<{ keyId: string; resolve: (passphrase: string) => void; reject: () => void } | null>(null);
  const [smimePassphraseInput, setSmimePassphraseInput] = useState('');
  const [smimePassphraseError, setSmimePassphraseError] = useState('');
  const [showAttachmentWarning, setShowAttachmentWarning] = useState(false);
  const [attachmentWarningKeyword, setAttachmentWarningKeyword] = useState('');
  const [attachmentWarningDelayedUntil, setAttachmentWarningDelayedUntil] = useState<string | undefined>();
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [scheduleValue, setScheduleValue] = useState('');
  const [scheduleError, setScheduleError] = useState('');
  const [showSendMenu, setShowSendMenu] = useState(false);
  const sendMenuRef = useRef<HTMLDivElement>(null);

  const saveTemplateModalRef = useFocusTrap({
    isActive: showSaveAsTemplate,
    onEscape: () => setShowSaveAsTemplate(false),
    restoreFocus: true,
  });

  const closeDialogRef = useFocusTrap({
    isActive: showCloseDialog,
    onEscape: () => setShowCloseDialog(false),
    restoreFocus: true,
  });

  const attachmentWarningRef = useFocusTrap({
    isActive: showAttachmentWarning,
    onEscape: () => setShowAttachmentWarning(false),
    restoreFocus: true,
  });

  const { client } = useAuthStore();
  const currentIdentity = selectedIdentityId
    ? identities.find((identity) => identity.id === selectedIdentityId) || primaryIdentity
    : primaryIdentity;

  // When the selected identity belongs to a non-active account (Pro
  // multi-account dropdown), `currentIdentity.id` carries a "<localId>::"
  // namespace and JMAP calls must be routed through that account's
  // client with the un-prefixed id. `composerClient` and
  // `currentIdentityRawId` are what save/send code should use.
  const currentIdentityParts = currentIdentity?.id
    ? stripCrossAccountIdentityPrefix(currentIdentity.id)
    : { localAccountId: null, rawId: undefined };
  const composerClient = currentIdentityParts.localAccountId
    ? (useAuthStore.getState().getClientForAccount(currentIdentityParts.localAccountId) ?? client)
    : client;
  const currentIdentityRawId = currentIdentityParts.rawId ?? currentIdentity?.id;
  // Alias identities often lack a configured signature - fall back to the primary
  // identity's signature so replies (which auto-select a matching alias) still
  // populate the user's signature.
  const signatureIdentity = (currentIdentity?.htmlSignature || currentIdentity?.textSignature)
    ? currentIdentity
    : primaryIdentity;

  // Hold the TipTap editor instance so we can swap the embedded signature
  // when the user switches identity in "above quote" mode without rebuilding
  // the whole body (which would lose user edits to the surrounding draft).
  const editorRef = useRef<Editor | null>(null);
  const prevSignatureIdentityIdRef = useRef<string | null | undefined>(signatureIdentity?.id);
  const prevSignatureSeparatorRef = useRef<boolean>(signatureSeparatorEnabled);

  useEffect(() => {
    const editor = editorRef.current;
    const identityChanged = prevSignatureIdentityIdRef.current !== signatureIdentity?.id;
    const separatorChanged = prevSignatureSeparatorRef.current !== signatureSeparatorEnabled;
    prevSignatureIdentityIdRef.current = signatureIdentity?.id;
    prevSignatureSeparatorRef.current = signatureSeparatorEnabled;
    if (!editor) return;
    if (!identityChanged && !separatorChanged) return;
    if (plainTextMode) return;
    // Replies/forwards only embed when configured for "above quote". Compose
    // always embeds (see getInitialBody), so swap on identity change there too.
    const isReplyLike = mode === 'reply' || mode === 'replyAll' || mode === 'forward';
    if (!isReplyLike && mode !== 'compose') return;
    if (isReplyLike && signaturePosition !== 'above_quote') return;

    // serializeEditorContent (not getHTML) so a QuotedHtml island's verbatim
    // body isn't lost during the signature splice + setContent round-trip.
    const currentHtml = serializeEditorContent(editor);
    const doc = new DOMParser().parseFromString(currentHtml, 'text/html');
    const startEl = doc.querySelector('[data-signature-block="separator"], [data-signature-block="start"]');
    if (!startEl) return;
    const endEl = doc.querySelector('[data-signature-block="end"]');

    const newSignature = buildEmbeddedSignatureHtml(signatureIdentity, {
      embed: true,
      separator: signatureSeparatorEnabled,
    });
    if (!newSignature) return;

    // Build a temporary container holding the replacement nodes so we can
    // splice them in without re-serializing/parsing twice.
    const replacementHost = doc.createElement('div');
    replacementHost.innerHTML = newSignature;
    const replacementNodes = Array.from(replacementHost.childNodes);

    const parent = startEl.parentNode;
    if (!parent) return;

    // Remove the existing signature range [startEl … endEl] inclusive, or
    // from startEl to the next quote boundary if no end marker is present.
    // The quote boundary is either a legacy <blockquote> or the QuotedHtml
    // island wrapper (<div data-quoted-html>) - stop before either so the
    // signature splice never eats into the quoted body.
    const removeUntil = endEl && endEl.parentNode === parent ? endEl : null;
    const isQuoteBoundary = (n: Node | null): boolean => {
      if (!n || n.nodeType !== 1) return false;
      const el = n as Element;
      return el.tagName === 'BLOCKQUOTE' || el.hasAttribute('data-quoted-html');
    };
    const toRemove: Node[] = [];
    let cursor: Node | null = startEl;
    while (cursor) {
      toRemove.push(cursor);
      if (cursor === removeUntil) break;
      const next: Node | null = cursor.nextSibling;
      if (!removeUntil && isQuoteBoundary(next)) break;
      cursor = next;
    }
    const insertBefore = toRemove[toRemove.length - 1]?.nextSibling ?? null;
    toRemove.forEach((node) => parent.removeChild(node));
    replacementNodes.forEach((node) => parent.insertBefore(node, insertBefore));

    const nextHtml = doc.body.innerHTML;
    if (nextHtml !== currentHtml) {
      editor.commands.setContent(nextHtml, { emitUpdate: true });
    }
  }, [signatureIdentity?.id, signatureIdentity?.htmlSignature, signatureIdentity?.textSignature, signatureSeparatorEnabled, signaturePosition, mode, plainTextMode]);

  useEffect(() => {
    const handleClickOutsideSendMenu = (event: MouseEvent) => {
      if (!sendMenuRef.current?.contains(event.target as Node)) {
        setShowSendMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutsideSendMenu);
    return () => document.removeEventListener('mousedown', handleClickOutsideSendMenu);
  }, []);

  const openScheduleDialog = useCallback(() => {
    setScheduleError('');
    setScheduleValue(getDefaultScheduleValue());
    setShowScheduleDialog(true);
    setShowSendMenu(false);
  }, []);

  useEffect(() => {
    if (!autoSelectReplyIdentity) return;
    if (selectedIdentityId || initialData?.selectedIdentityId) return;
    if (mode !== 'reply' && mode !== 'replyAll') return;

    const resolved = resolveReplyFrom(identities, {
      to: replyTo?.to,
      cc: replyTo?.cc,
      bcc: replyTo?.bcc,
    });

    if (resolved) {
      setSelectedIdentityId(resolved.identityId);
      if (resolved.overrideEmail && !fromOverrideEnabled) {
        setFromOverrideEnabled(true);
        setFromOverrideEmail(resolved.overrideEmail);
        if (resolved.overrideName) setFromOverrideName(resolved.overrideName);
      }
      return;
    }

    // Fallback: match identity by the account's email when replying from unified view
    if (replyTo?.accountId) {
      const account = useAccountStore.getState().getAccountById(replyTo.accountId);
      if (account?.email) {
        const accountEmail = account.email.trim().toLowerCase();
        const accountIdentity = identities.find(
          (identity) => identity.email.trim().toLowerCase() === accountEmail
        );
        if (accountIdentity) {
          setSelectedIdentityId(accountIdentity.id);
        }
      }
    }
  }, [
    autoSelectReplyIdentity,
    fromOverrideEnabled,
    identities,
    initialData?.selectedIdentityId,
    mode,
    replyTo?.accountId,
    replyTo?.bcc,
    replyTo?.cc,
    replyTo?.to,
    selectedIdentityId,
  ]);

  // Hydrate inline images referenced by the quoted body (issue #163).
  // `getInitialBody` rewrites `<img src="cid:xxx">` to placeholder src +
  // data-cid; here we (1) register each inline attachment in inlineImagesRef
  // so the send path re-attaches the blob with the right cid, and (2) fetch
  // each blob as a data URL and swap it into the body so the editor actually
  // shows the image instead of a blank placeholder.
  useEffect(() => {
    if (plainTextMode) return;
    if (mode !== 'reply' && mode !== 'replyAll' && mode !== 'forward') return;
    if (!composerClient || !replyTo?.attachments?.length) return;

    const inlineAtts = replyTo.attachments.filter((att) =>
      att.cid && att.disposition === 'inline' && (att.type || '').startsWith('image/')
    );
    if (inlineAtts.length === 0) return;

    // Seed the ref synchronously so a fast Send still attaches the right blobs
    // even if the FileReader work below hasn't resolved yet.
    for (const att of inlineAtts) {
      if (!att.cid) continue;
      if (inlineImagesRef.current.some((e) => e.cid === att.cid)) continue;
      inlineImagesRef.current.push({
        cid: att.cid,
        blobId: att.blobId,
        type: att.type,
        name: att.name || 'inline',
        size: att.size,
        dataUrl: '',
      });
    }

    let cancelled = false;
    (async () => {
      const updates = new Map<string, string>();
      for (const att of inlineAtts) {
        if (!att.cid) continue;
        try {
          const buffer = await composerClient.fetchBlobArrayBuffer(
            att.blobId,
            att.name || 'inline',
            att.type,
          );
          if (cancelled) return;
          const blob = new Blob([buffer], { type: att.type });
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          if (cancelled) return;
          const entry = inlineImagesRef.current.find((e) => e.cid === att.cid);
          if (entry) entry.dataUrl = dataUrl;
          updates.set(att.cid, dataUrl);
        } catch (err) {
          debug.error('Failed to load inline image for compose', err);
        }
      }
      if (cancelled || updates.size === 0) return;
      setBody((prev) => replaceInlineImagePlaceholders(prev, updates));
    })();

    return () => {
      cancelled = true;
    };
    // We deliberately hydrate once per composer open - subsequent replyTo
    // object identity churn from parent renders shouldn't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerClient, plainTextMode, mode]);

  const composerSignatureHtml = signatureIdentity?.htmlSignature
    ? `<div>${sanitizeSignatureHtml(signatureIdentity.htmlSignature)}</div>`
    : signatureIdentity?.textSignature
      ? `<div>${getPlainTextSignature(signatureIdentity).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</div>`
      : '';
  const getAutocomplete = useContactStore((s) => s.getAutocomplete);
  const addToTrustedSendersBook = useContactStore((s) => s.addToTrustedSendersBook);
  const addTrustedSender = useSettingsStore((s) => s.addTrustedSender);
  const trustedSendersAddressBook = useSettingsStore((s) => s.trustedSendersAddressBook);
  const addTemplate = useTemplateStore((s) => s.addTemplate);
  const sendRawEmail = useEmailStore((s) => s.sendRawEmail);
  const smimeStore = useSmimeStore();

  // Determine S/MIME availability for the selected identity
  const currentSmimeIdentityId = selectedIdentityId || primaryIdentity?.id;
  const smimeKeyRecord = currentSmimeIdentityId ? smimeStore.getKeyRecordForIdentity(currentSmimeIdentityId) : undefined;
  const canSmimeSign = !!smimeKeyRecord;
  const canSmimeEncrypt = (() => {
    if (!smimeKeyRecord) return false;
    const toAddrs = to.split(',').map(e => e.trim()).filter(Boolean);
    const ccAddrs = cc.split(',').map(e => e.trim()).filter(Boolean);
    const bccAddrs = bcc.split(',').map(e => e.trim()).filter(Boolean);
    const allRecipients = [...toAddrs, ...ccAddrs, ...bccAddrs];
    if (allRecipients.length === 0) return false;
    const { missing } = smimeStore.getRecipientCerts(allRecipients);
    return missing.length === 0;
  })();

  // Initialize S/MIME defaults from store when identity changes
  useEffect(() => {
    if (currentSmimeIdentityId) {
      setSmimeSign(!!smimeStore.defaultSignIdentity[currentSmimeIdentityId] && canSmimeSign);
    }
    setSmimeEncrypt(smimeStore.defaultEncrypt && canSmimeEncrypt);
  // Only run when identity changes, not on every recipient edit
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSmimeIdentityId]);

  // Keep a ref to current state for the unmount save
  const stateRef = useRef({ to, cc, bcc, subject, body, showCc, showBcc, selectedIdentityId, subAddressTag, draftId, fromOverrideEnabled, fromOverrideEmail, fromOverrideName });
  stateRef.current = { to, cc, bcc, subject, body, showCc, showBcc, selectedIdentityId, subAddressTag, draftId, fromOverrideEnabled, fromOverrideEmail, fromOverrideName };

  // Track initial values for dirty detection (captured once on first render)
  const initialValuesRef = useRef({ to, cc, bcc, subject, body, attachmentCount: attachments.length });
  const isDirtyRef = useRef(false);
  isDirtyRef.current = to !== initialValuesRef.current.to || cc !== initialValuesRef.current.cc ||
    bcc !== initialValuesRef.current.bcc || subject !== initialValuesRef.current.subject ||
    body !== initialValuesRef.current.body || attachments.length > initialValuesRef.current.attachmentCount;

  // Ref to latest saveDraft for use in event handlers with stale closures
  const saveDraftRef = useRef<() => Promise<string | null>>(() => Promise.resolve(null));

  // Set by the explicit close paths (clean close, save-and-close, discard) so
  // the unmount auto-save below doesn't fire and stash a stale pendingDraft
  // on the parent (#329 D). Without this, "Reply → Discard → New mail" would
  // open the next composer with the discarded reply's mode/replyTo.
  const explicitCloseRef = useRef(false);

  // Auto-save state on unmount (when user navigates away without explicitly closing)
  useEffect(() => {
    return () => {
      if (explicitCloseRef.current) return;
      if (onSaveState && isDirtyRef.current) {
        const s = stateRef.current;
        onSaveState({
          ...s,
          mode,
          replyTo,
        });
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save draft to server on page close (best-effort)
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (isDirtyRef.current) {
        saveDraftRef.current();
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // Auto-focus the To field when composing a new email or forwarding
  useEffect(() => {
    if (mode === 'forward' || mode === 'compose') {
      // Small delay to ensure the input is rendered
      const timer = setTimeout(() => {
        toInputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [mode]);

  const [autocompleteResults, setAutocompleteResults] = useState<Array<{ name: string; email: string }>>([]);
  const [activeAutoField, setActiveAutoField] = useState<'to' | 'cc' | 'bcc' | null>(null);
  const [autoSelectedIndex, setAutoSelectedIndex] = useState(-1);
  const autocompleteTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const toInputRef = useRef<HTMLInputElement>(null);
  const ccInputRef = useRef<HTMLInputElement>(null);
  const bccInputRef = useRef<HTMLInputElement>(null);
  const subjectInputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const toDropdownRef = useRef<HTMLDivElement>(null);
  const ccDropdownRef = useRef<HTMLDivElement>(null);
  const bccDropdownRef = useRef<HTMLDivElement>(null);

  const focusSubject = useCallback(() => {
    subjectInputRef.current?.focus();
  }, []);

  const focusBody = useCallback(() => {
    if (plainTextMode) {
      bodyRef.current?.focus();
    } else {
      const proseMirror = editorContainerRef.current?.querySelector('.ProseMirror') as HTMLElement | null;
      proseMirror?.focus();
    }
  }, [plainTextMode]);

  const handleMoveChip = useCallback((chip: string, fromField: 'to' | 'cc' | 'bcc', toField: 'to' | 'cc' | 'bcc') => {
    const setters = { to: setTo, cc: setCc, bcc: setBcc };
    setters[fromField](prev => removeChipFromFieldValue(prev, chip));
    setters[toField](prev => addChipToFieldValue(prev, chip));
    if (toField === 'cc') setShowCc(true);
    if (toField === 'bcc') setShowBcc(true);
  }, [setTo, setCc, setBcc, setShowCc, setShowBcc]);

  const handleAutocomplete = useCallback((value: string, field: 'to' | 'cc' | 'bcc') => {
    if (autocompleteTimeoutRef.current) {
      clearTimeout(autocompleteTimeoutRef.current);
    }

    const lastPart = value.split(',').pop()?.trim() || '';
    if (lastPart.length < 1) {
      setAutocompleteResults([]);
      setActiveAutoField(null);
      setAutoSelectedIndex(-1);
      return;
    }

    autocompleteTimeoutRef.current = setTimeout(async () => {
      const localResults = getAutocomplete(lastPart);
      // Let plugins contribute extra suggestions (Slack handles, GitHub, CRM, …).
      const initial: RecipientSuggestion[] = localResults.map(r => ({ name: r.name, email: r.email }));
      const merged = await contactHooks.onProvideRecipientSuggestions.transform(initial, { query: lastPart });
      setAutocompleteResults(merged.map(s => ({ name: s.name, email: s.email })));
      setActiveAutoField(merged.length > 0 ? field : null);
      setAutoSelectedIndex(-1);
    }, 200);
  }, [getAutocomplete]);

  const insertAutocomplete = (suggestion: { name: string; email: string }, field: 'to' | 'cc' | 'bcc') => {
    const setter = field === 'to' ? setTo : field === 'cc' ? setCc : setBcc;
    const getter = field === 'to' ? to : field === 'cc' ? cc : bcc;

    const parts = getter.split(',').map(s => s.trim()).filter(Boolean);
    if (!getter.trimEnd().endsWith(',') && parts.length > 0) {
      parts.pop();
    }
    const formatted = suggestion.name && suggestion.name !== suggestion.email
      ? `${suggestion.name} <${suggestion.email}>`
      : suggestion.email;
    parts.push(formatted);
    setter(parts.join(', ') + ', ');
    setAutocompleteResults([]);
    setActiveAutoField(null);
    setAutoSelectedIndex(-1);

    const ref = field === 'to' ? toInputRef : field === 'cc' ? ccInputRef : bccInputRef;
    ref.current?.focus();
  };

  const handleAutoBlur = useCallback((e: React.FocusEvent, field: 'to' | 'cc' | 'bcc') => {
    const dropdownRef = field === 'to' ? toDropdownRef : field === 'cc' ? ccDropdownRef : bccDropdownRef;
    const relatedTarget = e.relatedTarget as Node | null;
    if (relatedTarget && dropdownRef.current?.contains(relatedTarget)) {
      return;
    }
    if (activeAutoField === field) {
      setActiveAutoField(null);
      setAutoSelectedIndex(-1);
    }
  }, [activeAutoField]);

  const handleAutoKeyDown = (e: React.KeyboardEvent, field: 'to' | 'cc' | 'bcc') => {
    if (!activeAutoField || autocompleteResults.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setAutoSelectedIndex((prev) => Math.min(prev + 1, autocompleteResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAutoSelectedIndex((prev) => Math.max(prev - 1, -1));
    } else if (e.key === 'Enter' && autoSelectedIndex >= 0) {
      e.preventDefault();
      insertAutocomplete(autocompleteResults[autoSelectedIndex], field);
    } else if (e.key === 'Escape') {
      setAutocompleteResults([]);
      setActiveAutoField(null);
      setAutoSelectedIndex(-1);
    }
  };

  const handleTemplateSelect = useCallback((template: EmailTemplate, filledValues: Record<string, string>) => {
    const filledSubject = Object.keys(filledValues).length > 0
      ? substitutePlaceholders(template.subject, filledValues)
      : template.subject;
    const filledBody = Object.keys(filledValues).length > 0
      ? substitutePlaceholders(template.body, filledValues)
      : template.body;

    // In plain text mode, use template body as-is; otherwise convert to HTML
    const bodyContent = plainTextMode
      ? filledBody
      : `<p>${filledBody.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`;

    if (mode === 'compose') {
      setSubject(filledSubject);
      setBody(bodyContent);
      if (template.defaultRecipients?.to?.length) {
        setTo(template.defaultRecipients.to.join(', ') + ', ');
      }
      if (template.defaultRecipients?.cc?.length) {
        setCc(template.defaultRecipients.cc.join(', ') + ', ');
        setShowCc(true);
      }
      if (template.defaultRecipients?.bcc?.length) {
        setBcc(template.defaultRecipients.bcc.join(', ') + ', ');
        setShowBcc(true);
      }
    } else {
      setBody((prev) => bodyContent + (plainTextMode ? '\n' : '') + prev);
    }

    if (template.identityId) {
      setSelectedIdentityId(template.identityId);
    }

    setShowTemplatePicker(false);
  }, [mode, plainTextMode]);

  useEffect(() => {
    const handleTemplateKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (target?.getAttribute('contenteditable') === 'true') return;
      if (e.key === 't' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setShowTemplatePicker(true);
      }
    };
    window.addEventListener('keydown', handleTemplateKey);
    return () => window.removeEventListener('keydown', handleTemplateKey);
  }, []);

  const addFiles = useCallback(async (files: File[]) => {
    if (!client || files.length === 0) return;

    // Let plugins veto each upload before it's queued.
    const allowedFiles: File[] = [];
    for (const file of files) {
      const ok = await emailHooks.onBeforeAttachmentUpload.intercept({
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
      });
      if (ok) allowedFiles.push(file);
    }
    if (allowedFiles.length === 0) return;
    files = allowedFiles;

    const newAttachments: ComposerAttachment[] = files.map(file => {
      const controller = new AbortController();
      return {
        file,
        name: file.name,
        type: file.type || 'application/octet-stream',
        size: file.size,
        uploading: true,
        abortController: controller,
      };
    });
    setAttachments(prev => [...prev, ...newAttachments]);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const controller = newAttachments[i].abortController;
      try {
        if (controller?.signal.aborted) continue;
        const { blobId } = await client.uploadBlob(file);

        if (controller?.signal.aborted) continue;
        setAttachments(prev =>
          prev.map(att =>
            att.file === file
              ? { ...att, blobId, uploading: false, abortController: undefined }
              : att
          )
        );
        emailHooks.onAfterAttachmentUpload.emit({
          name: file.name,
          type: file.type || 'application/octet-stream',
          size: file.size,
          blobId,
        });
      } catch (error) {
        if (controller?.signal.aborted) continue;
        debug.error(`Failed to upload ${file.name}:`, error);
        toast.error(t('upload_failed', { filename: file.name }));

        setAttachments(prev =>
          prev.map(att =>
            att.file === file
              ? { ...att, uploading: false, error: true, abortController: undefined }
              : att
          )
        );
      }
    }
  }, [client, t]);

  const handleImageUpload = useCallback(async (
    file: File,
  ): Promise<{ src: string; cid: string } | null> => {
    if (!client) return null;
    try {
      const readAsDataUrl = new Promise<string | null>((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve((e.target?.result as string) ?? null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
      const [{ blobId }, dataUrl] = await Promise.all([
        client.uploadBlob(file),
        readAsDataUrl,
      ]);
      if (!dataUrl) throw new Error('Failed to read image as data URL');
      const cid = `${generateUUID()}@webmail`;
      inlineImagesRef.current.push({
        cid,
        blobId,
        type: file.type || 'application/octet-stream',
        name: file.name,
        size: file.size,
        dataUrl,
      });
      return { src: dataUrl, cid };
    } catch (error) {
      debug.error(`Failed to upload inline image ${file.name}:`, error);
      toast.error(t('upload_failed', { filename: file.name }));
      return null;
    }
  }, [client, t]);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files) return;
    await addFiles(Array.from(event.target.files));
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const clearDragState = useCallback(() => {
    if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
    dragTimeoutRef.current = null;
    setIsDraggingOver(false);
  }, []);

  const resetDragTimeout = useCallback(() => {
    if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
    dragTimeoutRef.current = setTimeout(clearDragState, 150);
  }, [clearDragState]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingOver(true);
      resetDragTimeout();
    }
  }, [resetDragTimeout]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resetDragTimeout();
  }, [resetDragTimeout]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resetDragTimeout();
  }, [resetDragTimeout]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    clearDragState();
    if (e.dataTransfer.files?.length) {
      addFiles(Array.from(e.dataTransfer.files));
    }
  }, [addFiles, clearDragState]);

  const removeAttachment = (index: number) => {
    const att = attachments[index];
    att?.abortController?.abort();
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  // Inline preview for composer attachments, reusing the message viewer's
  // FilePreviewModal (so previewability and the open-in-new-tab safety gate are
  // handled there). Prefer the local File - no network - and fall back to the
  // uploaded blob (forwarded attachments, which carry only a blobId).
  const getPreviewAttachmentContent = useCallback(async () => {
    if (!previewAttachment) throw new Error('No attachment selected');
    if (previewAttachment.file) {
      return {
        blob: previewAttachment.file,
        contentType: previewAttachment.type || previewAttachment.file.type || 'application/octet-stream',
      };
    }
    if (composerClient && previewAttachment.blobId) {
      const blob = await composerClient.fetchBlob(previewAttachment.blobId, previewAttachment.name, previewAttachment.type);
      return { blob, contentType: previewAttachment.type || blob.type || 'application/octet-stream' };
    }
    throw new Error('No attachment content available');
  }, [previewAttachment, composerClient]);

  const handlePreviewAttachmentDownload = useCallback(async () => {
    if (!previewAttachment) return;
    if (previewAttachment.file) {
      const url = URL.createObjectURL(previewAttachment.file);
      const a = document.createElement('a');
      a.href = url;
      a.download = previewAttachment.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return;
    }
    if (composerClient && previewAttachment.blobId) {
      await composerClient.downloadBlob(previewAttachment.blobId, previewAttachment.name, previewAttachment.type);
    }
  }, [previewAttachment, composerClient]);

  // Auto-save draft functionality
  const saveDraftOnce = async (): Promise<string | null> => {
    if (!client || !composerClient) return null;

    const toAddresses = to.split(",").map(e => e.trim()).filter(Boolean);
    const ccAddresses = cc.split(",").map(e => e.trim()).filter(Boolean);
    const bccAddresses = bcc.split(",").map(e => e.trim()).filter(Boolean);

    if (!toAddresses.length && !subject && !(plainTextMode ? body.trim() : htmlToPlainText(body).trim())) {
      return null;
    }

    // Prepare attachments for draft
    const uploadedAttachments = attachments
      .filter(att => att.blobId && !att.uploading)
      .map(att => ({
        blobId: att.blobId!,
        name: att.name,
        type: att.type,
        size: att.size,
      }));

    // Create a hash of current data to compare with last saved
    const currentData = JSON.stringify({ to: toAddresses, cc: ccAddresses, bcc: bccAddresses, subject, body, attachments: uploadedAttachments, identityId: selectedIdentityId, subAddressTag });

    // Only save if data has changed
    if (currentData === lastSavedDataRef.current) {
      return draftIdRef.current;
    }

    setSaveStatus('saving');

    // Get the selected identity or primary identity
    // Generate sub-addressed email if tag is set
    const identityFromEmail = currentIdentity?.email
      ? subAddressTag
        ? generateSubAddress(currentIdentity.email, subAddressTag, subAddressDelimiter)
        : currentIdentity.email
      : undefined;
    const fromEmail = (fromOverrideEnabled && fromOverrideEmail.trim())
      ? fromOverrideEmail.trim()
      : identityFromEmail;
    const fromName = (fromOverrideEnabled && fromOverrideEmail.trim())
      ? (fromOverrideName.trim() || undefined)
      : (currentIdentity?.name || undefined);

    try {
      const previousDraftId = draftIdRef.current;
      // Use the JMAP client and raw identity id for the *owning* account
      // - falls back to active client for single-account / same-account
      // identities. See `composerClient` derivation above.
      const savedDraftId = await composerClient.createDraft(
        toAddresses,
        subject || t('no_subject'),
        plainTextMode ? body : htmlToPlainText(body),
        ccAddresses,
        bccAddresses,
        currentIdentityRawId,
        fromEmail,
        previousDraftId || undefined,
        uploadedAttachments,
        fromName,
        plainTextMode ? undefined : body
      );

      // Update the ref synchronously so a queued save sees the new id and
      // doesn't try to destroy the just-replaced draft.
      draftIdRef.current = savedDraftId;
      setDraftId(savedDraftId);
      lastSavedDataRef.current = currentData;
      setSaveStatus('saved');

      // Reset status after 2 seconds
      setTimeout(() => setSaveStatus('idle'), 2000);

      return savedDraftId;
    } catch (error) {
      console.error('Failed to save draft:', error);
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
      return null;
    }
  };

  // Serialize saves: each call waits for the previous in-flight save before
  // running. This prevents the autosave timer and the send button from
  // racing two `Email/set { destroy, create }` requests against the same
  // draftId, which left orphan drafts and (when EmailSubmission failed)
  // looked like "send didn't happen" (#303).
  const saveDraft = (): Promise<string | null> => {
    const previous = inflightSaveRef.current;
    const promise = (async (): Promise<string | null> => {
      if (previous) {
        try { await previous; } catch { /* prior failure already reported */ }
      }
      return saveDraftOnce();
    })();
    inflightSaveRef.current = promise;
    promise.finally(() => {
      if (inflightSaveRef.current === promise) {
        inflightSaveRef.current = null;
      }
    });
    return promise;
  };

  // Keep saveDraftRef pointing to latest saveDraft
  saveDraftRef.current = saveDraft;

  // Trigger auto-save when content changes (only if user modified something)
  useEffect(() => {
    // Clear existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Don't auto-save if nothing has changed from initial state
    if (!isDirtyRef.current) {
      return;
    }

    // Set new timeout for auto-save (2 seconds after last change)
    saveTimeoutRef.current = setTimeout(() => {
      // Clear the ref so handleSend can distinguish "save scheduled" from
      // "save in flight" - the former still needs flushing, the latter is
      // tracked via inflightSaveRef.
      saveTimeoutRef.current = null;
      // Plugin observers (AI assist, grammar, …) get a debounced snapshot here.
      emailHooks.onDraftChange.emit({
        to: to.split(',').map(s => s.trim()).filter(Boolean),
        cc: cc.split(',').map(s => s.trim()).filter(Boolean),
        bcc: bcc.split(',').map(s => s.trim()).filter(Boolean),
        subject,
        htmlBody: plainTextMode ? '' : body,
        textBody: plainTextMode ? body : htmlToPlainText(body),
        identityId: selectedIdentityId || '',
        attachments: attachments
          .filter(a => a.blobId && !a.uploading && !a.error)
          .map(a => ({ name: a.name, type: a.type || 'application/octet-stream', size: a.size })),
      });
      saveDraft();
    }, 2000);

    // Cleanup on unmount
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- saveDraft reads current state when called, not when effect is set up
  }, [to, cc, bcc, subject, body, attachments]);

  useEffect(() => {
    return () => {
      if (autocompleteTimeoutRef.current) {
        clearTimeout(autocompleteTimeoutRef.current);
      }
    };
  }, []);

  const toAddresses = to.split(",").map(e => e.trim()).filter(Boolean);
  const bodyPlainText = plainTextMode ? body.trim() : htmlToPlainText(body).trim();
  const hasContent = bodyPlainText || attachments.some(att => att.blobId && !att.uploading);
  const canSend = toAddresses.length > 0 && !!subject && hasContent;

  const getSendTooltip = (): string | undefined => {
    if (canSend) return undefined;
    if (toAddresses.length === 0) return t('validation.recipient_required');
    if (!subject) return t('validation.subject_required');
    if (!hasContent) return t('validation.body_required');
    return undefined;
  };

  const validateScheduleValue = (value: string): string | null => {
    if (!value) return t('schedule_send_required');
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return t('schedule_send_invalid');
    if (time <= Date.now()) return t('schedule_send_future');
    if (composerClient) {
      const maxDelayedSend = composerClient.getMaxDelayedSend();
      if (maxDelayedSend > 0 && time > Date.now() + maxDelayedSend * 1000) {
        return t('schedule_send_too_late');
      }
    }
    return null;
  };

  const resolveDelayedUntil = async (requestedDelayedUntil?: string): Promise<string | undefined> => {
    if (requestedDelayedUntil) return requestedDelayedUntil;
    if (sendDelaySeconds === 0) return undefined;
    if (composerClient?.hasDelayedSend()) {
      return new Date(Date.now() + sendDelaySeconds * 1000).toISOString();
    }
    const confirmed = window.confirm(t('send_delay_unsupported_confirm'));
    if (!confirmed) {
      throw new Error(t('send_delay_unsupported'));
    }
    return undefined;
  };

  // Rewrite data: URLs of dropped images (tagged with data-cid) into cid:
  // references so recipient clients that strip data URIs can still render them.
  const rewriteInlineImages = (html: string): {
    html: string;
    attachments: Array<{ blobId: string; name: string; type: string; size: number; disposition: 'inline'; cid: string }>;
  } => {
    const known = inlineImagesRef.current;
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const used = new Map<string, typeof known[number]>();

    if (known.length > 0) {
      doc.querySelectorAll('img[data-cid]').forEach((img) => {
        const cid = img.getAttribute('data-cid');
        if (!cid) return;
        const entry = known.find((e) => e.cid === cid);
        if (!entry) return;
        img.setAttribute('src', `cid:${cid}`);
        img.removeAttribute('data-cid');
        used.set(cid, entry);
      });
    }

    // Recipient mail clients apply default <p> margins inside table cells,
    // inflating row height. Tiptap wraps cell text in <p>, so force margin:0
    // to match the composer's tight rows.
    doc.querySelectorAll('td > p, th > p').forEach((p) => {
      const existing = p.getAttribute('style') || '';
      p.setAttribute('style', `margin:0;${existing}`);
    });

    return {
      html: doc.body.innerHTML,
      attachments: Array.from(used.values()).map((e) => ({
        blobId: e.blobId,
        name: e.name,
        type: e.type,
        size: e.size,
        disposition: 'inline' as const,
        cid: e.cid,
      })),
    };
  };

  const handleSend = async (skipAttachmentCheck = false, delayedUntil?: string) => {
    const ccAddresses = cc.split(",").map(e => e.trim()).filter(Boolean);
    const bccAddresses = bcc.split(",").map(e => e.trim()).filter(Boolean);

    if (!canSend) {
      const errors: { to?: boolean; subject?: boolean; body?: boolean } = {};
      if (toAddresses.length === 0) errors.to = true;
      if (!subject) errors.subject = true;
      if (!hasContent) errors.body = true;
      setValidationErrors(errors);

      if (errors.to) {
        setShakeField('to');
        setTimeout(() => setShakeField(null), 400);
        toInputRef.current?.focus();
      }
      return;
    }

    // Attachment reminder check
    if (!skipAttachmentCheck && attachmentReminderEnabled) {
      const hasAttachments = attachments.some(att => att.blobId && !att.uploading && !att.error);
      if (!hasAttachments) {
        const bodyText = htmlToPlainText(body);
        const searchText = `${subject} ${bodyText}`.toLowerCase();
        const matched = attachmentReminderKeywords.find(kw => searchText.includes(kw.toLowerCase()));
        if (matched) {
          setAttachmentWarningKeyword(matched);
          setAttachmentWarningDelayedUntil(delayedUntil);
          setShowAttachmentWarning(true);
          return;
        }
      }
    }

    // Resolve the freshest draftId we can. Two cases:
    //   1. An autosave is currently in flight - wait for it; don't issue a
    //      parallel destroy/create that would race with it on the same id.
    //   2. A debounced save is scheduled (timer set) - cancel it and flush
    //      now so the latest body content lands on the server.
    // Use draftIdRef (not the React state) because state updates from
    // the in-flight save may not have rendered yet when we read here.
    let finalDraftId = draftIdRef.current;
    if (inflightSaveRef.current) {
      try {
        const savedId = await inflightSaveRef.current;
        if (savedId) finalDraftId = savedId;
      } catch (err) {
        debug.error('In-flight draft save failed before send:', err);
      }
    }
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
      try {
        const savedId = await saveDraft();
        if (savedId) finalDraftId = savedId;
      } catch (err) {
        debug.error('Failed to save draft before send:', err);
      }
    }

    const identityFromEmail = currentIdentity?.email
      ? subAddressTag
        ? generateSubAddress(currentIdentity.email, subAddressTag, subAddressDelimiter)
        : currentIdentity.email
      : undefined;
    // When the user has typed a From override, that becomes the header From
    // (and MIME-builder From in the S/MIME path). The identity still drives
    // the SMTP envelope MAIL FROM - set explicitly so it doesn't mistakenly
    // default to the override address.
    const overrideActive = fromOverrideEnabled && fromOverrideEmail.trim().length > 0;
    const fromEmail = overrideActive ? fromOverrideEmail.trim() : identityFromEmail;
    const fromName = overrideActive
      ? (fromOverrideName.trim() || undefined)
      : (currentIdentity?.name || undefined);
    const envelopeMailFrom = overrideActive ? identityFromEmail : undefined;

    // Body is already HTML from the rich text editor (or plain text in plain text mode).
    // The signature is embedded into the body during init for compose mode
    // (when the initial identity had a signature) and for above-quote
    // replies/forwards - skip the trailing append in those cases so we don't
    // duplicate it.
    const signatureAlreadyInBody =
      shouldEmbedSignatureInNewMail ||
      ((mode === 'reply' || mode === 'replyAll' || mode === 'forward') &&
        signaturePosition === 'above_quote');

    // Build HTML signature block (used only in rich text mode)
    const buildSignatureHtml = (): string => {
      if (signatureAlreadyInBody) return '';
      const sep = signatureSeparatorEnabled ? `<br><br>-- <br>` : `<br><br>`;
      if (signatureIdentity?.htmlSignature) {
        return `${sep}${sanitizeSignatureHtml(signatureIdentity.htmlSignature)}`;
      }
      if (signatureIdentity?.textSignature) {
        return `${sep}${signatureIdentity.textSignature.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}`;
      }
      return '';
    };

    // RFC 5322 §3.6.4 threading - only continues the chain on a reply, not a forward.
    const threadingHeaders = (mode === 'reply' || mode === 'replyAll')
      ? computeReplyThreadingHeaders(replyTo)
      : null;

    // In plain text mode, send text/plain only (no HTML body)
    const signatureOpts = { separator: signatureSeparatorEnabled };
    const finalBody = plainTextMode
      ? (signatureAlreadyInBody ? body : appendPlainTextSignature(body, signatureIdentity, signatureOpts))
      : (signatureAlreadyInBody ? htmlToPlainText(body) : appendPlainTextSignature(htmlToPlainText(body), signatureIdentity, signatureOpts));

    const rewritten = plainTextMode ? null : rewriteInlineImages(body);
    const finalHtmlBody = plainTextMode
      ? undefined
      : `<div>${rewritten!.html}</div>${buildSignatureHtml()}`;
    const inlineAttachments = rewritten?.attachments ?? [];

    try {
      const effectiveDelayedUntil = await resolveDelayedUntil(delayedUntil);
      // Let plugins veto the send (external-mail warning, mistyped-domain
      // guards, etc.). Returning false from any handler aborts before either
      // the S/MIME or standard JMAP path runs.
      const sendablePreview: OutgoingEmail = {
        to: toAddresses,
        cc: ccAddresses,
        bcc: bccAddresses,
        subject,
        htmlBody: finalHtmlBody || '',
        textBody: finalBody,
        identityId: currentIdentity?.id || '',
        fromEmail,
        attachments: attachments
          .filter(att => att.blobId && !att.uploading && !att.error)
          .map(a => ({ name: a.name, type: a.type || 'application/octet-stream', size: a.size })),
        inReplyTo: threadingHeaders?.inReplyTo?.[0],
      };
      const sendAllowed = await emailHooks.onBeforeEmailSend.intercept(sendablePreview);
      if (!sendAllowed) return;

      // S/MIME send pipeline: build raw MIME → sign → encrypt → sendRawEmail
      if ((smimeSign_ || smimeEncrypt_) && client && currentIdentity?.id) {
        // S/MIME keys are scoped to one JMAP account's identity - sending
        // from a cross-account identity via S/MIME would mix accounts'
        // certs/clients. Refuse upfront and tell the user to switch.
        const crossAccount = stripCrossAccountIdentityPrefix(currentIdentity.id);
        if (crossAccount.localAccountId) {
          throw new Error('S/MIME sending from another account’s identity is not supported. Switch to that account first.');
        }
        // 1. Resolve S/MIME key
        if (smimeSign_ && !smimeKeyRecord) {
          throw new Error('No S/MIME key bound to this identity');
        }
        // S/MIME binds to the identity's key; sending from an override address
        // would produce a signature whose Subject differs from the visible
        // From, which most clients reject or flag. Refuse up front.
        if (overrideActive) {
          throw new Error('Cannot use From override with S/MIME - disable one to send.');
        }

        // 2. Ensure key is unlocked for signing
        if (smimeSign_ && smimeKeyRecord && !smimeStore.isKeyUnlocked(smimeKeyRecord.id)) {
          const passphrase = await new Promise<string>((resolve, reject) => {
            setSmimePassphrasePrompt({ keyId: smimeKeyRecord.id, resolve, reject });
          });
          try {
            await smimeStore.unlockKey(smimeKeyRecord.id, passphrase);
          } finally {
            setSmimePassphrasePrompt(null);
            setSmimePassphraseInput('');
            setSmimePassphraseError('');
          }
        }

        // 3. Resolve attachments as ArrayBuffers
        const mimeAttachments: MimeAttachment[] = [];
        for (const att of attachments) {
          if (att.error || att.uploading) continue;
          let content: ArrayBuffer;
          if (att.file && att.file.size > 0) {
            content = await att.file.arrayBuffer();
          } else if (att.blobId && client) {
            content = await client.fetchBlobArrayBuffer(att.blobId, att.name, att.type);
          } else {
            continue;
          }
          mimeAttachments.push({
            filename: att.name,
            contentType: att.type || 'application/octet-stream',
            content,
          });
        }
        for (const inline of inlineAttachments) {
          if (!client) break;
          const content = await client.fetchBlobArrayBuffer(inline.blobId, inline.name, inline.type);
          mimeAttachments.push({
            filename: inline.name,
            contentType: inline.type,
            content,
            cid: inline.cid,
          });
        }

        // 4. Build canonical MIME
        // mime-builder takes inReplyTo as a single ref-form msg-id (with brackets);
        // references stays an array. threadingHeaders contains bare msg-ids.
        const mimeInReplyTo = threadingHeaders?.inReplyTo[0]
          ? `<${threadingHeaders.inReplyTo[0]}>`
          : undefined;
        const mimeReferences = threadingHeaders?.references.length
          ? threadingHeaders.references.map(id => `<${id}>`)
          : undefined;
        const mimeBytes = buildMimeMessage({
          from: { name: currentIdentity.name || undefined, email: fromEmail || currentIdentity.email },
          to: toAddresses.map(parseRecipient),
          cc: ccAddresses.length > 0 ? ccAddresses.map(parseRecipient) : undefined,
          bcc: bccAddresses.length > 0 ? bccAddresses.map(parseRecipient) : undefined,
          subject,
          inReplyTo: mimeInReplyTo,
          references: mimeReferences,
          textBody: finalBody,
          htmlBody: finalHtmlBody,
          attachments: mimeAttachments.length > 0 ? mimeAttachments : undefined,
        });

        let payload: Blob = new Blob([mimeBytes.buffer as ArrayBuffer], { type: 'message/rfc822' });

        const smimeHeaders = {
          from: { name: currentIdentity.name || undefined, email: fromEmail || currentIdentity.email },
          to: toAddresses.map(parseRecipient),
          cc: ccAddresses.length > 0 ? ccAddresses.map(parseRecipient) : undefined,
          subject,
          inReplyTo: mimeInReplyTo,
          references: mimeReferences,
        };

        // 5. Sign if enabled
        if (smimeSign_ && smimeKeyRecord) {
          const privateKey = smimeStore.getUnlockedKey(smimeKeyRecord.id);
          if (!privateKey) throw new Error('S/MIME key is not unlocked');
          const cmsBlob = await smimeSign(
            mimeBytes,
            privateKey,
            smimeKeyRecord.certificate,
            smimeKeyRecord.certificateChain || [],
          );
          const cmsBytes = new Uint8Array(await cmsBlob.arrayBuffer());
          payload = wrapCmsAsSmimeMessage(cmsBytes, { ...smimeHeaders, smimeType: 'signed-data' });
        }

        // 6. Encrypt if enabled
        if (smimeEncrypt_ && smimeKeyRecord) {
          const allRecipients = [...toAddresses, ...ccAddresses, ...bccAddresses].map(s => parseRecipient(s).email);
          const { found, missing } = smimeStore.getRecipientCerts(allRecipients);
          if (missing.length > 0) {
            throw new Error(`Missing certificates for: ${missing.join(', ')}`);
          }
          const recipientCertsDer = found.map(c => c.certificate instanceof ArrayBuffer ? c.certificate : new Uint8Array(c.certificate as ArrayBuffer).buffer);
          const payloadBytes = new Uint8Array(await payload.arrayBuffer());
          const cmsBlob = await smimeEncrypt(
            payloadBytes,
            recipientCertsDer,
            smimeKeyRecord.certificate,
          );
          const cmsBytes = new Uint8Array(await cmsBlob.arrayBuffer());
          payload = wrapCmsAsSmimeMessage(cmsBytes, { ...smimeHeaders, smimeType: 'enveloped-data' });
        }

        // 7. Send via raw email path
        const result = await sendRawEmail(client, payload, currentIdentity.id, effectiveDelayedUntil, [...toAddresses, ...ccAddresses, ...bccAddresses].map(s => parseRecipient(s).email));
        if (effectiveDelayedUntil && finalDraftId) {
          client.deleteEmail(finalDraftId).catch(err => {
            debug.warn('email', 'Scheduled S/MIME send created, but plaintext draft cleanup failed:', err);
            toast.warning(t('schedule_send_cleanup_warning'));
          });
        }
        if (result.scheduled) {
          await onScheduledSendCreated?.();
        }
      } else {
        // Standard JMAP send path
        // Collect uploaded attachment blobIds for the send request
        const uploadedAttachments: Array<{ blobId: string; name: string; type: string; size: number; disposition?: 'attachment' | 'inline'; cid?: string }> = attachments
          .filter(att => att.blobId && !att.uploading && !att.error)
          .map(att => ({ blobId: att.blobId!, name: att.name, type: att.type || 'application/octet-stream', size: att.size }));
        uploadedAttachments.push(...inlineAttachments);

        // Let plugins (signatures, link-rewriting, encryption, AI rewrite, …)
        // transform the outgoing message immediately before submission.
        const transformInput: OutgoingEmail = {
          to: toAddresses,
          cc: ccAddresses,
          bcc: bccAddresses,
          subject,
          htmlBody: finalHtmlBody || '',
          textBody: finalBody,
          identityId: currentIdentity?.id || '',
          fromEmail,
          attachments: uploadedAttachments.map(a => ({ name: a.name, type: a.type, size: a.size })),
          inReplyTo: threadingHeaders?.inReplyTo?.[0],
        };
        const outgoing = await emailHooks.onTransformOutgoingEmail.transform(transformInput);

        // Strip the cross-account namespace from the identity id before
        // handing it to the parent - the JMAP server only knows the raw
        // id. The owning local account travels alongside so the parent
        // can route the send through the right client.
        const rawIdentityId = outgoing.identityId || currentIdentity?.id;
        const { localAccountId: identityLocalAccountId, rawId } = rawIdentityId
          ? stripCrossAccountIdentityPrefix(rawIdentityId)
          : { localAccountId: null, rawId: undefined };

        await onSend?.({
          to: outgoing.to,
          cc: outgoing.cc,
          bcc: outgoing.bcc,
          subject: outgoing.subject,
          body: outgoing.textBody,
          htmlBody: outgoing.htmlBody || undefined,
          draftId: finalDraftId || undefined,
          fromEmail,
          fromName,
          identityId: rawId,
          envelopeMailFrom,
          localAccountId: identityLocalAccountId ?? undefined,
          attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
          inReplyTo: threadingHeaders?.inReplyTo,
          references: threadingHeaders?.references,
          requestReadReceipt,
          delayedUntil: effectiveDelayedUntil,
        });

        if (mode === 'reply' || mode === 'replyAll') {
          for (const recipient of [...outgoing.to, ...outgoing.cc].filter(Boolean)) {
            if (trustedSendersAddressBook && client) {
              addToTrustedSendersBook(client, recipient).catch(err => {
                debug.error('Failed to add trusted sender to address book:', err);
              });
            } else {
              addTrustedSender(recipient);
            }
          }
        }
      }

      setTo("");
      setCc("");
      setBcc("");
      setSubject("");
      setBody("");
      draftIdRef.current = null;
      setDraftId(null);
      setSubAddressTag("");
      setValidationErrors({});
      setShowScheduleDialog(false);
      setScheduleValue('');
      setScheduleError('');
      // Clear ref so unmount effect doesn't re-save
      stateRef.current = { to: '', cc: '', bcc: '', subject: '', body: '', showCc: false, showBcc: false, selectedIdentityId: null, subAddressTag: '', draftId: null, fromOverrideEnabled: false, fromOverrideEmail: '', fromOverrideName: '' };
    } catch (err) {
      debug.error('Failed to send email:', err);
      toast.error(err instanceof Error ? err.message : t('send_failed'));
    }
  };

  const handleScheduleSend = () => {
    if (!composerClient?.hasDelayedSend()) {
      setScheduleError(t('schedule_send_unsupported'));
      return;
    }
    const error = validateScheduleValue(scheduleValue);
    if (error) {
      setScheduleError(error);
      return;
    }
    handleSend(false, new Date(scheduleValue).toISOString());
  };

  // Ctrl+Enter (Win/Linux) / Cmd+Enter (macOS) sends the open compose
  // draft. Scoped to events whose target lives inside this composer's
  // DOM tree — in Pro mode multiple composer tabs can be mounted at
  // once (inactive tabs are CSS-hidden, not unmounted), so a window
  // listener would otherwise fire every mounted composer's handleSend
  // on a single keystroke. handleSend is rebound every render, so we
  // route through a ref to keep the listener stable.
  const composerRootRef = useRef<HTMLDivElement | null>(null);
  const handleSendRef = useRef<((skipAttachmentCheck?: boolean) => Promise<void>) | undefined>(undefined);
  handleSendRef.current = handleSend;
  useEffect(() => {
    const handleSendShortcut = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.altKey || e.shiftKey) return;
      const root = composerRootRef.current;
      if (!root || !(e.target instanceof Node) || !root.contains(e.target)) return;
      e.preventDefault();
      void handleSendRef.current?.();
    };
    window.addEventListener('keydown', handleSendShortcut);
    return () => window.removeEventListener('keydown', handleSendShortcut);
  }, []);

  const cleanClose = () => {
    explicitCloseRef.current = true;
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    stateRef.current = { to: '', cc: '', bcc: '', subject: '', body: '', showCc: false, showBcc: false, selectedIdentityId: null, subAddressTag: '', draftId: null, fromOverrideEnabled: false, fromOverrideEmail: '', fromOverrideName: '' };
    onClose?.();
  };

  const handleSaveDraftAndClose = async () => {
    explicitCloseRef.current = true;
    setShowCloseDialog(false);
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    await saveDraft();
    stateRef.current = { to: '', cc: '', bcc: '', subject: '', body: '', showCc: false, showBcc: false, selectedIdentityId: null, subAddressTag: '', draftId: null, fromOverrideEnabled: false, fromOverrideEmail: '', fromOverrideName: '' };
    onClose?.();
  };

  const handleDiscardAndClose = () => {
    explicitCloseRef.current = true;
    setShowCloseDialog(false);
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    if (draftId && onDiscardDraft) {
      onDiscardDraft(draftId);
    }
    stateRef.current = { to: '', cc: '', bcc: '', subject: '', body: '', showCc: false, showBcc: false, selectedIdentityId: null, subAddressTag: '', draftId: null, fromOverrideEnabled: false, fromOverrideEmail: '', fromOverrideName: '' };
    onClose?.();
  };

  const handleClose = () => {
    if (isDirtyRef.current) {
      setShowCloseDialog(true);
    } else {
      cleanClose();
    }
  };

  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;

    const isPlainEscape = e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    const hasPrimaryModifier = e.ctrlKey || e.metaKey;
    const isSendShortcut = e.key === 'Enter' && hasPrimaryModifier && !e.altKey && !e.shiftKey;
    const isScheduleShortcut = e.key === 'Enter' && hasPrimaryModifier && !e.altKey && e.shiftKey;
    if (!isPlainEscape && !isSendShortcut && !isScheduleShortcut) return;

    if (
      showTemplatePicker ||
      showSaveAsTemplate ||
      showScheduleDialog ||
      smimePassphrasePrompt ||
      showAttachmentWarning ||
      showCloseDialog
    ) return;

    if (isPlainEscape) {
      if (activeAutoField) return;
      e.preventDefault();
      handleClose();
      return;
    }

    if (isSendShortcut) {
      if (e.repeat) {
        e.preventDefault();
        return;
      }

      e.preventDefault();
      handleSend();
      return;
    }

    if (isScheduleShortcut) {
      e.preventDefault();
      if (!e.repeat && composerClient?.hasDelayedSend()) openScheduleDialog();
    }
  };

  return (
    <div ref={composerRootRef} className={cn("flex h-full bg-background", className)}>
      <PluginSlot
        name="composer-sidebar"
        className="hidden md:flex shrink-0 h-full overflow-hidden border-r border-border"
      />
      {/* Right-side composer sidebar slot is rendered after the main content div below. */}
    <div
      className="flex flex-col h-full bg-background relative flex-1 min-w-0"
      data-tour="composer"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onKeyDown={handleComposerKeyDown}
    >
      {/* Drag overlay */}
      {isDraggingOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 border-2 border-dashed border-primary rounded-lg pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Paperclip className="w-8 h-8" />
            <span className="text-sm font-medium">{t('drop_files')}</span>
          </div>
        </div>
      )}
      {/* Header - mobile: clean bar with close/send, desktop: title bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-background">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={handleClose} className="h-9 w-9 md:h-8 md:w-8">
            <X className="w-5 h-5 md:w-4 md:h-4" />
          </Button>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-base">{t('new_message')}</h3>
            {saveStatus === 'saving' && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Save className="w-3 h-3 animate-pulse" />
                <span className="hidden md:inline">{t('saving')}</span>
              </div>
            )}
            {saveStatus === 'saved' && (
              <div className="flex items-center gap-1 text-xs text-green-600">
                <Check className="w-3 h-3" />
                <span className="hidden md:inline">{t('draft_saved')}</span>
              </div>
            )}
            {saveStatus === 'error' && (
              <div className="flex items-center gap-1 text-xs text-red-600">
                <X className="w-3 h-3" />
                <span className="hidden md:inline">{t('save_failed')}</span>
              </div>
            )}
          </div>
        </div>
        {/* Mobile: send button in header */}
        <Button
          onClick={() => handleSend()}
          disabled={!canSend}
          title={getSendTooltip()}
          size="sm"
          className="md:hidden h-9 px-4"
        >
          <Send className="w-4 h-4 mr-1.5" />
          {t('send')}
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {/* Fields section */}
        <div className="space-y-0 border-b">
          {/* From field */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50">
            <span className="text-sm text-muted-foreground w-12 md:w-16 shrink-0">{t('from')}:</span>
            <div className="flex-1 flex items-center gap-1 min-w-0">
              {fromOverrideEnabled ? (
                <div className="flex-1 flex items-center gap-1 min-w-0">
                  <Input
                    value={fromOverrideName}
                    onChange={(e) => setFromOverrideName(e.target.value)}
                    placeholder={t('from_override.name_placeholder')}
                    className="h-7 text-sm w-32 md:w-40 shrink-0"
                    aria-label={t('from_override.name_label')}
                  />
                  <Input
                    value={fromOverrideEmail}
                    onChange={(e) => setFromOverrideEmail(e.target.value)}
                    placeholder={t('from_override.email_placeholder')}
                    type="email"
                    className="h-7 text-sm flex-1 min-w-0 font-mono"
                    aria-label={t('from_override.email_label')}
                  />
                </div>
              ) : identities.length > 1 ? (
                <select
                  value={selectedIdentityId || primaryIdentity?.id || ''}
                  onChange={(e) => setSelectedIdentityId(e.target.value)}
                  className="flex-1 bg-transparent text-sm text-foreground outline-none cursor-pointer hover:text-muted-foreground transition-colors min-w-0 truncate"
                >
                  {identityGroups.length > 0
                    ? identityGroups.map((group) => (
                        <optgroup key={group.localAccountId} label={group.accountLabel}>
                          {group.identities.map((identity) => {
                            const displayEmail = subAddressTag
                              ? generateSubAddress(identity.email, subAddressTag, subAddressDelimiter)
                              : identity.email;
                            return (
                              <option key={identity.id} value={identity.id}>
                                {identity.name ? `${identity.name} <${displayEmail}>` : displayEmail}
                              </option>
                            );
                          })}
                        </optgroup>
                      ))
                    : identities.map((identity) => {
                        const displayEmail = subAddressTag
                          ? generateSubAddress(identity.email, subAddressTag, subAddressDelimiter)
                          : identity.email;
                        return (
                          <option key={identity.id} value={identity.id}>
                            {identity.name ? `${identity.name} <${displayEmail}>` : displayEmail}
                          </option>
                        );
                      })}
                </select>
              ) : (
                <span className="text-sm text-foreground flex-1 truncate">
                  {subAddressTag ? (
                    <span className="font-mono">
                      {generateSubAddress(primaryIdentity?.email || '', subAddressTag, subAddressDelimiter)}
                    </span>
                  ) : (
                    <>
                      {primaryIdentity?.name
                        ? `${primaryIdentity.name} <${primaryIdentity.email}>`
                        : primaryIdentity?.email || ''}
                    </>
                  )}
                </span>
              )}
              {!fromOverrideEnabled && (
                <SubAddressHelper
                  baseEmail={
                    (selectedIdentityId
                      ? identities.find(id => id.id === selectedIdentityId)?.email
                      : primaryIdentity?.email) || ''
                  }
                  recipientEmails={to.split(',').map(e => e.trim()).filter(Boolean)}
                  onSelectTag={setSubAddressTag}
                />
              )}
              {!fromOverrideEnabled && subAddressTag && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSubAddressTag('')}
                  className="h-6 px-2 text-xs"
                  title={t('remove_sub_address')}
                >
                  <X className="w-3 h-3" />
                </Button>
              )}
              <Button
                type="button"
                variant={fromOverrideEnabled ? 'outline' : 'ghost'}
                size="sm"
                onClick={() => {
                  if (fromOverrideEnabled) {
                    setFromOverrideEnabled(false);
                  } else {
                    setFromOverrideEnabled(true);
                    if (!fromOverrideEmail && currentIdentity?.email) {
                      setFromOverrideEmail(currentIdentity.email);
                    }
                    if (!fromOverrideName && currentIdentity?.name) {
                      setFromOverrideName(currentIdentity.name);
                    }
                  }
                }}
                className="h-6 px-2 text-xs shrink-0"
                title={t('from_override.toggle_tooltip')}
              >
                {fromOverrideEnabled ? t('from_override.toggle_on') : t('from_override.toggle_off')}
              </Button>
            </div>
          </div>

          {/* To field */}
          <div className={cn("flex items-center gap-2 px-4 py-2.5 border-b border-border/50 relative", shakeField === 'to' && "animate-shake")}>
            <span className="text-sm text-muted-foreground w-12 md:w-16 shrink-0">{t('to')}:</span>
            <RecipientChipInput
              value={to}
              onChange={(v) => {
                setTo(v);
                if (validationErrors.to) setValidationErrors(prev => ({ ...prev, to: false }));
              }}
              inputRef={toInputRef}
              placeholder={t('to_placeholder')}
              field="to"
              onAutocomplete={handleAutocomplete}
              onAutoKeyDown={handleAutoKeyDown}
              onAutoBlur={handleAutoBlur}
              activeAutoField={activeAutoField}
              autocompleteResults={autocompleteResults}
              autoSelectedIndex={autoSelectedIndex}
              dropdownRef={toDropdownRef}
              onInsertAutocomplete={insertAutocomplete}
              validationError={validationErrors.to}
              validationMessage={t('validation.recipient_required')}
              onTab={focusSubject}
              onMoveChip={handleMoveChip}
            />
            <div className="flex gap-0.5 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowCc(!showCc)}
                className={cn("text-xs h-7 px-2", isDraggingChipOverCc && "ring-2 ring-primary/50")}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes('application/x-recipient-chip')) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setIsDraggingChipOverCc(true);
                }}
                onDragLeave={() => setIsDraggingChipOverCc(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDraggingChipOverCc(false);
                  const raw = e.dataTransfer.getData('application/x-recipient-chip');
                  if (!raw) return;
                  const { chip, fromField } = JSON.parse(raw) as { chip: string; fromField: 'to' | 'cc' | 'bcc' };
                  if (fromField !== 'cc') handleMoveChip(chip, fromField, 'cc');
                  setShowCc(true);
                }}
              >
                Cc
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowBcc(!showBcc)}
                className={cn("text-xs h-7 px-2", isDraggingChipOverBcc && "ring-2 ring-primary/50")}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes('application/x-recipient-chip')) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setIsDraggingChipOverBcc(true);
                }}
                onDragLeave={() => setIsDraggingChipOverBcc(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDraggingChipOverBcc(false);
                  const raw = e.dataTransfer.getData('application/x-recipient-chip');
                  if (!raw) return;
                  const { chip, fromField } = JSON.parse(raw) as { chip: string; fromField: 'to' | 'cc' | 'bcc' };
                  if (fromField !== 'bcc') handleMoveChip(chip, fromField, 'bcc');
                  setShowBcc(true);
                }}
              >
                Bcc
              </Button>
            </div>
          </div>

          {/* Cc field */}
          {showCc && (
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 relative">
              <span className="text-sm text-muted-foreground w-12 md:w-16 shrink-0">{t('cc_label')}</span>
              <RecipientChipInput
                value={cc}
                onChange={setCc}
                inputRef={ccInputRef}
                placeholder={t('cc_placeholder')}
                field="cc"
                onAutocomplete={handleAutocomplete}
                onAutoKeyDown={handleAutoKeyDown}
                onAutoBlur={handleAutoBlur}
                activeAutoField={activeAutoField}
                autocompleteResults={autocompleteResults}
                autoSelectedIndex={autoSelectedIndex}
                dropdownRef={ccDropdownRef}
                onInsertAutocomplete={insertAutocomplete}
                onMoveChip={handleMoveChip}
              />
            </div>
          )}

          {/* Bcc field */}
          {showBcc && (
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 relative">
              <span className="text-sm text-muted-foreground w-12 md:w-16 shrink-0">{t('bcc_label')}</span>
              <RecipientChipInput
                value={bcc}
                onChange={setBcc}
                inputRef={bccInputRef}
                placeholder={t('bcc_placeholder')}
                field="bcc"
                onAutocomplete={handleAutocomplete}
                onAutoKeyDown={handleAutoKeyDown}
                onAutoBlur={handleAutoBlur}
                activeAutoField={activeAutoField}
                autocompleteResults={autocompleteResults}
                autoSelectedIndex={autoSelectedIndex}
                dropdownRef={bccDropdownRef}
                onInsertAutocomplete={insertAutocomplete}
                onMoveChip={handleMoveChip}
              />
            </div>
          )}

          {/* Subject field */}
          <div className="flex items-center gap-2 px-4 py-2.5">
            <span className="text-sm text-muted-foreground w-12 md:w-16 shrink-0">{t('subject_label')}</span>
            <Input
              ref={subjectInputRef}
              type="text"
              placeholder={t('subject_placeholder')}
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                if (validationErrors.subject) setValidationErrors(prev => ({ ...prev, subject: false }));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Tab' && !e.shiftKey) {
                  e.preventDefault();
                  focusBody();
                }
              }}
              className={cn(
                "flex-1 border-0 focus-visible:ring-0 h-8 px-0 text-sm",
                validationErrors.subject && "ring-2 ring-red-500 dark:ring-red-400"
              )}
              aria-invalid={validationErrors.subject || undefined}
            />
          </div>
        </div>

        {/* Body */}
        {plainTextMode ? (
          <textarea
            ref={bodyRef}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              if (validationErrors.body) setValidationErrors(prev => ({ ...prev, body: false }));
            }}
            placeholder={t('body_placeholder')}
            className={cn(
              "w-full min-h-[300px] px-4 py-3 text-sm text-foreground bg-transparent resize-y focus:outline-none font-mono",
              validationErrors.body && "ring-2 ring-red-500 dark:ring-red-400 rounded"
            )}
            style={{ height: 'calc(100vh - 350px)' }}
            aria-invalid={validationErrors.body || undefined}
          />
        ) : (
          <div ref={editorContainerRef}>
            <RichTextEditor
              content={body}
              onChange={(html) => {
                setBody(html);
                if (validationErrors.body) setValidationErrors(prev => ({ ...prev, body: false }));
              }}
              onImageUpload={handleImageUpload}
              placeholder={t('body_placeholder')}
              hasError={validationErrors.body}
              onEditorReady={(ed) => { editorRef.current = ed; }}
            />
          </div>
        )}

        {/* Hide the visual signature preview when the signature has already been
            embedded into the body (compose, or above-quote replies). */}
        {(shouldEmbedSignatureInNewMail
          || ((mode === 'reply' || mode === 'replyAll' || mode === 'forward') && signaturePosition === 'above_quote')) ? null
          : plainTextMode ? (
          getPlainTextSignature(signatureIdentity) ? (
            <div className="px-4 pb-3 text-sm leading-6 text-muted-foreground break-words whitespace-pre-wrap font-mono">
              {signatureSeparatorEnabled ? '-- \n' : ''}{getPlainTextSignature(signatureIdentity)}
            </div>
          ) : null
        ) : composerSignatureHtml ? (
          <div
            className="px-4 pb-3 text-sm leading-6 text-foreground break-words [&_a]:text-primary [&_a]:underline-offset-2 [&_a:hover]:underline"
            dangerouslySetInnerHTML={{ __html: `${signatureSeparatorEnabled ? '<div>-- </div>' : ''}${composerSignatureHtml}` }}
          />
        ) : null}
      </div>

        {/* Attachments */}
        {attachments.length > 0 && (
          <div className="px-4 py-2 border-t shrink-0">
            <div className="flex flex-wrap gap-2">
              {(showAllAttachments ? attachments : attachments.slice(0, 3)).map((att, index) => {
                // Clickable to preview only once it has content (local File or an
                // uploaded blob) and the type is previewable; never mid-upload.
                const canPreview = !att.uploading && !att.error
                  && (!!att.file || !!att.blobId)
                  && isFilePreviewable(att.name, att.type);
                const label = (
                  <>
                    <span className="max-w-[150px] md:max-w-[200px] truncate">{att.name}</span>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      ({formatFileSize(att.size)})
                    </span>
                  </>
                );
                return (
                <div
                  key={index}
                  className={cn(
                    "relative flex items-center gap-2 px-3 py-1.5 rounded-md text-sm overflow-hidden",
                    att.error ? "bg-red-500/10 text-red-600 dark:text-red-400" : "bg-muted text-foreground"
                  )}
                >
                  {att.uploading && (
                    <div className="absolute inset-0 pointer-events-none">
                      <div className="h-full bg-primary/10 animate-pulse" />
                      <div className="absolute bottom-0 left-0 h-0.5 bg-primary/40 animate-[indeterminate_1.5s_ease-in-out_infinite]" style={{ width: '40%' }} />
                    </div>
                  )}
                  <div className="relative flex items-center gap-2">
                    {att.uploading ? (
                      <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
                    ) : att.error ? (
                      <AlertCircle className="w-3 h-3 flex-shrink-0" />
                    ) : (
                      <Paperclip className="w-3 h-3 flex-shrink-0" />
                    )}
                    {canPreview ? (
                      <button
                        type="button"
                        onClick={() => setPreviewAttachment(att)}
                        title={att.name}
                        className="flex items-center gap-2 min-w-0 hover:underline"
                      >
                        {label}
                      </button>
                    ) : (
                      <div className="flex items-center gap-2 min-w-0">{label}</div>
                    )}
                    <button
                      onClick={() => removeAttachment(index)}
                      className="ml-1 hover:text-red-500 min-w-[20px] min-h-[20px] flex items-center justify-center"
                      title={att.uploading ? t('upload_cancel') : undefined}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                );
              })}
              {attachments.length > 3 && (
                <button
                  onClick={() => setShowAllAttachments(prev => !prev)}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-md text-sm bg-muted text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showAllAttachments ? t('show_less') : `+${attachments.length - 3}`}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Bottom toolbar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t bg-background shrink-0 pb-[calc(0.625rem+env(safe-area-inset-bottom)/2)]">
          {/* Left side actions */}
          <div className="flex items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
              accept="*/*"
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              className="h-9 w-9"
              title={t('attach')}
            >
              <Paperclip className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowTemplatePicker(true)}
              title={t('use_template')}
              className="h-9 w-9"
            >
              <FileText className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowSaveAsTemplate(true)}
              title={t('save_as_template')}
              className="h-9 w-9"
            >
              <BookmarkPlus className="w-4 h-4" />
            </Button>
            {/* S/MIME toggles */}
            {canSmimeSign && (
              <>
                <div className="w-px h-5 bg-border mx-1" />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setSmimeSign(v => !v)}
                  className={cn("h-9 w-9", smimeSign_ && "bg-primary/10 text-primary")}
                  title={smimeSign_ ? t('smime_sign_on') : t('smime_sign_off')}
                >
                  <ShieldCheck className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setSmimeEncrypt(v => !v)}
                  disabled={!canSmimeEncrypt}
                  className={cn("h-9 w-9", smimeEncrypt_ && "bg-primary/10 text-primary")}
                  title={smimeEncrypt_ ? t('smime_encrypt_on') : canSmimeEncrypt ? t('smime_encrypt_off') : t('smime_encrypt_unavailable')}
                >
                  <Lock className="w-4 h-4" />
                </Button>
              </>
            )}

            {/* Read-receipt request toggle */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setRequestReadReceipt(v => !v)}
              className={cn(
                "h-9 w-9",
                requestReadReceipt && "bg-green-600 text-white hover:bg-green-600 hover:text-white dark:bg-green-600 dark:hover:bg-green-600"
              )}
              title={requestReadReceipt ? t('read_receipt_on') : t('read_receipt_off')}
              aria-pressed={requestReadReceipt}
            >
              <MailCheck className="w-4 h-4" />
            </Button>
            <PluginSlot name="composer-toolbar" />
          </div>

          {/* Right side - Discard + Send (desktop) */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="text-sm text-muted-foreground hover:text-red-500 transition-colors px-2 py-1"
            >
              {t('discard')}
            </button>
            {composerClient?.hasDelayedSend() ? (
              <div ref={sendMenuRef} className="relative hidden md:inline-flex">
                <Button
                  onClick={() => handleSend()}
                  disabled={!canSend}
                  title={getSendTooltip()}
                  className="rounded-r-none border-r border-primary-foreground/20"
                >
                  <Send className="w-4 h-4 mr-2" />
                  {t('send')}
                </Button>
                <Button
                  type="button"
                  onClick={() => setShowSendMenu((open) => !open)}
                  disabled={!canSend}
                  title={t('schedule_send')}
                  className="rounded-l-none px-2"
                  aria-haspopup="menu"
                  aria-expanded={showSendMenu}
                >
                  <ChevronDown className="w-4 h-4" />
                </Button>
                {showSendMenu && (
                  <div
                    role="menu"
                    className="absolute right-0 bottom-full z-50 mb-2 min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={openScheduleDialog}
                      className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                    >
                      <CalendarClock className="w-4 h-4" />
                      {t('schedule_send')}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <Button
                onClick={() => handleSend()}
                disabled={!canSend}
                title={getSendTooltip()}
                className="hidden md:inline-flex"
              >
                <Send className="w-4 h-4 mr-2" />
                {t('send')}
              </Button>
            )}
          </div>
        </div>

      {showTemplatePicker && (
        <TemplatePicker
          isOpen={showTemplatePicker}
          onClose={() => setShowTemplatePicker(false)}
          onSelect={handleTemplateSelect}
        />
      )}

      {showSaveAsTemplate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 animate-in fade-in duration-150">
          <div
            ref={saveTemplateModalRef}
            role="dialog"
            aria-modal="true"
            className="bg-background border border-border rounded-lg shadow-xl w-full max-w-lg p-6 animate-in zoom-in-95 duration-200"
          >
            <h3 className="text-lg font-semibold text-foreground mb-4">{t('save_as_template')}</h3>
            <TemplateForm
              initialData={{
                subject,
                body,
                to: to.split(',').map(s => s.trim()).filter(Boolean),
                cc: cc.split(',').map(s => s.trim()).filter(Boolean),
                bcc: bcc.split(',').map(s => s.trim()).filter(Boolean),
              }}
              onSave={(data) => {
                addTemplate(data);
                setShowSaveAsTemplate(false);
              }}
              onCancel={() => setShowSaveAsTemplate(false)}
            />
          </div>
        </div>
      )}

      {showScheduleDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 animate-in fade-in duration-150">
          <div className="bg-background border border-border rounded-lg shadow-xl w-full max-w-md p-6 animate-in zoom-in-95 duration-200">
            <h3 className="text-lg font-semibold text-foreground mb-2">{t('schedule_send')}</h3>
            <p className="text-sm text-muted-foreground mb-4">{t('schedule_send_description')}</p>
            <Input
              type="datetime-local"
              value={scheduleValue}
              onChange={(e) => {
                setScheduleValue(e.target.value);
                setScheduleError('');
              }}
              className={cn(scheduleError && "border-destructive focus-visible:ring-destructive")}
            />
            {scheduleError && <p className="mt-2 text-sm text-destructive">{scheduleError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowScheduleDialog(false)}>{tCommon('cancel')}</Button>
              <Button onClick={handleScheduleSend} disabled={!canSend}>{t('schedule_send')}</Button>
            </div>
          </div>
        </div>
      )}

      {/* S/MIME passphrase prompt */}
      {smimePassphrasePrompt && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-[1px] flex items-center justify-center z-[60] p-4 animate-in fade-in duration-150"
        >
          <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className="bg-background border border-border rounded-lg shadow-xl w-full max-w-sm animate-in zoom-in-95 duration-200"
          >
            <div className="p-6">
              <h2 className="text-lg font-semibold text-foreground">{t('smime_unlock_title')}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{t('smime_unlock_message')}</p>
              <input
                type="password"
                autoFocus
                value={smimePassphraseInput}
                onChange={(e) => {
                  setSmimePassphraseInput(e.target.value);
                  setSmimePassphraseError('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && smimePassphraseInput) {
                    smimePassphrasePrompt.resolve(smimePassphraseInput);
                  }
                }}
                placeholder={t('smime_passphrase_placeholder')}
                className="mt-3 w-full px-3 py-2 border border-border rounded-md text-sm bg-background text-foreground outline-none focus:ring-2 focus:ring-primary"
              />
              {smimePassphraseError && (
                <p className="mt-1 text-xs text-red-500">{smimePassphraseError}</p>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 px-6 pb-6">
              <Button variant="outline" onClick={() => {
                smimePassphrasePrompt.reject();
                setSmimePassphrasePrompt(null);
                setSmimePassphraseInput('');
                setSmimePassphraseError('');
              }}>
                {t('cancel')}
              </Button>
              <Button
                disabled={!smimePassphraseInput}
                onClick={() => smimePassphrasePrompt.resolve(smimePassphraseInput)}
              >
                {t('smime_unlock_button')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showAttachmentWarning && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-[1px] flex items-center justify-center z-[60] p-4 animate-in fade-in duration-150"
          onClick={() => setShowAttachmentWarning(false)}
        >
          <div
            ref={attachmentWarningRef}
            role="alertdialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className="bg-background border border-border rounded-lg shadow-xl w-full max-w-md animate-in zoom-in-95 duration-200"
          >
            <div className="p-6">
              <h2 className="text-lg font-semibold text-foreground">{t('forgot_attachment.title')}</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {t('forgot_attachment.message', { keyword: attachmentWarningKeyword })}
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 pb-6">
              <Button variant="outline" onClick={() => setShowAttachmentWarning(false)}>
                {t('forgot_attachment.back')}
              </Button>
              <Button onClick={() => { setShowAttachmentWarning(false); handleSend(true, attachmentWarningDelayedUntil); setAttachmentWarningDelayedUntil(undefined); }}>
                {t('forgot_attachment.send_anyway')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showCloseDialog && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-[1px] flex items-center justify-center z-[60] p-4 animate-in fade-in duration-150"
          onClick={() => setShowCloseDialog(false)}
        >
          <div
            ref={closeDialogRef}
            role="alertdialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            className="bg-background border border-border rounded-lg shadow-xl w-full max-w-md animate-in zoom-in-95 duration-200"
          >
            <div className="p-6">
              <h2 className="text-lg font-semibold text-foreground">{t('close_draft_title')}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{t('close_draft_message')}</p>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 pb-6">
              <Button variant="outline" onClick={() => setShowCloseDialog(false)}>
                {t('cancel')}
              </Button>
              <Button variant="destructive" onClick={handleDiscardAndClose}>
                {t('discard')}
              </Button>
              <Button onClick={handleSaveDraftAndClose}>
                <Save className="w-4 h-4 mr-2" />
                {t('save_draft')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {previewAttachment && (
        <FilePreviewModal
          name={previewAttachment.name}
          onClose={() => setPreviewAttachment(null)}
          onDownload={handlePreviewAttachmentDownload}
          getFileContent={getPreviewAttachmentContent}
        />
      )}
    </div>
      <PluginSlot
        name="composer-sidebar-right"
        className="hidden md:flex shrink-0 h-full overflow-hidden border-l border-border"
      />
    </div>
  );
}

const AutocompleteDropdown = React.forwardRef<HTMLDivElement, {
  id: string;
  results: Array<{ name: string; email: string }>;
  selectedIndex: number;
  onSelect: (suggestion: { name: string; email: string }) => void;
}>(function AutocompleteDropdown({ id, results, selectedIndex, onSelect }, ref) {
  return (
    <div ref={ref} id={id} role="listbox" className="absolute top-full left-0 right-0 z-50 mt-1 bg-background border border-border rounded-md shadow-lg max-h-48 overflow-y-auto">
      {results.map((r, i) => (
        <button
          key={i}
          id={`autocomplete-option-${i}`}
          type="button"
          role="option"
          aria-selected={i === selectedIndex}
          className={cn(
            "w-full px-3 py-2 text-left text-sm flex items-center gap-2",
            i === selectedIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted"
          )}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(r);
          }}
        >
          <Avatar name={r.name} email={r.email} size="sm" className="shrink-0 w-6 h-6 text-[10px]" />
          <span className="font-medium truncate">{r.name || r.email}</span>
          {r.name && (
            <span className="text-muted-foreground truncate">&lt;{r.email}&gt;</span>
          )}
        </button>
      ))}
    </div>
  );
});

function RecipientChipInput({
  value,
  onChange,
  inputRef,
  placeholder,
  field,
  onAutocomplete,
  onAutoKeyDown,
  onAutoBlur,
  activeAutoField,
  autocompleteResults,
  autoSelectedIndex,
  dropdownRef,
  onInsertAutocomplete,
  validationError,
  validationMessage,
  onTab,
  onMoveChip,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  placeholder: string;
  field: 'to' | 'cc' | 'bcc';
  onAutocomplete: (value: string, field: 'to' | 'cc' | 'bcc') => void;
  onAutoKeyDown: (e: React.KeyboardEvent, field: 'to' | 'cc' | 'bcc') => void;
  onAutoBlur: (e: React.FocusEvent, field: 'to' | 'cc' | 'bcc') => void;
  activeAutoField: 'to' | 'cc' | 'bcc' | null;
  autocompleteResults: Array<{ name: string; email: string }>;
  autoSelectedIndex: number;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  onInsertAutocomplete: (suggestion: { name: string; email: string }, field: 'to' | 'cc' | 'bcc') => void;
  validationError?: boolean;
  validationMessage?: string;
  onTab?: () => void;
  onMoveChip: (chip: string, fromField: 'to' | 'cc' | 'bcc', toField: 'to' | 'cc' | 'bcc') => void;
}) {
  const t = useTranslations('email_composer');
  const tCommon = useTranslations('common');
  const { contextMenu, openContextMenu, closeContextMenu, menuRef } = useContextMenu<{ index: number; chip: string }>();
  const [editingChip, setEditingChip] = useState<{ index: number; chip: string; editType: 'email' | 'name' } | null>(null);
  const [editValue, setEditValue] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);

  const allParts = value.split(',').map(s => s.trim()).filter(Boolean);
  const hasTrailingComma = value.trimEnd().endsWith(',');
  const chips = hasTrailingComma ? allParts : allParts.slice(0, -1);
  const inputText = hasTrailingComma ? '' : (allParts[allParts.length - 1] || '');

  // Focus edit input when editing starts
  useEffect(() => {
    if (editingChip) {
      setTimeout(() => {
        if (editInputRef.current) {
          editInputRef.current.focus();
          editInputRef.current.select();
        }
      }, 0);
    }
  }, [editingChip]);

  // Parse a chip string to extract name and email
  const parseChip = (chip: string): { name?: string; email: string } => {
    const angleMatch = chip.match(/^(.+?)\s*<([^>]+)>$/);
    if (angleMatch) {
      return { name: angleMatch[1].trim(), email: angleMatch[2].trim() };
    }
    return { email: chip };
  };

  // Format a chip for display
  const formatChipDisplay = (chip: string): string => {
    const parsed = parseChip(chip);
    if (parsed.name && parsed.name !== parsed.email) {
      return `${parsed.name} (${parsed.email})`;
    }
    return parsed.email;
  };

  // Handle saving an edited chip
  const handleSaveEdit = (newValue: string) => {
    if (!editingChip) return;
    const { index, editType } = editingChip;
    const chip = chips[index];
    const parsed = parseChip(chip);

    let newChip: string;
    if (editType === 'email') {
      // Update email, keep name
      const trimmedNew = newValue.trim();
      if (!trimmedNew) {
        setEditingChip(null);
        return;
      }
      newChip = parsed.name ? `${parsed.name} <${trimmedNew}>` : trimmedNew;
    } else {
      // Update name, keep email
      const trimmedNew = newValue.trim();
      if (trimmedNew) {
        newChip = `${trimmedNew} <${parsed.email}>`;
      } else {
        // Name cleared, remove from format
        newChip = parsed.email;
      }
    }

    // Replace the chip in the value
    const newChips = [...chips];
    newChips[index] = newChip;
    onChange(newChips.join(', ') + ', ');
    setEditingChip(null);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newInputText = e.target.value;
    const chipPart = chips.length > 0 ? chips.join(', ') + ', ' : '';
    const newValue = chipPart + newInputText;
    onChange(newValue);
    onAutocomplete(newValue, field);
  };

  const commitCurrentInput = () => {
    if (inputText.trim()) {
      const newChips = [...chips, inputText.trim()];
      onChange(newChips.join(', ') + ', ');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (activeAutoField === field && autocompleteResults.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Escape' ||
          (e.key === 'Enter' && autoSelectedIndex >= 0)) {
        onAutoKeyDown(e, field);
        return;
      }
    }

    if ((e.key === ' ' || e.key === 'Enter' || e.key === 'Tab') && inputText.trim()) {
      if (e.key !== 'Tab') e.preventDefault();
      commitCurrentInput();
      if (e.key === 'Tab' && onTab) {
        e.preventDefault();
        setTimeout(() => onTab(), 0);
      } else {
        setTimeout(() => inputRef.current?.focus(), 0);
      }
      return;
    }

    if (e.key === 'Tab' && !e.shiftKey && onTab) {
      e.preventDefault();
      onTab();
      return;
    }

    if (e.key === 'Backspace' && !inputText && chips.length > 0) {
      const lastChip = chips[chips.length - 1];
      const remainingChips = chips.slice(0, -1);
      const chipPart = remainingChips.length > 0 ? remainingChips.join(', ') + ', ' : '';
      onChange(chipPart + lastChip);
      return;
    }
  };

  const handleChipRemove = (index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const remainingChips = chips.filter((_, i) => i !== index);
    if (remainingChips.length > 0) {
      onChange(remainingChips.join(', ') + ', ' + inputText);
    } else {
      onChange(inputText);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, index: number, chip: string) => {
    openContextMenu(e, { index, chip });
  };

  const handleEditEmail = () => {
    if (!contextMenu.data) return;
    const { index, chip } = contextMenu.data;
    const parsed = parseChip(chip);
    closeContextMenu();
    setEditValue(parsed.email);
    setEditingChip({ index, chip, editType: 'email' });
  };

  const handleEditName = () => {
    if (!contextMenu.data) return;
    const { index, chip } = contextMenu.data;
    const parsed = parseChip(chip);
    closeContextMenu();
    setEditValue(parsed.name || '');
    setEditingChip({ index, chip, editType: 'name' });
  };

  const handleBlur = (e: React.FocusEvent) => {
    const relatedTarget = e.relatedTarget as Node | null;
    if (relatedTarget && dropdownRef.current?.contains(relatedTarget)) {
      return;
    }
    if (inputText.trim()) {
      const newChips = [...chips, inputText.trim()];
      onChange(newChips.join(', ') + ', ');
    }
    onAutoBlur(e, field);
  };

  const handleContainerDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/x-recipient-chip')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setIsDragOver(true);
  };

  const handleContainerDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  };

  const handleContainerDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const raw = e.dataTransfer.getData('application/x-recipient-chip');
    if (!raw) return;
    const { chip: draggedChip, fromField } = JSON.parse(raw) as { chip: string; fromField: 'to' | 'cc' | 'bcc' };
    if (fromField === field) return;
    onMoveChip(draggedChip, fromField, field);
  };

  return (
    <div className="flex-1 relative min-w-0">
      <div
        className={cn(
          "flex flex-wrap items-center gap-1 min-h-[32px] cursor-text",
          validationError && "ring-2 ring-red-500 dark:ring-red-400 rounded",
          isDragOver && "ring-2 ring-primary/50 rounded bg-accent/20"
        )}
        onClick={() => inputRef.current?.focus()}
        onDragOver={handleContainerDragOver}
        onDragLeave={handleContainerDragLeave}
        onDrop={handleContainerDrop}
      >
        {chips.map((chip, i) => {
          const isEditing = editingChip?.index === i;
          const chipDisplay = formatChipDisplay(chip);
          return (
            <span
              key={`${chip}-${i}`}
              draggable={!isEditing}
              onDragStart={(e) => {
                e.stopPropagation();
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('application/x-recipient-chip', JSON.stringify({ chip, fromField: field }));
                setDraggingIndex(i);
              }}
              onDragEnd={() => setDraggingIndex(null)}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-sm border border-border transition-colors",
                isEditing
                  ? "bg-background ring-1 ring-ring"
                  : "bg-secondary text-secondary-foreground hover:bg-accent cursor-grab active:cursor-grabbing",
                !isEditing && draggingIndex === i && "opacity-50"
              )}
              onContextMenu={isEditing ? undefined : (e) => handleContextMenu(e, i, chip)}
            >
              {isEditing ? (
                <input
                  ref={editInputRef}
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleSaveEdit(editValue);
                    } else if (e.key === 'Escape') {
                      setEditingChip(null);
                    } else if (e.key === 'Tab') {
                      e.preventDefault();
                      handleSaveEdit(editValue);
                    }
                  }}
                  onBlur={(e) => {
                    const relatedTarget = e.relatedTarget as Node | null;
                    if (relatedTarget && dropdownRef.current?.contains(relatedTarget)) {
                      return;
                    }
                    handleSaveEdit(editValue);
                  }}
                  className="flex-1 min-w-[80px] border-0 outline-none h-5 text-sm bg-transparent text-foreground placeholder:text-muted-foreground"
                  placeholder={editingChip?.editType === 'email' ? t('recipient_email_placeholder') : t('recipient_name_placeholder')}
                  data-bwignore="true"
                />
              ) : (
                <span className="truncate max-w-[200px]">{chipDisplay}</span>
              )}
              <button
                type="button"
                className="flex items-center justify-center w-4 h-4 rounded-full hover:bg-muted-foreground/20 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  if (isEditing) {
                    handleSaveEdit(editValue);
                  } else {
                    handleChipRemove(i, e);
                  }
                }}
                tabIndex={-1}
              >
                {isEditing ? (
                  <Check className="w-3 h-3" />
                ) : (
                  <X className="w-3 h-3" />
                )}
              </button>
            </span>
          );
        })}
        {!editingChip && (
          <input
            ref={inputRef}
            type="text"
            placeholder={chips.length === 0 ? placeholder : ''}
            value={inputText}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            className="flex-1 min-w-[120px] border-0 outline-none h-7 text-sm bg-transparent text-foreground placeholder:text-muted-foreground"
            role="combobox"
            aria-expanded={activeAutoField === field && autocompleteResults.length > 0}
            aria-autocomplete="list"
            aria-controls={activeAutoField === field ? `autocomplete-${field}` : undefined}
            aria-activedescendant={activeAutoField === field && autoSelectedIndex >= 0 ? `autocomplete-option-${autoSelectedIndex}` : undefined}
            aria-invalid={validationError || undefined}
            data-bwignore="true"
            data-1p-ignore
            data-op-ignore
            data-lpignore="true"
            data-form-type="other"
          />
        )}
      </div>
      {validationError && validationMessage && (
        <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">{validationMessage}</p>
      )}
      {activeAutoField === field && autocompleteResults.length > 0 && (
        <AutocompleteDropdown
          ref={dropdownRef}
          id={`autocomplete-${field}`}
          results={autocompleteResults}
          selectedIndex={autoSelectedIndex}
          onSelect={(suggestion) => onInsertAutocomplete(suggestion, field)}
        />
      )}
      <ContextMenu
        isOpen={contextMenu.isOpen}
        position={contextMenu.position}
        onClose={closeContextMenu}
        ref={menuRef}
      >
        {contextMenu.data && (
          <>
            <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground truncate max-w-[200px]">
              {formatChipDisplay(contextMenu.data.chip)}
            </div>
            <ContextMenuSeparator />
            <ContextMenuItem label={t('recipient_edit_email')} onClick={handleEditEmail} />
            <ContextMenuItem label={t('recipient_edit_name')} onClick={handleEditName} />
            <ContextMenuSeparator />
            <ContextMenuItem label={tCommon('delete')} onClick={() => {
              if (contextMenu.data) {
                handleChipRemove(contextMenu.data.index, { stopPropagation: () => {} } as React.MouseEvent);
              }
              closeContextMenu();
            }} destructive />
          </>
        )}
      </ContextMenu>
    </div>
  );
}
