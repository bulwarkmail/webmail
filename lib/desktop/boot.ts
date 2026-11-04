/** What the boot script reads for "Always show the menu bar" (lib/desktop/menu-bar.ts). */
export const MENU_BAR_STORAGE_KEY = 'bulwark-menu-bar';
/** On <html> while the menu bar takes its row: app/globals.css moves everything down under it. */
export const MENU_BAR_ATTRIBUTE = 'data-menu-bar';

/**
 * Runs in the inline boot script, before the first paint. The preload bridge
 * exists before any page script, so app/desktop.css holds from the first
 * frame. Nothing happens in a browser, which has no bridge. An always-shown
 * menu bar has its row from the first frame too, so nothing jumps when it draws.
 */
export function desktopBootScript(): string {
  return `if (window.bulwarkDesktop) document.documentElement.setAttribute('data-desktop', '');
                if (navigator.windowControlsOverlay && navigator.windowControlsOverlay.visible) document.documentElement.setAttribute('data-window-controls', '');
                try { if (window.bulwarkDesktop && window.bulwarkDesktop.platform !== 'darwin' && navigator.windowControlsOverlay && navigator.windowControlsOverlay.visible && localStorage.getItem('${MENU_BAR_STORAGE_KEY}') === 'pinned') document.documentElement.setAttribute('${MENU_BAR_ATTRIBUTE}', ''); } catch (e) {}`;
}
