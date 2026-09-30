import { locales } from '@/i18n/routing';

/**
 * Href helpers for a Lite bundle mounted at a prefix nobody knew at build time
 * (Stalwart `Application` with an admin-chosen `urlPrefix`).
 *
 * Next's router only knows the build-time `basePath`, and next-intl only adds
 * the locale, so `router.push('/settings')` would leave `/webmail` and land
 * on Stalwart's own routes. The Stalwart build routes every `@/i18n/navigation`
 * call through these helpers instead (i18n/mounted-navigation.tsx): hrefs gain
 * `<mount>/<locale>` on the way out, pathnames lose them on the way in, so the
 * components keep comparing against `/settings` exactly as before.
 */

export type MountedHref =
  | string
  | {
      pathname: string;
      query?: Record<string, string | number | boolean | readonly (string | number | boolean)[] | null | undefined>;
      hash?: string;
    };

function isLocale(segment: string | undefined): boolean {
  return !!segment && (locales as readonly string[]).includes(segment);
}

/** `{ pathname, query, hash }` (next-intl's object form) as a plain href string. */
export function hrefToString(href: MountedHref): string {
  if (typeof href === 'string') return href;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(href.query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((v) => params.append(key, String(v)));
    else params.append(key, String(value));
  }
  const search = params.toString();
  const hash = href.hash ? (href.hash.startsWith('#') ? href.hash : `#${href.hash}`) : '';
  return `${href.pathname}${search ? `?${search}` : ''}${hash}`;
}

/**
 * `/settings?tab=x` -> `<prefix>/<locale>/settings?tab=x`.
 *
 * External, protocol-relative and relative hrefs pass through, and so does a
 * path that already carries the prefix (or, at the site root, a locale), so
 * wrapping twice is harmless.
 */
export function mountedHref(href: MountedHref, locale: string, prefix: string): string {
  const raw = hrefToString(href);
  if (!raw.startsWith('/') || raw.startsWith('//')) return raw;
  if (prefix && (raw === prefix || raw.startsWith(`${prefix}/`))) return raw;
  if (!prefix && isLocale(raw.split(/[/?#]/)[1])) return raw;
  return `${prefix}/${locale}${raw}`;
}

/**
 * Browser pathname -> the locale-less path next-intl's `usePathname` returns:
 * `/webmail/en/settings/` -> `/settings`, `/webmail/en/` -> `/`.
 */
export function stripMountedPathname(pathname: string, prefix: string): string {
  let path = pathname || '/';
  if (prefix && (path === prefix || path.startsWith(`${prefix}/`))) path = path.slice(prefix.length) || '/';
  const parts = path.split('/');
  if (isLocale(parts[1])) path = `/${parts.slice(2).join('/')}`;
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path || '/';
}
