import { locales } from '@/i18n/routing';

export function replaceWindowLocation(url: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.location.replace(url);
}

// Build-time constant injected by next.config.ts. When the app is built with
// NEXT_PUBLIC_BASE_PATH=/webmail, Next.js itself prefixes routes and assets;
// helpers below use the same value so client code stays consistent.
const STATIC_BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

/**
 * Returns the mount prefix the app is served at.
 *
 * Resolution order:
 *  1. The build-time `NEXT_PUBLIC_BASE_PATH` constant (set in next.config.ts).
 *  2. Runtime detection from `window.location.pathname` for legacy deploys
 *     where the reverse proxy mounts the app at a subpath without rebuilding.
 *
 * If a locale is supplied (e.g. from route params) it anchors the runtime
 * detection; otherwise the first path segment that matches a known locale is
 * used.
 *
 * Returns '' when there is no prefix.
 */
export function getPathPrefix(locale?: string): string {
  if (STATIC_BASE_PATH) return STATIC_BASE_PATH;
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
 * the raw Fetch API - the mount prefix is a browser-only concept.
 *
 * @example
 *   await apiFetch('/api/jmap', { method: 'POST', body })
 *   // Browser at /webmail/en/inbox  → /webmail/api/jmap
 *   // Browser at /en/inbox          → /api/jmap
 */
export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  if (input.startsWith('/') && !input.startsWith('//')) {
    return fetch(getPathPrefix() + input, init);
  }
  return fetch(input, init);
}

/**
 * Mount-prefix-aware wrapper for URL strings used in `<img src>`, `<link href>`,
 * `window.location.*`, etc. — anything the browser resolves itself, where
 * `apiFetch` can't help.
 *
 * Idempotent: passing an already-prefixed value, an external URL, a
 * protocol-relative URL, or an empty/falsy value returns it unchanged. So it's
 * safe to wrap admin-configurable values that might be either a local path
 * (`/branding/foo.svg`, `/api/admin/branding/...`) or a full URL.
 */
export function withBasePath(url: string | null | undefined): string {
  if (!url) return url ?? '';
  if (url.charCodeAt(0) !== 47) return url;        // not absolute (e.g. https://, data:, blob:)
  if (url.charCodeAt(1) === 47) return url;        // protocol-relative //cdn...
  const prefix = getPathPrefix();
  if (!prefix) return url;
  if (url === prefix || url.startsWith(prefix + '/')) return url;
  return prefix + url;
}


/**
 * Converts a browser-style path (as found in `window.location.pathname`,
 * which always includes the mount prefix) into a path safe to hand to Next's
 * client router (`router.push` / `router.replace`).
 *
 * When the app is built with NEXT_PUBLIC_BASE_PATH, Next's router prepends
 * the basePath itself, so a stored prefixed path would get it twice (#390) —
 * strip it here. Legacy runtime-detected proxy mounts pass through unchanged:
 * Next knows nothing about that prefix, so the router needs the full path.
 *
 * Accepts paths with query/hash suffixes (`/webmail/en/calendar?view=day`).
 */
export function toRouterPath(path: string): string {
  if (!STATIC_BASE_PATH || !path.startsWith(STATIC_BASE_PATH)) return path;
  const rest = path.slice(STATIC_BASE_PATH.length);
  if (rest === '') return '/';
  if (rest[0] === '/') return rest;
  if (rest[0] === '?' || rest[0] === '#') return '/' + rest;
  return path; // different first segment that merely shares the prefix text
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