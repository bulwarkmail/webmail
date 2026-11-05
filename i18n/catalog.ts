import { mergeMessages } from './merge-messages';
import { addPlainLanguage } from './plain-language';

type Messages = Record<string, unknown>;

/**
 * The catalog a server layout hands to IntlProvider: the locale's strings with
 * their plain wording, and English under them for anything not translated.
 * Merged here, so the browser doesn't need its own copy of English to draw the
 * page (it was half a megabyte of script on every first load). Throws for a
 * locale without a catalog.
 */
export async function loadCatalog(locale: string): Promise<Messages> {
  const own = await addPlainLanguage(locale, (await import(`@/locales/${locale}/common.json`)).default as Messages);
  if (locale === 'en') return own;
  const english = await addPlainLanguage('en', (await import('@/locales/en/common.json')).default as Messages);
  return mergeMessages(english, own);
}
