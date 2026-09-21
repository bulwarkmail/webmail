import { getRequestConfig } from 'next-intl/server';
import { headers } from 'next/headers';
import { mergeMessages } from './merge-messages';
import { localeFromAcceptLanguage } from './locale-matcher';
import { routing, type Locale } from './routing';
import { IS_LITE } from '@/lib/lite';
import { configManager } from '@/lib/admin/config-manager';
import { resolveDefaultLocale } from '@/lib/admin/default-locale';

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;

  if (!locale || !routing.locales.includes(locale as Locale)) {
    if (IS_LITE) {
      // Static export: there is no request to sniff; every localized page pins
      // its locale via setRequestLocale, so this only covers the root layout.
      locale = routing.defaultLocale;
    } else {
      await configManager.ensureLoaded();
      const accept = (await headers()).get('accept-language');
      locale = localeFromAcceptLanguage(accept, routing.locales) ?? resolveDefaultLocale();
    }
  }

  // Use static imports for better compatibility
  let messages;
  switch (locale) {
    case 'ar':
      messages = (await import('../locales/ar/common.json')).default;
      break;
    case 'ca':
      messages = (await import('../locales/ca/common.json')).default;
      break;
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
    case 'mn':
      messages = (await import('../locales/mn/common.json')).default;
      break;
    case 'nb':
      messages = (await import('../locales/nb/common.json')).default;
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
    case 'zh-TW':
      messages = (await import('../locales/zh-TW/common.json')).default;
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
