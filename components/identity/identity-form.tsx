'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Identity, EmailAddress } from '@/lib/jmap/types';
import { sanitizeSignatureHtml, sanitizeSignatureHtmlForDisplay } from '@/lib/email-sanitization';
import { getEmailValidationError, validateEmailList } from '@/lib/validation';

// Stalwarts JMAP Identity/set caps signature fields at 2047 UTF-8 bytes
const SIGNATURE_MAX_BYTES = 2047;
const utf8Encoder = new TextEncoder();

function utf8ByteLength(s: string): number {
  return utf8Encoder.encode(s).length;
}

function truncateToUtf8Bytes(s: string, maxBytes: number): string {
  if (utf8ByteLength(s) <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (utf8ByteLength(s.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  // Don't split a surrogate pair: if we landed right after a high surrogate, back off one code unit.
  if (lo > 0) {
    const prev = s.charCodeAt(lo - 1);
    if (prev >= 0xD800 && prev <= 0xDBFF) lo -= 1;
  }
  return s.slice(0, lo);
}

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
}

export function IdentityForm({ identity, onSave, onCancel }: IdentityFormProps) {
  const t = useTranslations('identities.form');
  const tValidation = useTranslations('identities.validation_errors');
  const tDisplay = useTranslations('identities.display');
  const isEditing = !!identity;

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

  const parseEmailList = (input: string): EmailAddress[] | undefined => {
    if (!input.trim()) return undefined;

    const emails = input.split(',').map(e => e.trim()).filter(Boolean);
    return emails.map(email => ({ email }));
  };

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.name.trim()) {
      newErrors.name = t('name_required');
    }

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
        textSignature: trimmedText ? formData.textSignature : null,
        htmlSignature: trimmedHtml ? sanitizeSignatureHtml(formData.htmlSignature!) : null,
        replyTo: parseEmailList(replyToInput) ?? null,
        bcc: parseEmailList(bccInput) ?? null,
      };

      await onSave(sanitizedData);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Name */}
      <div>
        <label htmlFor="identity-name" className="block text-sm font-medium mb-1">
          {t('name_label')} <span className="text-destructive">*</span>
        </label>
        <Input
          id="identity-name"
          type="text"
          maxLength={256}
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={t('name_placeholder')}
          disabled={isSubmitting}
          className={errors.name ? 'border-destructive' : ''}
          aria-describedby={errors.name ? 'name-error' : undefined}
          aria-invalid={!!errors.name}
        />
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

      {/* Text Signature */}
      <div>
        <label htmlFor="identity-text-sig" className="block text-sm font-medium mb-1">
          {t('text_signature_label')}
        </label>
        <textarea
          id="identity-text-sig"
          value={formData.textSignature ?? ''}
          onChange={(e) => setFormData({ ...formData, textSignature: truncateToUtf8Bytes(e.target.value, SIGNATURE_MAX_BYTES) })}
          rows={3}
          disabled={isSubmitting}
          aria-label={t('text_signature_label')}
          aria-describedby="identity-text-sig-counter"
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground transition-all duration-200 placeholder:text-muted-foreground hover:border-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50"
        />
        <SignatureByteCounter id="identity-text-sig-counter" value={formData.textSignature || ''} />
      </div>

      {/* HTML Signature */}
      <div>
        <label htmlFor="identity-html-sig" className="block text-sm font-medium mb-1">
          {t('html_signature_label')}
        </label>
        <textarea
          id="identity-html-sig"
          value={formData.htmlSignature ?? ''}
          onChange={(e) => setFormData({ ...formData, htmlSignature: truncateToUtf8Bytes(e.target.value, SIGNATURE_MAX_BYTES) })}
          rows={5}
          disabled={isSubmitting}
          aria-label={t('html_signature_label')}
          aria-describedby="identity-html-sig-counter"
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground font-mono transition-all duration-200 placeholder:text-muted-foreground hover:border-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50"
        />
        <SignatureByteCounter id="identity-html-sig-counter" value={formData.htmlSignature || ''} />
        {formData.htmlSignature && (
          <div className="mt-2 p-2 border rounded bg-muted">
            <div className="text-xs text-muted-foreground mb-1">{tDisplay('preview')}</div>
            <div
              dangerouslySetInnerHTML={{
                __html: sanitizeSignatureHtmlForDisplay(formData.htmlSignature)
              }}
            />
          </div>
        )}
      </div>

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

function SignatureByteCounter({ id, value }: { id: string; value: string }) {
  const t = useTranslations('identities.form');
  const bytes = utf8ByteLength(value);
  const atLimit = bytes >= SIGNATURE_MAX_BYTES;
  const nearLimit = !atLimit && bytes >= Math.floor(SIGNATURE_MAX_BYTES * 0.9);
  const tone = atLimit
    ? 'text-destructive'
    : nearLimit
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-muted-foreground';
  return (
    <p
      id={id}
      className={`text-xs mt-1 tabular-nums ${tone}`}
      role="status"
      aria-live="polite"
    >
      {t('signature_byte_counter', { bytes, max: SIGNATURE_MAX_BYTES })}
      {atLimit && <span className="ms-1">{t('signature_byte_limit_reached')}</span>}
    </p>
  );
}
