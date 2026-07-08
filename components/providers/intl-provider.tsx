"use client";

import { useEffect, useMemo, useState } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { useLocaleStore } from '@/stores/locale-store';
import csMessages from '@/locales/cs/common.json';
import daMessages from '@/locales/da/common.json';
import deMessages from '@/locales/de/common.json';
import { getLocaleDirection } from '@/i18n/direction';
import { mergeMessages } from '@/i18n/merge-messages';
import { detectBrowserLocale } from '@/i18n/detect-locale';
import enMessages from '@/locales/en/common.json';
import esMessages from '@/locales/es/common.json';
import heMessages from '@/locales/he/common.json';
import faMessages from '@/locales/fa/common.json';
import frMessages from '@/locales/fr/common.json';
import huMessages from '@/locales/hu/common.json';
import itMessages from '@/locales/it/common.json';
import jaMessages from '@/locales/ja/common.json';
import koMessages from '@/locales/ko/common.json';
import lvMessages from '@/locales/lv/common.json';
import nlMessages from '@/locales/nl/common.json';
import plMessages from '@/locales/pl/common.json';
import ptMessages from '@/locales/pt/common.json';
import roMessages from '@/locales/ro/common.json';
import ruMessages from '@/locales/ru/common.json';
import skMessages from '@/locales/sk/common.json';
import trMessages from '@/locales/tr/common.json';
import ukMessages from '@/locales/uk/common.json';
import zhMessages from '@/locales/zh/common.json';

// Pre-loaded translations (loaded at build time, not runtime)
const ALL_MESSAGES = {
  cs: csMessages,
  da: daMessages,
  de: deMessages,
  en: enMessages,
  es: esMessages,
  he: heMessages,
  fa: faMessages,
  fr: frMessages,
  hu: huMessages,
  it: itMessages,
  ja: jaMessages,
  ko: koMessages,
  lv: lvMessages,
  nl: nlMessages,
  pl: plMessages,
  pt: ptMessages,
  ro: roMessages,
  ru: ruMessages,
  sk: skMessages,
  tr: trMessages,
  uk: ukMessages,
  zh: zhMessages,
};

interface IntlProviderProps {
  locale: string;
  messages: Record<string, unknown>;
  children: React.ReactNode;
}

export function IntlProvider({ locale: initialLocale, children }: IntlProviderProps) {
  const currentLocale = useLocaleStore((state) => state.locale);
  const [activeLocale, setActiveLocale] = useState(initialLocale);
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

  // Resolve the active locale from the user's stored choice. Empty or 'auto'
  // means "follow the browser" (English default); a specific code forces it and
  // is never overridden by detection.
  useEffect(() => {
    setActiveLocale(
      !currentLocale || currentLocale === 'auto'
        ? detectBrowserLocale(initialLocale)
        : currentLocale
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLocale]);

  // Keep <html> lang/dir in sync with the active locale (RTL for he/fa).
  useEffect(() => {
    document.documentElement.lang = activeLocale;
    document.documentElement.dir = getLocaleDirection(activeLocale);
  }, [activeLocale]);

  // Fall back to English for any key the active locale has not translated, so
  // untranslated strings show English text instead of a raw message key.
  const messages = useMemo(
    () => mergeMessages(
      ALL_MESSAGES.en as Record<string, unknown>,
      (ALL_MESSAGES[activeLocale as keyof typeof ALL_MESSAGES] ?? {}) as Record<string, unknown>
    ),
    [activeLocale]
  );

  return (
    <NextIntlClientProvider
      locale={activeLocale}
      messages={messages}
      timeZone={timeZone}
    >
      {children}
    </NextIntlClientProvider>
  );
}
