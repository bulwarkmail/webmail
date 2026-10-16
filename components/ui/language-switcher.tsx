"use client";

import { useState, useRef, useEffect, useMemo, useId } from "react";
import { useTranslations } from 'next-intl';
import { useLocaleStore } from '@/stores/locale-store';
import { getEffectiveLocale } from '@/i18n/detect-locale';
import { Check, ChevronDown, Search } from '@/components/icons';
import { cn } from '@/lib/utils';
import { flagComponents } from './flag-icons';

const languages = [
  { value: 'auto', label: 'Auto' },
  { value: 'ar', label: 'العربية' },
  { value: 'ca', label: 'Català' },
  { value: 'cs', label: 'Česky' },
  { value: 'sk', label: 'Slovenčina' },
  { value: 'da', label: 'Dansk' },
  { value: 'de', label: 'Deutsch' },
  { value: 'en', label: 'English' },
  { value: 'et', label: 'Eesti' },
  { value: 'fa', label: 'فارسی' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'he', label: 'עברית' },
  { value: 'it', label: 'Italiano' },
  { value: 'hu', label: 'Magyar' },
  { value: 'lv', label: 'Latviešu' },
  { value: 'nl', label: 'Nederlands' },
  { value: 'nb', label: 'Norsk bokmål' },
  { value: 'pl', label: 'Polski' },
  { value: 'pt', label: 'Português' },
  { value: 'ro', label: 'Română' },
  { value: 'tr', label: 'Türkçe' },
  { value: 'ru', label: 'Русский' },
  { value: 'uk', label: 'Українська' },
  { value: 'ko', label: '한국어' },
  { value: 'ja', label: '日本語' },
  { value: 'mn', label: 'Монгол' },
  { value: 'zh', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文（台灣）' },
];

// Case- and accent-insensitive, so "espanol" finds "Español".
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function displayNames(locale: string): ((code: string) => string | undefined) {
  try {
    const names = new Intl.DisplayNames([locale], { type: 'language' });
    return (code) => names.of(code);
  } catch {
    return () => undefined;
  }
}

function FlagIcon({ locale }: { locale: string }) {
  const Flag = flagComponents[locale];
  if (!Flag) return <span className="inline-block w-5 shrink-0" aria-hidden="true" />;
  return <Flag />;
}

export function LanguageSwitcher({ className }: { className?: string }) {
  const t = useTranslations();
  const setLocale = useLocaleStore((state) => state.setLocale);
  const choice = useLocaleStore((state) => state.locale) || 'auto';
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const current = languages.find((l) => l.value === choice) ?? languages[0];

  // Each language also gets its name in the UI language (and in English), so
  // "German" and "Deutsch" both find it and unfamiliar scripts stay readable.
  const entries = useMemo(() => {
    void choice;
    const local = displayNames(getEffectiveLocale());
    const english = displayNames('en');
    return languages.map((lang) => {
      const translated = lang.value === 'auto' ? undefined : local(lang.value);
      const hint = translated && fold(translated) !== fold(lang.label) ? translated : undefined;
      const haystack = fold([lang.label, lang.value, translated, lang.value === 'auto' ? undefined : english(lang.value)].filter(Boolean).join(' '));
      return { ...lang, hint, haystack };
    });
  }, [choice]);

  const results = useMemo(() => {
    const needle = fold(query.trim());
    return needle ? entries.filter((e) => e.haystack.includes(needle)) : entries;
  }, [entries, query]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const pick = (value: string) => {
    setLocale(value);
    close(true);
  };

  // Start on the current language each time the menu opens.
  const toggle = () => {
    if (open) return close(false);
    setQuery('');
    setActive(Math.max(0, languages.findIndex((l) => l.value === choice)));
    setOpen(true);
  };

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, results]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
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

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        type="button"
        ref={buttonRef}
        onClick={toggle}
        className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground hover:border-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors duration-150 cursor-pointer w-full"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <FlagIcon locale={current.value} />
        <span className="flex-1 text-start">{current.label}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform duration-150", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute end-0 z-50 mt-1 w-64 max-w-[80vw] rounded-md border border-border bg-background shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={results[active] ? `${listId}-${results[active].value}` : undefined}
              aria-label={t('common.search')}
              placeholder={t('common.search')}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onInputKeyDown}
              className="w-full bg-transparent py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <ul ref={listRef} id={listId} role="listbox" className="max-h-72 overflow-auto py-1">
            {results.map((lang, index) => (
              <li
                key={lang.value}
                id={`${listId}-${lang.value}`}
                data-index={index}
                role="option"
                aria-selected={lang.value === choice}
                onMouseMove={() => setActive(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(lang.value)}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer",
                  index === active ? "bg-accent text-accent-foreground" : "text-foreground"
                )}
              >
                <FlagIcon locale={lang.value} />
                <span className="truncate" dir="auto">{lang.label}</span>
                {lang.hint && <span className="truncate text-xs text-muted-foreground">{lang.hint}</span>}
                {lang.value === choice && <Check className="ms-auto h-4 w-4 shrink-0" />}
              </li>
            ))}
            {results.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-foreground">{t('sharing.no_match')}</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
