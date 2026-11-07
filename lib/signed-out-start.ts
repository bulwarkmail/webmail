/**
 * A start with nothing to sign in with goes straight to the sign-in page.
 *
 * The mail view at the app's root used to start up first: it downloaded and
 * ran the whole mail client, asked the server whether a session cookie could
 * be adopted, and only then moved to /login. On a first visit that was half
 * of the time to the sign-in form, and none of it was needed.
 *
 * Whether there is anything to sign in with is split between the server and
 * the browser. The server sees the session cookies (all named `jmap_…`), the
 * browser sees the accounts it keeps in localStorage. So the page script
 * below keeps a marker cookie (LOCAL_COOKIE) while it keeps anything a start
 * could restore, and proxy.ts redirects a page load of the root to the
 * sign-in page only when the request carries neither (signedOutStartTarget).
 *
 * A browser can keep accounts without the marker: one that last ran an older
 * version, or whose cookies were cleared without its storage. The redirect
 * sets START_COOKIE for a minute, and the sign-in page's script, finding it
 * together with kept accounts, sets the marker and goes back to the root,
 * which then starts the mail view as before.
 */

/** Set by the page script while the browser keeps accounts a start could restore. */
export const LOCAL_COOKIE = 'bulwark_local';
/** Set by the redirect for the sign-in page's script to check (see above). */
export const START_COOKIE = 'bulwark_start';
/** lib/app-lock/sign-out.ts COOKIES_TO_CLEAR_KEY: a sign-out whose cookies may still be there. */
const COOKIES_TO_CLEAR_KEY = 'bulwark-cookies-to-clear';

export interface StartRequest {
  method: string;
  /** Decoded path without the base path. */
  pathname: string;
  search: string;
  header: (name: string) => string | null;
  cookieNames: readonly string[];
  locales: readonly string[];
  /**
   * The path (without the base path) the locale middleware redirects to, or
   * null when it rewrote the request or didn't run.
   */
  intlRedirect: string | null;
  demoMode: boolean;
}

function isPageLoad(r: StartRequest): boolean {
  if (r.method !== 'GET') return false;
  // The router's own requests (RSC, prefetches) and the app lock's probe aren't page loads.
  if (r.header('rsc') !== null || r.header('next-router-prefetch') !== null || r.header('x-bulwark-reload-probe') !== null) return false;
  const dest = r.header('sec-fetch-dest');
  // Only a top-level page: a portal's frame may sign in through its bridge.
  if (dest !== null) return dest === 'document';
  return (r.header('accept') ?? '').includes('text/html');
}

/** `/<locale>` (with or without a trailing slash) gives the locale, anything else null. */
function localeRoot(path: string, locales: readonly string[]): string | null {
  const m = /^\/([^/]+)\/?$/.exec(path);
  return m && locales.includes(m[1]) ? m[1] : null;
}

/**
 * The sign-in page to redirect a page load of the root to, or null to serve
 * the request as it is. Only the bare root: a deep link, a query (mailto, a
 * hand-off) or a fragment keeps the mail view, which saves where to return.
 */
export function signedOutStartTarget(r: StartRequest): string | null {
  if (r.demoMode || r.search !== '' || !isPageLoad(r)) return null;
  if (r.cookieNames.some((name) => name.startsWith('jmap_') || name === LOCAL_COOKIE)) return null;
  if (r.pathname === '/') {
    if (r.intlRedirect === null) return '/login';
    const locale = localeRoot(r.intlRedirect, r.locales);
    return locale ? `/${locale}/login` : null;
  }
  const locale = localeRoot(r.pathname, r.locales);
  return locale && r.intlRedirect === null ? `/${locale}/login` : null;
}

export interface StartScriptConfig {
  local: string;
  start: string;
  clear: string;
  path: string;
}

/**
 * Runs in the page's inline <head> script. Keeps LOCAL_COOKIE in step with
 * what this browser keeps, and sends a sign-in page reached by the redirect
 * back to the root when there was something to restore after all. Only the
 * sign-in page drops the marker: there the account list is the main window's
 * and complete. ES5 and self-contained: it is inlined with toString().
 */
export function applySignedOutStart(w: Window, d: Document, cfg: StartScriptConfig): void {
  var local = false;
  try {
    // The desktop app restores its sign-ins its own way; it always starts the mail view.
    if ((w as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop) local = true;
    var registry = JSON.parse(w.localStorage.getItem('account-registry') || 'null');
    var accounts = registry && registry.state && registry.state.accounts;
    if (Array.isArray(accounts) && accounts.length > 0) local = true;
    if (w.localStorage.getItem(cfg.clear) !== null) local = true;
    var auth = JSON.parse(w.localStorage.getItem('auth-storage') || 'null');
    if (auth && auth.state && auth.state.isAuthenticated === true) local = true;
  } catch {
    // Can't tell: start the mail view, which finds out.
    local = true;
  }
  var has = function (name: string) { return (' ' + d.cookie).indexOf(' ' + name + '=') !== -1; };
  var secure = w.location.protocol === 'https:' ? ';Secure' : '';
  var put = function (name: string, value: string, age: number) {
    d.cookie = name + '=' + value + ';Path=' + cfg.path + ';Max-Age=' + age + ';SameSite=Lax' + secure;
  };
  var onLogin = /\/login\/?$/.test(w.location.pathname);
  if (local) {
    if (!has(cfg.local)) put(cfg.local, '1', 34560000);
  } else if (onLogin && has(cfg.local)) {
    put(cfg.local, '', 0);
  }
  if (has(cfg.start)) {
    put(cfg.start, '', 0);
    if (local && onLogin) w.location.replace(w.location.pathname.replace(/\/login\/?$/, '') || '/');
  }
}

/** The inline script for the (main) layout's <head>. `basePath` without a trailing slash. */
export function signedOutStartScript(basePath: string): string {
  const cfg: StartScriptConfig = { local: LOCAL_COOKIE, start: START_COOKIE, clear: COOKIES_TO_CLEAR_KEY, path: basePath || '/' };
  return `try{(${applySignedOutStart.toString()})(window,document,${JSON.stringify(cfg)});}catch(e){}`;
}
