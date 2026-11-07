/**
 * Work the sign-in page doesn't need waits while it is up.
 *
 * The rest of the catalog (components/providers/intl-provider.tsx) and the
 * page-wide hosts loaded after the first paint (components/providers/
 * deferred-hosts.tsx) are for the app behind the sign-in: the sign-in page
 * draws everything from its first-screen catalog and has nothing to import,
 * pop out or drop files into. On a first visit they used to load in the gaps
 * right as the form came up, about 180 KB of script while the user starts to
 * type. They now start once the page is left (signed in) or SIGN_IN_HOLD_MS
 * after it showed, whichever comes first, and then wait for idle as before.
 */

export const SIGN_IN_HOLD_MS = 2_500;

/** Whether `pathname` is the sign-in page (with or without a locale or base path). */
export function onSignInPage(pathname: string): boolean {
  return /\/login\/?$/.test(pathname);
}

/**
 * Runs `fn` now, or on the sign-in page once it is left or SIGN_IN_HOLD_MS
 * later. Returns a cancel function.
 */
export function afterSignInPage(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  if (!onSignInPage(window.location.pathname)) {
    fn();
    return () => {};
  }
  const start = Date.now();
  const id = window.setInterval(() => {
    if (onSignInPage(window.location.pathname) && Date.now() - start < SIGN_IN_HOLD_MS) return;
    window.clearInterval(id);
    fn();
  }, 100);
  return () => window.clearInterval(id);
}
