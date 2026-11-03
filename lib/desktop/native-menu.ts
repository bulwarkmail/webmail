/**
 * Turns an HTML menu into a native one. The ContextMenu component renders as it does
 * in a browser, hidden, with its submenus open. This reads the result and shows that
 * natively. A pick clicks the row the HTML menu has for it, so a menu has one list of
 * entries with one set of handlers and the two can't drift.
 *
 * A menu with something a native one can't show (a colour picker, a row with no text)
 * stays HTML. So does anything marked data-native-menu="html". A plugin's frame in the
 * menu doesn't: the rest shows natively, with one line that opens the HTML menu.
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
  /** A plugin drew something of its own in the menu. */
  hasFrames: boolean;
}

const ROW = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], button, a[href]';

/** The native line that opens the HTML menu instead. */
export const HTML_MENU_ITEM = "html-menu";

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
  let unsupported = root.querySelector('[data-native-menu="html"], select, textarea, input[type="color"]') !== null;
  let hasFrames = false;
  let next = 1;

  const walk = (container: Element, into: DesktopNativeMenuItem[]): void => {
    for (const child of Array.from(container.children)) {
      if (!(child instanceof HTMLElement) || isHidden(child)) continue;
      if (child.getAttribute('role') === 'separator') {
        into.push({ type: 'separator' });
        continue;
      }
      if (child.tagName === 'IFRAME') {
        // Only a plugin's own slot has this coming. Anything else stays HTML whole.
        if (child.closest('[data-plugin-slot]')) hasFrames = true;
        else unsupported = true;
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
  return { items, elements, unsupported, hasFrames };
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

function labelOfId(items: DesktopNativeMenuItem[], id: string): string | undefined {
  for (const item of items) {
    if (item.id === id) return item.label;
    const below = item.submenu && labelOfId(item.submenu, id);
    if (below) return below;
  }
  return undefined;
}

export type NativeMenuOutcome = 'done' | 'html' | 'gone';

/**
 * Shows it and clicks the row picked. Says when the pick found nothing: the page can
 * re-render under a menu that stays up (the list refreshing), and a row that's gone
 * would otherwise do nothing with no word about it. If the same line is back at the
 * same place, that's the one.
 */
export async function showNativeMenu(read: ReadMenu, root: HTMLElement, at?: { x: number; y: number }, fromPlugins?: string): Promise<NativeMenuOutcome> {
  const popup = getDesktopBridge()?.menu?.popup;
  if (!popup) return 'done';
  const items = read.hasFrames && fromPlugins
    ? [...read.items, { type: 'separator' as const }, { id: HTML_MENU_ITEM, label: fromPlugins }]
    : read.items;
  document.documentElement.dataset.nativeMenuOpen = '';
  let picked: string | null;
  try {
    picked = await popup(items, at);
  } finally {
    delete document.documentElement.dataset.nativeMenuOpen;
  }
  if (!picked) return 'done';
  if (picked === HTML_MENU_ITEM) return 'html';
  let row = read.elements.get(picked);
  if (!row?.isConnected) {
    const again = root.isConnected ? readMenu(root) : null;
    row = again && labelOfId(again.items, picked) === labelOfId(read.items, picked) ? again.elements.get(picked) : undefined;
  }
  if (!row?.isConnected) return 'gone';
  row.click();
  return 'done';
}

/** A native menu is up: the window's blur or a stray event says nothing about it. */
export function nativeMenuIsOpen(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.nativeMenuOpen !== undefined;
}
