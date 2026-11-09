import { isDesktopApp } from './bridge';

/**
 * Which of two texts a line shows: the desktop app's or the browser's. The app has a
 * taskbar, a tray, system voices and its own text size; a browser has tabs, its own
 * scrollbars and its own spell check. Settings pages ask here instead of each checking
 * for the app, so none of them says "browser" or "tab" in the app (settings-p3-2).
 */
export function wordingFor<T>(choices: { app: T; browser: T }): T {
  return isDesktopApp() ? choices.app : choices.browser;
}
