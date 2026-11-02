"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { usePathname } from 'next/navigation';
import { RouteSkeleton } from '@/components/boot-skeleton/route-skeleton';
import { surfaceFromPath } from '@/lib/boot-skeleton/surfaces';
import { locales } from '@/i18n/routing';
import { useLocaleStore } from '@/stores/locale-store';
import { useSettingsStore } from '@/stores/settings-store';
import { getBrowserTimeZone, resolveTimeZone } from '@/lib/timezone';
import enMessages from '@/locales/en/common.json';
import { getLocaleDirection } from '@/i18n/direction';
import { mergeMessages } from '@/i18n/merge-messages';
import { detectBrowserLocale } from '@/i18n/detect-locale';
import { PLAIN_LANGUAGE_LOADERS, hasPlainLanguage, withPlainLanguage } from '@/i18n/plain-language';

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
  et: () => import('@/locales/et/common.json').then((m) => m.default),
  fa: () => import('@/locales/fa/common.json').then((m) => m.default),
  fr: () => import('@/locales/fr/common.json').then((m) => m.default),
  hu: () => import('@/locales/hu/common.json').then((m) => m.default),
  it: () => import('@/locales/it/common.json').then((m) => m.default),
  ja: () => import('@/locales/ja/common.json').then((m) => m.default),
  ko: () => import('@/locales/ko/common.json').then((m) => m.default),
  lv: () => import('@/locales/lv/common.json').then((m) => m.default),
  mn: () => import('@/locales/mn/common.json').then((m) => m.default),
  nb: () => import('@/locales/nb/common.json').then((m) => m.default),
  nl: () => import('@/locales/nl/common.json').then((m) => m.default),
  pl: () => import('@/locales/pl/common.json').then((m) => m.default),
  pt: () => import('@/locales/pt/common.json').then((m) => m.default),
  ro: () => import('@/locales/ro/common.json').then((m) => m.default),
  ru: () => import('@/locales/ru/common.json').then((m) => m.default),
  sk: () => import('@/locales/sk/common.json').then((m) => m.default),
  th: () => import('@/locales/th/common.json').then((m) => m.default),
  tr: () => import('@/locales/tr/common.json').then((m) => m.default),
  uk: () => import('@/locales/uk/common.json').then((m) => m.default),
  vi: () => import('@/locales/vi/common.json').then((m) => m.default),
  zh: () => import('@/locales/zh/common.json').then((m) => m.default),
  'zh-TW': () => import('@/locales/zh-TW/common.json').then((m) => m.default),
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
  const plainLanguage = useSettingsStore((state) => state.plainLanguage);
  const pathname = usePathname();

  // The catalog currently in use. Seeded with the server-provided messages for
  // the SSR-resolved locale, so the first render needs no async work and
  // matches the server output. Locale and messages switch together once a
  // lazily loaded catalog arrives, never out of sync. Without server messages
  // (Lite) only English is at hand; any other locale renders nothing, on the
  // server and on the client alike, until its chunk arrives.
  const seed = initialMessages ?? (initialLocale === 'en' ? (enMessages as Messages) : undefined);
  const [catalog, setCatalog] = useState<{ locale: string; messages: Messages } | null>(
    seed ? { locale: initialLocale, messages: seed } : null,
  );
  const loadedRef = useRef<Record<string, Messages>>({
    en: enMessages as Messages,
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
    (load ? load().catch(() => ({} as Messages)) : Promise.resolve({} as Messages)).then((messages) => {
      if (stale) return;
      loadedRef.current[target] = messages;
      setCatalog({ locale: target, messages });
    });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentLocale]);

  // Plain-language strings, loaded the first time the setting is on for an
  // English or German UI. They arrive after the first render, so hydration
  // always matches the server's normal strings.
  const [plainCatalogs, setPlainCatalogs] = useState<Record<string, Messages>>({});
  const plainLocale = plainLanguage && catalog && hasPlainLanguage(catalog.locale) ? catalog.locale : null;
  useEffect(() => {
    if (!plainLocale || plainCatalogs[plainLocale]) return;
    let stale = false;
    PLAIN_LANGUAGE_LOADERS[plainLocale]()
      .catch(() => ({} as Messages))
      .then((plain) => {
        if (!stale) setPlainCatalogs((prev) => ({ ...prev, [plainLocale]: plain }));
      });
    return () => { stale = true; };
  }, [plainLocale, plainCatalogs]);

  // Keep <html> lang/dir in sync with the rendered locale (RTL for he/fa).
  const activeLocale = catalog?.locale;
  useEffect(() => {
    if (!activeLocale) return;
    document.documentElement.lang = activeLocale;
    document.documentElement.dir = getLocaleDirection(activeLocale);
  }, [activeLocale]);

  // Fall back to English for any key the active locale has not translated, so
  // untranslated strings show English text instead of a raw message key.
  const baseMessages = useMemo(
    () =>
      !catalog || catalog.locale === 'en'
        ? (enMessages as Messages)
        : mergeMessages(enMessages as Messages, catalog.messages),
    [catalog]
  );
  // Plain strings win over the catalog; keys without a plain version keep it.
  const plainMessages = plainLocale ? plainCatalogs[plainLocale] : undefined;
  const messages = useMemo(
    () => withPlainLanguage(baseMessages, plainMessages),
    [baseMessages, plainMessages]
  );

  if (!catalog) {
    // Lite without this locale's catalog yet: no text can be drawn, but the
    // page's skeleton can (it takes no translations), so the prerendered HTML
    // still shows the page's shape instead of a blank screen.
    const surface = pathname ? surfaceFromPath(pathname, locales) : null;
    return surface ? <RouteSkeleton surface={surface} /> : null;
  }

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
