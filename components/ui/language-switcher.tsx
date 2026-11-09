"use client";

import { useMemo } from "react";
import { useTranslations } from 'next-intl';
import { useLocaleStore } from '@/stores/locale-store';
import { getEffectiveLocale } from '@/i18n/detect-locale';
import { SearchableSelect, foldForSearch } from './searchable-select';
import { flagComponents } from './flag-icons';

const LANGUAGES = [
  { value: 'auto', label: 'Auto' },
  { value: 'ar', label: 'العربية' },
  { value: 'ca', label: 'Català' },
  { value: 'cs', label: 'Česky' },
  { value: 'sk', label: 'Slovenčina' },
  { value: 'da', label: 'Dansk' },
  { value: 'de', label: 'Deutsch' },
  { value: 'el', label: 'Ελληνικά' },
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
  { value: 'nn', label: 'Norsk nynorsk' },
  { value: 'pl', label: 'Polski' },
  { value: 'pt', label: 'Português' },
  { value: 'ro', label: 'Română' },
  { value: 'th', label: 'ไทย' },
  { value: 'tr', label: 'Türkçe' },
  { value: 'ru', label: 'Русский' },
  { value: 'uk', label: 'Українська' },
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'ko', label: '한국어' },
  { value: 'ja', label: '日本語' },
  { value: 'mn', label: 'Монгол' },
  { value: 'zh', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文（台灣）' },
];

// Auto first, then by each language's own name: "Česky" sorts with C,
// "Slovenčina" with S, and other scripts follow the Latin ones.
export const languages = [
  LANGUAGES[0],
  ...LANGUAGES.slice(1).sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base' })),
];

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

/**
 * The languages as options for a SearchableSelect: each also carries its name
 * in the UI language (and in English), so "German" and "Deutsch" both find it
 * and unfamiliar scripts stay readable.
 */
export function useLanguageOptions() {
  const choice = useLocaleStore((state) => state.locale) || 'auto';
  return useMemo(() => {
    void choice;
    const local = displayNames(getEffectiveLocale());
    const english = displayNames('en');
    return languages.map((lang) => {
      const translated = lang.value === 'auto' ? undefined : local(lang.value);
      const hint = translated && foldForSearch(translated) !== foldForSearch(lang.label) ? translated : undefined;
      const keywords = lang.value === 'auto' ? undefined : english(lang.value);
      return { value: lang.value, label: lang.label, hint, keywords, icon: <FlagIcon locale={lang.value} /> };
    });
  }, [choice]);
}

export function LanguageSwitcher({ className }: { className?: string }) {
  const t = useTranslations();
  const setLocale = useLocaleStore((state) => state.setLocale);
  const choice = useLocaleStore((state) => state.locale) || 'auto';
  const options = useLanguageOptions();

  return (
    <SearchableSelect
      className={className}
      value={choice}
      options={options}
      onSelect={setLocale}
      searchLabel={t('common.search')}
      noMatchLabel={t('sharing.no_match')}
    />
  );
}
