'use client';

// The plugin UI kit: the app's own controls, for plugin iframes. Plugins get
// it as `require('@plugin-host/ui')`; the runtime hands over this module, so
// a plugin bundle carries none of it and always matches the app it runs in.
//
// Every component is built from the same Tailwind classes as its
// counterpart in the app (named in each comment), and
// ui-kit.test.tsx checks that those classes are still the app's. The CSS
// comes from app/(sandbox)/plugin-kit.css, which scans this folder only, so
// classes must be written out in full here (no string building).
//
// Each component's root carries `bk`, which scopes the CSS reset to kit
// elements: a plugin's own markup keeps the browser defaults it was written
// against.

import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button as AppButton } from '@/components/ui/button';
import { Input as AppInput } from '@/components/ui/input';
import { getFileIconByName, getFolderIcon } from '@/components/files/file-icons';
import { iconForName } from '@/components/icons/named';
import { Check, ChevronDown, ChevronRight, ChevronUp, Loader2, Puzzle, Search, X } from '@/components/icons';
import {
  isFloatingDropdownSupported,
  openFloatingDropdown,
  updateFloatingDropdown,
  closeFloatingDropdown,
  registerFloatingDropdownListener,
} from './floating-dropdown-bridge';

type Children = { children?: React.ReactNode };
type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'primary';

// ─── Icons ─────────────────────────────────────────────────────

/** An app icon by name (the names api.ui.setActions takes). Unknown names show a puzzle piece. */
export function Icon({ name, size = 'md', className }: { name?: string; size?: 'xs' | 'sm' | 'md' | 'lg'; className?: string }) {
  const Glyph = (name ? iconForName(name) : null) ?? Puzzle;
  const sizeClass = { xs: 'w-3 h-3', sm: 'w-3.5 h-3.5', md: 'w-4 h-4', lg: 'w-5 h-5' }[size];
  return <Glyph className={cn('bk flex-shrink-0', sizeClass, className)} aria-hidden="true" />;
}

/** The Files app's icon for a file name (by extension), or its folder icon. */
export function FileIcon({ name = '', folder = false, size = 'sm' }: { name?: string; folder?: boolean; size?: 'sm' | 'md' | 'lg' }) {
  return <span className="bk inline-flex flex-shrink-0" aria-hidden="true">{folder ? getFolderIcon(size) : getFileIconByName(name, size)}</span>;
}

/** Loader2 with animate-spin, as everywhere in the app. */
export function Spinner({ size = 'md', label }: { size?: 'sm' | 'md' | 'lg'; label?: string }) {
  const sizeClass = { sm: 'w-3.5 h-3.5', md: 'w-4 h-4', lg: 'w-6 h-6' }[size];
  return (
    <span className="bk inline-flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader2 className={cn(sizeClass, 'animate-spin')} aria-hidden="true" />
      {label ? <span>{label}</span> : <span className="sr-only">…</span>}
    </span>
  );
}

/** A spinner in the middle of a page or panel (plugin-page-app's loading state). */
export function Loading({ label }: { label?: string }) {
  return (
    <div className="bk flex items-center justify-center py-12">
      <Spinner size="lg" label={label} />
    </div>
  );
}

// ─── Buttons ───────────────────────────────────────────────────

export interface KitButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** primary = the app's default button, secondary = outline. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive';
  size?: 'sm' | 'md' | 'icon';
  icon?: string;
  /** Shows a spinner and disables the button. */
  busy?: boolean;
  children?: React.ReactNode;
}

const BUTTON_VARIANT = { primary: 'default', secondary: 'outline', ghost: 'ghost', destructive: 'destructive' } as const;

/** components/ui/button.tsx itself. */
export const Button = React.forwardRef<HTMLButtonElement, KitButtonProps>(function Button(
  { variant = 'primary', size = 'md', icon, busy = false, disabled, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <AppButton
      ref={ref}
      type={type}
      variant={BUTTON_VARIANT[variant] ?? 'default'}
      size={size}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cn('bk gap-1.5', size !== 'icon' && size !== 'sm' && 'text-sm', className)}
      {...rest}
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </AppButton>
  );
});

/** A text link styled like the app's inline links ("Add condition"). */
export function LinkButton({ icon, children, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: string }) {
  return (
    <button type="button" className={cn('bk inline-flex items-center gap-1 text-sm text-primary hover:underline disabled:opacity-50 disabled:pointer-events-none', className)} {...rest}>
      {icon && <Icon name={icon} size="sm" />}
      {children}
    </button>
  );
}

/** An external link: opens in a new tab. */
export function Link({ href, children, className }: { href: string; className?: string } & Children) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cn('bk text-primary hover:underline underline-offset-2', className)}>
      {children}
    </a>
  );
}

// ─── Form controls ─────────────────────────────────────────────

/** components/ui/input.tsx itself. */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <AppInput ref={ref} className={cn('bk', className)} {...rest} />;
});

/** The textarea of the identity form (Input without the fixed height). */
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn('bk flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground transition-all duration-200 placeholder:text-muted-foreground hover:border-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50', className)}
      {...rest}
    />
  );
});

export interface KitSelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  options?: { value: string; label: string; disabled?: boolean }[];
  /** Called with the new value. */
  onChange?: (value: string, event: React.ChangeEvent<HTMLSelectElement>) => void;
  /** Stretch to the width of its container (forms); settings rows keep it narrow. */
  block?: boolean;
}

/** The settings select (settings-section.tsx). */
export function Select({ options, children, onChange, disabled, block = false, className, ...rest }: KitSelectProps) {
  return (
    <select
      className={cn(
        'bk px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors duration-150',
        disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:border-muted-foreground',
        block && 'w-full',
        className,
      )}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.value, e)}
      {...rest}
    >
      {options?.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
      {children}
    </select>
  );
}

export interface KitComboboxOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface KitComboboxProps {
  options?: KitComboboxOption[];
  /** Currently selected value (string for single, string[] for multiple). */
  value?: string | string[] | null;
  /** Called with the selected value (string for single, string[] for multiple). */
  onChange?: (value: any) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Stretch to the width of its container (forms); settings rows keep it narrow. */
  block?: boolean;
  /** Allow selecting multiple options (e.g. for tags). */
  multiple?: boolean;
  /** Whether the user can clear the selected value (default: true). */
  clearable?: boolean;
  id?: string;
  /** Accessible label when not wrapped by Field. */
  ariaLabel?: string;
  className?: string;
}

/** A searchable combobox with keyboard navigation, clear button and multiselect support. */
export function Combobox({
  options = [],
  value,
  onChange,
  placeholder,
  disabled = false,
  block = false,
  multiple = false,
  clearable = true,
  id,
  ariaLabel,
  className,
}: KitComboboxProps) {
  const autoId = React.useId();
  const inputId = id ?? autoId;
  const listboxId = `${inputId}-listbox`;

  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const optionRefs = React.useRef<(HTMLDivElement | null)[]>([]);

  const [isOpen, setIsOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [isTyping, setIsTyping] = React.useState(false);
  const [highlightedIndex, setHighlightedIndex] = React.useState(-1);

  const selectedValues = React.useMemo(() => {
    if (multiple) {
      return Array.isArray(value) ? value : value ? [value] : [];
    }
    return [];
  }, [multiple, value]);

  const singleValue = React.useMemo(() => {
    if (multiple) return '';
    return typeof value === 'string' ? value : '';
  }, [multiple, value]);

  const selectedOption = React.useMemo(() => {
    if (multiple || !singleValue) return null;
    return options.find((o) => o.value === singleValue) || null;
  }, [multiple, singleValue, options]);

  const selectedOptions = React.useMemo(() => {
    if (!multiple) return [];
    return options.filter((o) => selectedValues.includes(o.value));
  }, [multiple, options, selectedValues]);

  // Synchronize input query with selected option label when not typing in single-select mode
  React.useEffect(() => {
    if (!isTyping) {
      if (multiple) {
        setQuery('');
      } else {
        setQuery(selectedOption ? selectedOption.label : '');
      }
    }
  }, [selectedOption, isTyping, multiple]);

  const filteredOptions = React.useMemo(() => {
    if (!isTyping || !query.trim()) return options;
    const q = query.trim().toLowerCase();
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, isTyping, query]);

  // When opening dropdown, pre-highlight the currently selected item or first item
  React.useEffect(() => {
    if (isOpen) {
      if (multiple) {
        setHighlightedIndex(filteredOptions.length > 0 ? 0 : -1);
      } else {
        const idx = filteredOptions.findIndex((o) => o.value === singleValue);
        setHighlightedIndex(idx >= 0 ? idx : filteredOptions.length > 0 ? 0 : -1);
      }
    } else {
      setHighlightedIndex(-1);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll highlighted option into view
  React.useEffect(() => {
    if (isOpen && highlightedIndex >= 0 && optionRefs.current[highlightedIndex]) {
      const el = optionRefs.current[highlightedIndex];
      if (typeof el?.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [isOpen, highlightedIndex]);

  // Close when clicking outside
  React.useEffect(() => {
    if (!isOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setIsTyping(false);
        if (multiple) {
          setQuery('');
        } else {
          setQuery(selectedOption ? selectedOption.label : '');
        }
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [isOpen, selectedOption, multiple]);

  const toggleMultipleOption = (opt: KitComboboxOption) => {
    if (opt.disabled) return;
    const exists = selectedValues.includes(opt.value);
    const next = exists ? selectedValues.filter((v) => v !== opt.value) : [...selectedValues, opt.value];
    onChange?.(next);
    setQuery('');
    setIsTyping(false);
    if (isOpen) {
      inputRef.current?.focus();
    }
  };

  const selectOption = (opt: KitComboboxOption) => {
    if (opt.disabled) return;
    if (multiple) {
      toggleMultipleOption(opt);
    } else {
      onChange?.(opt.value);
      setIsOpen(false);
      setIsTyping(false);
      setQuery(opt.value ? opt.label : '');
      inputRef.current?.focus();
    }
  };

  const isHostFloating = isFloatingDropdownSupported();

  const getContainerRect = () => {
    if (!containerRef.current) return null;
    const r = containerRef.current.getBoundingClientRect();
    return {
      left: Math.round(r.left),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  };

  const selectOptionRef = React.useRef(selectOption);
  selectOptionRef.current = selectOption;
  const selectedOptionRef = React.useRef(selectedOption);
  selectedOptionRef.current = selectedOption;

  // When isOpen changes: if host floating dropdown is active, open it on host and register listener
  React.useEffect(() => {
    if (!isHostFloating) return;
    if (isOpen) {
      const rect = getContainerRect();
      if (!rect) return;
      openFloatingDropdown({
        id: listboxId,
        rect,
        options: filteredOptions,
        multiple,
        selectedValues,
        singleValue,
        highlightedIndex,
        ariaLabel: ariaLabel ?? placeholder,
      });

      const unregister = registerFloatingDropdownListener(listboxId, (ev) => {
        if (ev.type === 'select') {
          selectOptionRef.current(ev.option);
        } else if (ev.type === 'highlight') {
          setHighlightedIndex(ev.index);
        } else if (ev.type === 'dismiss') {
          setIsOpen(false);
          setIsTyping(false);
          if (multiple) {
            setQuery('');
          } else {
            setQuery(selectedOptionRef.current ? selectedOptionRef.current.label : '');
          }
        }
      });

      return () => {
        unregister();
        closeFloatingDropdown(listboxId);
      };
    }
  }, [isOpen, isHostFloating, listboxId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Push updates to host dropdown when options, selection, or highlight changes while open
  React.useEffect(() => {
    if (!isHostFloating || !isOpen) return;
    const rect = getContainerRect();
    updateFloatingDropdown({
      id: listboxId,
      ...(rect ? { rect } : {}),
      options: filteredOptions,
      multiple,
      selectedValues,
      singleValue,
      highlightedIndex,
    });
  }, [isHostFloating, isOpen, filteredOptions, selectedValues, singleValue, highlightedIndex, multiple, listboxId]);

  const handleClear = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (multiple) {
      onChange?.([]);
    } else {
      onChange?.('');
    }
    setQuery('');
    setIsTyping(false);
    setIsOpen(false);
  };

  const handleToggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    if (isOpen) {
      setIsOpen(false);
      setIsTyping(false);
      if (multiple) {
        setQuery('');
      } else {
        setQuery(selectedOption ? selectedOption.label : '');
      }
    } else {
      setIsOpen(true);
      setIsTyping(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        setIsTyping(false);
      } else if (filteredOptions.length > 0) {
        setHighlightedIndex((prev) => (prev + 1 < filteredOptions.length ? prev + 1 : 0));
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        setIsTyping(false);
      } else if (filteredOptions.length > 0) {
        setHighlightedIndex((prev) => (prev - 1 >= 0 ? prev - 1 : filteredOptions.length - 1));
      }
    } else if (e.key === 'Enter') {
      if (isOpen && highlightedIndex >= 0 && highlightedIndex < filteredOptions.length) {
        e.preventDefault();
        selectOption(filteredOptions[highlightedIndex]);
      }
    } else if (e.key === 'Escape') {
      if (isOpen) {
        e.preventDefault();
        setIsOpen(false);
        setIsTyping(false);
        if (multiple) {
          setQuery('');
        } else {
          setQuery(selectedOption ? selectedOption.label : '');
        }
      }
    } else if (e.key === 'Tab') {
      if (isOpen) {
        setIsOpen(false);
        setIsTyping(false);
        if (multiple) {
          setQuery('');
        } else {
          setQuery(selectedOption ? selectedOption.label : '');
        }
      }
    } else if (e.key === 'Backspace' && multiple && query === '' && selectedValues.length > 0) {
      const next = selectedValues.slice(0, -1);
      onChange?.(next);
    }
  };

  const hasValue = multiple ? selectedValues.length > 0 : Boolean(singleValue);

  return (
    <div
      ref={containerRef}
      className={cn('bk relative', block ? 'w-full' : 'w-56', className)}
    >
      <div
        onClick={() => {
          if (!disabled) inputRef.current?.focus();
        }}
        className={cn(
          'relative w-full rounded-md border border-input bg-background transition-colors duration-150 focus-within:ring-2 focus-within:ring-ring hover:border-muted-foreground',
          disabled && 'cursor-not-allowed opacity-50',
          multiple ? 'flex flex-wrap items-center gap-1.5 p-1.5 min-h-[38px] pe-14' : 'flex items-center',
        )}
      >
        {multiple &&
          selectedOptions.map((opt) => (
            <span
              key={opt.value}
              role="checkbox"
              aria-checked="true"
              aria-label={opt.label}
              className="bk inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs text-foreground font-medium max-w-full"
            >
              <span className="truncate">{opt.label}</span>
              {!disabled && (
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleMultipleOption(opt);
                  }}
                  aria-label={`Remove ${opt.label}`}
                  className="text-muted-foreground hover:text-foreground p-0.5 rounded focus:outline-none"
                >
                  <X className="w-3 h-3" aria-hidden="true" />
                </button>
              )}
            </span>
          ))}

        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          autoComplete="off"
          disabled={disabled}
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          aria-activedescendant={isOpen && highlightedIndex >= 0 ? `${listboxId}-opt-${highlightedIndex}` : undefined}
          value={query}
          placeholder={multiple && selectedValues.length > 0 ? '' : placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsTyping(true);
            if (!isOpen) setIsOpen(true);
          }}
          onFocus={() => {
            if (!disabled && !isOpen) {
              setIsOpen(true);
              setIsTyping(false);
            }
          }}
          onClick={() => {
            if (!disabled && !isOpen) {
              setIsOpen(true);
              setIsTyping(false);
            }
          }}
          onKeyDown={handleKeyDown}
          className={cn(
            multiple
              ? 'flex-1 min-w-[80px] bg-transparent border-0 p-0 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:ring-0'
              : cn(
                  'w-full rounded-md border-0 bg-transparent ps-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground outline-none',
                  clearable && hasValue ? 'pe-14' : 'pe-8',
                ),
          )}
        />
        <div className="absolute end-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5 text-muted-foreground pointer-events-auto">
          {clearable && hasValue && !disabled && (
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={handleClear}
              aria-label="Clear"
              className="p-1 rounded hover:text-foreground focus:outline-none"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={handleToggle}
            aria-label={isOpen ? 'Close' : 'Open'}
            className="p-1 rounded hover:text-foreground focus:outline-none disabled:opacity-50"
          >
            {isOpen ? <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />}
          </button>
        </div>
      </div>

      {isOpen && !isHostFloating && (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-multiselectable={multiple || undefined}
          aria-label={ariaLabel ?? placeholder}
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md p-1 focus:outline-none"
        >
          {filteredOptions.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground text-center">
              No results
            </div>
          ) : (
            filteredOptions.map((opt, i) => {
              const isSelected = multiple ? selectedValues.includes(opt.value) : opt.value === singleValue;
              const isHighlighted = highlightedIndex === i;
              return (
                <div
                  key={opt.value}
                  ref={(el) => { optionRefs.current[i] = el; }}
                  id={`${listboxId}-opt-${i}`}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={opt.disabled}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => selectOption(opt)}
                  onMouseEnter={() => setHighlightedIndex(i)}
                  className={cn(
                    'relative flex cursor-pointer select-none items-center justify-between rounded-sm px-2 py-1.5 text-sm transition-colors',
                    isHighlighted ? 'bg-accent text-accent-foreground' : 'text-foreground',
                    isSelected && 'font-medium',
                    opt.disabled && 'pointer-events-none opacity-50',
                  )}
                >
                  <span className="truncate">{opt.label}</span>
                  {isSelected && <Check className="w-4 h-4 ms-2 shrink-0 text-primary" aria-hidden="true" />}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

export interface KitCheckboxProps {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  label?: React.ReactNode;
  /** Name for screen readers when there is no visible label. */
  ariaLabel?: string;
  hint?: React.ReactNode;
  disabled?: boolean;
  id?: string;
}

/** The composer's check items and the Files app's select box: a drawn box, not the browser's. */
export function Checkbox({ checked, onChange, label, hint, disabled = false, id, ariaLabel }: KitCheckboxProps) {
  const autoId = React.useId();
  const boxId = id ?? autoId;
  const box = (
    <button
      id={boxId}
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={cn(
        'bk mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50 bg-background',
      )}
    >
      {checked && <Check className="w-3 h-3" strokeWidth={3} aria-hidden="true" />}
    </button>
  );
  if (!label) return box;
  return (
    <div className={cn('bk flex items-start gap-2', disabled && 'opacity-60')}>
      {box}
      <div className="min-w-0">
        <label htmlFor={boxId} className="text-sm text-foreground cursor-pointer">{label}</label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

/** ToggleSwitch from settings-section.tsx. */
export function Switch({ checked, onChange, disabled = false, label, id }: { checked: boolean; onChange?: (checked: boolean) => void; disabled?: boolean; label?: string; id?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={cn(
        'bk relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        checked ? 'bg-primary' : 'bg-muted',
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-background transition-transform duration-150',
          checked ? 'ltr:translate-x-6 rtl:-translate-x-6' : 'ltr:translate-x-1 rtl:-translate-x-1',
        )}
      />
    </button>
  );
}

/** RadioGroup from settings-section.tsx: a row of segments. */
export function Segmented({ value, options, onChange, label }: { value: string; options: { value: string; label: string }[]; onChange?: (value: string) => void; label?: string }) {
  return (
    <div className="bk flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange?.(o.value)}
          className={cn(
            'px-3 py-1.5 text-xs rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            o.value === value ? 'bg-primary text-primary-foreground font-medium' : 'bg-muted hover:bg-accent text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A form field: label above, hint and error below (identity form). The
 * control inside gets the label's id when it has none.
 */
export function Field({ label, hint, error, required = false, children }: { label: React.ReactNode; hint?: React.ReactNode; error?: React.ReactNode; required?: boolean } & Children) {
  const autoId = React.useId();
  const only = React.Children.count(children) === 1 && React.isValidElement(children) ? children as React.ReactElement<{ id?: string }> : null;
  const controlId = only?.props.id ?? autoId;
  return (
    <div className="bk">
      <label htmlFor={only ? controlId : undefined} className="text-sm font-medium mb-1 block text-foreground">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </label>
      {only && !only.props.id ? React.cloneElement(only, { id: controlId }) : children}
      {hint && !error && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
      {error && <p className="text-sm text-destructive mt-1" role="alert">{error}</p>}
    </div>
  );
}

/** A search box like the Files toolbar's. */
export function SearchInput({ value, onChange, placeholder, label, className }: { value: string; onChange: (value: string) => void; placeholder?: string; label?: string; className?: string }) {
  return (
    <div className={cn('bk relative w-56 max-w-full', className)}>
      <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" aria-hidden="true" />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-8 rounded-md border border-input bg-background ps-8 pe-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="×" className="absolute end-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground hover:text-foreground">
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

// ─── Layout ────────────────────────────────────────────────────

const GAP = { 0: 'gap-0', 1: 'gap-1', 2: 'gap-2', 3: 'gap-3', 4: 'gap-4', 6: 'gap-6' } as const;
type Gap = keyof typeof GAP;

/** Children one below the other. */
export function Stack({ gap = 3, children, className }: { gap?: Gap; className?: string } & Children) {
  return <div className={cn('bk flex flex-col min-w-0', GAP[gap], className)}>{children}</div>;
}

/** Children side by side. */
export function Row({ gap = 2, wrap = true, justify = 'start', align = 'center', grow = false, fill = false, children, className }: {
  gap?: Gap; wrap?: boolean; justify?: 'start' | 'end' | 'between'; align?: 'start' | 'center' | 'baseline'; grow?: boolean;
  /** Children share the width equally, e.g. two Fields side by side; they wrap below 12rem each. */
  fill?: boolean; className?: string;
} & Children) {
  return (
    <div className={cn(
      'bk flex min-w-0', GAP[gap], wrap && 'flex-wrap', grow && 'flex-1', fill && '[&>*]:flex-1 [&>*]:min-w-[12rem]',
      { start: 'justify-start', end: 'justify-end', between: 'justify-between' }[justify],
      { start: 'items-start', center: 'items-center', baseline: 'items-baseline' }[align],
      className,
    )}>
      {children}
    </div>
  );
}

/** Body text. */
export function Text({ tone = 'default', size = 'sm', weight = 'normal', truncate = false, children, className }: {
  tone?: 'default' | 'muted' | 'danger' | 'success'; size?: 'xs' | 'sm' | 'base'; weight?: 'normal' | 'medium' | 'semibold'; truncate?: boolean; className?: string;
} & Children) {
  return (
    <p className={cn(
      'bk break-words',
      { default: 'text-foreground', muted: 'text-muted-foreground', danger: 'text-destructive', success: 'text-success' }[tone],
      { xs: 'text-xs', sm: 'text-sm', base: 'text-base' }[size],
      { normal: '', medium: 'font-medium', semibold: 'font-semibold' }[weight],
      truncate && 'truncate',
      className,
    )}>
      {children}
    </p>
  );
}

/** A heading inside a section (settings subheading). */
export function Heading({ children, level = 3 }: { level?: 2 | 3 | 4 } & Children) {
  const Tag = `h${level}` as 'h2' | 'h3' | 'h4';
  return <Tag className={cn('bk text-foreground', level === 2 ? 'text-lg font-semibold' : level === 3 ? 'text-base font-medium' : 'text-sm font-medium')}>{children}</Tag>;
}

export function Divider() {
  return <div className="bk h-px bg-border" role="separator" />;
}

/**
 * A plugin's full page (app-page slot): the app's content width and
 * padding, with an optional header. Pages that are a tool, like a file
 * browser, pass `flush` and put a Toolbar first instead.
 */
export function Page({ flush = false, wide = false, children }: { flush?: boolean; wide?: boolean } & Children) {
  if (flush) return <div className="bk flex flex-col min-h-full text-foreground">{children}</div>;
  return <div className={cn('bk mx-auto p-4 md:p-6 space-y-6 text-foreground', wide ? 'max-w-6xl' : 'max-w-4xl')}>{children}</div>;
}

/** The admin pages' header: title, subtitle, actions on the right. */
export function PageHeader({ title, description, actions, icon }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; icon?: string }) {
  return (
    <div className="bk flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
          {icon && <Icon name={icon} size="lg" className="text-muted-foreground" />}
          <span className="min-w-0 truncate">{title}</span>
        </h1>
        {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** SettingsSection: a titled group of settings. */
export function Section({ title, description, children }: { title?: React.ReactNode; description?: React.ReactNode } & Children) {
  return (
    <section className="bk space-y-4">
      {(title || description) && (
        <div>
          {title && <h3 className="text-lg font-medium text-foreground">{title}</h3>}
          {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
        </div>
      )}
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/** SettingItem: label and description on the left, the control on the right. */
export function SettingRow({ label, description, children, htmlFor }: { label: React.ReactNode; description?: React.ReactNode; htmlFor?: string } & Children) {
  return (
    <div className="bk flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4 py-3 border-b border-border last:border-0">
      <div className="flex-1 min-w-0 sm:pe-4">
        <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">{label}</label>
        {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

/** The admin section card: a bordered box with a tinted head. */
export function Card({ title, actions, children, padded = true }: { title?: React.ReactNode; actions?: React.ReactNode; padded?: boolean } & Children) {
  return (
    <div className="bk border border-border rounded-lg overflow-hidden">
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border bg-muted/30">
          <h2 className="text-sm font-medium text-foreground min-w-0 truncate">{title}</h2>
          {actions && <div className="flex items-center gap-1">{actions}</div>}
        </div>
      )}
      <div className={cn(padded && 'p-4')}>{children}</div>
    </div>
  );
}

// ─── Tabs ──────────────────────────────────────────────────────

/** The tab bar of the app's dialogs (iCal import). */
export function Tabs({ value, tabs, onChange, label }: { value: string; tabs: { id: string; label: string; icon?: string; count?: number }[]; onChange: (id: string) => void; label?: string }) {
  return (
    <div className="bk flex border-b border-border overflow-x-auto" role="tablist" aria-label={label}>
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
              active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.icon && <Icon name={tab.icon} />}
            <span>{tab.label}</span>
            {tab.count !== undefined && <span className="text-xs font-semibold tabular-nums">{tab.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ─── Toolbar (Files app) ───────────────────────────────────────

/** The Files app's toolbar row. */
export function Toolbar({ children }: Children) {
  return (
    <div className="bk flex items-center gap-1 px-3 border-b border-border min-w-0 flex-shrink-0" style={{ paddingBlock: 'var(--density-header-py)' }}>
      {children}
    </div>
  );
}

/** ToolButton from the Files header: ghost, 32 px high, icon-only when compact. */
export function ToolbarButton({ icon, label, compact = false, active = false, danger = false, busy = false, disabled, onClick }: {
  icon?: string; label: string; compact?: boolean; active?: boolean; danger?: boolean; busy?: boolean; disabled?: boolean; onClick?: () => void;
}) {
  return (
    <AppButton
      type="button"
      variant="ghost"
      size={compact ? 'icon' : 'sm'}
      title={compact ? label : undefined}
      aria-label={compact ? label : undefined}
      aria-pressed={active || undefined}
      disabled={disabled || busy}
      onClick={onClick}
      className={cn(
        'bk h-8 shrink-0',
        compact ? 'w-8' : 'gap-1.5 px-2.5',
        active && 'bg-accent text-accent-foreground',
        danger && 'text-destructive hover:text-destructive hover:bg-destructive/10',
      )}
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : icon ? <Icon name={icon} /> : null}
      {!compact && <span>{label}</span>}
    </AppButton>
  );
}

/** Takes the free space in a Toolbar. */
export function ToolbarSpacer() {
  return <div className="bk flex-1 min-w-0" />;
}

/** The Files app's breadcrumbs. */
export function Breadcrumbs({ items, onSelect, label }: { items: { id: string; label: string }[]; onSelect: (id: string) => void; label?: string }) {
  return (
    <nav className="bk flex-1 min-w-0" aria-label={label}>
      <ol className="flex items-center text-sm min-w-0">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={item.id} className="flex items-center min-w-0 shrink-0 last:shrink">
              {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0 rtl:rotate-180" aria-hidden="true" />}
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                aria-current={last ? 'page' : undefined}
                className={cn('px-1.5 py-1 rounded-md transition-colors truncate max-w-[16rem]', last ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}
              >
                {item.label}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ─── Lists (Files app rows) ────────────────────────────────────

/** A list like the Files app's: optional column header, rows below. */
export function List({ children, label, columns }: { label?: string; columns?: { label: string; align?: 'start' | 'end'; hideNarrow?: boolean }[] } & Children) {
  return (
    <div className="bk text-sm" role="list" aria-label={label}>
      {columns && (
        <div className="flex items-center gap-x-3 sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-4 h-9 text-xs font-medium text-muted-foreground" aria-hidden="true">
          {columns.map((c, i) => (
            <span key={i} className={cn(i === 0 ? 'flex-1 min-w-0 ps-8' : 'w-24 flex-shrink-0', c.align === 'end' && 'text-end', c.hideNarrow && 'hidden sm:block')}>{c.label}</span>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

export interface KitListRowProps {
  title: React.ReactNode;
  /** A line under the title. */
  subtitle?: React.ReactNode;
  /** Short right-hand columns (size, date). */
  meta?: React.ReactNode[];
  /** FileIcon or Icon; or a file name to use the Files app's icon for it. */
  icon?: React.ReactNode;
  folder?: boolean;
  selected?: boolean;
  /** Shows a select box in front. */
  checked?: boolean;
  onCheck?: (checked: boolean) => void;
  /** Name of the select box for screen readers, e.g. "Select report.pdf". */
  checkLabel?: string;
  onClick?: () => void;
  onDoubleClick?: () => void;
  /** Buttons at the end of the row. */
  actions?: React.ReactNode;
  disabled?: boolean;
}

/** A Files app row: 40 px, icon, name, muted meta columns, hover and selected states. */
export function ListRow({ title, subtitle, meta, icon, folder = false, selected = false, checked, onCheck, checkLabel, onClick, onDoubleClick, actions, disabled = false }: KitListRowProps) {
  const clickable = !!onClick && !disabled;
  return (
    <div
      role="listitem"
      aria-selected={selected || undefined}
      aria-disabled={disabled || undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onClick : undefined}
      onDoubleClick={disabled ? undefined : onDoubleClick}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } } : undefined}
      className={cn(
        'bk group flex items-center gap-x-3 px-4 border-b border-border/60 select-none transition-colors outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/60',
        subtitle ? 'min-h-[52px] py-1.5' : 'h-10',
        selected ? 'bg-primary/10' : clickable && 'hover:bg-muted/60',
        clickable ? 'cursor-pointer' : 'cursor-default',
        disabled && 'opacity-50',
      )}
    >
      {checked !== undefined && (
        <span onClick={(e) => e.stopPropagation()} className="flex">
          <Checkbox checked={checked} onChange={onCheck} disabled={disabled} ariaLabel={checkLabel ?? (typeof title === 'string' ? title : undefined)} />
        </span>
      )}
      <span className="flex items-center gap-3 min-w-0 flex-1">
        {typeof icon === 'string' ? <FileIcon name={icon} folder={folder} /> : icon ?? (folder ? <FileIcon folder /> : null)}
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-start', folder && 'font-medium')}>{title}</span>
          {subtitle && <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>}
        </span>
      </span>
      {meta?.map((m, i) => (
        <span key={i} className={cn('flex-shrink-0 text-muted-foreground tabular-nums truncate text-end w-24', i > 0 && 'hidden sm:block')}>{m}</span>
      ))}
      {actions && <span className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>{actions}</span>}
    </div>
  );
}

/** A row's icon button (Files row actions). */
export function RowAction({ icon, label, onClick, danger = false }: { icon: string; label: string; onClick?: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn('bk p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', danger && 'hover:text-destructive')}
    >
      <Icon name={icon} />
    </button>
  );
}

// ─── Status ────────────────────────────────────────────────────

const BADGE_TONE: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  info: 'bg-info/15 text-info',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-destructive/15 text-destructive',
  primary: 'bg-primary/10 text-primary',
};

/** The status pills (calendar invitation, identity "Default"). */
export function Badge({ tone = 'neutral', children }: { tone?: Tone } & Children) {
  return <span className={cn('bk inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', BADGE_TONE[tone])}>{children}</span>;
}

/** The reader's attachment chip: icon, label, muted detail. Clickable when onClick is set. */
export function Chip({ icon, label, detail, onClick, onRemove, removeLabel, title }: {
  icon?: string; label: React.ReactNode; detail?: React.ReactNode; onClick?: () => void; onRemove?: () => void; removeLabel?: string; title?: string;
}) {
  const body = (
    <>
      {icon && <Icon name={icon} className="text-muted-foreground" />}
      <span className="text-sm text-foreground truncate max-w-[200px]">{label}</span>
      {detail && <span className="text-xs text-muted-foreground flex-shrink-0">{detail}</span>}
    </>
  );
  const box = 'bk inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-muted/60 rounded-md border border-border/50 flex-shrink-0 max-w-full';
  if (onClick && !onRemove) {
    return <button type="button" title={title} onClick={onClick} className={cn(box, 'hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}>{body}</button>;
  }
  return (
    <span className={box} title={title}>
      {body}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={removeLabel ?? '×'} className="p-0.5 -me-1 rounded hover:bg-accent transition-colors">
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

const INFO_TONE: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  info: 'bg-info/15 text-info',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-destructive/15 text-destructive',
  primary: 'bg-primary/10 text-primary',
};

/**
 * The reader's info bar (external content, calendar invitation, read
 * receipt): a round icon, a small caps label, the line, then buttons.
 * `compact` drops the circle for a one-line bar.
 */
export function InfoBar({ tone = 'neutral', icon, eyebrow, title, children, compact = false }: {
  tone?: Tone; icon?: string; eyebrow?: React.ReactNode; title?: React.ReactNode; compact?: boolean;
} & Children) {
  if (compact) {
    return (
      <div className="bk flex flex-wrap items-center gap-x-3 gap-y-1.5 px-6 py-1.5 border-b border-border bg-muted/30 text-sm">
        {icon && <span className={cn('w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0', INFO_TONE[tone])}><Icon name={icon} size="sm" /></span>}
        {eyebrow && <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{eyebrow}</span>}
        {title && <span className="min-w-0 flex-1 text-foreground break-words">{title}</span>}
        {children}
      </div>
    );
  }
  return (
    <div className="bk border-b border-border bg-muted/30">
      <div className="px-6 py-1.5">
        <div className="flex items-start gap-3 py-1">
          {icon && (
            <div className={cn('w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 shadow-sm', INFO_TONE[tone])}>
              <Icon name={icon} size="lg" />
            </div>
          )}
          <div className="flex-1 min-w-0 space-y-2">
            {(eyebrow || title) && (
              <div>
                {eyebrow && <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{eyebrow}</div>}
                {title && <div className="text-sm font-medium text-foreground break-words">{title}</div>}
              </div>
            )}
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The bordered buttons of the reader's info bars ("Load images", RSVP). */
export function BarButton({ icon, children, onClick, active = false, busy = false, disabled }: { icon?: string; onClick?: () => void; active?: boolean; busy?: boolean; disabled?: boolean } & Children) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-pressed={active || undefined}
      className={cn(
        'bk inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border transition-colors min-h-[36px] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'bg-primary/10 text-primary border-primary/30 font-medium' : 'text-muted-foreground hover:text-foreground border-border hover:bg-muted',
      )}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : icon ? <Icon name={icon} size="sm" /> : null}
      {children}
    </button>
  );
}

const ALERT_TONE: Record<Exclude<Tone, 'primary' | 'neutral'> | 'neutral', string> = {
  neutral: 'bg-muted text-foreground',
  info: 'bg-info/10 text-foreground',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-foreground',
  danger: 'bg-destructive/10 text-destructive',
};

/** The Files app's error bar, in other tones too. */
export function Alert({ tone = 'danger', icon, children, action }: { tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; icon?: string; action?: React.ReactNode } & Children) {
  return (
    <div className={cn('bk px-3 py-2 rounded-md text-sm flex items-center gap-2', ALERT_TONE[tone])} role={tone === 'danger' ? 'alert' : 'status'}>
      {icon && <Icon name={icon} />}
      <div className="flex-1 min-w-0 break-words">{children}</div>
      {action}
    </div>
  );
}

/** A thin progress bar; value 0..1, or null while unknown. */
export function ProgressBar({ value, label }: { value: number | null; label?: string }) {
  const pct = value === null ? null : Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="bk h-1.5 w-full rounded-full bg-muted overflow-hidden" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct === null ? undefined : Math.round(pct)}>
      <div className={cn('h-full bg-primary transition-[width] duration-200', pct === null && 'w-1/3 animate-pulse')} style={pct === null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

/** The Files app's empty state: icon in a circle, title, text, buttons. */
export function EmptyState({ icon, title, description, actions, compact = false }: { icon?: string; title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; compact?: boolean }) {
  return (
    <div className={cn('bk flex items-center justify-center', compact ? 'p-6' : 'min-h-[18rem] p-8')}>
      <div className="flex flex-col items-center text-center max-w-sm">
        {icon && (
          <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center mb-4">
            <Icon name={icon} className="w-7 h-7 text-muted-foreground" />
          </div>
        )}
        <h3 className="text-base font-medium text-foreground">{title}</h3>
        {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
        {actions && <div className="flex gap-2 flex-wrap justify-center mt-5">{actions}</div>}
      </div>
    </div>
  );
}

// ─── Sidebar sections ──────────────────────────────────────────

/** A row in a sidebar section, like a folder row. */
export function SidebarRow({ icon, label, detail, onClick, title, ariaLabel }: { icon?: string; label: React.ReactNode; detail?: React.ReactNode; onClick?: () => void; title?: string; /** What a click does, for screen readers. */ ariaLabel?: string }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      title={title}
      aria-label={ariaLabel}
      className={cn('bk w-full flex items-center gap-2 ps-[28px] pe-3 text-sm text-foreground text-start border-s-2 border-transparent transition-colors duration-150', onClick && 'hover:bg-muted/50 focus-visible:outline-none focus-visible:bg-muted/50')}
      // Folder rows are 44px tall on phones (max-lg); the frame's own
      // viewport can't tell, so the page passes the height in.
      style={{ paddingBlock: 'var(--density-sidebar-py)', minHeight: 'var(--touch-row-min-h, 0px)' }}
    >
      {icon && <span className="flex items-center justify-center flex-shrink-0 w-4 h-4 text-muted-foreground"><Icon name={icon} /></span>}
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {detail && <span className="flex-shrink-0 text-xs text-muted-foreground tabular-nums">{detail}</span>}
    </Tag>
  );
}

/** The sidebar's "nothing here" line (as under Folders while loading). */
export function SidebarEmpty({ children }: Children) {
  return <p className="bk px-4 py-2 text-sm text-muted-foreground">{children}</p>;
}

// ─── Changes ───────────────────────────────────────────────────

export interface DiffPart {
  type: 'same' | 'add' | 'del';
  text: string;
}

/**
 * A text with its changes marked: removed words struck through in red,
 * added ones highlighted. For previews of a rewrite before it is applied.
 * `streaming` shows a caret at the end while the text is still coming in.
 */
export function DiffView({ parts, streaming = false, label }: { parts: DiffPart[]; streaming?: boolean; label?: string }) {
  return (
    <div className="bk rounded-md border border-border bg-muted/30 p-3 text-sm text-foreground leading-relaxed whitespace-pre-wrap break-words" aria-label={label} aria-busy={streaming || undefined}>
      {parts.map((p, i) => (
        p.type === 'del'
          ? <del key={i} className="rounded-sm bg-destructive/10 text-destructive line-through decoration-destructive/60">{p.text}</del>
          : p.type === 'add'
            ? <ins key={i} className="rounded-sm bg-success/15 text-foreground no-underline">{p.text}</ins>
            : <span key={i}>{p.text}</span>
      ))}
      {streaming && <span className="ms-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-primary/60" aria-hidden="true" />}
    </div>
  );
}

// ─── Panels and details ────────────────────────────────────────

/** The padding of a side panel or detail section (message details, composer side panels). */
export function Panel({ children }: Children) {
  return <div className="bk p-4 space-y-3 text-sm text-foreground">{children}</div>;
}

/** The small caps heading of the message details' sections. */
export function DetailHeading({ children }: Children) {
  return <div className="bk text-[10px] font-semibold tracking-wider text-muted-foreground uppercase mb-1.5">{children}</div>;
}

/** Label and value rows like the message details (From, Date, Size...). Children are DetailRows. */
export function DetailList({ children }: Children) {
  return <dl className="bk grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1.5">{children}</dl>;
}

export function DetailRow({ label, children, mono = false }: { label: React.ReactNode; mono?: boolean } & Children) {
  return (
    <>
      <dt className="text-muted-foreground text-xs pt-1">{label}</dt>
      <dd className={cn('text-sm text-foreground min-w-0 break-words', mono && 'font-mono text-xs')}>{children}</dd>
    </>
  );
}

/**
 * A small round dot in a colour the data carries, like a calendar's or a
 * tag's colour. Only #rgb/#rrggbb values are used; anything else shows the
 * muted colour.
 */
export function ColorDot({ color, label }: { color?: string; label?: string }) {
  const safe = typeof color === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : undefined;
  return (
    <span
      className={cn('bk inline-block h-2.5 w-2.5 shrink-0 rounded-full', !safe && 'bg-muted-foreground')}
      style={safe ? { backgroundColor: safe } : undefined}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
