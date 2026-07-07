// RTL locales: Hebrew (he) and Persian/Farsi (fa). Everything else is LTR.
const rtlLocales = new Set(['he', 'fa']);

export function getLocaleDirection(locale: string): 'ltr' | 'rtl' {
  return rtlLocales.has(locale) ? 'rtl' : 'ltr';
}
