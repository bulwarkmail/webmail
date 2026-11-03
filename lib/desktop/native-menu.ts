/**
 * Turns an HTML menu into a native one. The ContextMenu component renders as it does
 * in a browser, hidden, with its submenus open. This reads the result and shows that
 * natively. A pick clicks the row the HTML menu has for it, so a menu has one list of
 * entries with one set of handlers and the two can't drift.
 *
 * A menu with something a native one can't show (a plugin's frame, a colour picker,
 * a row with no text) stays HTML. So does anything marked data-native-menu="html".
 */

import { getDesktopBridge } from './bridge';
import type { DesktopNativeMenuItem } from './types';

export function nativeMenusAvailable(): boolean {
  return !!getDesktopBridge()?.menu?.popup;
}

export interface ReadMenu {
  items: DesktopNativeMenuItem[];
  /** The HTML row behind each native item's id. */
  elements: Map<string, HTMLElement>;
  /** There's something here a native menu can't show. */
  unsupported: boolean;
}

const ROW = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], button, a[href]';

function isDisabled(el: HTMLElement): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
}

function labelOf(el: HTMLElement): string {
  const named = el.getAttribute('aria-label') ?? el.querySelector<HTMLElement>('[data-menu-label]')?.textContent ?? el.textContent ?? '';
  return named.replace(/\s+/g, ' ').trim();
}

function isHidden(el: Element): boolean {
  return typeof window.getComputedStyle === 'function' && window.getComputedStyle(el).display === 'none';
}

export function readMenu(root: HTMLElement): ReadMenu {
  const elements = new Map<string, HTMLElement>();
  let unsupported = root.querySelector('[data-native-menu="html"], iframe, select, textarea, input[type="color"]') !== null;
  let next = 1;

  const walk = (container: Element, into: DesktopNativeMenuItem[]): void => {
    for (const child of Array.from(container.children)) {
      if (!(child instanceof HTMLElement) || isHidden(child)) continue;
      if (child.getAttribute('role') === 'separator') {
        into.push({ type: 'separator' });
        continue;
      }
      if (child.dataset.submenuPanel !== undefined) continue;
      if (child.dataset.contextMenuHeader !== undefined) {
        const label = labelOf(child);
        if (label) into.push({ id: `h${next++}`, label, enabled: false });
        continue;
      }
      if (child.dataset.submenuTrigger !== undefined) {
        const label = labelOf(child);
        if (isDisabled(child)) {
          into.push({ id: `s${next++}`, label, enabled: false });
          continue;
        }
        const panel = child.parentElement?.querySelector<HTMLElement>(':scope > [data-submenu-panel]');
        if (!panel) {
          unsupported = true;
          continue;
        }
        const submenu: DesktopNativeMenuItem[] = [];
        walk(panel, submenu);
        into.push({ label, submenu });
        continue;
      }
      if (child.matches(ROW)) {
        // A row that opens its own popup: there's nothing to click through to.
        if (child.hasAttribute('aria-haspopup')) {
          unsupported = true;
          continue;
        }
        const label = labelOf(child);
        if (!label) {
          // A swatch or an icon says nothing in a native menu.
          unsupported = true;
          continue;
        }
        const id = `i${next++}`;
        elements.set(id, child);
        const role = child.getAttribute('role');
        into.push({
          id,
          label,
          enabled: !isDisabled(child),
          ...(role === 'menuitemcheckbox' || role === 'menuitemradio'
            ? { type: role === 'menuitemcheckbox' ? 'checkbox' as const : 'radio' as const, checked: child.getAttribute('aria-checked') === 'true' }
            : {}),
        });
        continue;
      }
      // A search field over a list is no use where you can't type.
      if (child instanceof HTMLInputElement) continue;
      walk(child, into);
    }
  };

  const items: DesktopNativeMenuItem[] = [];
  walk(root, items);
  return { items, elements, unsupported };
}

const SETTLE_MS = 30;
const SETTLE_LIMIT_MS = 400;

/**
 * The menu once it stopped changing. Entries can render a moment after the menu
 * (the mail menu waits for its data), and a native menu can't grow once it's up.
 */
export async function readSettledMenu(root: HTMLElement, cancelled: () => boolean): Promise<ReadMenu> {
  const started = Date.now();
  let previous = readMenu(root);
  while (!cancelled() && Date.now() - started < SETTLE_LIMIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const current = readMenu(root);
    if (current.items.length > 0 && JSON.stringify(current.items) === JSON.stringify(previous.items)) return current;
    previous = current;
  }
  return previous;
}

/** Shows it and clicks the row picked. Resolves when the menu has gone. */
export async function showNativeMenu(read: ReadMenu, at?: { x: number; y: number }): Promise<void> {
  const popup = getDesktopBridge()?.menu?.popup;
  if (!popup) return;
  document.documentElement.dataset.nativeMenuOpen = '';
  try {
    const picked = await popup(read.items, at);
    if (picked) read.elements.get(picked)?.click();
  } finally {
    delete document.documentElement.dataset.nativeMenuOpen;
  }
}

/** A native menu is up: the window's blur or a stray event says nothing about it. */
export function nativeMenuIsOpen(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.nativeMenuOpen !== undefined;
}
