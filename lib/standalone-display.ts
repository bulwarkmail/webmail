/**
 * Installed-app (PWA) display modes and what they break.
 *
 * In an installed web app, window.open(url, "_blank") is handed to the system
 * browser: a separate browsing context that cannot resolve the app's blob:
 * URLs, so the new window opens blank or errors (#865). Callers that would
 * open a blob: URL in a new window ask here first and show the file in-app
 * instead.
 */

import { downloadAllowedQuietly, type DownloadSubject } from "@/lib/download-guard";

type StandaloneNavigator = Navigator & { standalone?: boolean };

const APP_DISPLAY_MODES = ["standalone", "fullscreen", "window-controls-overlay"] as const;

/** Whether the page runs as an installed app rather than in a browser tab. */
export function isStandaloneDisplayMode(): boolean {
  if (typeof window === "undefined") return false;
  // iOS Safari home-screen apps report navigator.standalone and (on older
  // versions) no display-mode media feature at all.
  if ((window.navigator as StandaloneNavigator).standalone === true) return true;
  if (typeof window.matchMedia !== "function") return false;
  return APP_DISPLAY_MODES.some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches);
}

/** Whether a new window could load this URL. Only blob: URLs in an installed app cannot. */
export function canOpenUrlInNewWindow(url: string): boolean {
  return !url.startsWith("blob:") || !isStandaloneDisplayMode();
}

/**
 * Opens a preview URL in a new window when that window can load it. Returns
 * false without opening anything when it cannot, so the caller shows the
 * file in-app (or downloads it) instead of leaving the user a dead window.
 */
export function openPreviewInNewWindow(url: string, subject?: DownloadSubject): boolean {
  if (!canOpenUrlInNewWindow(url)) return false;
  // A file in a tab of its own can be saved from there: the same device
  // policy as a download. Refused, the caller previews it in the app.
  if (!downloadAllowedQuietly('attachment', subject)) return false;
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}
