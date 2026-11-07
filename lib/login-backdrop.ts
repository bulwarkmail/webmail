/**
 * The login page's layout and background, as the admin set them (Branding >
 * Login page, or LOGIN_LAYOUT / LOGIN_BACKGROUND_*). The root layout writes
 * them into the page's <head> on the server, so the page and its loading
 * skeleton both draw them on the first paint (app/login.css).
 */

export type LoginLayout = 'centered' | 'split';

export interface LoginBackdrop {
  layout: LoginLayout;
  /** Image for light mode; '' for none. */
  lightUrl: string;
  /** Image for dark mode; falls back to the light one. */
  darkUrl: string;
  /** How much the image is darkened, 0 to MAX_DIM percent. */
  dim: number;
  /** How much the image is blurred, 0 to MAX_BLUR px. */
  blur: number;
}

export const MAX_DIM = 80;
export const MAX_BLUR = 24;

/** A whole number between 0 and max, from an admin's text; 0 for anything else. */
function clampInt(raw: string, max: number): number {
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, max);
}

/**
 * Only a path on this site or an http(s) URL is used. Anything else (a
 * `javascript:` or `data:` URL, a protocol-relative `//host`) is dropped.
 */
export function usableBackgroundUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return '';
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  if (/^https?:\/\/[^\s/]/i.test(url)) return url;
  return '';
}

export function resolveLoginBackdrop(get: (key: string) => string): LoginBackdrop {
  const lightUrl = usableBackgroundUrl(get('loginBackgroundLightUrl'));
  const darkUrl = usableBackgroundUrl(get('loginBackgroundDarkUrl')) || lightUrl;
  return {
    layout: get('loginLayout').trim() === 'split' ? 'split' : 'centered',
    lightUrl,
    darkUrl,
    dim: clampInt(get('loginBackgroundDim'), MAX_DIM),
    blur: clampInt(get('loginBackgroundBlur'), MAX_BLUR),
  };
}

/**
 * A CSS url() for a value that goes into a <style> element: the characters
 * that could end the string, the declaration or the element are
 * percent-encoded, which leaves the URL itself unchanged for the browser.
 */
export function cssUrl(url: string): string {
  const escaped = url.replace(/["'\\<>()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  return `url("${escaped}")`;
}

/**
 * The CSS for the backdrop: the image per colour mode, the dim and the blur
 * as custom properties that app/login.css reads. Empty without an image.
 * `withBase` adds the base path to a path on this site.
 */
export function loginBackdropCss(backdrop: LoginBackdrop, withBase: (path: string) => string = (p) => p): string {
  if (!backdrop.lightUrl) return '';
  const src = (url: string) => cssUrl(url.startsWith('/') ? withBase(url) : url);
  const rules = [
    `:root{--login-bg-image:${src(backdrop.lightUrl)};--login-bg-dim:${backdrop.dim / 100};--login-bg-blur:${backdrop.blur}px}`,
  ];
  if (backdrop.darkUrl !== backdrop.lightUrl) rules.push(`:root.dark{--login-bg-image:${src(backdrop.darkUrl)}}`);
  return rules.join('');
}

/** Attributes for <html> that app/login.css keys the layout and backdrop on. */
export function loginBackdropAttributes(backdrop: LoginBackdrop): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (backdrop.layout === 'split') attrs['data-login-layout'] = 'split';
  if (backdrop.lightUrl) attrs['data-login-bg'] = 'image';
  return attrs;
}
