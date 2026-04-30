"use client";

import { useState, useRef, useEffect } from "react";
import { useLocale } from 'next-intl';
import { useLocaleStore } from '@/stores/locale-store';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { flagComponents } from './flag-icons';

const languages = [
  { value: 'cs', label: 'Česky' },
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'Français' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'es', label: 'Español' },
  { value: 'it', label: 'Italiano' },
  { value: 'de', label: 'Deutsch' },
  { value: 'lv', label: 'Latviešu' },
  { value: 'nl', label: 'Nederlands' },
  { value: 'pl', label: 'Polski' },
  { value: 'pt', label: 'Português' },
  { value: 'ru', label: 'Русский' },
  { value: 'tr', label: 'Türkçe' },
  { value: 'uk', label: 'Українська' },
  { value: 'zh', label: '简体中文' },
];

function FlagIcon({ locale }: { locale: string }) {
  const Flag = flagComponents[locale];
  if (!Flag) return null;
  return <Flag />;
}

export function LanguageSwitcher({ className }: { className?: string }) {
  const currentLocale = useLocale();
  const setLocale = useLocaleStore((state) => state.setLocale);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const current = languages.find((l) => l.value === currentLocale) ?? languages[0];

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-md bg-muted border border-border text-foreground hover:border-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors duration-150 cursor-pointer w-full"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <FlagIcon locale={current.value} />
        <span className="flex-1 text-left">{current.label}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform duration-150", open && "rotate-180")} />
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          aria-activedescendant={`lang-${currentLocale}`}
          className="absolute z-50 mt-1 w-full max-h-60 overflow-auto rounded-md border border-border bg-background shadow-lg py-1"
        >
          {languages.map((lang) => (
            <li
              key={lang.value}
              id={`lang-${lang.value}`}
              role="option"
              aria-selected={lang.value === currentLocale}
              onClick={() => {
                setLocale(lang.value);
                setOpen(false);
              }}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer transition-colors duration-100",
                lang.value === currentLocale
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-foreground hover:bg-accent/50"
              )}
            >
              <FlagIcon locale={lang.value} />
              <span>{lang.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
