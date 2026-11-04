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

/** What a row shows apart from its label: the key, a count. Never part of the label. */
const ASIDE = 'kbd, [data-menu-shortcut], [data-menu-badge]';

/**
 * The words of an element, each element's apart: "Day" and "D" make "Day D", not
 * "DayD", and a name over an address doesn't run into it. Keys and counts are left out.
 */
function wordsOf(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof Element) || node.matches(ASIDE)) return '';
  return Array.from(node.childNodes).map(wordsOf).join(' ');
}

function labelOf(el: HTMLElement): string {
  const named = el.getAttribute('aria-label') ?? el.querySelector<HTMLElement>('[data-menu-label]')?.textContent ?? wordsOf(el);
  const badge = el.querySelector<HTMLElement>('[data-menu-badge]')?.textContent?.trim();
  const label = named.replace(/\s+/g, ' ').trim();
  return badge && label ? `${label} (${badge})` : label;
}

const KEY_NAMES: Record<string, string> = {
  del: 'Delete', delete: 'Delete', esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter',
  space: 'Space', tab: 'Tab', backspace: 'Backspace', insert: 'Insert', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  '↑': 'Up', '↓': 'Down', '←': 'Left', '→': 'Right', '+': 'Plus', '⌫': 'Backspace', '⏎': 'Enter', '↵': 'Enter',
};
const MODIFIERS: Record<string, string> = {
  ctrl: 'Ctrl', control: 'Ctrl', mod: 'CmdOrCtrl', cmd: 'Cmd', command: 'Cmd', '⌘': 'Cmd', alt: 'Alt', option: 'Alt',
  '⌥': 'Alt', shift: 'Shift', '⇧': 'Shift', '⌃': 'Ctrl', meta: 'Super', win: 'Super',
};
const KEY = /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|[)!@#$%^&*(:;=<,_\-.>?/~`{\][|\\}"']|Plus|Space|Tab|Backspace|Delete|Insert|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape)$/;

/**
 * A key hint as the app shows it ("Shift + I", "⌘X", "Del") in Electron's accelerator
 * syntax, or undefined when it isn't one key (two alternatives, a word).
 */
export function toAccelerator(hint: string): string | undefined {
  let text = hint.trim();
  if (!text || text.includes(' / ')) return undefined;
  const parts: string[] = [];
  // macOS writes its modifiers as symbols with nothing between: ⌘⇧K.
  while (text.length > 1 && /^[⌘⌥⇧⌃]/.test(text)) {
    parts.push(MODIFIERS[text[0]]);
    text = text.slice(1).replace(/^\s*\+?\s*/, '');
  }
  const pieces = text === '+' ? ['+'] : text.split(/\s*\+\s*/).filter(Boolean);
  if (text.endsWith('++')) pieces.push('+');
  for (let i = 0; i < pieces.length - 1; i++) {
    const modifier = MODIFIERS[pieces[i].toLowerCase()];
    if (!modifier) return undefined;
    parts.push(modifier);
  }
  const last = pieces[pieces.length - 1];
  if (!last) return undefined;
  const key = KEY_NAMES[last.toLowerCase()] ?? (last.length === 1 ? last.toUpperCase() : last);
  if (!KEY.test(key)) return undefined;
  return [...new Set(parts), key].join('+');
}

function acceleratorOf(el: HTMLElement): string | undefined {
  const hint = el.querySelector<HTMLElement>('[data-menu-shortcut], kbd')?.textContent;
  return hint ? toAccelerator(hint) : undefined;
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
      if (child.dataset.nativeSubmenu !== undefined) {
        // A folder with subfolders (a Move list): a native menu can't indent,
        // so it's a submenu with the folder itself first, as Thunderbird has it.
        const group: DesktopNativeMenuItem[] = [];
        walk(child, group);
        const [head, ...rest] = group;
        if (head && rest.length && head.type !== 'separator' && head.label) {
          into.push({ label: head.label, submenu: [head, { type: 'separator' }, ...rest] });
        } else {
          into.push(...group);
        }
        continue;
      }
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
        const accelerator = acceleratorOf(child);
        into.push({
          id,
          label,
          enabled: !isDisabled(child),
          ...(accelerator ? { accelerator } : {}),
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

/**
 * The system's menu font and the room a native menu adds around its words, in screen
 * pixels: Chromium's menus on Windows and Linux, AppKit's on macOS. Measured off the
 * real menus at 100 %; an estimate within a few pixels is all a placement needs.
 */
const NATIVE_METRICS = {
  win32: { font: '12px "Segoe UI", system-ui, sans-serif', padding: 74, keyGap: 28, charWidth: 6.2 },
  darwin: { font: '14px -apple-system, system-ui, sans-serif', padding: 48, keyGap: 24, charWidth: 7.2 },
  linux: { font: '13px system-ui, sans-serif', padding: 70, keyGap: 28, charWidth: 6.8 },
} as const;

let measureContext: CanvasRenderingContext2D | null | undefined;

function textWidth(text: string, font: string, charWidth: number): number {
  if (measureContext === undefined) {
    try {
      // jsdom has no canvas, and says so on the console.
      measureContext = typeof document === 'undefined' || /jsdom/i.test(navigator.userAgent)
        ? null
        : document.createElement('canvas').getContext('2d');
    } catch {
      measureContext = null;
    }
  }
  if (measureContext) {
    measureContext.font = font;
    const width = measureContext.measureText(text).width;
    if (Number.isFinite(width) && width > 0) return width;
  }
  return text.length * charWidth;
}

/**
 * How wide the native menu for these items will be, in the page's CSS pixels. A native
 * menu is drawn at the screen's scale, not the page's zoom: at 150 % zoom it takes up
 * less of the page. outerWidth is in screen pixels and innerWidth in CSS pixels, which
 * gives the zoom in a window with no frame.
 */
export function estimateNativeMenuWidth(items: DesktopNativeMenuItem[], platform = getDesktopBridge()?.platform ?? 'win32'): number {
  const metrics = NATIVE_METRICS[platform] ?? NATIVE_METRICS.win32;
  let widest = 0;
  for (const item of items) {
    if (item.type === 'separator' || !item.label) continue;
    const key = item.accelerator ? metrics.keyGap + textWidth(item.accelerator, metrics.font, metrics.charWidth) : 0;
    widest = Math.max(widest, textWidth(item.label, metrics.font, metrics.charWidth) + key);
  }
  const screenWidth = widest + metrics.padding;
  const zoom = typeof window !== 'undefined' && window.innerWidth > 0 && window.outerWidth > 0
    ? Math.min(5, Math.max(0.25, window.outerWidth / window.innerWidth))
    : 1;
  return Math.round(screenWidth / zoom);
}

/**
 * Where a native menu from a button opens, in page coordinates: its top left corner,
 * under the button and lined up with the edge the HTML menu would use. Only that: the
 * OS keeps a native menu on the screen itself, and it may reach past the window.
 */
export function nativeMenuPoint(
  anchor: { left: number; right: number; bottom: number; align?: 'start' | 'end' },
  menuWidth: number,
  rtl: boolean,
  gap: number,
): { x: number; y: number } {
  const alignEnd = (anchor.align === 'end') !== rtl;
  return { x: Math.max(0, Math.round(alignEnd ? anchor.right - menuWidth : anchor.left)), y: Math.round(anchor.bottom + gap) };
}

/** A native menu is up: the window's blur or a stray event says nothing about it. */
export function nativeMenuIsOpen(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.nativeMenuOpen !== undefined;
}
