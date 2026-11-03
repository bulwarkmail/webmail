/**
 * Whether this window is a pop-out (`/[locale]/popout/...`): a single message
 * or a composer in its own window, without the rail or the sidebar.
 *
 * A pop-out is a guest of the main window's session. It never evicts an
 * account, never starts a token timer and doesn't write the account list:
 * stores/auth-store.ts and stores/account-store.ts ask here.
 */

import { withBasePath } from '@/lib/browser-navigation';

/** First path segments that are pages of their own, so a files path like /files/popout/compose isn't taken for a pop-out. */
const OTHER_SECTIONS = new Set(['mail', 'calendar', 'contacts', 'files', 'settings', 'apps', 'pro', 'admin', 'protocol', 'setup', 'connector', 'login', 'auth', 'plugins']);

export function isPopoutPath(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean);
  const at = segments.indexOf('popout');
  if (at < 0 || segments.slice(0, at).some((segment) => OTHER_SECTIONS.has(segment))) return false;
  const rest = segments.slice(at + 1);
  return (rest.length === 1 && rest[0] === 'compose') || (rest.length === 2 && rest[0] === 'message');
}

export function isPopoutWindow(): boolean {
  return typeof window !== 'undefined' && isPopoutPath(window.location.pathname);
}

/**
 * localStorage for the stores a pop-out shares with the main window, without
 * its writes: a pop-out on account B would otherwise switch the main window
 * to B at its next reload, and write back a list older than the main
 * window's. Throws on the server like a bare `localStorage` does, which
 * createJSONStorage takes as "no storage".
 */
export function mainWindowStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  if (typeof localStorage === 'undefined') throw new Error('No localStorage here');
  return {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => {
      if (!isPopoutWindow()) localStorage.setItem(key, value);
    },
    removeItem: (key) => {
      if (!isPopoutWindow()) localStorage.removeItem(key);
    },
  };
}

/**
 * Closes the pop-out. A script may only close a window a script opened, so a
 * pop-out address opened by hand goes to the app instead.
 */
export function closePopoutWindow(): void {
  if (typeof window === 'undefined') return;
  window.close();
  window.setTimeout(() => {
    if (!window.closed) window.location.replace(withBasePath('/'));
  }, 300);
}
