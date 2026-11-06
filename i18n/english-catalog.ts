import { mergeMessages } from './merge-messages';
import { withPlainLanguage } from './plain-language';

type Messages = Record<string, unknown>;

let english: Promise<Messages> | null = null;

/**
 * English with its plain wording, the base every other catalog falls back to.
 * Its own chunk, fetched once on first use: the server hands each page its
 * catalog with English already under it (i18n/catalog.ts), so a page load
 * needs this only to switch language or to translate outside the page.
 */
export function loadEnglishMessages(): Promise<Messages> {
  if (!english) {
    const loading = Promise.all([
      import('@/locales/en/common.json'),
      import('@/locales/en/plain.json'),
    ]).then(([common, plain]) => withPlainLanguage(common.default as Messages, plain.default as Messages));
    // A chunk that failed to load is tried again next time.
    loading.catch(() => { if (english === loading) english = null; });
    english = loading;
  }
  return english;
}

/** `messages` with English under it, for any string it hasn't translated. */
export async function withEnglishFallback(messages: Messages): Promise<Messages> {
  return mergeMessages(await loadEnglishMessages(), messages);
}
