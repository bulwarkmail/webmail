/**
 * Global shortcuts as the shell takes them (Electron accelerators) and as people read them.
 */

/** Ctrl+Alt+N, Cmd+Opt+N. The shell's default too: src/main/features/os-rules.ts. */
export const QUICK_COMPOSE_DEFAULT = 'CommandOrControl+Alt+N';

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

export function describeAccelerator(accelerator: string, platform: string | undefined): string {
  const parts = accelerator.split('+');
  const key = parts.pop() ?? '';
  const named = parts.map((part) => part.toLowerCase());
  if (platform === 'darwin') {
    const symbols = named.map((part) => MAC_SYMBOLS[part] ?? part);
    return [...symbols].sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b)).join('') + key;
  }
  const superKey = platform === 'win32' ? 'Win' : 'Super';
  return [...named.map((part) => OTHER_NAMES[part] ?? superKey), key].join('+');
}

export interface ShortcutKeyEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** The key's own letter where the layout gives one: Alt on a Mac turns N into a dead key. */
function keyName(event: ShortcutKeyEvent): string | null {
  if (/^[a-zA-Z0-9]$/.test(event.key)) return event.key.toUpperCase();
  const code = /^(?:Key([A-Z])|Digit(\d)|(F\d{1,2}))$/.exec(event.code);
  return code ? (code[1] ?? code[2] ?? code[3]) : null;
}

/**
 * A key press as a shortcut, or null while it can't be one. Two modifiers, since a global
 * Ctrl+C would take that key away from every other app. A function key is rare enough for one.
 */
export function acceleratorFromKeyEvent(event: ShortcutKeyEvent, platform: string | undefined): string | null {
  const key = keyName(event);
  if (!key) return null;
  const mac = platform === 'darwin';
  const modifiers = [
    ...((mac ? event.metaKey : event.ctrlKey) ? ['CommandOrControl'] : []),
    ...(mac && event.ctrlKey ? ['Control'] : []),
    ...(!mac && event.metaKey ? ['Super'] : []),
    ...(event.altKey ? ['Alt'] : []),
    ...(event.shiftKey ? ['Shift'] : []),
  ];
  if (modifiers.length < (/^F\d/.test(key) ? 1 : 2)) return null;
  return [...modifiers, key].join('+');
}
