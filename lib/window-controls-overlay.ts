/**
 * Window Controls Overlay: an installed app (and the desktop app's
 * titleBarOverlay window) draws the page up to the top of the window and lays
 * the native minimise, maximise and close buttons over it.
 *
 * Asks navigator.windowControlsOverlay, never the media query:
 * `(display-mode: window-controls-overlay)` is false in Electron with
 * titleBarOverlay, while the API and env(titlebar-area-*) work there.
 *
 * app/globals.css gives --titlebar-inset its first value from
 * env(titlebar-area-height, 0px), so the page has the right top padding from
 * the first paint, before any script runs. This module keeps the variable in
 * step with the API afterwards, which is what a browser or bridge without the
 * env() values relies on.
 */

export interface TitlebarArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface OverlayLike extends EventTarget {
  visible: boolean;
  getTitlebarAreaRect?: () => { x: number; y: number; width: number; height: number };
}

export const TITLEBAR_INSET_VAR = '--titlebar-inset';

function overlay(): OverlayLike | null {
  if (typeof navigator === 'undefined') return null;
  const value = (navigator as Navigator & { windowControlsOverlay?: OverlayLike }).windowControlsOverlay;
  return value ?? null;
}

/** The strip the page may draw in next to the window's controls, or null when there is no overlay. */
export function readTitlebarArea(): TitlebarArea | null {
  const current = overlay();
  if (!current?.visible) return null;
  const rect = current.getTitlebarAreaRect?.();
  if (!rect || !(rect.height > 0)) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * Sets --titlebar-inset for this area. With no area the inline value goes, so
 * the stylesheet's value (0 without an overlay) is what counts again.
 */
export function applyTitlebarInset(area: TitlebarArea | null, root: HTMLElement = document.documentElement): void {
  if (area) root.style.setProperty(TITLEBAR_INSET_VAR, `${area.height}px`);
  else root.style.removeProperty(TITLEBAR_INSET_VAR);
}

/**
 * Calls `listener` now and whenever the overlay's size or visibility changes
 * (`geometrychange`). Without the API it calls it once with null and listens
 * to nothing, so a browser without it runs no extra code. Returns the
 * unsubscribe.
 */
export function watchTitlebarArea(listener: (area: TitlebarArea | null) => void): () => void {
  listener(readTitlebarArea());
  const current = overlay();
  if (!current) return () => {};
  const onChange = () => listener(readTitlebarArea());
  current.addEventListener('geometrychange', onChange);
  return () => current.removeEventListener('geometrychange', onChange);
}
