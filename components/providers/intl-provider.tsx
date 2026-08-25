"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { useLocaleStore } from '@/stores/locale-store';
import enMessages from '@/locales/en/common.json';
import { getLocaleDirection } from '@/i18n/direction';
import { mergeMessages } from '@/i18n/merge-messages';
import { detectBrowserLocale } from '@/i18n/detect-locale';

type Messages = Record<string, unknown>;

// Per-locale dynamic loaders so each catalog is its own lazy chunk. Importing
// them all statically put every locale (~3 MB) in the critical client bundle,
// which dominated time-to-mail-list. English stays a static import: it is the
// default and the fallback base every other locale merges onto. Exported so a
// test can pin this map to SUPPORTED_LOCALES - a locale wired into routing but
// missing here renders as English no matter what the picker says (#756).
export const LOCALE_LOADERS: Record<string, () => Promise<Messages>> = {
  ar: () => import('@/locales/ar/common.json').then((m) => m.default),
  ca: () => import('@/locales/ca/common.json').then((m) => m.default),
  cs: () => import('@/locales/cs/common.json').then((m) => m.default),
  da: () => import('@/locales/da/common.json').then((m) => m.default),
  de: () => import('@/locales/de/common.json').then((m) => m.default),
  en: () => Promise.resolve(enMessages as Messages),
  es: () => import('@/locales/es/common.json').then((m) => m.default),
  he: () => import('@/locales/he/common.json').then((m) => m.default),
  fa: () => import('@/locales/fa/common.json').then((m) => m.default),
  fr: () => import('@/locales/fr/common.json').then((m) => m.default),
  hu: () => import('@/locales/hu/common.json').then((m) => m.default),
  it: () => import('@/locales/it/common.json').then((m) => m.default),
  ja: () => import('@/locales/ja/common.json').then((m) => m.default),
  ko: () => import('@/locales/ko/common.json').then((m) => m.default),
  lv: () => import('@/locales/lv/common.json').then((m) => m.default),
  mn: () => import('@/locales/mn/common.json').then((m) => m.default),
  nl: () => import('@/locales/nl/common.json').then((m) => m.default),
  pl: () => import('@/locales/pl/common.json').then((m) => m.default),
  pt: () => import('@/locales/pt/common.json').then((m) => m.default),
  ro: () => import('@/locales/ro/common.json').then((m) => m.default),
  ru: () => import('@/locales/ru/common.json').then((m) => m.default),
  sk: () => import('@/locales/sk/common.json').then((m) => m.default),
  tr: () => import('@/locales/tr/common.json').then((m) => m.default),
  uk: () => import('@/locales/uk/common.json').then((m) => m.default),
  zh: () => import('@/locales/zh/common.json').then((m) => m.default),
};

interface IntlProviderProps {
  locale: string;
  messages: Messages;
  children: React.ReactNode;
}

export function IntlProvider({ locale: initialLocale, messages: initialMessages, children }: IntlProviderProps) {
  const currentLocale = useLocaleStore((state) => state.locale);
  const [timeZone, setTimeZone] = useState<string>('UTC');

  // The catalog currently in use. Seeded with the server-provided messages for
  // the SSR-resolved locale, so the first render needs no async work and
  // matches the server output. Locale and messages switch together once a
  // lazily loaded catalog arrives, never out of sync.
  const [catalog, setCatalog] = useState<{ locale: string; messages: Messages }>({
    locale: initialLocale,
    messages: initialMessages,
  });
  const loadedRef = useRef<Record<string, Messages>>({
    en: enMessages as Messages,
    [initialLocale]: initialMessages,
  });

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
  // is never overridden by detection. Loading a not-yet-cached catalog is
  // async; until it lands we keep rendering the previous locale.
  useEffect(() => {
    const target =
      !currentLocale || currentLocale === 'auto'
        ? detectBrowserLocale(initialLocale)
        : currentLocale;

    const cached = loadedRef.current[target];
    if (cached) {
      setCatalog((prev) => (prev.locale === target ? prev : { locale: target, messages: cached }));
      return;
    }

    let stale = false;
    const load = LOCALE_LOADERS[target];
    // Unknown locale: render English strings under the requested tag, matching
    // the old `?? {}` fallback behavior.
    (load ? load() : Promise.resolve({} as Messages)).then((messages) => {
      if (stale) return;
      loadedRef.current[target] = messages;
      setCatalog({ locale: target, messages });
    });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLocale]);

  // Keep <html> lang/dir in sync with the rendered locale (RTL for he/fa).
  useEffect(() => {
    document.documentElement.lang = catalog.locale;
    document.documentElement.dir = getLocaleDirection(catalog.locale);
  }, [catalog.locale]);

  // Fall back to English for any key the active locale has not translated, so
  // untranslated strings show English text instead of a raw message key.
  const messages = useMemo(
    () =>
      catalog.locale === 'en'
        ? (enMessages as Messages)
        : mergeMessages(enMessages as Messages, catalog.messages),
    [catalog]
  );

  return (
    <NextIntlClientProvider
      locale={catalog.locale}
      messages={messages}
      timeZone={timeZone}
    >
      {children}
    </NextIntlClientProvider>
  );
}
