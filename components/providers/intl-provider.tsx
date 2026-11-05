"use client";

import { useEffect, useRef, useState } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { usePathname } from 'next/navigation';
import { surfaceFromPath } from '@/lib/boot-skeleton/surfaces';
import { locales } from '@/i18n/routing';
import { useLocaleStore } from '@/stores/locale-store';
import { useSettingsStore } from '@/stores/settings-store';
import { getBrowserTimeZone, resolveTimeZone } from '@/lib/timezone';
import { getLocaleDirection } from '@/i18n/direction';
import { detectBrowserLocale } from '@/i18n/detect-locale';
import { addPlainLanguage } from '@/i18n/plain-language';
import { loadEnglishMessages, withEnglishFallback } from '@/i18n/english-catalog';
import { LITE_ENGLISH, LiteRouteSkeleton } from './lite-intl-assets';

type Messages = Record<string, unknown>;

// Per-locale dynamic loaders so each catalog is its own lazy chunk. Importing
// them all statically put every locale (~3 MB) in the critical client bundle,
// which dominated time-to-mail-list. Each comes with English under it, for the
// strings it hasn't translated. Exported so a test can pin this map to
// SUPPORTED_LOCALES - a locale wired into routing but missing here renders as
// English no matter what the picker says (#756).
export const LOCALE_LOADERS: Record<string, () => Promise<Messages>> = {
  ar: () => import('@/locales/ar/common.json').then((m) => withEnglishFallback(m.default)),
  ca: () => import('@/locales/ca/common.json').then((m) => withEnglishFallback(m.default)),
  cs: () => import('@/locales/cs/common.json').then((m) => withEnglishFallback(m.default)),
  da: () => import('@/locales/da/common.json').then((m) => withEnglishFallback(m.default)),
  de: () => import('@/locales/de/common.json').then((m) => addPlainLanguage('de', m.default)).then(withEnglishFallback),
  en: () => (LITE_ENGLISH ? Promise.resolve(LITE_ENGLISH) : loadEnglishMessages()),
  es: () => import('@/locales/es/common.json').then((m) => withEnglishFallback(m.default)),
  he: () => import('@/locales/he/common.json').then((m) => withEnglishFallback(m.default)),
  et: () => import('@/locales/et/common.json').then((m) => withEnglishFallback(m.default)),
  fa: () => import('@/locales/fa/common.json').then((m) => withEnglishFallback(m.default)),
  fr: () => import('@/locales/fr/common.json').then((m) => withEnglishFallback(m.default)),
  hu: () => import('@/locales/hu/common.json').then((m) => withEnglishFallback(m.default)),
  it: () => import('@/locales/it/common.json').then((m) => withEnglishFallback(m.default)),
  ja: () => import('@/locales/ja/common.json').then((m) => withEnglishFallback(m.default)),
  ko: () => import('@/locales/ko/common.json').then((m) => withEnglishFallback(m.default)),
  lv: () => import('@/locales/lv/common.json').then((m) => withEnglishFallback(m.default)),
  mn: () => import('@/locales/mn/common.json').then((m) => withEnglishFallback(m.default)),
  nb: () => import('@/locales/nb/common.json').then((m) => withEnglishFallback(m.default)),
  nl: () => import('@/locales/nl/common.json').then((m) => withEnglishFallback(m.default)),
  pl: () => import('@/locales/pl/common.json').then((m) => withEnglishFallback(m.default)),
  pt: () => import('@/locales/pt/common.json').then((m) => withEnglishFallback(m.default)),
  ro: () => import('@/locales/ro/common.json').then((m) => withEnglishFallback(m.default)),
  ru: () => import('@/locales/ru/common.json').then((m) => withEnglishFallback(m.default)),
  sk: () => import('@/locales/sk/common.json').then((m) => withEnglishFallback(m.default)),
  th: () => import('@/locales/th/common.json').then((m) => withEnglishFallback(m.default)),
  tr: () => import('@/locales/tr/common.json').then((m) => withEnglishFallback(m.default)),
  uk: () => import('@/locales/uk/common.json').then((m) => withEnglishFallback(m.default)),
  vi: () => import('@/locales/vi/common.json').then((m) => addPlainLanguage('vi', m.default)).then(withEnglishFallback),
  zh: () => import('@/locales/zh/common.json').then((m) => withEnglishFallback(m.default)),
  'zh-TW': () => import('@/locales/zh-TW/common.json').then((m) => withEnglishFallback(m.default)),
};

interface IntlProviderProps {
  locale: string;
  /** Omitted by the Lite export: the catalog is then loaded on the client. */
  messages?: Messages;
  children: React.ReactNode;
}

export function IntlProvider({ locale: initialLocale, messages: initialMessages, children }: IntlProviderProps) {
  const currentLocale = useLocaleStore((state) => state.locale);
  // Browser zone is detected on mount (SSR has no browser, so it renders UTC
  // until then); the user's `timeZone` setting overrides it (#755).
  const [browserTimeZone, setBrowserTimeZone] = useState<string>('UTC');
  const timeZoneSetting = useSettingsStore((state) => state.timeZone);
  const timeZone = resolveTimeZone(timeZoneSetting, browserTimeZone);
  const pathname = usePathname();

  // The catalog currently in use. Seeded with the server-provided messages for
  // the SSR-resolved locale, so the first render needs no async work and
  // matches the server output. Locale and messages switch together once a
  // lazily loaded catalog arrives, never out of sync. The server's catalog
  // has English under it already. Without server messages (Lite) only English
  // is at hand; any other locale renders nothing, on the server and on the
  // client alike, until its chunk arrives.
  const seed = initialMessages ?? (initialLocale === 'en' ? LITE_ENGLISH ?? undefined : undefined);
  const [catalog, setCatalog] = useState<{ locale: string; messages: Messages } | null>(
    seed ? { locale: initialLocale, messages: seed } : null,
  );
  const loadedRef = useRef<Record<string, Messages>>({
    ...(LITE_ENGLISH ? { en: LITE_ENGLISH } : {}),
    ...(seed ? { [initialLocale]: seed } : {}),
  });

  // Detect the browser's timezone on mount (falls back to UTC internally)
  useEffect(() => {
    setBrowserTimeZone(getBrowserTimeZone());
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
      setCatalog((prev) => (prev?.locale === target ? prev : { locale: target, messages: cached }));
      return;
    }

    let stale = false;
    const load = LOCALE_LOADERS[target];
    // Unknown locale: render English strings under the requested tag, matching
    // the old `?? {}` fallback behavior.
    // A chunk that fails to load falls back the same way, so a Lite page with
    // no seeded catalog never stays blank.
    const english = () => (LITE_ENGLISH ? Promise.resolve(LITE_ENGLISH) : loadEnglishMessages().catch(() => ({} as Messages)));
    (load ? load().catch(english) : english()).then((messages) => {
      if (stale) return;
      loadedRef.current[target] = messages;
      setCatalog({ locale: target, messages });
    });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLocale]);

  // Keep <html> lang/dir in sync with the rendered locale (RTL for he/fa).
  const activeLocale = catalog?.locale;
  useEffect(() => {
    if (!activeLocale) return;
    document.documentElement.lang = activeLocale;
    document.documentElement.dir = getLocaleDirection(activeLocale);
  }, [activeLocale]);

  // Every catalog comes with English under it for the keys the locale has not
  // translated (the server's, the loaders' above), and with its plain strings,
  // so first render and hydration show the same wording.
  if (!catalog) {
    // Lite without this locale's catalog yet: no text can be drawn, but the
    // page's skeleton can (it takes no translations), so the prerendered HTML
    // still shows the page's shape instead of a blank screen.
    const surface = pathname ? surfaceFromPath(pathname, locales) : null;
    return surface && LiteRouteSkeleton ? <LiteRouteSkeleton surface={surface} /> : null;
  }

  return (
    <NextIntlClientProvider
      locale={catalog.locale}
      messages={catalog.messages}
      timeZone={timeZone}
    >
      {children}
    </NextIntlClientProvider>
  );
}
