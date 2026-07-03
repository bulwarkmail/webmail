"use client";

import { useEffect, useState } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { useLocaleStore } from '@/stores/locale-store';
import csMessages from '@/locales/cs/common.json';
import daMessages from '@/locales/da/common.json';
import deMessages from '@/locales/de/common.json';
import enMessages from '@/locales/en/common.json';
import esMessages from '@/locales/es/common.json';
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
  const setLocale = useLocaleStore((state) => state.setLocale);
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

  // First mount: seed the store from the server-resolved locale if nothing is persisted.
  useEffect(() => {
    if (!currentLocale) {
      setLocale(initialLocale);
    } else {
      setActiveLocale(currentLocale);
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
      messages={ALL_MESSAGES[activeLocale as keyof typeof ALL_MESSAGES] ?? ALL_MESSAGES.en}
      timeZone={timeZone}
    >
      {children}
    </NextIntlClientProvider>
  );
}
