'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Identity, EmailAddress } from '@/lib/jmap/types';
import { sanitizeSignatureHtml, sanitizeSignatureHtmlForDisplay } from '@/lib/email-sanitization';
import { getEmailValidationError, validateEmailList } from '@/lib/validation';
import { getPlainTextSignature } from '@/lib/signature-utils';
import { useOrgSignatureSetup } from '@/hooks/use-org-signature';
import { OrgLockedNote } from '@/components/settings/org-locked-note';
import { useSettingsStore } from '@/stores/settings-store';
import { SignatureEditor, SIGNATURE_MAX_BYTES, signatureBytes } from './signature-editor';

interface IdentityFormData {
  name: string;
  email: string;
  replyTo?: EmailAddress[] | null;
  bcc?: EmailAddress[] | null;
  textSignature?: string | null;
  htmlSignature?: string | null;
}

interface IdentityFormProps {
  identity?: Identity;
  onSave: (data: IdentityFormData) => Promise<void>;
  onCancel: () => void;
  /** Told whenever the form starts or stops holding unsaved input. */
  onDirtyChange?: (dirty: boolean) => void;
}

export function IdentityForm({ identity, onSave, onCancel, onDirtyChange }: IdentityFormProps) {
  const t = useTranslations('identities.form');
  const tValidation = useTranslations('identities.validation_errors');
  const tOrg = useTranslations('org_signature');
  const tName = useTranslations('uxs2_ident.your_name');
  const isEditing = !!identity;
  // Composing > Plain text only: the signature is plain text too.
  const plainTextMode = useSettingsStore((s) => s.plainTextMode);

  const [formData, setFormData] = useState<IdentityFormData>({
    name: identity?.name || '',
    email: identity?.email || '',
    replyTo: identity?.replyTo,
    bcc: identity?.bcc,
    textSignature: identity?.textSignature || '',
    htmlSignature: identity?.htmlSignature || '',
  });

  const [replyToInput, setReplyToInput] = useState(
    identity?.replyTo?.map(a => a.email).join(', ') || ''
  );
  const [bccInput, setBccInput] = useState(
    identity?.bcc?.map(a => a.email).join(', ') || ''
  );

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // The admin's `signature` restriction: locked shows the signature this
  // address sends with, read-only; hidden shows no signature editor.
  const org = useOrgSignatureSetup({ name: formData.name, email: formData.email || identity?.email || '' });
  const signatureHidden = org.restriction.hidden;
  const signatureLocked = org.restriction.locked && !signatureHidden;
  const signatureEditable = !signatureHidden && !signatureLocked;

  const dirty =
    formData.name !== (identity?.name || '') ||
    formData.email !== (identity?.email || '') ||
    (formData.textSignature || '') !== (identity?.textSignature || '') ||
    (formData.htmlSignature || '') !== (identity?.htmlSignature || '') ||
    replyToInput !== (identity?.replyTo?.map(a => a.email).join(', ') || '') ||
    bccInput !== (identity?.bcc?.map(a => a.email).join(', ') || '');
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const parseEmailList = (input: string): EmailAddress[] | undefined => {
    if (!input.trim()) return undefined;

    const emails = input.split(',').map(e => e.trim()).filter(Boolean);
    return emails.map(email => ({ email }));
  };

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    // The display name may be empty (RFC 8621 §6, default ""): the From line
    // then carries only the address.

    // Use secure email validation
    const emailError = getEmailValidationError(formData.email);
    if (emailError) {
      newErrors.email = emailError;
    }

    // Validate reply-to email list
    if (replyToInput.trim()) {
      const validation = validateEmailList(replyToInput);
      if (!validation.valid) {
        newErrors.replyTo = tValidation('invalid_emails', { emails: validation.invalidEmails.join(', ') });
      }
    }

    // Validate bcc email list
    if (bccInput.trim()) {
      const validation = validateEmailList(bccInput);
      if (!validation.valid) {
        newErrors.bcc = tValidation('invalid_emails', { emails: validation.invalidEmails.join(', ') });
      }
    }

    // Too long for the server: the field says so under it; nothing is cut off.
    if (signatureEditable && signatureBytes(formData.htmlSignature ?? '', formData.textSignature ?? '', plainTextMode) > SIGNATURE_MAX_BYTES) {
      newErrors.signature = 'too_long';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validate()) return;

    setIsSubmitting(true);

    try {
      // JMAP needs explicit null to clear a field; undefined would be dropped
      // from the JSON payload and leave the server-side value untouched.
      const trimmedText = formData.textSignature?.trim() ?? '';
      const trimmedHtml = formData.htmlSignature?.trim() ?? '';
      const sanitizedData: IdentityFormData = {
        ...formData,
        name: formData.name.trim() ? formData.name : '',
        textSignature: trimmedText ? formData.textSignature : null,
        htmlSignature: trimmedHtml ? sanitizeSignatureHtml(formData.htmlSignature!) : null,
        replyTo: parseEmailList(replyToInput) ?? null,
        bcc: parseEmailList(bccInput) ?? null,
      };
      // A locked or hidden signature leaves the identity's own as it is.
      if (!signatureEditable) {
        delete sanitizedData.textSignature;
        delete sanitizedData.htmlSignature;
      }

      await onSave(sanitizedData);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Name */}
      <div>
        {/* "Your name", like the Account page: the one name recipients see. */}
        <label htmlFor="identity-name" className="block text-sm font-medium mb-1">
          {tName('label')}
        </label>
        <Input
          id="identity-name"
          type="text"
          maxLength={256}
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          disabled={isSubmitting}
          className={errors.name ? 'border-destructive' : ''}
          aria-describedby={errors.name ? 'name-error' : 'identity-name-hint'}
          aria-invalid={!!errors.name}
        />
        <p id="identity-name-hint" className="text-xs text-muted-foreground mt-1">{tName('description')}</p>
        {errors.name && (
          <p
            id="name-error"
            className="text-sm text-destructive mt-1"
            role="alert"
            aria-live="polite"
            aria-atomic="true"
          >
            {errors.name}
          </p>
        )}
      </div>

      {/* Email */}
      <div>
        <label htmlFor="identity-email" className="block text-sm font-medium mb-1">
          {t('email_label')} <span className="text-destructive">*</span>
        </label>
        <Input
          id="identity-email"
          type="email"
          maxLength={254}
          value={formData.email}
          onChange={(e) => setFormData({ ...formData, email: e.target.value })}
          placeholder={t('email_placeholder')}
          disabled={isSubmitting || isEditing}
          className={errors.email ? 'border-destructive' : ''}
          aria-describedby={errors.email ? 'email-error' : undefined}
          aria-invalid={!!errors.email}
        />
        {isEditing && (
          <p className="text-sm text-muted-foreground mt-1">
            {t('email_immutable')}
          </p>
        )}
        {errors.email && (
          <p
            id="email-error"
            className="text-sm text-destructive mt-1"
            role="alert"
            aria-live="polite"
            aria-atomic="true"
          >
            {errors.email}
          </p>
        )}
      </div>

      {/* Reply-To */}
      <div>
        <label htmlFor="identity-reply-to" className="block text-sm font-medium mb-1">
          {t('reply_to_label')}
        </label>
        <Input
          id="identity-reply-to"
          type="text"
          maxLength={512}
          value={replyToInput}
          onChange={(e) => setReplyToInput(e.target.value)}
          placeholder={t('reply_to_placeholder')}
          disabled={isSubmitting}
          className={errors.replyTo ? 'border-destructive' : ''}
          aria-describedby={errors.replyTo ? 'reply-to-error' : undefined}
          aria-invalid={!!errors.replyTo}
        />
        {errors.replyTo && (
          <p
            id="reply-to-error"
            className="text-sm text-destructive mt-1"
            role="alert"
            aria-live="polite"
            aria-atomic="true"
          >
            {errors.replyTo}
          </p>
        )}
      </div>

      {/* BCC */}
      <div>
        <label htmlFor="identity-bcc" className="block text-sm font-medium mb-1">
          {t('bcc_label')}
        </label>
        <Input
          id="identity-bcc"
          type="text"
          maxLength={512}
          value={bccInput}
          onChange={(e) => setBccInput(e.target.value)}
          placeholder={t('bcc_placeholder')}
          disabled={isSubmitting}
          className={errors.bcc ? 'border-destructive' : ''}
          aria-describedby={errors.bcc ? 'bcc-error' : undefined}
          aria-invalid={!!errors.bcc}
        />
        {errors.bcc && (
          <p
            id="bcc-error"
            className="text-sm text-destructive mt-1"
            role="alert"
            aria-live="polite"
            aria-atomic="true"
          >
            {errors.bcc}
          </p>
        )}
      </div>

      {signatureLocked && (
        <LockedSignature
          html={org.signature ? org.signature.html : formData.htmlSignature ?? ''}
          text={org.signature ? org.signature.text : formData.textSignature ?? ''}
        />
      )}

      {signatureEditable && (
        <SignatureEditor
          html={formData.htmlSignature ?? ''}
          text={formData.textSignature ?? ''}
          plainOnly={plainTextMode}
          disabled={isSubmitting}
          onChange={(next) => setFormData({ ...formData, ...next })}
          note={org.signature ? (
            <p className="text-xs text-muted-foreground mt-1" data-testid="identity-org-signature-default">
              {tOrg('identity_default')}
            </p>
          ) : null}
        />
      )}

      {/* Actions */}
      <div className="flex justify-end gap-2 pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting
            ? isEditing
              ? t('updating')
              : t('creating')
            : t('save')}
        </Button>
      </div>
    </form>
  );
}

/** The signature an address sends with when the admin locked signatures, read-only. */
export function LockedSignature({ html, text }: { html: string; text: string }) {
  const t = useTranslations('org_signature');
  const preview = html.trim() ? sanitizeSignatureHtmlForDisplay(html) : '';
  const plain = preview ? '' : getPlainTextSignature({ textSignature: text, htmlSignature: html });
  return (
    <div data-testid="identity-locked-signature">
      <span className="block text-sm font-medium mb-1">{t('identity_signature_label')}</span>
      <div className="p-2 border rounded bg-muted text-sm break-words min-w-0">
        {preview ? (
          <div dangerouslySetInnerHTML={{ __html: preview }} />
        ) : plain ? (
          <div className="whitespace-pre-wrap">{plain}</div>
        ) : (
          <div className="text-muted-foreground">{t('identity_no_signature')}</div>
        )}
      </div>
      <OrgLockedNote className="mt-1" />
    </div>
  );
}
