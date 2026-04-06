"use client";

import { useEffect, useState } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { useLocaleStore } from '@/stores/locale-store';
import enMessages from '@/locales/en/common.json';
import frMessages from '@/locales/fr/common.json';
import jaMessages from '@/locales/ja/common.json';
import koMessages from '@/locales/ko/common.json';
import esMessages from '@/locales/es/common.json';
import itMessages from '@/locales/it/common.json';
import deMessages from '@/locales/de/common.json';
import nlMessages from '@/locales/nl/common.json';
import plMessages from '@/locales/pl/common.json';
import ptMessages from '@/locales/pt/common.json';
import ruMessages from '@/locales/ru/common.json';

// Pre-loaded translations (loaded at build time, not runtime)
const ALL_MESSAGES = {
  en: enMessages,
  fr: frMessages,
  ja: jaMessages,
  ko: koMessages,
  es: esMessages,
  it: itMessages,
  de: deMessages,
  nl: nlMessages,
  pl: plMessages,
  pt: ptMessages,
  ru: ruMessages,
};

interface IntlProviderProps {
  locale: string;
  messages: Record<string, unknown>;
  children: React.ReactNode;
}

export function IntlProvider({ locale: initialLocale, children }: IntlProviderProps) {
  const currentLocale = useLocaleStore((state) => state.locale);
  const setLocale = useLocaleStore((state) => state.setLocale);
  const [activeLocale, setActiveLocale] = useState(currentLocale || initialLocale);
  const [timeZone, setTimeZone] = useState<string>('UTC');

  // Detect user's timezone on mount
  useEffect(() => {
    try {
      const detectedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      setTimeZone(detectedTimeZone);
    } catch (error) {
      // Fallback to UTC if detection fails
      console.warn('Failed to detect timezone, using UTC:', error);
      setTimeZone('UTC');
    }
  }, []);

  // Sync initial locale with store on first mount only
  useEffect(() => {
    if (!currentLocale) {
      setLocale(initialLocale);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch locale immediately when store changes
  useEffect(() => {
    if (currentLocale) {
      setActiveLocale(currentLocale);
    }
  }, [currentLocale]);

  return (
    <NextIntlClientProvider
      locale={activeLocale}
      messages={ALL_MESSAGES[activeLocale as keyof typeof ALL_MESSAGES]}
      timeZone={timeZone}
    >
      {children}
    </NextIntlClientProvider>
  );
}
