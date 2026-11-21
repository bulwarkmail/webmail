'use client';

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { useDiscardChanges } from '@/components/settings/use-discard-changes';
import { substitutePlaceholders, isBuiltInPlaceholder, getPlaceholderDefaults } from '@/lib/template-utils';
import { sanitizeEmailHtml } from '@/lib/email-sanitization';
import type { EmailTemplate } from '@/lib/template-types';

interface PlaceholderFillModalProps {
  template: EmailTemplate;
  placeholders: string[];
  autoFilled: Record<string, string>;
  onConfirm: (values: Record<string, string>) => void;
  onSkip: () => void;
  onClose: () => void;
}

export function PlaceholderFillModal({
  template,
  placeholders,
  autoFilled,
  onConfirm,
  onSkip,
  onClose,
}: PlaceholderFillModalProps) {
  const t = useTranslations('templates');
  const { confirmDiscard, discardDialog } = useDiscardChanges();

  const [initialValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    const defaults = getPlaceholderDefaults(template);
    for (const p of placeholders) {
      initial[p] = autoFilled[p] || defaults.get(p) || '';
    }
    return initial;
  });
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  // Typed values would be lost: Escape, the X and outside clicks ask first (R5).
  const dirty = placeholders.some((p) => values[p] !== initialValues[p]);

  const preview = useMemo(() => {
    return substitutePlaceholders(template.body, values, { html: !!template.isHTML });
  }, [template.body, template.isHTML, values]);

  const requestClose = async () => {
    if (await confirmDiscard(dirty)) onClose();
  };

  return (
    <>
      <Dialog
        isOpen
        onClose={() => void requestClose()}
        title={t('fill_placeholders')}
        dirty={dirty}
        size="md"
        testId="placeholder-fill"
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm(values);
        }}
        footer={
          <>
            <Button type="button" variant="outline" onClick={onSkip}>
              {t('insert_raw')}
            </Button>
            <Button type="submit">
              {t('insert_with_values')}
            </Button>
          </>
        }
      >
        <div className="space-y-4 pt-4">
          {placeholders.map((p) => (
            <div key={p}>
              <label htmlFor={`placeholder-${p}`} className="text-sm font-medium text-foreground flex items-center gap-2">
                <span className="font-mono text-xs text-primary">{`{{${p}}}`}</span>
                {isBuiltInPlaceholder(p) && (
                  <span className="text-xs text-muted-foreground">{t(`placeholders.${p}`)}</span>
                )}
              </label>
              <Input
                id={`placeholder-${p}`}
                value={values[p]}
                onChange={(e) => setValues((prev) => ({ ...prev, [p]: e.target.value }))}
                onFocus={(e) => {
                  if (values[p] && values[p] === initialValues[p]) e.currentTarget.select();
                }}
                placeholder={t('enter_value')}
                className="mt-1"
              />
            </div>
          ))}

          {preview && (
            <div className="pt-4 border-t border-border">
              <p className="text-xs font-medium text-muted-foreground mb-2">{t('preview')}</p>
              <div className="text-sm text-foreground whitespace-pre-wrap p-3 rounded-md bg-muted/50 border border-border max-h-32 overflow-y-auto">
                {/* The body may come from an imported file or a synced blob; it is markup in the app document here. */}
                {template.isHTML ? <div dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(preview) }}></div> : preview}
              </div>
            </div>
          )}
        </div>
      </Dialog>
      {discardDialog}
    </>
  );
}
