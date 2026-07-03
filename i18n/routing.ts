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

const SUPPORTED_LOCALES = ['cs', 'da', 'de', 'en', 'es', 'fa', 'fr', 'hu', 'it', 'ja', 'ko', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'tr', 'uk', 'zh'] as const;

// Fallback locale used when the visitor's Accept-Language header does not
// match any supported locale (and no NEXT_LOCALE cookie is set yet). Admins
// set this via NEXT_PUBLIC_DEFAULT_LOCALE at build time to localise greenfield
// deployments without having every user change their preference manually.
const envDefaultLocale = process.env.NEXT_PUBLIC_DEFAULT_LOCALE?.trim();
const resolvedDefaultLocale =
  envDefaultLocale && (SUPPORTED_LOCALES as readonly string[]).includes(envDefaultLocale)
    ? (envDefaultLocale as (typeof SUPPORTED_LOCALES)[number])
    : 'en';

export const routing = defineRouting({
  locales: SUPPORTED_LOCALES,
  defaultLocale: resolvedDefaultLocale,
  localePrefix
});

export const locales = routing.locales;
export const defaultLocale = routing.defaultLocale;
export type Locale = (typeof locales)[number];
