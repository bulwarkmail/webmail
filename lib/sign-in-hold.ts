import { locales } from '@/i18n/routing';

/**
 * Work the sign-in page doesn't need waits while it is up.
 *
 * The rest of the catalog (components/providers/intl-provider.tsx) and the
 * page-wide hosts loaded after the first paint (components/providers/
 * deferred-hosts.tsx) are for the app behind the sign-in: the sign-in page
 * draws everything from its first-screen catalog, its notices included
 * (i18n/first-screen.ts), and has nothing to import, pop out or drop files
 * into. On a first visit they used to load in the gaps right as the form came
 * up, about 180 KB of script while the user starts to type. They now start
 * when the sign-in starts to leave the page (endSignInHold), when the page is
 * left, or SIGN_IN_HOLD_MS after it showed, whichever comes first, and then
 * wait for idle as before.
 */

export const SIGN_IN_HOLD_MS = 2_500;

const LOCALES: readonly string[] = locales;

/**
 * Whether `pathname` is the sign-in page: `/login` or `/<locale>/login`,
 * under the base path. Not /admin/login, not a folder named "login".
 */
export function onSignInPage(pathname: string, basePath: string = process.env.NEXT_PUBLIC_BASE_PATH ?? ''): boolean {
  let path = pathname;
  if (basePath) {
    if (path !== basePath && !path.startsWith(`${basePath}/`)) return false;
    path = path.slice(basePath.length) || '/';
  }
  const m = /^\/(?:([^/]+)\/)?login\/?$/.exec(path);
  return !!m && (m[1] === undefined || LOCALES.includes(m[1]));
}

/** Kept on the window: a page's state, never the server's. */
const ENDED = '__bulwarkSignInHoldEnded';
const ended = () => typeof window !== 'undefined' && (window as unknown as Record<string, unknown>)[ENDED] === true;

/**
 * The sign-in is under way and the page is about to go: a message opened from
 * a link needs the reader's strings from the rest of the catalog as soon as it
 * draws, so nothing waits any longer.
 */
export function endSignInHold(): void {
  if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>)[ENDED] = true;
}

/** For tests: a fresh page. */
export function resetSignInHold(): void {
  if (typeof window !== 'undefined') delete (window as unknown as Record<string, unknown>)[ENDED];
}

/**
 * Runs `fn` now, or on the sign-in page once the hold ends (endSignInHold),
 * the page is left, or SIGN_IN_HOLD_MS later. Returns a cancel function.
 */
export function afterSignInPage(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  if (ended() || !onSignInPage(window.location.pathname)) {
    fn();
    return () => {};
  }
  const start = Date.now();
  const id = window.setInterval(() => {
    if (!ended() && onSignInPage(window.location.pathname) && Date.now() - start < SIGN_IN_HOLD_MS) return;
    window.clearInterval(id);
    fn();
  }, 100);
  return () => window.clearInterval(id);
}
