'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Loader2 } from '@/components/icons';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { validateTemplateName } from '@/lib/template-utils';

interface QuickSaveTemplateDialogProps {
  /** The name to start with: the message's subject. */
  defaultName: string;
  onSave: (name: string) => void;
  /** "Edit details…": the full template editor, with the name typed so far. */
  onEditDetails: (name: string) => void;
  onClose: () => void;
  /** What is saved is still being read (a message's images): Save and Edit details wait. */
  busy?: boolean;
}

/**
 * "Save as template" from the composer: a name and Save. The full editor
 * (category, recipients, sending identity, favourite) is one click further,
 * behind "Edit details…"; it used to open straight away with nine fields.
 */
export function QuickSaveTemplateDialog({ defaultName, onSave, onEditDetails, onClose, busy = false }: QuickSaveTemplateDialogProps) {
  const tComposer = useTranslations('email_composer');
  const tSend = useTranslations('compose_send');
  const tSettings = useTranslations('settings.templates');
  const tCommon = useTranslations('common');
  const fieldId = useId();
  const [name, setName] = useState(defaultName);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    if (busy) return;
    const problem = validateTemplateName(name);
    if (problem) {
      setError(problem);
      return;
    }
    onSave(name.trim());
  };

  return (
    <Dialog
      isOpen
      onClose={onClose}
      title={tComposer('save_as_template')}
      size="sm"
      dirty={name !== defaultName}
      testId="quick-save-template"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      footer={
        <>
          <Button type="button" variant="ghost" className="me-auto" disabled={busy} onClick={() => onEditDetails(name)}>
            {tSend('template_edit_details')}
          </Button>
          <Button type="button" variant="outline" onClick={onClose}>{tCommon('cancel')}</Button>
          <Button type="submit" disabled={busy || !name.trim()} aria-busy={busy || undefined}>
            {busy && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {tCommon('save')}
          </Button>
        </>
      }
    >
      <div className="mt-4">
        <label htmlFor={fieldId} className="text-sm font-medium text-foreground">{tSend('template_name')}</label>
        <Input
          id={fieldId}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          className={cn('mt-1', error && 'border-destructive')}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${fieldId}-error` : undefined}
          autoFocus
        />
        {error && (
          <p id={`${fieldId}-error`} className="text-xs text-red-600 dark:text-red-400 mt-1">
            {tSettings(`validation.${error}`)}
          </p>
        )}
      </div>
    </Dialog>
  );
}
