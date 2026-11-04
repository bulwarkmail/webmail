'use client';

import { useId, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { RichTextEditor } from '@/components/email/rich-text-editor';
import { sanitizeSignatureHtml, sanitizeSignatureHtmlForDisplay } from '@/lib/email-sanitization';
import { htmlToPlainText } from '@/lib/html-to-text';
import { textToParagraphHtml } from '@/lib/text-to-paragraph-html';
import { useSettingsStore } from '@/stores/settings-store';
import { cn } from '@/lib/utils';

/** Stalwart's JMAP Identity/set caps each signature field at 2047 UTF-8 bytes. */
export const SIGNATURE_MAX_BYTES = 2047;
/** The size shows from here on, so it is there before the limit is reached. */
const SHOW_SIZE_FROM = Math.floor(SIGNATURE_MAX_BYTES * 0.9);

const utf8Encoder = new TextEncoder();
const utf8ByteLength = (value: string) => utf8Encoder.encode(value).length;

/** The plain-text part a save sends with a formatted signature. */
export function textFromSignatureHtml(html: string): string {
  const clean = sanitizeSignatureHtml(html);
  return clean ? htmlToPlainText(clean).trim() : '';
}

/** Whether a formatted signature holds anything: text, or a picture. */
function hasSignatureContent(html: string): boolean {
  const clean = sanitizeSignatureHtml(html);
  return !!clean && (!!htmlToPlainText(clean).trim() || /<img\b/i.test(clean));
}

/**
 * The bytes the larger of the two fields takes as a save sends them: the
 * sanitized HTML and the plain text. A plain-text-only signature sends its
 * text alone.
 */
export function signatureBytes(html: string, text: string, plainOnly: boolean): number {
  const textBytes = utf8ByteLength(text);
  if (plainOnly) return textBytes;
  return Math.max(textBytes, utf8ByteLength(html.trim() ? sanitizeSignatureHtml(html) : ''));
}

export interface SignatureChange {
  htmlSignature?: string;
  textSignature?: string;
}

/**
 * One signature field. With formatting it is the composer's editor (bold,
 * links, lists, tables); the plain-text version is generated from it on every
 * change, so the two can't drift apart. "Edit as HTML" (shown with advanced
 * settings on) swaps in the HTML source. Someone who writes plain text only
 * (Composing) gets a plain text box, which leaves a stored HTML version alone.
 */
export function SignatureEditor({ html, text, plainOnly, disabled, onChange, note }: {
  html: string;
  text: string;
  plainOnly: boolean;
  disabled?: boolean;
  onChange: (change: SignatureChange) => void;
  /** A line under the field (the organisation's default signature). */
  note?: ReactNode;
}) {
  const t = useTranslations('uxs_vacation');
  const showAdvanced = useSettingsStore((s) => s.showAdvancedSettings);
  const [source, setSource] = useState(false);
  const labelId = useId();
  const sizeId = useId();
  const sourceId = useId();

  const bytes = signatureBytes(html, text, plainOnly);
  const tooLong = bytes > SIGNATURE_MAX_BYTES;
  const sizeShown = bytes >= SHOW_SIZE_FROM;

  const editHtml = (value: string) => {
    const kept = hasSignatureContent(value) ? value : '';
    onChange({ htmlSignature: kept, textSignature: kept ? textFromSignatureHtml(kept) : '' });
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <span id={labelId} className="block text-sm font-medium">
          {plainOnly ? t('signature_plain_label') : t('signature_label')}
        </span>
        {!plainOnly && (showAdvanced || source) && (
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={() => setSource((on) => !on)}
            aria-pressed={source}
            disabled={disabled}
          >
            {source ? t('edit_formatted') : t('edit_as_html')}
          </button>
        )}
      </div>

      {plainOnly ? (
        <>
          <textarea
            value={text}
            onChange={(e) => onChange({ textSignature: e.target.value })}
            rows={4}
            disabled={disabled}
            aria-labelledby={labelId}
            aria-describedby={sizeShown ? sizeId : undefined}
            aria-invalid={tooLong}
            className={cn(
              'flex w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground transition-all duration-200 hover:border-muted-foreground focus-visible:outline-hidden focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50',
              tooLong ? 'border-destructive' : 'border-input',
            )}
          />
          <p className="text-xs text-muted-foreground mt-1">{t('signature_plain_description')}</p>
        </>
      ) : source ? (
        <>
          <textarea
            id={sourceId}
            value={html}
            onChange={(e) => editHtml(e.target.value)}
            rows={6}
            disabled={disabled}
            aria-label={t('html_source_label')}
            aria-describedby={sizeShown ? sizeId : undefined}
            aria-invalid={tooLong}
            className={cn(
              'flex w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground font-mono transition-all duration-200 hover:border-muted-foreground focus-visible:outline-hidden focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50',
              tooLong ? 'border-destructive' : 'border-input',
            )}
          />
          {html.trim() && (
            <div
              className="mt-2 p-2 border rounded bg-muted text-sm break-words min-w-0"
              data-testid="signature-source-preview"
              dangerouslySetInnerHTML={{ __html: sanitizeSignatureHtmlForDisplay(html) }}
            />
          )}
        </>
      ) : (
        <div className={cn('rounded-md border overflow-hidden', tooLong ? 'border-destructive' : 'border-input')}>
          <RichTextEditor
            content={html || textToParagraphHtml(text)}
            onChange={editHtml}
            ariaLabel={t('signature_label')}
            ariaInvalid={tooLong}
            ariaDescribedBy={sizeShown ? sizeId : undefined}
          />
        </div>
      )}

      {sizeShown && (
        <p
          id={sizeId}
          data-testid="signature-size"
          role="status"
          aria-live="polite"
          className={cn('text-xs mt-1 tabular-nums', tooLong ? 'text-destructive' : 'text-amber-600 dark:text-amber-400')}
        >
          {tooLong
            ? t('signature_too_long', { bytes, max: SIGNATURE_MAX_BYTES })
            : t('signature_size', { bytes, max: SIGNATURE_MAX_BYTES })}
        </p>
      )}
      {note}
    </div>
  );
}
