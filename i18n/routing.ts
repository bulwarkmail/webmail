import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['en', 'fr', 'de', 'es', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru'],
  defaultLocale: 'en',
  localePrefix: 'never'
});

export const locales = routing.locales;
export const defaultLocale = routing.defaultLocale;
export type Locale = (typeof locales)[number];