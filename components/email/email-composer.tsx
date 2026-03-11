"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Paperclip, Send, Save, Check, Loader2, AlertCircle, FileText, BookmarkPlus } from "lucide-react";
import { cn, formatFileSize } from "@/lib/utils";
import { debug } from "@/lib/debug";
import { toast } from "@/stores/toast-store";
import { useAuthStore } from "@/stores/auth-store";
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

  // Initialize with reply/forward data if provided
  const getInitialTo = () => {
    if (!replyTo) return "";
    if (mode === 'reply') {
      return replyTo.from?.[0]?.email || "";
    } else if (mode === 'replyAll') {
      const from = replyTo.from?.[0]?.email || "";
      const originalTo = replyTo.to?.filter(r => r.email).map(r => r.email).join(", ") || "";
      return [from, originalTo].filter(Boolean).join(", ");
    }
    return "";
  };

  const getInitialCc = () => {
    if (!replyTo || mode !== 'replyAll') return "";
    return replyTo.cc?.map(r => r.email).join(", ") || "";
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
    if (!replyTo?.body) return prefix;

    const date = replyTo.receivedAt ? new Date(replyTo.receivedAt).toLocaleString() : "";
    const from = replyTo.from?.[0];
    const fromStr = from ? `${from.name || from.email}` : tCommon('unknown');

    if (mode === 'forward') {
      return `${prefix}\n\n---------- Forwarded message ----------\nFrom: ${fromStr}\nDate: ${date}\nSubject: ${replyTo.subject || ""}\n\n${replyTo.body}`;
    } else if (mode === 'reply' || mode === 'replyAll') {
      return `${prefix}\n\nOn ${date}, ${fromStr} wrote:\n> ${replyTo.body.split('\n').join('\n> ')}`;
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
  const [attachments, setAttachments] = useState<Array<{ file: File; blobId?: string; uploading?: boolean; error?: boolean; abortController?: AbortController }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [validationErrors, setValidationErrors] = useState<{ to?: boolean; subject?: boolean; body?: boolean }>({});
  const [shakeField, setShakeField] = useState<string | null>(null);
  const [selectedIdentityId, setSelectedIdentityId] = useState<string | null>(initialData?.selectedIdentityId ?? null);
  const [subAddressTag, setSubAddressTag] = useState<string>(initialData?.subAddressTag ?? '');
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [showSaveAsTemplate, setShowSaveAsTemplate] = useState(false);
  const [showCloseDialog, setShowCloseDialog] = useState(false);

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

  const { client, identities, primaryIdentity } = useAuthStore();
  const getAutocomplete = useContactStore((s) => s.getAutocomplete);
  const addTemplate = useTemplateStore((s) => s.addTemplate);

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

    const parts = getter.split(',');
    parts.pop();
    parts.push(` ${email}`);
    setter(parts.join(',').replace(/^,\s*/, ''));
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
        setTo(template.defaultRecipients.to.join(', '));
      }
      if (template.defaultRecipients?.cc?.length) {
        setCc(template.defaultRecipients.cc.join(', '));
        setShowCc(true);
      }
      if (template.defaultRecipients?.bcc?.length) {
        setBcc(template.defaultRecipients.bcc.join(', '));
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

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!client || !event.target.files) return;

    const files = Array.from(event.target.files);

    // AbortController tracks cancellation state but uploadBlob doesn't accept a signal,
    // so abort only prevents post-upload state updates (cosmetic cancellation)
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

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

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

    try {
      await onSend?.({
        to: toAddresses,
        cc: ccAddresses,
        bcc: bccAddresses,
        subject,
        body,
        draftId: finalDraftId || undefined,
        fromEmail,
        fromName: currentIdentity?.name || undefined,
        identityId: currentIdentity?.id,
      });

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
    <div className={cn("flex flex-col h-full bg-background", className)}>
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

      <div className="flex-1 flex flex-col min-h-0">
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
            <div className="flex-1 relative min-w-0">
              <Input
                ref={toInputRef}
                type="email"
                placeholder={t('to_placeholder')}
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  if (validationErrors.to) setValidationErrors(prev => ({ ...prev, to: false }));
                  handleAutocomplete(e.target.value, 'to');
                }}
                onKeyDown={(e) => handleAutoKeyDown(e, 'to')}
                onBlur={(e) => handleAutoBlur(e, 'to')}
                className={cn(
                  "border-0 focus-visible:ring-0 h-8 px-0 text-sm",
                  validationErrors.to && "ring-2 ring-red-500 dark:ring-red-400"
                )}
                role="combobox"
                aria-expanded={activeAutoField === 'to' && autocompleteResults.length > 0}
                aria-autocomplete="list"
                aria-controls={activeAutoField === 'to' ? 'autocomplete-to' : undefined}
                aria-activedescendant={activeAutoField === 'to' && autoSelectedIndex >= 0 ? `autocomplete-option-${autoSelectedIndex}` : undefined}
                aria-invalid={validationErrors.to || undefined}
              />
              {validationErrors.to && (
                <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">{t('validation.recipient_required')}</p>
              )}
              {activeAutoField === 'to' && autocompleteResults.length > 0 && (
                <AutocompleteDropdown ref={toDropdownRef} id="autocomplete-to" results={autocompleteResults} selectedIndex={autoSelectedIndex} onSelect={(email) => insertAutocomplete(email, 'to')} />
              )}
            </div>
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
              <div className="flex-1 relative min-w-0">
                <Input
                  ref={ccInputRef}
                  type="email"
                  placeholder={t('cc_placeholder')}
                  value={cc}
                  onChange={(e) => {
                    setCc(e.target.value);
                    handleAutocomplete(e.target.value, 'cc');
                  }}
                  onKeyDown={(e) => handleAutoKeyDown(e, 'cc')}
                  onBlur={(e) => handleAutoBlur(e, 'cc')}
                  className="border-0 focus-visible:ring-0 h-8 px-0 text-sm"
                  role="combobox"
                  aria-expanded={activeAutoField === 'cc' && autocompleteResults.length > 0}
                  aria-autocomplete="list"
                  aria-controls={activeAutoField === 'cc' ? 'autocomplete-cc' : undefined}
                  aria-activedescendant={activeAutoField === 'cc' && autoSelectedIndex >= 0 ? `autocomplete-option-${autoSelectedIndex}` : undefined}
                />
                {activeAutoField === 'cc' && autocompleteResults.length > 0 && (
                  <AutocompleteDropdown ref={ccDropdownRef} id="autocomplete-cc" results={autocompleteResults} selectedIndex={autoSelectedIndex} onSelect={(email) => insertAutocomplete(email, 'cc')} />
                )}
              </div>
            </div>
          )}

          {/* Bcc field */}
          {showBcc && (
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/50 relative">
              <span className="text-sm text-muted-foreground w-12 md:w-16 shrink-0">{t('bcc_label')}</span>
              <div className="flex-1 relative min-w-0">
                <Input
                  ref={bccInputRef}
                  type="email"
                  placeholder={t('bcc_placeholder')}
                  value={bcc}
                  onChange={(e) => {
                    setBcc(e.target.value);
                    handleAutocomplete(e.target.value, 'bcc');
                  }}
                  onKeyDown={(e) => handleAutoKeyDown(e, 'bcc')}
                  onBlur={(e) => handleAutoBlur(e, 'bcc')}
                  className="border-0 focus-visible:ring-0 h-8 px-0 text-sm"
                  role="combobox"
                  aria-expanded={activeAutoField === 'bcc' && autocompleteResults.length > 0}
                  aria-autocomplete="list"
                  aria-controls={activeAutoField === 'bcc' ? 'autocomplete-bcc' : undefined}
                  aria-activedescendant={activeAutoField === 'bcc' && autoSelectedIndex >= 0 ? `autocomplete-option-${autoSelectedIndex}` : undefined}
                />
                {activeAutoField === 'bcc' && autocompleteResults.length > 0 && (
                  <AutocompleteDropdown ref={bccDropdownRef} id="autocomplete-bcc" results={autocompleteResults} selectedIndex={autoSelectedIndex} onSelect={(email) => insertAutocomplete(email, 'bcc')} />
                )}
              </div>
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
        <div className="flex-1 px-4 py-3 min-h-0">
          <textarea
            className={cn(
              "w-full h-full resize-none outline-none text-sm bg-transparent text-foreground placeholder:text-muted-foreground rounded",
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

        {/* Attachments */}
        {attachments.length > 0 && (
          <div className="px-4 py-2 border-t">
            <div className="flex flex-wrap gap-2">
              {attachments.map((att, index) => (
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
            </div>
          </div>
        )}

        {/* Bottom toolbar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t bg-background">
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
    <div ref={ref} id={id} role="listbox" className="absolute top-full left-0 right-0 z-50 mt-1 bg-popover border border-border rounded-md shadow-lg max-h-48 overflow-y-auto">
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