'use client';

import { forwardRef, useId, useImperativeHandle, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Send } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { noteLength } from '@/lib/team-mailboxes/note-format';

/** The counter shows up when this few characters are left. */
const SHOW_COUNT_BELOW = 200;

export interface NoteFieldHandle {
  focus: () => void;
}

interface NoteFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter or the button: the text is checked against the limit first. */
  onSubmit: () => void;
  /** Escape or Cancel: closes the field, the text stays as a draft. */
  onClose: () => void;
  /** Extra key handling first (the @ list); return true when it took the key. */
  onKeyDownFirst?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** The @ list, rendered under the field. */
  children?: React.ReactNode;
  textareaProps?: React.TextareaHTMLAttributes<HTMLTextAreaElement>;
}

/**
 * Where a note is written: Enter sends, Shift+Enter is a new line, Escape
 * closes (the text is kept). Never sends while an input method is composing.
 */
export const NoteField = forwardRef<NoteFieldHandle, NoteFieldProps>(function NoteField(
  { value, onChange, onSubmit, onClose, onKeyDownFirst, children, textareaProps },
  ref,
) {
  const t = useTranslations('team_mailboxes');
  const tCommon = useTranslations('common');
  const area = useRef<HTMLTextAreaElement>(null);
  const counterId = useId();
  const fieldId = useId();
  useImperativeHandle(ref, () => ({ focus: () => area.current?.focus() }), []);
  const { left, over } = noteLength(value.trim());
  const empty = value.trim().length === 0;

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (onKeyDownFirst?.(event)) return;
    // Keys typed here never reach the mail shortcuts.
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (!empty && over === 0) onSubmit();
    }
  };

  return (
    <div className="relative rounded-lg border border-note-border bg-background p-2" data-team-note-field="">
      <label htmlFor={fieldId} className="sr-only">{t('field_label')}</label>
      <textarea
        id={fieldId}
        ref={area}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        dir="auto"
        placeholder={t('placeholder')}
        aria-describedby={left < SHOW_COUNT_BELOW || over > 0 ? counterId : undefined}
        aria-invalid={over > 0 || undefined}
        className="block max-h-60 min-h-[3.5rem] w-full resize-y bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
        {...textareaProps}
      />
      {children}
      <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
        {(left < SHOW_COUNT_BELOW || over > 0) && (
          <span id={counterId} className={cn('me-auto text-xs', over > 0 ? 'text-destructive' : 'text-muted-foreground')} aria-live="polite">
            {over > 0 ? t('too_long', { count: over }) : t('chars_left', { count: left })}
          </span>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>{tCommon('cancel')}</Button>
        <Button type="button" size="sm" className="gap-1.5" onClick={onSubmit} disabled={empty || over > 0}>
          <Send className="h-4 w-4" />
          {t('add_note')}
        </Button>
      </div>
    </div>
  );
});
