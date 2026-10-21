import { afterEach, describe, expect, it, vi } from 'vitest';

// The xenaxio build only has DE/EN pages (spec W6, LITE_LOCALES=en,de). A
// browser in Russian used to switch the app to /ru/..., which is a 404.

function setBrowserLanguages(languages: string[]) {
  vi.stubGlobal('navigator', { languages, language: languages[0] });
}

async function loadDetect(bff: boolean) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_XENAXIO_BFF', bff ? '1' : '');
  return import('@/i18n/detect-locale');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('locale detection in the xenaxio build', () => {
  it('ignores browser languages other than DE/EN', async () => {
    const { detectBrowserLocale } = await loadDetect(true);
    setBrowserLanguages(['ru-RU', 'ru', 'en-US']);
    expect(detectBrowserLocale('en')).toBe('en');
    setBrowserLanguages(['ru', 'de-DE']);
    expect(detectBrowserLocale('en')).toBe('de');
  });

  it('treats a stored choice outside DE/EN as auto', async () => {
    const { isUsableLocaleChoice } = await loadDetect(true);
    expect(isUsableLocaleChoice('ru')).toBe(false);
    expect(isUsableLocaleChoice('auto')).toBe(false);
    expect(isUsableLocaleChoice('de')).toBe(true);
  });

  it('keeps upstream behaviour without the BFF flag', async () => {
    const { detectBrowserLocale, isUsableLocaleChoice } = await loadDetect(false);
    setBrowserLanguages(['ru-RU']);
    expect(detectBrowserLocale('en')).toBe('ru');
    expect(isUsableLocaleChoice('ru')).toBe(true);
  });
});
