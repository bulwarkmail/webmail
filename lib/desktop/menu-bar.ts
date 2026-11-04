/**
 * The desktop app's menu bar on Windows and Linux, where a window with its controls over
 * the page has no native bar: the page draws the app menu as a row at the top
 * (components/layout/window-menu-bar.tsx). Alt shows it, or "Always show the menu bar"
 * keeps it. The shell owns that setting; this keeps a copy for the first frame.
 */

import { useEffect, useState } from 'react';
import { getDesktopBridge } from './bridge';
import { describeAccelerator } from './shortcut-keys';

import { MENU_BAR_STORAGE_KEY } from './boot';

export { MENU_BAR_ATTRIBUTE, MENU_BAR_STORAGE_KEY } from './boot';

/** A shell that lets the page draw the bar and keep it shown. Never on macOS: it has the system's. */
export function menuBarAvailable(): boolean {
  const bridge = getDesktopBridge();
  return !!bridge?.menu?.bar?.setPinned && bridge.platform !== 'darwin';
}

export function cachedMenuBarPinned(): boolean {
  try {
    return localStorage.getItem(MENU_BAR_STORAGE_KEY) === 'pinned';
  } catch {
    return false;
  }
}

export function rememberMenuBarPinned(pinned: boolean): void {
  try {
    if (pinned) localStorage.setItem(MENU_BAR_STORAGE_KEY, 'pinned');
    else localStorage.removeItem(MENU_BAR_STORAGE_KEY);
  } catch {
    // Private storage off: the bar still follows the shell, a frame late.
  }
}

/** "Always show the menu bar" as the shell has it, and a way to change it in every window. */
export function useMenuBarPinned(): [boolean, (pinned: boolean) => void] {
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    setPinned(cachedMenuBarPinned());
    const bar = getDesktopBridge()?.menu?.bar;
    if (!bar) return;
    return bar.onEvent((event) => {
      if (typeof event.pinned === 'boolean') setPinned(event.pinned);
    });
  }, []);
  const change = (next: boolean) => {
    setPinned(next);
    rememberMenuBarPinned(next);
    getDesktopBridge()?.menu?.bar?.setPinned?.(next);
  };
  return [pinned, change];
}

const KEY_NAMES: Record<string, string> = {
  plus: '+',
  delete: 'Del',
  escape: 'Esc',
  left: '←',
  right: '→',
  up: '↑',
  down: '↓',
  space: 'Space',
};

/** An Electron accelerator the way a Windows or Linux menu shows it: `Ctrl+Shift+N`, `Alt+←`, `?`. */
export function menuKeyText(accelerator: string, platform: string | undefined): string {
  // A key that is itself "+", as in Ctrl++, ends in an empty part.
  const parts = accelerator.split('+');
  const last = parts[parts.length - 1] === '' ? '+' : parts[parts.length - 1];
  const key = KEY_NAMES[last.toLowerCase()] ?? (last.length === 1 ? last.toUpperCase() : last);
  const modifiers = parts.slice(0, parts[parts.length - 1] === '' ? -2 : -1);
  if (modifiers.length === 0) return key;
  const named = describeAccelerator(`${modifiers.join('+')}+X`, platform);
  return `${named.slice(0, -1)}${key}`;
}
