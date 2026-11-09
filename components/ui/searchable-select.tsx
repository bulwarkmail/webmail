"use client";

import { useState, useRef, useEffect, useMemo, useId, type ReactNode } from "react";
import { Check, ChevronDown, Search } from '@/components/icons';
import { cn } from '@/lib/utils';

export interface SearchableOption {
  value: string;
  label: string;
  /** Shown after the label in smaller text. */
  hint?: string;
  /** Extra text a search should match (names in other languages, offsets). */
  keywords?: string;
  /** Options with the same group are listed under its heading while nothing is typed. */
  group?: string;
  icon?: ReactNode;
}

// Case- and accent-insensitive, so "espanol" finds "Español".
export function foldForSearch(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

interface SearchableSelectProps {
  value: string;
  options: SearchableOption[];
  onSelect: (value: string) => void;
  /** Accessible name of the button, when its text doesn't say what it picks. */
  ariaLabel?: string;
  searchLabel: string;
  noMatchLabel: string;
  /** What the button shows; the selected option's icon and label by default. */
  renderValue?: (option: SearchableOption | undefined) => ReactNode;
  className?: string;
  /** Replaces the button's look (its layout classes stay), for a picker that sits among icon buttons. */
  buttonClassName?: string;
  menuClassName?: string;
  /**
   * Orders the results, lower first, and can add or drop options:
   * `wordsMatch` says whether every typed word is in the option's text.
   * null leaves the option out. Without it, the matching options keep
   * their order.
   */
  rank?: (query: string, option: SearchableOption, wordsMatch: boolean) => number | null;
  /** Opens the list on mount, for a field that appears because the user asked to change it. */
  defaultOpen?: boolean;
}

/**
 * A button that opens a list with a search box on top: type to filter,
 * arrows and Page Up/Down to move, Enter to pick, Escape to close. Used by
 * the language picker and the time zone picker.
 */
export function SearchableSelect({
  value,
  options,
  onSelect,
  ariaLabel,
  searchLabel,
  noMatchLabel,
  renderValue,
  className,
  buttonClassName,
  menuClassName,
  rank,
  defaultOpen = false,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(() => (defaultOpen ? Math.max(0, options.findIndex((o) => o.value === value)) : 0));
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const current = options.find((o) => o.value === value);

  const entries = useMemo(
    () => options.map((o) => ({ ...o, haystack: foldForSearch([o.label, o.value, o.hint, o.keywords].filter(Boolean).join(' ')) })),
    [options],
  );

  const results = useMemo(() => {
    const needle = foldForSearch(query.trim());
    if (!needle) return entries;
    // Every word typed has to match, each anywhere.
    const words = needle.split(/\s+/);
    // An option listed in two groups shows once in the results.
    const seen = new Set<string>();
    if (rank) {
      const ranked: { entry: (typeof entries)[number]; rank: number }[] = [];
      for (const e of entries) {
        if (seen.has(e.value)) continue;
        const r = rank(query, e, words.every((w) => e.haystack.includes(w)));
        if (r === null) continue;
        seen.add(e.value);
        ranked.push({ entry: e, rank: r });
      }
      // Array sort is stable: equal ranks keep the list's order.
      return ranked.sort((a, b) => a.rank - b.rank).map((r) => r.entry);
    }
    return entries.filter((e) => {
      if (seen.has(e.value) || !words.every((w) => e.haystack.includes(w))) return false;
      seen.add(e.value);
      return true;
    });
  }, [entries, query, rank]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const pick = (next: string) => {
    onSelect(next);
    close(true);
  };

  // Start on the current value each time the menu opens.
  const toggle = () => {
    if (open) return close(false);
    setQuery('');
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Options that arrive after the menu opened (the time zones are read after
  // mount) keep the current value marked, not the first row (pim-p3-14).
  const optionsRef = useRef(options);
  useEffect(() => {
    if (optionsRef.current === options) return;
    optionsRef.current = options;
    if (!open || query) return;
    const index = options.findIndex((o) => o.value === value);
    if (index >= 0) setActive(index);
  }, [options, open, query, value]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, results]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    // Its own document: in the desktop app a dialog has a window of its own.
    const doc = containerRef.current?.ownerDocument ?? document;
    doc.addEventListener("mousedown", handleClick);
    return () => doc.removeEventListener("mousedown", handleClick);
  }, [open]);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => Math.min(results.length - 1, i + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case 'PageDown':
        e.preventDefault();
        setActive((i) => Math.min(results.length - 1, i + 8));
        break;
      case 'PageUp':
        e.preventDefault();
        setActive((i) => Math.max(0, i - 8));
        break;
      case 'Enter':
        e.preventDefault();
        if (results[active]) pick(results[active].value);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
    }
  };

  const showGroups = !query.trim();

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        type="button"
        ref={buttonRef}
        onClick={toggle}
        className={cn("flex items-center gap-2 px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground hover:border-muted-foreground focus:outline-hidden transition-colors duration-150 cursor-pointer w-full", buttonClassName)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        {renderValue ? renderValue(current) : (
          <>
            {current?.icon}
            <span className="flex-1 truncate text-start">{current?.label ?? value}</span>
          </>
        )}
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150", open && "rotate-180")} />
      </button>

      {open && (
        <div className={cn("absolute end-0 z-50 mt-1 w-64 max-w-[80vw] rounded-md border border-border bg-background shadow-lg", menuClassName)}>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
              aria-label={searchLabel}
              placeholder={searchLabel}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onInputKeyDown}
              // The ring inside: the menu's edge cut it off (pim-p3-14).
              className="focus-inset w-full bg-transparent py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <ul ref={listRef} id={listId} role="listbox" aria-label={ariaLabel} className="max-h-72 overflow-auto py-1">
            {results.map((option, index) => {
              const heading = showGroups && option.group && option.group !== results[index - 1]?.group ? option.group : null;
              return [
                heading && (
                  <li key={`group-${heading}`} role="presentation" className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                    {heading}
                  </li>
                ),
                <li
                  key={`${option.group ?? ''}:${option.value}`}
                  id={`${listId}-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={option.value === value}
                  onMouseMove={() => setActive(index)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(option.value)}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer",
                    index === active ? "bg-accent text-accent-foreground" : "text-foreground"
                  )}
                >
                  {option.icon}
                  <span className="truncate" dir="auto">{option.label}</span>
                  {option.hint && <span className="truncate text-xs text-muted-foreground">{option.hint}</span>}
                  {option.value === value && <Check className="ms-auto h-4 w-4 shrink-0" />}
                </li>,
              ];
            })}
            {results.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-foreground">{noMatchLabel}</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
