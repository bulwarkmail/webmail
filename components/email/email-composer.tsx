"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Paperclip, Send, Save, Check, Loader2, AlertCircle, FileText, BookmarkPlus, ShieldCheck, Lock } from "lucide-react";
import { cn, formatFileSize, formatDateTime } from "@/lib/utils";
import { debug } from "@/lib/debug";
import { toast } from "@/stores/toast-store";
import { sanitizeEmailHtml } from "@/lib/email-sanitization";
import { useAuthStore } from "@/stores/auth-store";
import { useIdentityStore } from "@/stores/identity-store";
import { useSmimeStore } from "@/stores/smime-store";
import { useEmailStore } from "@/stores/email-store";
import { useSettingsStore } from "@/stores/settings-store";
import { buildMimeMessage, wrapCmsAsSmimeMessage } from "@/lib/smime/mime-builder";
import type { MimeAttachment } from "@/lib/smime/mime-builder";
import { smimeSign } from "@/lib/smime/smime-sign";
import { smimeEncrypt } from "@/lib/smime/smime-encrypt";
import { useContactStore } from "@/stores/contact-store";
import { useTemplateStore } from "@/stores/template-store";
import { SubAddressHelper } from "@/components/identity/sub-address-helper";
import { generateSubAddress } from "@/lib/sub-addressing";
import { substitutePlaceholders } from "@/lib/template-utils";
import { TemplatePicker } from "@/components/templates/template-picker";
import { TemplateForm } from "@/components/templates/template-form";
import type { EmailTemplate } from "@/lib/template-types";

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
  }) => void | Promise<void>;
  onClose?: () => void;
  onDiscardDraft?: (draftId: string) => void;
  onSaveState?: (data: ComposerDraftData) => void;
  className?: string;
  initialDraftText?: string;
  initialData?: ComposerDraftData | null;
  mode?: 'compose' | 'reply' | 'replyAll' | 'forward';
  replyTo?: {
    from?: { email?: string; name?: string }[];
    to?: { email?: string; name?: string }[];
    cc?: { email?: string; name?: string }[];
    subject?: string;
    body?: string;
    htmlBody?: string;
    receivedAt?: string;
  };
}

export function EmailComposer({
  onSend,
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
  const timeFormat = useSettingsStore((state) => state.timeFormat);

  // Initialize with reply/forward data if provided
  const getInitialTo = () => {
    if (!replyTo) return "";
    if (mode === 'reply') {
      const email = replyTo.from?.[0]?.email || "";
      return email ? email + ', ' : "";
    } else if (mode === 'replyAll') {
      const from = replyTo.from?.[0]?.email || "";
      const originalTo = replyTo.to?.filter(r => r.email).map(r => r.email).join(", ") || "";
      const combined = [from, originalTo].filter(Boolean).join(", ");
      return combined ? combined + ', ' : "";
    }
    return "";
  };

  const getInitialCc = () => {
    if (!replyTo || mode !== 'replyAll') return "";
    const cc = replyTo.cc?.map(r => r.email).join(", ") || "";
    return cc ? cc + ', ' : "";
  };

  const getInitialSubject = () => {
    if (!replyTo?.subject) return "";
    if (mode === 'forward') {
      const fwdPrefix = t('prefix.forward');
      return `${fwdPrefix} ${replyTo.subject.replace(/^(Fwd:\s*|Tr:\s*)+/i, '')}`;
    } else if (mode === 'reply' || mode === 'replyAll') {
      const rePrefix = t('prefix.reply');
      return `${rePrefix} ${replyTo.subject.replace(/^(Re:\s*)+/i, '')}`;
    }
    return "";
  };

  const getInitialBody = () => {
    const prefix = initialDraftText || "";
    if (!replyTo?.body && !replyTo?.htmlBody) return prefix;

    const date = replyTo.receivedAt ? formatDateTime(replyTo.receivedAt, timeFormat, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : "";
    const from = replyTo.from?.[0];
    const fromStr = from ? `${from.name || from.email}` : tCommon('unknown');

    // When HTML body is available, don't include quoted text in the textarea
    // The HTML original will be shown separately below the textarea
    if (replyTo.htmlBody && (mode === 'reply' || mode === 'replyAll' || mode === 'forward')) {
      return prefix;
    }

    if (mode === 'forward') {
      return `${prefix}\n\n---------- Forwarded message ----------\nFrom: ${fromStr}\nDate: ${date}\nSubject: ${replyTo.subject || ""}\n\n${replyTo.body}`;
    } else if (mode === 'reply' || mode === 'replyAll') {
      return `${prefix}\n\nOn ${date}, ${fromStr} wrote:\n> ${(replyTo.body || '').split('\n').join('\n> ')}`;
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
  const [draftId, setDraftId] = useState<string | null>(initialData?.draftId ?? null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedDataRef = useRef<string>("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, []);

  useEffect(() => {
    autoResizeTextarea();
  }, [body, autoResizeTextarea]);
  const [attachments, setAttachments] = useState<Array<{ file: File; blobId?: string; uploading?: boolean; error?: boolean; abortController?: AbortController }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [validationErrors, setValidationErrors] = useState<{ to?: boolean; subject?: boolean; body?: boolean }>({});
  const [shakeField, setShakeField] = useState<string | null>(null);
  const [selectedIdentityId, setSelectedIdentityId] = useState<string | null>(initialData?.selectedIdentityId ?? null);
  const [subAddressTag, setSubAddressTag] = useState<string>(initialData?.subAddressTag ?? '');
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [showSaveAsTemplate, setShowSaveAsTemplate] = useState(false);
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [showAllAttachments, setShowAllAttachments] = useState(false);
  const [smimeSign_, setSmimeSign] = useState(false);
  const [smimeEncrypt_, setSmimeEncrypt] = useState(false);
  const [smimePassphrasePrompt, setSmimePassphrasePrompt] = useState<{ keyId: string; resolve: (passphrase: string) => void; reject: () => void } | null>(null);
  const [smimePassphraseInput, setSmimePassphraseInput] = useState('');
  const [smimePassphraseError, setSmimePassphraseError] = useState('');

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

  const { client } = useAuthStore();
  const identities = useIdentityStore((s) => s.identities);
  const primaryIdentity = identities[0] ?? null;
  const getAutocomplete = useContactStore((s) => s.getAutocomplete);
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
  const stateRef = useRef({ to, cc, bcc, subject, body, showCc, showBcc, selectedIdentityId, subAddressTag, draftId });
  stateRef.current = { to, cc, bcc, subject, body, showCc, showBcc, selectedIdentityId, subAddressTag, draftId };

  // Track initial values for dirty detection (captured once on first render)
  const initialValuesRef = useRef({ to, cc, bcc, subject, body, attachmentCount: 0 });
  const isDirtyRef = useRef(false);
  isDirtyRef.current = to !== initialValuesRef.current.to || cc !== initialValuesRef.current.cc ||
    bcc !== initialValuesRef.current.bcc || subject !== initialValuesRef.current.subject ||
    body !== initialValuesRef.current.body || attachments.length > initialValuesRef.current.attachmentCount;

  // Ref to latest saveDraft for use in event handlers with stale closures
  const saveDraftRef = useRef<() => Promise<string | null>>(() => Promise.resolve(null));

  // Auto-save state on unmount (when user navigates away without explicitly closing)
  useEffect(() => {
    return () => {
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

  const [autocompleteResults, setAutocompleteResults] = useState<Array<{ name: string; email: string }>>([]);
  const [activeAutoField, setActiveAutoField] = useState<'to' | 'cc' | 'bcc' | null>(null);
  const [autoSelectedIndex, setAutoSelectedIndex] = useState(-1);
  const autocompleteTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const toInputRef = useRef<HTMLInputElement>(null);
  const ccInputRef = useRef<HTMLInputElement>(null);
  const bccInputRef = useRef<HTMLInputElement>(null);
  const toDropdownRef = useRef<HTMLDivElement>(null);
  const ccDropdownRef = useRef<HTMLDivElement>(null);
  const bccDropdownRef = useRef<HTMLDivElement>(null);

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

    autocompleteTimeoutRef.current = setTimeout(() => {
      const results = getAutocomplete(lastPart);
      setAutocompleteResults(results);
      setActiveAutoField(results.length > 0 ? field : null);
      setAutoSelectedIndex(-1);
    }, 200);
  }, [getAutocomplete]);

  const insertAutocomplete = (email: string, field: 'to' | 'cc' | 'bcc') => {
    const setter = field === 'to' ? setTo : field === 'cc' ? setCc : setBcc;
    const getter = field === 'to' ? to : field === 'cc' ? cc : bcc;

    const parts = getter.split(',').map(s => s.trim()).filter(Boolean);
    if (!getter.trimEnd().endsWith(',') && parts.length > 0) {
      parts.pop();
    }
    parts.push(email);
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
      insertAutocomplete(autocompleteResults[autoSelectedIndex].email, field);
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

    if (mode === 'compose') {
      setSubject(filledSubject);
      setBody(filledBody);
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
      setBody((prev) => filledBody + prev);
    }

    if (template.identityId) {
      setSelectedIdentityId(template.identityId);
    }

    setShowTemplatePicker(false);
  }, [mode]);

  useEffect(() => {
    const handleTemplateKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
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

    const newAttachments = files.map(file => {
      const controller = new AbortController();
      return { file, uploading: true, abortController: controller };
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

  // Auto-save draft functionality
  const saveDraft = async (): Promise<string | null> => {
    if (!client) return null;

    const toAddresses = to.split(",").map(e => e.trim()).filter(Boolean);
    const ccAddresses = cc.split(",").map(e => e.trim()).filter(Boolean);
    const bccAddresses = bcc.split(",").map(e => e.trim()).filter(Boolean);

    if (!toAddresses.length && !subject && !body) {
      return null;
    }

    // Prepare attachments for draft
    const uploadedAttachments = attachments
      .filter(att => att.blobId && !att.uploading)
      .map(att => ({
        blobId: att.blobId!,
        name: att.file.name,
        type: att.file.type,
        size: att.file.size,
      }));

    // Create a hash of current data to compare with last saved
    const currentData = JSON.stringify({ to: toAddresses, cc: ccAddresses, bcc: bccAddresses, subject, body, attachments: uploadedAttachments, identityId: selectedIdentityId, subAddressTag });

    // Only save if data has changed
    if (currentData === lastSavedDataRef.current) {
      return draftId;
    }

    setSaveStatus('saving');

    // Get the selected identity or primary identity
    const currentIdentity = selectedIdentityId
      ? identities.find(id => id.id === selectedIdentityId)
      : primaryIdentity;

    // Generate sub-addressed email if tag is set
    const fromEmail = currentIdentity?.email
      ? subAddressTag
        ? generateSubAddress(currentIdentity.email, subAddressTag)
        : currentIdentity.email
      : undefined;

    try {
      const savedDraftId = await client.createDraft(
        toAddresses,
        subject || t('no_subject'),
        body,
        ccAddresses,
        bccAddresses,
        currentIdentity?.id,
        fromEmail,
        draftId || undefined,
        uploadedAttachments,
        currentIdentity?.name || undefined
      );

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
  const hasContent = body || attachments.some(att => att.blobId && !att.uploading);
  const canSend = toAddresses.length > 0 && !!subject && hasContent;

  const getSendTooltip = (): string | undefined => {
    if (canSend) return undefined;
    if (toAddresses.length === 0) return t('validation.recipient_required');
    if (!subject) return t('validation.subject_required');
    if (!hasContent) return t('validation.body_required');
    return undefined;
  };

  const handleSend = async () => {
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

    let finalDraftId = draftId;
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      try {
        const savedId = await saveDraft();
        if (savedId) {
          finalDraftId = savedId;
        }
      } catch (err) {
        debug.error('Failed to save draft before send:', err);
      }
    }

    const currentIdentity = selectedIdentityId
      ? identities.find(id => id.id === selectedIdentityId)
      : primaryIdentity;

    const fromEmail = currentIdentity?.email
      ? subAddressTag
        ? generateSubAddress(currentIdentity.email, subAddressTag)
        : currentIdentity.email
      : undefined;

    // Append signature from the selected identity
    let finalBody = body;
    if (currentIdentity?.textSignature) {
      finalBody = body + '\n\n-- \n' + currentIdentity.textSignature;
    }

    // Build HTML body when replying/forwarding with original HTML content
    let finalHtmlBody: string | undefined;
    if (replyTo?.htmlBody && (mode === 'reply' || mode === 'replyAll' || mode === 'forward')) {
      const escapedBody = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
      const signatureHtml = currentIdentity?.textSignature
        ? `<br><br>-- <br>${currentIdentity.textSignature.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}`
        : '';
      const date = replyTo.receivedAt ? formatDateTime(replyTo.receivedAt, timeFormat, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : '';
      const fromAddr = replyTo.from?.[0];
      const fromStr = fromAddr ? `${fromAddr.name || fromAddr.email}` : tCommon('unknown');
      const quoteHeader = mode === 'forward'
        ? `---------- ${t('prefix.forward')} ----------<br>From: ${fromStr}<br>Date: ${date}<br>Subject: ${replyTo.subject || ''}<br><br>`
        : `On ${date}, ${fromStr} wrote:<br>`;

      finalHtmlBody = `<div>${escapedBody}</div>${signatureHtml}<br><div><div>${quoteHeader}</div><blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex">${replyTo.htmlBody}</blockquote></div>`;
    }

    try {
      // S/MIME send pipeline: build raw MIME → sign → encrypt → sendRawEmail
      if ((smimeSign_ || smimeEncrypt_) && client && currentIdentity?.id) {
        // 1. Resolve S/MIME key
        if (smimeSign_ && !smimeKeyRecord) {
          throw new Error('No S/MIME key bound to this identity');
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
          if (att.file.size > 0) {
            content = await att.file.arrayBuffer();
          } else if (att.blobId && client) {
            content = await client.fetchBlobArrayBuffer(att.blobId, att.file.name, att.file.type);
          } else {
            continue;
          }
          mimeAttachments.push({
            filename: att.file.name,
            contentType: att.file.type || 'application/octet-stream',
            content,
          });
        }

        // 4. Build canonical MIME
        const mimeBytes = buildMimeMessage({
          from: { name: currentIdentity.name || undefined, email: fromEmail || currentIdentity.email },
          to: toAddresses.map(e => ({ email: e })),
          cc: ccAddresses.length > 0 ? ccAddresses.map(e => ({ email: e })) : undefined,
          bcc: bccAddresses.length > 0 ? bccAddresses.map(e => ({ email: e })) : undefined,
          subject,
          textBody: finalBody,
          htmlBody: finalHtmlBody,
          attachments: mimeAttachments.length > 0 ? mimeAttachments : undefined,
        });

        let payload: Blob = new Blob([mimeBytes.buffer as ArrayBuffer], { type: 'message/rfc822' });

        const smimeHeaders = {
          from: { name: currentIdentity.name || undefined, email: fromEmail || currentIdentity.email },
          to: toAddresses.map(e => ({ email: e })),
          cc: ccAddresses.length > 0 ? ccAddresses.map(e => ({ email: e })) : undefined,
          subject,
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
          const allRecipients = [...toAddresses, ...ccAddresses, ...bccAddresses];
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
        await sendRawEmail(client, payload, currentIdentity.id);
      } else {
        // Standard JMAP send path
        await onSend?.({
          to: toAddresses,
          cc: ccAddresses,
          bcc: bccAddresses,
          subject,
          body: finalBody,
          htmlBody: finalHtmlBody,
          draftId: finalDraftId || undefined,
          fromEmail,
          fromName: currentIdentity?.name || undefined,
          identityId: currentIdentity?.id,
        });
      }

      setTo("");
      setCc("");
      setBcc("");
      setSubject("");
      setBody("");
      setDraftId(null);
      setSubAddressTag("");
      setValidationErrors({});
      // Clear ref so unmount effect doesn't re-save
      stateRef.current = { to: '', cc: '', bcc: '', subject: '', body: '', showCc: false, showBcc: false, selectedIdentityId: null, subAddressTag: '', draftId: null };
    } catch (err) {
      debug.error('Failed to send email:', err);
      toast.error(t('send_failed'));
    }
  };

  const cleanClose = () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    stateRef.current = { to: '', cc: '', bcc: '', subject: '', body: '', showCc: false, showBcc: false, selectedIdentityId: null, subAddressTag: '', draftId: null };
    onClose?.();
  };

  const handleSaveDraftAndClose = async () => {
    setShowCloseDialog(false);
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    await saveDraft();
    stateRef.current = { to: '', cc: '', bcc: '', subject: '', body: '', showCc: false, showBcc: false, selectedIdentityId: null, subAddressTag: '', draftId: null };
    onClose?.();
  };

  const handleDiscardAndClose = () => {
    setShowCloseDialog(false);
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    if (draftId && onDiscardDraft) {
      onDiscardDraft(draftId);
    }
    stateRef.current = { to: '', cc: '', bcc: '', subject: '', body: '', showCc: false, showBcc: false, selectedIdentityId: null, subAddressTag: '', draftId: null };
    onClose?.();
  };

  const handleClose = () => {
    if (isDirtyRef.current) {
      setShowCloseDialog(true);
    } else {
      cleanClose();
    }
  };

  return (
    <div
      className={cn("flex flex-col h-full bg-background relative", className)}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
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
          onClick={handleSend}
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
              {identities.length > 1 ? (
                <select
                  value={selectedIdentityId || primaryIdentity?.id || ''}
                  onChange={(e) => setSelectedIdentityId(e.target.value)}
                  className="flex-1 bg-transparent text-sm text-foreground outline-none cursor-pointer hover:text-muted-foreground transition-colors min-w-0 truncate"
                >
                  {identities.map((identity) => (
                    <option key={identity.id} value={identity.id}>
                      {identity.name ? `${identity.name} <${identity.email}>` : identity.email}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-sm text-foreground flex-1 truncate">
                  {subAddressTag ? (
                    <span className="font-mono">
                      {generateSubAddress(primaryIdentity?.email || '', subAddressTag)}
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
              <SubAddressHelper
                baseEmail={
                  (selectedIdentityId
                    ? identities.find(id => id.id === selectedIdentityId)?.email
                    : primaryIdentity?.email) || ''
                }
                recipientEmails={to.split(',').map(e => e.trim()).filter(Boolean)}
                onSelectTag={setSubAddressTag}
              />
              {subAddressTag && (
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
            />
            <div className="flex gap-0.5 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowCc(!showCc)}
                className="text-xs h-7 px-2"
              >
                Cc
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowBcc(!showBcc)}
                className="text-xs h-7 px-2"
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
              />
            </div>
          )}

          {/* Subject field */}
          <div className="flex items-center gap-2 px-4 py-2.5">
            <span className="text-sm text-muted-foreground w-12 md:w-16 shrink-0">{t('subject_label')}</span>
            <Input
              type="text"
              placeholder={t('subject_placeholder')}
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value);
                if (validationErrors.subject) setValidationErrors(prev => ({ ...prev, subject: false }));
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
        <div className="px-4 py-3">
          <textarea
            ref={textareaRef}
            className={cn(
              "w-full resize-none outline-none text-sm bg-transparent text-foreground placeholder:text-muted-foreground rounded min-h-[100px] overflow-hidden",
              validationErrors.body && "ring-2 ring-red-500 dark:ring-red-400"
            )}
            placeholder={t('body_placeholder')}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              if (validationErrors.body) setValidationErrors(prev => ({ ...prev, body: false }));
            }}
            aria-invalid={validationErrors.body || undefined}
          />
        </div>

        {/* Quoted original HTML */}
        {replyTo?.htmlBody && (mode === 'reply' || mode === 'replyAll' || mode === 'forward') && (
          <div className="border-t border-border">
            <div className="px-4 py-2 text-xs text-muted-foreground">
              {mode === 'forward'
                ? `---------- ${t('prefix.forward')} ----------`
                : `${replyTo.receivedAt ? formatDateTime(replyTo.receivedAt, timeFormat, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : ''}, ${replyTo.from?.[0]?.name || replyTo.from?.[0]?.email || tCommon('unknown')}:`
              }
            </div>
            <div
              className="email-reply-quote px-4 pb-3 border-l-2 border-muted-foreground/30 ml-4 max-w-none rounded"
              style={{ backgroundColor: '#ffffff', color: '#1a1a1a', fontSize: '14px' }}
              dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(replyTo.htmlBody) }}
            />
          </div>
        )}
      </div>

        {/* Attachments */}
        {attachments.length > 0 && (
          <div className="px-4 py-2 border-t shrink-0">
            <div className="flex flex-wrap gap-2">
              {(showAllAttachments ? attachments : attachments.slice(0, 3)).map((att, index) => (
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
                    <span className="max-w-[150px] md:max-w-[200px] truncate">{att.file.name}</span>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      ({formatFileSize(att.file.size)})
                    </span>
                    <button
                      onClick={() => removeAttachment(index)}
                      className="ml-1 hover:text-red-500 min-w-[20px] min-h-[20px] flex items-center justify-center"
                      title={att.uploading ? t('upload_cancel') : undefined}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
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
        <div className="flex items-center justify-between px-4 py-2.5 border-t bg-background shrink-0">
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
            <Button
              onClick={handleSend}
              disabled={!canSend}
              title={getSendTooltip()}
              className="hidden md:inline-flex"
            >
              <Send className="w-4 h-4 mr-2" />
              {t('send')}
            </Button>
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
    </div>
  );
}

const AutocompleteDropdown = React.forwardRef<HTMLDivElement, {
  id: string;
  results: Array<{ name: string; email: string }>;
  selectedIndex: number;
  onSelect: (email: string) => void;
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
            onSelect(r.email);
          }}
        >
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
  onInsertAutocomplete: (email: string, field: 'to' | 'cc' | 'bcc') => void;
  validationError?: boolean;
  validationMessage?: string;
}) {
  const allParts = value.split(',').map(s => s.trim()).filter(Boolean);
  const hasTrailingComma = value.trimEnd().endsWith(',');
  const chips = hasTrailingComma ? allParts : allParts.slice(0, -1);
  const inputText = hasTrailingComma ? '' : (allParts[allParts.length - 1] || '');

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
      setTimeout(() => inputRef.current?.focus(), 0);
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

  const handleChipClick = (index: number) => {
    const chipEmail = chips[index];
    const remainingChips = chips.filter((_, i) => i !== index);
    const chipPart = remainingChips.length > 0 ? remainingChips.join(', ') + ', ' : '';
    onChange(chipPart + chipEmail);
    setTimeout(() => inputRef.current?.focus(), 0);
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

  return (
    <div className="flex-1 relative min-w-0">
      <div
        className={cn(
          "flex flex-wrap items-center gap-1 min-h-[32px] cursor-text",
          validationError && "ring-2 ring-red-500 dark:ring-red-400 rounded"
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {chips.map((chip, i) => (
          <span
            key={`${chip}-${i}`}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-secondary text-secondary-foreground text-sm border border-border cursor-pointer hover:bg-accent transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              handleChipClick(i);
            }}
          >
            <span className="truncate max-w-[200px]">{chip}</span>
            <button
              type="button"
              className="flex items-center justify-center w-4 h-4 rounded-full hover:bg-muted-foreground/20 transition-colors"
              onClick={(e) => handleChipRemove(i, e)}
              tabIndex={-1}
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
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
        />
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
          onSelect={(email) => onInsertAutocomplete(email, field)}
        />
      )}
    </div>
  );
}