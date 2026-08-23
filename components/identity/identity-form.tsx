'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ImagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Identity, EmailAddress } from '@/lib/jmap/types';
import { sanitizeSignatureHtml, sanitizeSignatureHtmlForDisplay } from '@/lib/email-sanitization';
import { getEmailValidationError, validateEmailList } from '@/lib/validation';
import {
  SIGNATURE_ASSET_ATTR,
  buildJmapSignatureFallback,
  collectSignatureAssetIds,
  getExtendedSignature,
  placeholderSignatureAssetImages,
} from '@/lib/extended-signatures';
import {
  SIGNATURE_ASSET_MAX_BYTES,
  SIGNATURE_ASSETS_PER_IDENTITY_MAX,
} from '@/lib/signature-asset-constants';
import {
  uploadSignatureAssetClient,
  fetchSignatureAssetBlob,
  deleteSignatureAssetClient,
  blobToDataUrl,
} from '@/lib/signature-assets-client';
import { useSettingsStore } from '@/stores/settings-store';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { INLINE_IMAGE_PLACEHOLDER } from '@/lib/email-composer-utils';

// Stalwart's JMAP Identity/set caps signature fields at 2047 UTF-8 bytes
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
  if (lo > 0) {
    const prev = s.charCodeAt(lo - 1);
    if (prev >= 0xD800 && prev <= 0xDBFF) lo -= 1;
  }
  return s.slice(0, lo);
}

export interface IdentityFormData {
  name: string;
  email: string;
  replyTo?: EmailAddress[] | null;
  bcc?: EmailAddress[] | null;
  textSignature?: string | null;
  /** JMAP Identity.htmlSignature (image-free fallback when assets are used). */
  htmlSignature?: string | null;
  /** Bulwark extended HTML with data-signature-asset markers; null clears. */
  extendedSignatureHtml?: string | null;
  /** Asset ids present after save (for orphan cleanup). */
  signatureAssetIds?: string[];
  /** Asset ids that were referenced when the form opened. */
  previousSignatureAssetIds?: string[];
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

  const username = useAuthStore((s) => s.username);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const extendedSignatures = useSettingsStore((s) => s.extendedSignatures);

  const initialExtended = identity && activeAccountId
    ? getExtendedSignature(extendedSignatures, activeAccountId, identity.id)
    : null;
  const initialHtml = initialExtended?.html || identity?.htmlSignature || '';
  const initialAssetIds = collectSignatureAssetIds(initialHtml);

  const [formData, setFormData] = useState({
    name: identity?.name || '',
    email: identity?.email || '',
    replyTo: identity?.replyTo,
    bcc: identity?.bcc,
    textSignature: identity?.textSignature || '',
    htmlSignature: initialHtml,
  });

  const [replyToInput, setReplyToInput] = useState(
    identity?.replyTo?.map((a) => a.email).join(', ') || '',
  );
  const [bccInput, setBccInput] = useState(
    identity?.bcc?.map((a) => a.email).join(', ') || '',
  );

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [previewHtml, setPreviewHtml] = useState(() =>
    sanitizeSignatureHtmlForDisplay(placeholderSignatureAssetImages(initialHtml)),
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previousAssetIdsRef = useRef(initialAssetIds);

  // Hydrate asset placeholders in the live preview.
  useEffect(() => {
    let cancelled = false;
    const html = formData.htmlSignature || '';
    const sanitized = sanitizeSignatureHtmlForDisplay(placeholderSignatureAssetImages(html));
    setPreviewHtml(sanitized);

    const assetIds = collectSignatureAssetIds(html);
    if (!username || !serverUrl || assetIds.length === 0) return;

    (async () => {
      const doc = new DOMParser().parseFromString(`<body>${sanitized}</body>`, 'text/html');
      let touched = false;
      for (const assetId of assetIds) {
        try {
          const blob = await fetchSignatureAssetBlob(username, serverUrl, assetId);
          if (cancelled) return;
          const dataUrl = await blobToDataUrl(blob);
          doc.querySelectorAll(`img[${SIGNATURE_ASSET_ATTR}="${assetId}"]`).forEach((img) => {
            img.setAttribute('src', dataUrl);
            touched = true;
          });
        } catch {
          // Leave placeholder; non-fatal for preview.
        }
      }
      if (!cancelled && touched) {
        setPreviewHtml(doc.body.innerHTML);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [formData.htmlSignature, username, serverUrl]);

  const parseEmailList = (input: string): EmailAddress[] | undefined => {
    if (!input.trim()) return undefined;
    const emails = input.split(',').map((e) => e.trim()).filter(Boolean);
    return emails.map((email) => ({ email }));
  };

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.name.trim()) {
      newErrors.name = t('name_required');
    }

    const emailError = getEmailValidationError(formData.email);
    if (emailError) {
      newErrors.email = emailError;
    }

    if (replyToInput.trim()) {
      const validation = validateEmailList(replyToInput);
      if (!validation.valid) {
        newErrors.replyTo = tValidation('invalid_emails', { emails: validation.invalidEmails.join(', ') });
      }
    }

    if (bccInput.trim()) {
      const validation = validateEmailList(bccInput);
      if (!validation.valid) {
        newErrors.bcc = tValidation('invalid_emails', { emails: validation.invalidEmails.join(', ') });
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleInsertImage = async (file: File) => {
    setImageError(null);
    if (!identity?.id) {
      setImageError(t('image_requires_saved_identity'));
      return;
    }
    if (!username || !serverUrl) {
      setImageError(t('image_storage_unavailable'));
      return;
    }
    if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
      setImageError(t('image_type_rejected'));
      return;
    }
    if (file.size > SIGNATURE_ASSET_MAX_BYTES) {
      setImageError(t('image_too_large', { maxMb: 1 }));
      return;
    }
    const currentCount = collectSignatureAssetIds(formData.htmlSignature || '').length;
    if (currentCount >= SIGNATURE_ASSETS_PER_IDENTITY_MAX) {
      setImageError(t('image_too_many', { max: SIGNATURE_ASSETS_PER_IDENTITY_MAX }));
      return;
    }

    setIsUploadingImage(true);
    try {
      const asset = await uploadSignatureAssetClient(username, serverUrl, identity.id, file);
      const tag = `<p><img ${SIGNATURE_ASSET_ATTR}="${asset.id}" alt="" src="${INLINE_IMAGE_PLACEHOLDER}"></p>`;
      setFormData((prev) => ({
        ...prev,
        htmlSignature: `${prev.htmlSignature || ''}${tag}`,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('image_upload_failed');
      setImageError(message);
    } finally {
      setIsUploadingImage(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setIsSubmitting(true);
    try {
      const trimmedText = formData.textSignature?.trim() ?? '';
      const rawHtml = formData.htmlSignature?.trim() ?? '';
      const sanitizedHtml = rawHtml ? sanitizeSignatureHtml(rawHtml) : '';
      const assetIds = collectSignatureAssetIds(sanitizedHtml);
      const hasAssets = assetIds.length > 0;

      const jmapHtml = hasAssets
        ? truncateToUtf8Bytes(buildJmapSignatureFallback(sanitizedHtml), SIGNATURE_MAX_BYTES)
        : truncateToUtf8Bytes(sanitizedHtml, SIGNATURE_MAX_BYTES);

      const previousIds = previousAssetIdsRef.current;
      const removed = previousIds.filter((id) => !assetIds.includes(id));
      if (username && serverUrl && removed.length > 0) {
        await Promise.allSettled(
          removed.map((id) => deleteSignatureAssetClient(username, serverUrl, id)),
        );
      }

      const payload: IdentityFormData = {
        name: formData.name,
        email: formData.email,
        replyTo: parseEmailList(replyToInput) ?? null,
        bcc: parseEmailList(bccInput) ?? null,
        textSignature: trimmedText ? formData.textSignature : null,
        htmlSignature: jmapHtml.trim() ? jmapHtml : null,
        extendedSignatureHtml: hasAssets ? sanitizedHtml : null,
        signatureAssetIds: assetIds,
        previousSignatureAssetIds: previousIds,
      };

      await onSave(payload);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
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
          <p id="name-error" className="text-sm text-destructive mt-1" role="alert" aria-live="polite" aria-atomic="true">
            {errors.name}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="identity-email" className="block text-sm font-medium mb-1">
          {t('email_label')} <span className="text-destructive">*</span>
        </label>
        <Input
          id="identity-email"
          type="email"
          value={formData.email}
          onChange={(e) => setFormData({ ...formData, email: e.target.value })}
          placeholder={t('email_placeholder')}
          disabled={isSubmitting || isEditing}
          className={errors.email ? 'border-destructive' : ''}
          aria-describedby={errors.email ? 'email-error' : isEditing ? 'email-immutable-hint' : undefined}
          aria-invalid={!!errors.email}
        />
        {isEditing && (
          <p id="email-immutable-hint" className="text-xs text-muted-foreground mt-1">
            {t('email_immutable')}
          </p>
        )}
        {errors.email && (
          <p id="email-error" className="text-sm text-destructive mt-1" role="alert" aria-live="polite" aria-atomic="true">
            {errors.email}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="identity-reply-to" className="block text-sm font-medium mb-1">
          {t('reply_to_label')}
        </label>
        <Input
          id="identity-reply-to"
          type="text"
          value={replyToInput}
          onChange={(e) => setReplyToInput(e.target.value)}
          placeholder={t('reply_to_placeholder')}
          disabled={isSubmitting}
          className={errors.replyTo ? 'border-destructive' : ''}
          aria-describedby={errors.replyTo ? 'reply-to-error' : undefined}
          aria-invalid={!!errors.replyTo}
        />
        {errors.replyTo && (
          <p id="reply-to-error" className="text-sm text-destructive mt-1" role="alert" aria-live="polite" aria-atomic="true">
            {errors.replyTo}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="identity-bcc" className="block text-sm font-medium mb-1">
          {t('bcc_label')}
        </label>
        <Input
          id="identity-bcc"
          type="text"
          value={bccInput}
          onChange={(e) => setBccInput(e.target.value)}
          placeholder={t('bcc_placeholder')}
          disabled={isSubmitting}
          className={errors.bcc ? 'border-destructive' : ''}
          aria-describedby={errors.bcc ? 'bcc-error' : undefined}
          aria-invalid={!!errors.bcc}
        />
        {errors.bcc && (
          <p id="bcc-error" className="text-sm text-destructive mt-1" role="alert" aria-live="polite" aria-atomic="true">
            {errors.bcc}
          </p>
        )}
      </div>

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

      <div>
        <div className="flex items-center justify-between gap-2 mb-1">
          <label htmlFor="identity-html-sig" className="block text-sm font-medium">
            {t('html_signature_label')}
          </label>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleInsertImage(file);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isSubmitting || isUploadingImage || !isEditing}
              onClick={() => fileInputRef.current?.click()}
              title={!isEditing ? t('image_requires_saved_identity') : t('insert_image')}
            >
              <ImagePlus className="size-4 me-1" aria-hidden />
              {isUploadingImage ? t('uploading_image') : t('insert_image')}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mb-2">{t('image_help')}</p>
        {imageError && (
          <p className="text-sm text-destructive mb-2" role="alert" aria-live="polite">
            {imageError}
          </p>
        )}
        <textarea
          id="identity-html-sig"
          value={formData.htmlSignature ?? ''}
          onChange={(e) => setFormData({ ...formData, htmlSignature: e.target.value })}
          rows={5}
          disabled={isSubmitting}
          aria-label={t('html_signature_label')}
          aria-describedby="identity-html-sig-counter"
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground font-mono transition-all duration-200 placeholder:text-muted-foreground hover:border-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50"
        />
        {collectSignatureAssetIds(formData.htmlSignature || '').length === 0 ? (
          <SignatureByteCounter id="identity-html-sig-counter" value={formData.htmlSignature || ''} />
        ) : (
          <p id="identity-html-sig-counter" className="text-xs mt-1 text-muted-foreground" role="status">
            {t('image_assets_note', {
              count: collectSignatureAssetIds(formData.htmlSignature || '').length,
            })}
          </p>
        )}
        {formData.htmlSignature && (
          <div className="mt-2 p-2 border rounded bg-muted">
            <div className="text-xs text-muted-foreground mb-1">{tDisplay('preview')}</div>
            <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-4">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={isSubmitting || isUploadingImage}>
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
    <p id={id} className={`text-xs mt-1 tabular-nums ${tone}`} role="status" aria-live="polite">
      {t('signature_byte_counter', { bytes, max: SIGNATURE_MAX_BYTES })}
      {atLimit && <span className="ms-1">{t('signature_byte_limit_reached')}</span>}
    </p>
  );
}
