import { routing } from './routing';
import { matchSupportedLocale } from './locale-matcher';
import { useLocaleStore } from '@/stores/locale-store';
import { XENAXIO_BFF, XENAXIO_LOCALES } from '@/lib/xenaxio/bff';

// xenaxio: only DE/EN exist (spec W6); a browser in any other language gets
// the default instead of a locale whose pages the build does not have.
const detectableLocales = XENAXIO_BFF ? XENAXIO_LOCALES : routing.locales;

/** xenaxio: a stored or synced choice outside DE/EN counts as "auto". */
export function isUsableLocaleChoice(choice: string | null | undefined): choice is string {
  if (!choice || choice === 'auto') return false;
  return !XENAXIO_BFF || XENAXIO_LOCALES.includes(choice);
}

/**
 * Pick the best supported locale for a first-time visitor from their browser
 * language preferences. Returns `fallback` (English default) when the browser
 * prefers English, prefers nothing we support, or is unavailable (SSR) — so we
 * only auto-switch AWAY from English when the browser clearly prefers another
 * language we ship. A user's explicit choice is persisted separately and is
 * never overridden by this.
 */
export function detectBrowserLocale(fallback: string): string {
  if (typeof navigator === 'undefined') return fallback;
  const prefs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of prefs) {
    if (!tag) continue;
    const locale = matchSupportedLocale(tag, detectableLocales);
    if (locale === 'en') return fallback; // English is the top preference -> keep default
    if (locale) return locale;             // first supported non-English preference wins
  }
  return fallback;
}

/**
 * The locale to actually use for Intl/formatting and the provider: the user's
 * stored choice when it's a real locale, otherwise (empty or 'auto') the
 * resolved UI locale — never the 'auto' sentinel, which is not a valid BCP-47
 * tag and throws in Intl.* APIs.
 */
export function getEffectiveLocale(): string {
  const choice = useLocaleStore.getState().locale;
  if (isUsableLocaleChoice(choice)) return choice;
  if (typeof document !== 'undefined' && document.documentElement.lang) {
    return document.documentElement.lang;
  }
  return detectBrowserLocale('en');
}
