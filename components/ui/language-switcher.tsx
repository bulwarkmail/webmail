"use client";

import { useLocale } from 'next-intl';
import { useLocaleStore } from '@/stores/locale-store';
import { Select } from '@/components/settings/settings-section';

export function LanguageSwitcher({ className }: { className?: string }) {
  const currentLocale = useLocale();
  const setLocale = useLocaleStore((state) => state.setLocale);

  const languages = [
    { value: 'en', label: 'English' },
    { value: 'fr', label: 'Français' },
    { value: 'ja', label: '日本語' },
    { value: 'ko', label: '한국어' },
    { value: 'es', label: 'Español' },
    { value: 'it', label: 'Italiano' },
    { value: 'de', label: 'Deutsch' },
    { value: 'nl', label: 'Nederlands' },
    { value: 'pl', label: 'Polski' },
    { value: 'pt', label: 'Português' },
    { value: 'ru', label: 'Русский' }
  ];

  return (
    <div className={className}>
      <Select
        value={currentLocale}
        onChange={setLocale}
        options={languages}
      />
    </div>
  );
}
