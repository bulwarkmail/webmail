/**
 * Global shortcuts as the shell takes them (Electron accelerators) and as people read them.
 * `shortcutProblem` is the shell's own rule (`isAccelerator` in src/main/features/os-rules.ts),
 * so the settings page can say why before the shell silently refuses.
 */

import { localKeyName } from '@/lib/shortcut-keys';

/**
 * What turning quick compose on gives when the shell doesn't say. On Windows the shell
 * answers Ctrl+Alt+Enter: Ctrl+Alt+N is AltGr+N, which types a character on many layouts.
 */
export const QUICK_COMPOSE_DEFAULT = 'CommandOrControl+Alt+N';

/**
 * What "Show the app with a keyboard shortcut" takes when switched on: Ctrl+Alt+B (⌥⌘B), and
 * on Windows Ctrl+Alt+F11, since Ctrl+Alt is AltGr there and B types on many layouts. The
 * shell's showShortcutBuiltIn, which also moves anyone still on the old Ctrl+Shift+B to it.
 */
export function showShortcutDefault(platform: string | undefined): string {
  return platform === 'win32' ? 'CommandOrControl+Alt+F11' : 'CommandOrControl+Alt+B';
}

const MAC_SYMBOLS: Record<string, string> = {
  control: '⌃',
  ctrl: '⌃',
  alt: '⌥',
  option: '⌥',
  altgr: '⌥',
  shift: '⇧',
  commandorcontrol: '⌘',
  cmdorctrl: '⌘',
  command: '⌘',
  cmd: '⌘',
  super: '⌘',
  meta: '⌘',
};

const OTHER_NAMES: Record<string, string> = {
  control: 'Ctrl',
  ctrl: 'Ctrl',
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
  command: 'Ctrl',
  cmd: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
};

/** The order a Mac shows modifiers in. */
const MAC_ORDER = ['⌃', '⌥', '⇧', '⌘'];

/** An Electron accelerator as people read it: ⇧⌘B on a Mac, Ctrl+Alt+F11 elsewhere, in the app's language (Strg in German). */
export function describeAccelerator(accelerator: string, platform: string | undefined, language?: string): string {
  const parts = accelerator.split('+');
  const key = parts.pop() ?? '';
  const named = parts.map((part) => part.toLowerCase());
  if (platform === 'darwin') {
    const symbols = named.map((part) => MAC_SYMBOLS[part] ?? part);
    return [...symbols].sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b)).join('') + key;
  }
  const superKey = platform === 'win32' ? 'Win' : 'Super';
  return [...named.map((part) => OTHER_NAMES[part] ?? superKey), key].map((part) => localKeyName(part, language)).join('+');
}

export interface ShortcutKeyEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * What a system or every app already uses, past the rule of two modifiers. Same list as the
 * shell's. `cmd` is Cmd on a Mac and Ctrl elsewhere.
 */
const RESERVED = new Set(['cmd+shift+A', 'cmd+shift+C', 'cmd+shift+V', 'cmd+shift+X', 'cmd+shift+Z']);
/**
 * The app's own keys with two modifiers, which a global key would take from Bulwark itself:
 * the composer's Cc, Bcc and schedule send, and the menus' new message, new window, Save as
 * PDF, reply all and forward. Same list as APP_KEYS in the shell's os-rules.ts.
 */
const APP_KEYS = new Set(['cmd+shift+B', 'cmd+shift+C', 'cmd+shift+ENTER', 'cmd+shift+M', 'cmd+shift+N', 'cmd+shift+S', 'cmd+shift+R', 'cmd+shift+F']);
const RESERVED_ON_MAC = new Set([
  'cmd+shift+3', 'cmd+shift+4', 'cmd+shift+5', 'cmd+shift+Q',
  'cmd+ctrl+Q', 'cmd+ctrl+F',
  'alt+cmd+D', 'alt+cmd+H', 'alt+cmd+M',
]);

export type ShortcutPress =
  | { accelerator: string }
  /** Still pressing, or too few modifiers. */
  | { refused: 'incomplete' }
  /** This keyboard types a character with these keys, which would stop working in every app. */
  | { refused: 'types-character' }
  /** The system or every app uses these. */
  | { refused: 'reserved' };

/** The key's own letter where the layout gives one: Alt on a Mac turns N into a dead key. */
function keyName(event: ShortcutKeyEvent): string | null {
  if (/^[a-zA-Z0-9]$/.test(event.key)) return event.key.toUpperCase();
  const code = /^(?:Key([A-Z])|Digit(\d)|(F\d{1,2})|(Enter))$/.exec(event.code);
  return code ? (code[1] ?? code[2] ?? code[3] ?? code[4]) : null;
}

/**
 * AltGr is Ctrl+Alt to Windows, so a press with both reports the character it types: `}` for
 * AltGr+N on a Czech keyboard. A letter of the layout's own is no such thing: Ctrl+Alt+N on a
 * Russian keyboard reports т, which is that key anyway. `plainKey` is what the key gives
 * alone, from the keyboard map; without one, anything but a plain letter or digit counts.
 */
function typesCharacter(event: ShortcutKeyEvent, platform: string | undefined, plainKey: string | undefined): boolean {
  const mac = platform === 'darwin';
  const altGrShaped = mac ? event.altKey && !event.metaKey : event.ctrlKey && event.altKey;
  if (!altGrShaped) return false;
  if (event.key === 'Dead') return true;
  if ([...event.key].length !== 1) return false;
  if (/^[a-zA-Z0-9]$/.test(event.key)) return false;
  return !plainKey || event.key.toLowerCase() !== plainKey.toLowerCase();
}

/** The shell's rule, for an accelerator in this file's own form. */
export function shortcutProblem(accelerator: string, platform: string | undefined): 'incomplete' | 'reserved' | null {
  const parts = accelerator.split('+');
  const key = parts.pop() ?? '';
  const mac = platform === 'darwin';
  const modifiers = new Set(parts.map((part) => {
    const name = part.toLowerCase();
    if (name === 'commandorcontrol') return 'cmd';
    if (name === 'control') return mac ? 'ctrl' : 'cmd';
    return name;
  }));
  if (modifiers.has('super')) return 'reserved';
  if (modifiers.size < 2 || !(modifiers.has('cmd') || modifiers.has('ctrl'))) return 'incomplete';
  const named = `${[...modifiers].sort().join('+')}+${key}`;
  return RESERVED.has(named) || APP_KEYS.has(`${[...modifiers].sort().join('+')}+${key.toUpperCase()}`) || (mac && RESERVED_ON_MAC.has(named)) ? 'reserved' : null;
}

/**
 * A key press as a shortcut, or why not. Two modifiers with Ctrl or Cmd among them, since a
 * global Ctrl+C or Alt+F4 would take that key away from every other app.
 */
export function readShortcutPress(event: ShortcutKeyEvent, platform: string | undefined, plainKey?: string): ShortcutPress {
  if (typesCharacter(event, platform, plainKey)) return { refused: 'types-character' };
  const key = keyName(event);
  if (!key) return { refused: 'incomplete' };
  const mac = platform === 'darwin';
  const accelerator = [
    ...((mac ? event.metaKey : event.ctrlKey) ? ['CommandOrControl'] : []),
    ...(mac && event.ctrlKey ? ['Control'] : []),
    ...(!mac && event.metaKey ? ['Super'] : []),
    ...(event.altKey ? ['Alt'] : []),
    ...(event.shiftKey ? ['Shift'] : []),
    key,
  ].join('+');
  const problem = shortcutProblem(accelerator, platform);
  return problem ? { refused: problem } : { accelerator };
}
