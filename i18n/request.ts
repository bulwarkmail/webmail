import { getRequestConfig } from 'next-intl/server';
import { routing, type Locale } from './routing';

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;

  if (!locale || !routing.locales.includes(locale as Locale)) {
    locale = routing.defaultLocale;
  }

  // Use static imports for better compatibility
  let messages;
  switch (locale) {
    case 'cs':
      messages = (await import('../locales/cs/common.json')).default;
      break;
    case 'fr':
      messages = (await import('../locales/fr/common.json')).default;
      break;
    case 'de':
      messages = (await import('../locales/de/common.json')).default;
      break;
    case 'es':
      messages = (await import('../locales/es/common.json')).default;
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
    case 'ru':
      messages = (await import('../locales/ru/common.json')).default;
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

  return {
    locale,
    messages,
    timeZone: 'Europe/Paris',
    now: new Date()
  };
});
