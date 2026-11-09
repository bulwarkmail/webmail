'use client';

import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, LabelIcon } from '@/components/icons';
import type { ClassificationLabel } from '@/lib/admin/organisation-policy';
import { textColorOn } from '@/lib/classification/labels';
import { cn } from '@/lib/utils';

export interface ClassificationPickerHandle {
  /** Opens the picker with the focus on it (Send without a required label). */
  open: () => void;
}

interface Props {
  labels: ClassificationLabel[];
  selected: ClassificationLabel | null;
  required: boolean;
  /** Shows the trigger as missing (Send was pressed without a label). */
  invalid?: boolean;
  onPick: (id: string | null) => void;
  className?: string;
}

/**
 * The composer's label picker: a button in the label's colour that opens a
 * radio group (arrow keys move the pick, Enter or Escape closes, the focus
 * goes back to the button). Keys stay inside, away from the composer's and
 * the mail page's shortcuts. "No label" is offered unless one is required.
 */
export const ClassificationLabelPicker = forwardRef<ClassificationPickerHandle, Props>(function ClassificationLabelPicker(
  { labels, selected, required, invalid, onPick, className },
  ref,
) {
  const t = useTranslations('classification');
  const id = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const options: Array<ClassificationLabel | null> = required ? labels : [null, ...labels];
  const selectedIndex = Math.max(0, options.findIndex((o) => (o?.id ?? null) === (selected?.id ?? null)));

  useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), []);

  useEffect(() => {
    if (!open) return;
    const radios = groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]');
    radios?.[selectedIndex]?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!groupRef.current?.parentElement?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // Focus only when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const pick = (option: ClassificationLabel | null) => onPick(option?.id ?? null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const radios = [...(groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
    const current = radios.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      const next = (to + options.length) % options.length;
      pick(options[next]);
      radios[next]?.focus();
    };
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        e.preventDefault();
        move(current + 1);
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        e.preventDefault();
        move(current - 1);
        break;
      case 'Home':
        e.preventDefault();
        move(0);
        break;
      case 'End':
        e.preventDefault();
        move(options.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (current >= 0) pick(options[current]);
        close();
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  const name = selected?.name ?? (required ? t('pick_required') : t('none'));
  return (
    <div className={cn('relative', className)} data-testid="composer-classification">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('chip_label', { name })}
        aria-invalid={invalid || undefined}
        data-testid="composer-classification-trigger"
        className={cn(
          'inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors max-md:h-9',
          selected ? 'border-transparent' : 'border-dashed border-border text-muted-foreground hover:bg-muted',
          invalid && !selected && 'border-destructive text-destructive animate-pulse',
        )}
        style={selected ? { backgroundColor: selected.color, color: textColorOn(selected.color) } : undefined}
      >
        <LabelIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{name}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('picker_label')}
          className="absolute end-0 top-full z-50 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg max-md:start-0 max-md:end-auto"
          onKeyDown={onKeyDown}
        >
          {required && <p className="px-2 py-1 text-xs text-muted-foreground">{t('required_hint')}</p>}
          <div ref={groupRef} role="radiogroup" aria-labelledby={`${id}-label`} data-testid="composer-classification-options">
            <span id={`${id}-label`} className="sr-only">{t('picker_label')}</span>
            {options.map((option, index) => {
              const checked = (option?.id ?? null) === (selected?.id ?? null);
              return (
                <div
                  key={option?.id ?? 'none'}
                  role="radio"
                  aria-checked={checked}
                  tabIndex={index === selectedIndex ? 0 : -1}
                  data-testid={`composer-classification-option-${option?.id ?? 'none'}`}
                  onClick={() => { pick(option); close(); }}
                  className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    className={cn('mt-1 h-3 w-3 shrink-0 rounded-full', !option && 'border border-dashed border-muted-foreground')}
                    style={option ? { backgroundColor: option.color } : undefined}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{option?.name ?? t('none')}</span>
                    {option?.description && <span className="block text-xs text-muted-foreground">{option.description}</span>}
                  </span>
                  {checked && <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});
