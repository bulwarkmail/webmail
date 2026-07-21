// RTL locales: Hebrew (he) and Persian/Farsi (fa). Everything else is LTR.
const rtlLocales = new Set(['he', 'fa']);

export function getLocaleDirection(locale: string): 'ltr' | 'rtl' {
  return rtlLocales.has(locale) ? 'rtl' : 'ltr';
}

/**
 * Whether the document is currently rendering right-to-left. For popovers
 * positioned in JS via getBoundingClientRect() (Tailwind's logical start-0/
 * end-0 utilities don't apply to inline fixed-position styles), check this
 * to anchor on the correct physical side.
 */
export function isDocumentRTL(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
}
