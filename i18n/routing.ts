import { defineRouting } from 'next-intl/routing';

// Locale prefix mode can be configured via NEXT_PUBLIC_LOCALE_PREFIX.
// - "never"    (default): /settings - locale from cookie/Accept-Language
// - "always":             /en/settings - locale always in the URL
// - "as-needed":          /settings for default locale, /fr/settings otherwise
// When proxying Bulwark under a sub-path (NEXT_PUBLIC_BASE_PATH), "always" is
// recommended to avoid next-intl rewrite loops caused by locale detection
// conflicting with the proxy's path rewriting.
const localePrefix = (process.env.NEXT_PUBLIC_LOCALE_PREFIX ?? 'never') as
  | 'never'
  | 'always'
  | 'as-needed';

export const routing = defineRouting({
  locales: ['cs', 'en', 'fr', 'de', 'es', 'it', 'ja', 'ko', 'lv', 'nl', 'pl', 'pt', 'ru', 'tr', 'uk', 'zh'],
  defaultLocale: 'en',
  localePrefix
});

export const locales = routing.locales;
export const defaultLocale = routing.defaultLocale;
export type Locale = (typeof locales)[number];
