import { mergeMessages } from './merge-messages';

type Messages = Record<string, unknown>;

/**
 * Plain wording (CO-14, made the only wording in the 2026-11-04 usability
 * pass): simpler versions of settings and error messages. English, German
 * and Vietnamese have them; every other locale keeps its strings.
 *
 * The plain strings live in `locales/<code>/plain.json`, outside common.json,
 * so the translation parity test doesn't ask every locale for them. Each file
 * holds only the keys that get a simpler version, under the same key paths as
 * common.json; anything it leaves out falls back to the normal string. They
 * are laid over the catalog wherever a catalog is loaded (server layouts,
 * request config, the client's locale loaders), always, with no setting.
 */
export const PLAIN_LANGUAGE_LOADERS: Record<string, () => Promise<Messages>> = {
  en: () => import('@/locales/en/plain.json').then((m) => m.default as Messages),
  de: () => import('@/locales/de/plain.json').then((m) => m.default as Messages),
  vi: () => import('@/locales/vi/plain.json').then((m) => m.default as Messages),
};

export function hasPlainLanguage(locale: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLAIN_LANGUAGE_LOADERS, locale);
}

/** The catalog with the plain strings laid over it, or the catalog unchanged. */
export function withPlainLanguage(messages: Messages, plain: Messages | undefined): Messages {
  return plain ? mergeMessages(messages, plain) : messages;
}

/**
 * The locale's catalog with its plain strings laid over it. A locale without
 * plain strings, or one whose file fails to load, gets the catalog unchanged.
 */
export async function addPlainLanguage(locale: string, messages: Messages): Promise<Messages> {
  if (!hasPlainLanguage(locale)) return messages;
  const plain = await PLAIN_LANGUAGE_LOADERS[locale]().catch(() => undefined);
  return withPlainLanguage(messages, plain);
}
