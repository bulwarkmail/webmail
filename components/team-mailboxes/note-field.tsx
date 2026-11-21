'use client';

import { forwardRef, useId, useImperativeHandle, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Send } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { noteLength } from '@/lib/team-mailboxes/note-format';

/** The counter shows up when this few characters are left. */
const SHOW_COUNT_BELOW = 200;

export interface NoteFieldHandle {
  focus: () => void;
  blur: () => void;
  /** Puts the caret here (after an @ name was put in). */
  setCaret: (at: number) => void;
}

interface NoteFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Enter or the button: the text is checked against the limit first. */
  onSubmit: () => void;
  /** Escape: leaves the field, the text stays as a draft. */
  onClose: () => void;
  /** Cancel: empties the field. */
  onCancel: () => void;
  /** Extra key handling first (the @ list); return true when it took the key. */
  onKeyDownFirst?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** The @ list, rendered under the field. */
  children?: React.ReactNode;
  textareaProps?: React.TextareaHTMLAttributes<HTMLTextAreaElement>;
}

/**
 * Where a note is written, always there above the reply box: one line until
 * it has the focus or text, then taller with Cancel and Add note. Enter
 * sends, Shift+Enter is a new line, Escape leaves the field (the text is
 * kept). Never sends while an input method is composing.
 */
export const NoteField = forwardRef<NoteFieldHandle, NoteFieldProps>(function NoteField(
  { value, onChange, onSubmit, onClose, onCancel, onKeyDownFirst, children, textareaProps },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const t = useTranslations('team_mailboxes');
  const tCommon = useTranslations('common');
  const area = useRef<HTMLTextAreaElement>(null);
  const counterId = useId();
  const fieldId = useId();
  useImperativeHandle(ref, () => ({
    // A kept draft goes on where it stopped: the caret at its end.
    focus: () => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    },
    blur: () => area.current?.blur(),
    setCaret: (at: number) => {
      // After React has put the new text in.
      requestAnimationFrame(() => {
        area.current?.focus();
        area.current?.setSelectionRange(at, at);
      });
    },
  }), []);
  const { left, over } = noteLength(value.trim());
  const empty = value.trim().length === 0;
  const expanded = focused || value.length > 0;

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
    <div
      className={cn('relative rounded-lg border border-note-border bg-note/50 px-2', expanded ? 'py-2' : 'py-1.5')}
      data-team-note-field=""
      data-expanded={expanded ? '' : undefined}
    >
      <label htmlFor={fieldId} className="sr-only">{t('field_label')}</label>
      <textarea
        id={fieldId}
        ref={area}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        rows={expanded ? 2 : 1}
        dir="auto"
        placeholder={t('placeholder')}
        aria-describedby={left < SHOW_COUNT_BELOW || over > 0 ? counterId : undefined}
        aria-invalid={over > 0 || undefined}
        className={cn(
          'block max-h-60 w-full bg-transparent px-1 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground',
          expanded ? 'min-h-[3.5rem] resize-y' : 'h-6 resize-none overflow-hidden',
        )}
        {...textareaProps}
      />
      {children}
      {expanded && (
      <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
        {(left < SHOW_COUNT_BELOW || over > 0) && (
          <span id={counterId} className={cn('me-auto text-xs', over > 0 ? 'text-destructive' : 'text-muted-foreground')} aria-live="polite">
            {over > 0 ? t('too_long', { count: over }) : t('chars_left', { count: left })}
          </span>
        )}
        {/* Pressing a button keeps the focus in the field, so the line doesn't fold under the pointer. */}
        <Button type="button" variant="ghost" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={onCancel}>{tCommon('cancel')}</Button>
        <Button type="button" size="sm" className="gap-1.5" onMouseDown={(e) => e.preventDefault()} onClick={onSubmit} disabled={empty || over > 0}>
          <Send className="h-4 w-4" />
          {t('add_note')}
        </Button>
      </div>
      )}
    </div>
  );
});
