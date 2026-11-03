/**
 * Keeps what the windows of the app share up to date without a reload: theme,
 * language and settings. Each is a persisted store, so a change in one window
 * reaches the others as a `storage` event. Read state and drafts go through
 * lib/popout/channel.ts, and each window keeps its own account (see
 * local-data/desktop-offline-decisions.md).
 *
 * Only in pop-outs and the desktop app: tabs of a browser keep today's
 * behaviour, where a change shows at the next load.
 */

import { useLocaleStore } from '@/stores/locale-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useThemeStore } from '@/stores/theme-store';
import { hasDesktopWindows } from '@/lib/popout/support';
import { isPopoutWindow } from '@/lib/popout/window-role';

export function windowSyncWanted(): boolean {
  return isPopoutWindow() || hasDesktopWindows();
}

/** Starts listening; returns the stop. Does nothing where windowSyncWanted says no. */
export function startWindowSync(): () => void {
  if (!windowSyncWanted()) return () => {};
  const onStorage = (event: StorageEvent) => {
    switch (event.key) {
      case 'theme-storage':
        // Rehydrating sets the state; this puts it on the page.
        void Promise.resolve(useThemeStore.persist.rehydrate()).then(() => useThemeStore.getState().initializeTheme());
        break;
      case 'locale-storage':
        // IntlProvider switches the catalog when the store changes.
        void useLocaleStore.persist.rehydrate();
        break;
      case 'settings-storage':
        void useSettingsStore.persist.rehydrate();
        break;
    }
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
