// Bridge between Combobox in `@plugin-host/ui` and the sandbox runtime.
// When running inside a host-framed sandbox iframe, Combobox delegates its
// floating dropdown rendering to the host so the dropdown menu floats
// outside the popup modal boundary without causing the popup to scroll.

import type {
  FloatingDropdownOpenMsg,
  FloatingDropdownUpdateMsg,
  FloatingDropdownOption,
  FloatingDropdownRect,
} from '../protocol';

export type { FloatingDropdownOption, FloatingDropdownRect };

export type FloatingDropdownHostEvent =
  | { type: 'select'; option: FloatingDropdownOption }
  | { type: 'highlight'; index: number }
  | { type: 'dismiss' };

type DropdownListener = (event: FloatingDropdownHostEvent) => void;

let hostSender: ((msg: any) => void) | null = null;
let hostAvailableCheck: (() => boolean) | null = null;
const listeners = new Map<string, Set<DropdownListener>>();

export function initFloatingDropdownBridge(
  sender: (msg: any) => void,
  isAvailable: () => boolean,
): void {
  hostSender = sender;
  hostAvailableCheck = isAvailable;
}

export function isFloatingDropdownSupported(): boolean {
  return hostAvailableCheck ? hostAvailableCheck() : false;
}

export function openFloatingDropdown(spec: Omit<FloatingDropdownOpenMsg, 'type'>): void {
  hostSender?.({ type: 'floating-dropdown-open', ...spec });
}

export function updateFloatingDropdown(spec: Omit<FloatingDropdownUpdateMsg, 'type'>): void {
  hostSender?.({ type: 'floating-dropdown-update', ...spec });
}

export function closeFloatingDropdown(id: string): void {
  hostSender?.({ type: 'floating-dropdown-close', id });
}

export function registerFloatingDropdownListener(
  id: string,
  listener: DropdownListener,
): () => void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) {
      listeners.delete(id);
    }
  };
}

export function dispatchFloatingDropdownEvent(
  id: string,
  event: FloatingDropdownHostEvent,
): void {
  const set = listeners.get(id);
  if (set) {
    for (const listener of set) {
      try {
        listener(event);
      } catch (err) {
        console.error('[floating-dropdown] listener error', err);
      }
    }
  }
}
