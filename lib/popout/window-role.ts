/**
 * Whether this window is a pop-out (`/[locale]/popout/...`): a single message
 * or a composer in its own window, without the rail or the sidebar.
 *
 * A pop-out is a guest of the main window's session. It never evicts an
 * account, never starts a token timer and doesn't write the account list:
 * stores/auth-store.ts and stores/account-store.ts ask here.
 */

import { getDesktopBridge } from '@/lib/desktop/bridge';
import { withBasePath } from '@/lib/browser-navigation';
import { locales } from '@/i18n/routing';

const BUILD_BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

/** Path segments that are pages of their own, so a files path like /files/popout/compose isn't taken for a pop-out. */
const OTHER_SECTIONS = new Set(['mail', 'calendar', 'contacts', 'files', 'settings', 'apps', 'pro', 'admin', 'protocol', 'setup', 'connector', 'login', 'auth', 'plugins']);

export function isPopoutPath(pathname: string): boolean {
  // The mount comes off first: an app served under /mail isn't on its mail page.
  const inApp = BUILD_BASE_PATH && (pathname === BUILD_BASE_PATH || pathname.startsWith(`${BUILD_BASE_PATH}/`))
    ? pathname.slice(BUILD_BASE_PATH.length)
    : pathname;
  const segments = inApp.split('/').filter(Boolean);
  const at = segments.indexOf('popout');
  if (at < 0) return false;
  // Before it: nothing, or a locale, with a mount only a reverse proxy knows ahead of that.
  const before = segments.slice(0, at);
  if (before.length > 0 && !(locales as readonly string[]).includes(before[before.length - 1])) return false;
  if (before.some((segment) => OTHER_SECTIONS.has(segment))) return false;
  const rest = segments.slice(at + 1);
  return (rest.length === 1 && (rest[0] === 'compose' || rest[0] === 'spare')) || (rest.length === 2 && rest[0] === 'message');
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
  // The desktop app closes it for us: however the window came to be, and past the
  // shell's own bookkeeping. Whoever calls this has saved or discarded by now.
  const closeSelf = getDesktopBridge()?.windows?.closeSelf;
  if (closeSelf) {
    closeSelf();
    return;
  }
  window.close();
  window.setTimeout(() => {
    if (!window.closed) window.location.replace(withBasePath('/'));
  }, 300);
}
