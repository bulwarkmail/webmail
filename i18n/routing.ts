import { defineRouting } from 'next-intl/routing';

// Locale prefix mode can be configured via NEXT_PUBLIC_LOCALE_PREFIX.
// - "never"    (default): /settings - locale from cookie/Accept-Language
// - "always":             /en/settings - locale always in the URL
// - "as-needed":          /settings for default locale, /fr/settings otherwise
// When proxying Bulwark under a sub-path (NEXT_PUBLIC_BASE_PATH), "always" is
// recommended to avoid next-intl rewrite loops caused by locale detection
// conflicting with the proxy's path rewriting.
export type LocalePrefixMode = 'never' | 'always' | 'as-needed';
const LOCALE_PREFIX_MODES: readonly string[] = ['never', 'always', 'as-needed'];

/**
 * The prefix mode for a NEXT_PUBLIC_LOCALE_PREFIX value. Empty counts as
 * unset: the Dockerfile's `ARG NEXT_PUBLIC_LOCALE_PREFIX=` passes "" when no
 * build arg is given, and next-intl reads an empty mode as "always" (#1626).
 * next.config.ts refuses any other value at build time.
 */
export function localePrefixMode(value: string | undefined): LocalePrefixMode {
  const mode = value?.trim() ?? '';
  return LOCALE_PREFIX_MODES.includes(mode) ? (mode as LocalePrefixMode) : 'never';
}

const localePrefix = localePrefixMode(process.env.NEXT_PUBLIC_LOCALE_PREFIX);

const SUPPORTED_LOCALES = ['ar', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fa', 'fr', 'he', 'hu', 'it', 'ja', 'ko', 'lv', 'mn', 'nb', 'nl', 'nn', 'pl', 'pt', 'ro', 'ru', 'sk', 'th', 'tr', 'uk', 'vi', 'zh', 'zh-TW'] as const;

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
