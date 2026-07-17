'use client';

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { substitutePlaceholders, isBuiltInPlaceholder } from '@/lib/template-utils';
import { useFocusTrap } from '@/hooks/use-focus-trap';
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

  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const p of placeholders) {
      initial[p] = autoFilled[p] || '';
    }
    return initial;
  });

  const modalRef = useFocusTrap({
    isActive: true,
    onEscape: onClose,
    restoreFocus: true,
  });

  const preview = useMemo(() => {
    return substitutePlaceholders(template.body, values);
  }, [template.body, values]);

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[1px] flex items-center justify-center z-[60] p-4 animate-in fade-in duration-150">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="placeholder-fill-title"
        className={cn(
          'bg-background border border-border rounded-lg shadow-xl',
          'w-full max-w-lg max-h-[85vh] overflow-hidden',
          'animate-in zoom-in-95 duration-200'
        )}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 id="placeholder-fill-title" className="text-lg font-semibold text-foreground">
            {t('fill_placeholders')}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-muted transition-colors duration-150 text-muted-foreground hover:text-foreground"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto max-h-[calc(85vh-160px)] space-y-4">
          {placeholders.map((p) => (
            <div key={p}>
              <label className="text-sm font-medium text-foreground flex items-center gap-2">
                <span className="font-mono text-xs text-primary">{`{{${p}}}`}</span>
                {isBuiltInPlaceholder(p) && (
                  <span className="text-xs text-muted-foreground">{t(`placeholders.${p}`)}</span>
                )}
              </label>
              <Input
                value={values[p]}
                onChange={(e) => setValues((prev) => ({ ...prev, [p]: e.target.value }))}
                placeholder={t('enter_value')}
                className="mt-1"
              />
            </div>
          ))}

          {preview && (
            <div className="mt-4 pt-4 border-t border-border">
              <p className="text-xs font-medium text-muted-foreground mb-2">{t('preview')}</p>
              <div className="text-sm text-foreground whitespace-pre-wrap p-3 rounded-md bg-muted/50 border border-border max-h-32 overflow-y-auto">
                {template.isHTML ? <div dangerouslySetInnerHTML={{ __html: preview }}></div> : preview}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border">
          <Button variant="ghost" size="sm" onClick={onSkip}>
            {t('insert_raw')}
          </Button>
          <Button size="sm" onClick={() => onConfirm(values)}>
            {t('insert_with_values')}
          </Button>
        </div>
      </div>
    </div>
  );
}
