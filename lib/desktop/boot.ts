/**
 * Runs in the inline boot script, before the first paint. The preload bridge
 * exists before any page script, so app/desktop.css holds from the first
 * frame. Nothing happens in a browser, which has no bridge.
 */
export function desktopBootScript(): string {
  return `if (window.bulwarkDesktop) document.documentElement.setAttribute('data-desktop', '');
                if (navigator.windowControlsOverlay && navigator.windowControlsOverlay.visible) document.documentElement.setAttribute('data-window-controls', '');`;
}
