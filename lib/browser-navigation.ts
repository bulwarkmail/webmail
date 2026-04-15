import { locales } from '@/i18n/routing';

export function replaceWindowLocation(url: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.location.replace(url);
}

/**
 * Returns the mount prefix from the current URL.
 * When the app is served behind a reverse proxy at e.g. /bulwark,
 * the browser sees /bulwark/en/login while Next.js sees /en/login.
 *
 * If a locale is supplied (e.g. from route params) it is used directly;
 * otherwise the first path segment that matches a known locale is used.
 *
 * Returns '' when there is no prefix.
 */
export function getPathPrefix(locale?: string): string {
  if (typeof window === 'undefined') return '';

  const segments = window.location.pathname.split('/').filter(Boolean);

  let localeIndex: number;
  if (locale) {
    localeIndex = segments.indexOf(locale);
  } else {
    localeIndex = segments.findIndex(s =>
      (locales as readonly string[]).includes(s)
    );
  }

  if (localeIndex <= 0) return '';
  return '/' + segments.slice(0, localeIndex).join('/');
}

/**
 * Mount-prefix-aware wrapper around `fetch()`.
 *
 * When Bulwark is served behind a reverse proxy at a sub-path (e.g. `/bulwark`),
 * `fetch('/api/foo')` would target the browser origin at `/api/foo`, which the
 * proxy doesn't route. `apiFetch` detects the mount prefix from
 * `window.location.pathname` via `getPathPrefix()` at call time, so the same
 * built bundle works at any mount point without rebuilding.
 *
 * Only rewrites absolute paths that start with a single `/`. Protocol-relative
 * URLs (`//cdn.example.com/foo`) and absolute URLs (`https://...`) pass
 * through unchanged.
 *
 * Server code (route handlers, layout files running at SSR) should keep using
 * the raw Fetch API — the mount prefix is a browser-only concept.
 *
 * @example
 *   await apiFetch('/api/jmap', { method: 'POST', body })
 *   // Browser at /webmail/en/inbox  → /webmail/api/jmap
 *   // Browser at /en/inbox          → /api/jmap
 */
// eslint-disable-next-line no-undef
export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  if (input.startsWith('/') && !input.startsWith('//')) {
    return fetch(getPathPrefix() + input, init);
  }
  return fetch(input, init);
}


/**
 * Extracts the locale from the current URL, skipping any mount prefix.
 * Falls back to 'en' when no known locale segment is found.
 */
export function getLocaleFromPath(): string {
  if (typeof window === 'undefined') return 'en';

  const segments = window.location.pathname.split('/').filter(Boolean);
  const locale = segments.find(s =>
    (locales as readonly string[]).includes(s)
  );
  return locale || 'en';
}