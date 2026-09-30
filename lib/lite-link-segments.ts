import { locales } from '@/i18n/routing';
import { LITE_PENDING_PATH_KEY } from '@/lib/lite';
import type { AppSurface } from '@/lib/deep-links';

/**
 * Deep-link segments for the static Lite build.
 *
 * The exported HTML for `/en/mail/` is what a static host serves for every
 * path below it (`/en/mail/thread/abc`), so the route params Next prerendered
 * are always empty. The surfaces recover the segments from the address bar
 * instead, with exactly the shape Next would have passed: the path after
 * `/<prefix>/<locale>/<surface>/`, split and percent-decoded once.
 *
 * Hosts without rewrite rules (GitHub Pages) answer such a URL with 404.html.
 * The not-found page parks the requested path in sessionStorage and jumps to
 * the surface root; `takePendingLitePath` hands it over once so the surface
 * still opens the linked item and restores the URL.
 */

const SURFACES: readonly AppSurface[] = ['mail', 'calendar', 'contacts', 'files', 'settings'];

function stripPrefix(pathname: string, prefix: string): string {
  if (prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return pathname.slice(prefix.length) || '/';
  }
  return pathname;
}

function decodeOnce(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Splits a browser pathname into locale, surface and the remaining segments. */
export function parseLitePath(
  pathname: string,
  prefix = '',
): { locale: string | null; surface: AppSurface | null; segments: string[] } {
  const parts = stripPrefix(pathname.split('?')[0].split('#')[0], prefix)
    .split('/')
    .filter(Boolean);
  let locale: string | null = null;
  if (parts.length > 0 && (locales as readonly string[]).includes(parts[0])) {
    locale = parts.shift() as string;
  }
  const head = parts[0];
  if (!head) return { locale, surface: 'mail', segments: [] };
  if ((SURFACES as readonly string[]).includes(head)) {
    return { locale, surface: head as AppSurface, segments: parts.slice(1).map(decodeOnce) };
  }
  return { locale, surface: null, segments: [] };
}

/**
 * Segments for `surface` derived from `pathname`, or `[]` when the URL points
 * somewhere else (the root, another surface, the Pro shell).
 */
export function liteSegmentsFromPath(pathname: string, surface: AppSurface, prefix = ''): string[] {
  const parsed = parseLitePath(pathname, prefix);
  return parsed.surface === surface ? parsed.segments : [];
}

/** The surface root a parked deep link should be replayed on, or null. */
export function liteSurfaceRootFor(pathname: string, prefix = ''): string | null {
  const parsed = parseLitePath(pathname, prefix);
  if (!parsed.locale || !parsed.surface) return null;
  return `${prefix}/${parsed.locale}/${parsed.surface}/`;
}

/** Parks a deep link for the surface root to pick up (404 shim). */
export function stashPendingLitePath(pathWithSearch: string): boolean {
  try {
    sessionStorage.setItem(LITE_PENDING_PATH_KEY, pathWithSearch);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a parked deep link if it belongs to `surface`, leaving it in place.
 * Anything parked for another surface is ignored so its own shell can pick it
 * up. Safe to call from a render (or a `useState` initializer): React may
 * discard that render attempt when a sibling suspends (contacts reads
 * `useSearchParams` under a Suspense boundary) and run it again, so the entry
 * must survive until `clearPendingLitePath` runs from a committed effect.
 */
export function peekPendingLitePath(surface: AppSurface, prefix = ''): string | null {
  try {
    const pending = sessionStorage.getItem(LITE_PENDING_PATH_KEY);
    if (!pending) return null;
    const parsed = parseLitePath(pending, prefix);
    return parsed.surface === surface ? pending : null;
  } catch {
    return null;
  }
}

/** Removes the parked deep link once the surface has committed to it. */
export function clearPendingLitePath(): void {
  try {
    sessionStorage.removeItem(LITE_PENDING_PATH_KEY);
  } catch {
    // ignore
  }
}

/**
 * Consumes a parked deep link if it belongs to `surface` (peek + clear in one
 * step, for callers that run outside a React render).
 */
export function takePendingLitePath(surface: AppSurface, prefix = ''): string | null {
  const pending = peekPendingLitePath(surface, prefix);
  if (pending) clearPendingLitePath();
  return pending;
}
