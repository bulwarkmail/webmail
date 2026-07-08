import { getRequestConfig } from 'next-intl/server';
import { headers } from 'next/headers';
import { mergeMessages } from './merge-messages';
import { routing, type Locale } from './routing';

// Default a first-time visitor (no explicit stored choice) to the best supported
// language from their browser's Accept-Language header, so "Auto" is the real
// default and the first server render already matches the browser language.
function localeFromAcceptLanguage(header: string | null): string | null {
  if (!header) return null;
  const supported = new Set<string>(routing.locales as readonly string[]);
  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, q] = part.trim().split(';q=');
      return { base: tag.toLowerCase().split('-')[0], q: q ? parseFloat(q) : 1 };
    })
    .sort((a, b) => b.q - a.q);
  for (const { base } of ranked) {
    if (supported.has(base)) return base;
  }
  return null;
}

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;

  if (!locale || !routing.locales.includes(locale as Locale)) {
    const accept = (await headers()).get('accept-language');
    locale = localeFromAcceptLanguage(accept) ?? routing.defaultLocale;
  }

  // Use static imports for better compatibility
  let messages;
  switch (locale) {
    case 'cs':
      messages = (await import('../locales/cs/common.json')).default;
      break;
    case 'da':
      messages = (await import('../locales/da/common.json')).default;
      break;
    case 'de':
      messages = (await import('../locales/de/common.json')).default;
      break;
    case 'es':
      messages = (await import('../locales/es/common.json')).default;
      break;
    case 'he':
      messages = (await import('../locales/he/common.json')).default;
      break;
    case 'fa':
      messages = (await import('../locales/fa/common.json')).default;
      break;
    case 'fr':
      messages = (await import('../locales/fr/common.json')).default;
      break;
    case 'hu':
      messages = (await import('../locales/hu/common.json')).default;
      break;
    case 'it':
      messages = (await import('../locales/it/common.json')).default;
      break;
    case 'ja':
      messages = (await import('../locales/ja/common.json')).default;
      break;
    case 'ko':
      messages = (await import('../locales/ko/common.json')).default;
      break;
    case 'lv':
      messages = (await import('../locales/lv/common.json')).default;
      break;
    case 'nl':
      messages = (await import('../locales/nl/common.json')).default;
      break;
    case 'pl':
      messages = (await import('../locales/pl/common.json')).default;
      break;
    case 'pt':
      messages = (await import('../locales/pt/common.json')).default;
      break;
    case 'ro':
      messages = (await import('../locales/ro/common.json')).default;
      break;
    case 'ru':
      messages = (await import('../locales/ru/common.json')).default;
      break;
    case 'sk':
      messages = (await import('../locales/sk/common.json')).default;
      break;
    case 'tr':
      messages = (await import('../locales/tr/common.json')).default;
      break;
    case 'uk':
      messages = (await import('../locales/uk/common.json')).default;
      break;
    case 'zh':
      messages = (await import('../locales/zh/common.json')).default;
      break;
    default:
      messages = (await import('../locales/en/common.json')).default;
  }

  if (locale !== 'en') {
    const enBase = (await import('../locales/en/common.json')).default as Record<string, unknown>;
    messages = mergeMessages(enBase, messages as Record<string, unknown>);
  }

  return {
    locale,
    messages,
    timeZone: 'Europe/Paris',
    now: new Date()
  };
});
