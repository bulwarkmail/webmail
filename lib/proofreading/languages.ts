// Languages offered for the writing-language setting: the app's languages,
// with the regional variants spell checkers tell apart, plus whatever the
// installed checkers say they handle. Names come from the browser
// (Intl.DisplayNames) in the user's language.

export const WRITING_LANGUAGES = [
  'ar', 'ca', 'cs', 'da', 'de-DE', 'de-AT', 'de-CH', 'el', 'en-US', 'en-GB', 'en-AU', 'en-CA', 'en-NZ', 'en-ZA',
  'es', 'et', 'fa', 'fi', 'fr', 'fr-CA', 'fr-CH', 'he', 'hu', 'it', 'ja', 'ko', 'lv', 'mn', 'nb', 'nn', 'nl', 'nl-BE',
  'pl', 'pt-PT', 'pt-BR', 'ro', 'ru', 'sk', 'sl', 'sv', 'th', 'tr', 'uk', 'vi', 'zh-CN', 'zh-TW',
] as const;

export function languageName(tag: string, uiLocale: string): string {
  try {
    const name = new Intl.DisplayNames([uiLocale], { type: 'language' }).of(tag);
    if (name && name !== tag) return name;
  } catch { /* an odd tag: show it as it is */ }
  return tag;
}

/** The options for the setting, sorted by name, with extra tags from checkers. */
export function writingLanguageOptions(uiLocale: string, extra: readonly string[] = []): { value: string; label: string }[] {
  const tags = [...new Set<string>([...WRITING_LANGUAGES, ...extra])];
  return tags
    .map((value) => ({ value, label: languageName(value, uiLocale) }))
    .sort((a, b) => a.label.localeCompare(b.label, uiLocale));
}
