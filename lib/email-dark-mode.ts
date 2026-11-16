/**
 * Dark mode for HTML email bodies rendered in a viewer iframe.
 */

import createEmailDarkModeEngine, { type Rgba } from './email-dark-mode-engine';

export type { Rgba };

/** Whether the email ships its own dark styles. */
export function emailHasNativeDarkMode(html: string): boolean {
  return /prefers-color-scheme\s*:\s*dark/i.test(html);
}

/**
 * `color-scheme` for the iframe element and its root. A mail with its own
 * dark styles gets `dark`, so its `prefers-color-scheme: dark` rules apply
 * whenever the app shows it dark - not only when the OS is dark too, which is
 * what `light dark` would mean.
 */
export function emailColorScheme(isDark: boolean, nativeDarkMode: boolean): 'light' | 'dark' {
  return isDark && nativeDarkMode ? 'dark' : 'light';
}

const ALWAYS = '(min-width: 0px)';
const NEVER = '(max-width: 0.001px)';

/**
 * Pins the mail's `prefers-color-scheme` media queries to the theme the app
 * shows it in. Inside the iframe they would follow the OS, not the app: a
 * light app on a dark OS would render the mail's dark variant, and the app's
 * dark mode on a light OS would never trigger it. Only <style> blocks are
 * rewritten.
 */
export function resolveColorSchemeMedia(html: string, isDark: boolean): string {
  if (!/prefers-color-scheme/i.test(html)) return html;
  return html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open: string, css: string, close: string) =>
    open + css.replace(/\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi, (_q, scheme: string) =>
      (scheme.toLowerCase() === 'dark') === isDark ? ALWAYS : NEVER) + close);
}

export const EMAIL_DARK_CANVAS: Rgba = { r: 20, g: 20, b: 20, a: 1 };
const DARK_TEXT = '#e6e6e6';
const DARK_LINK = '#8ab4f8';

/** Class on <html> that keeps the body hidden until the pass has run. */
export const DARK_PENDING_CLASS = 'bulwark-dark-pending';

/**
 * Stylesheet for the srcdoc head in dark mode.
 */
export function emailDarkModeCss(): string {
  return `
      @keyframes bulwark-dark-reveal { to { visibility: visible; } }
      html.${DARK_PENDING_CLASS} { background-color: transparent !important; }
      html.${DARK_PENDING_CLASS} body { color: ${DARK_TEXT}; visibility: hidden; animation: bulwark-dark-reveal 0s 1.5s forwards; }
      html.${DARK_PENDING_CLASS} a { color: ${DARK_LINK}; }
    `;
}

const engine = createEmailDarkModeEngine();

export const {
  parseComputedColor,
  parseColor,
  formatColor,
  contrastRatio,
  darkenBackground,
  adaptTextColor,
  readSurfaceColor,
  judgeImagePixels,
  flipFilterMatrix,
} = engine;

export interface EmailDarkModeOptions {
  /**
   * The user allowed remote content for this message. Only then may a remote
   * image be fetched a second time (with CORS) to look at its pixels.
   */
  remoteContentAllowed?: boolean;
  canvas?: Rgba;
}

/**
 * Converts a rendered email document to dark colours in place. Call once,
 * after the document has parsed (styles applied).
 */
export function applyEmailDarkMode(doc: Document, options: EmailDarkModeOptions = {}): void {
  void engine.apply(doc, options);
}
