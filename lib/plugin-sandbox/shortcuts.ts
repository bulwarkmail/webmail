// Plugin shortcut dispatcher.
//
// Each enabled plugin declares zero-or-more keyboard shortcuts via its
// `shortcuts` export. On init the host registers each binding here. A single
// window keydown listener matches keys against the active bindings and
// dispatches via `instance.invokeHook('shortcut:<id>', [])`.
//
// The listener ignores events when an editable element has focus, matching
// the convention in `use-keyboard-shortcuts.ts`.

import { isEditableEventTarget } from '@/lib/keyboard';
import type { SandboxInstance } from './host-bridge';

interface Binding {
  pluginId: string;
  shortcutId: string;
  keys: string;          // "Ctrl+Shift+L"
  label: string;
  category?: string;
  invoke: () => Promise<void>;
}

interface NormalisedCombo {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
}

const bindings = new Map<string, Binding>();   // key: `${pluginId}:${shortcutId}`
let listenerInstalled = false;

/** The keys a plugin's shortcut is bound to ("Alt+A"), or null when it has none by that id. */
export function shortcutKeysFor(pluginId: string, shortcutId: string): string | null {
  return bindings.get(`${pluginId}:${shortcutId}`)?.keys ?? null;
}

function normaliseCombo(combo: string): NormalisedCombo | null {
  if (typeof combo !== 'string') return null;
  const parts = combo.split('+').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  let ctrl = false, shift = false, alt = false, meta = false;
  let key = '';
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') ctrl = true;
    else if (lower === 'shift') shift = true;
    else if (lower === 'alt' || lower === 'option') alt = true;
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command') meta = true;
    else key = lower;
  }
  if (!key) return null;
  return { ctrl, shift, alt, meta, key };
}

// Keys a plugin may never bind: the app and the browser need them.
const RESERVED_KEYS = new Set(['escape', 'tab', 'enter', 'f1', 'f5', 'f11', 'f12', 'delete', 'backspace']);
// Ctrl/Cmd+Shift chords browsers use (reopen tab, new private window,
// devtools, …).
const BROWSER_SHIFT_CHORDS = new Set(['t', 'n', 'w', 'q', 'i', 'j', 'c', 'r', 'p', 'b', 'o', 'delete', 'tab', 'enter', 'k']);

/**
 * Whether a plugin may bind this combo. The app uses bare keys (j, k, c, /,
 * Shift+G…) and Escape, and browsers own plain Ctrl/Cmd chords, so a plugin
 * needs Alt, Ctrl/Cmd+Shift or Ctrl/Cmd+Alt.
 */
export function isAllowedPluginCombo(keys: string): boolean {
  const combo = normaliseCombo(keys);
  if (!combo) return false;
  if (RESERVED_KEYS.has(combo.key)) return false;
  const primary = combo.ctrl || combo.meta;
  if (combo.alt) return true;
  if (primary && combo.shift) return !BROWSER_SHIFT_CHORDS.has(combo.key);
  return false;
}

function comboId(combo: NormalisedCombo): string {
  return `${combo.ctrl || combo.meta ? 'C' : ''}${combo.shift ? 'S' : ''}${combo.alt ? 'A' : ''}+${combo.key}`;
}

function eventMatches(ev: KeyboardEvent, combo: NormalisedCombo): boolean {
  if (combo.ctrl !== (ev.ctrlKey || ev.metaKey ? ev.ctrlKey : false)) {
    // Treat Ctrl and Cmd as equivalent: a binding declaring Ctrl matches a
    // Cmd press on macOS.
    if (combo.ctrl) {
      if (!(ev.ctrlKey || ev.metaKey)) return false;
    } else if (ev.ctrlKey) return false;
  }
  if (combo.shift !== ev.shiftKey) return false;
  if (combo.alt !== ev.altKey) return false;
  if (!combo.ctrl && combo.meta !== ev.metaKey) return false;
  if (ev.key.toLowerCase() === combo.key) return true;
  // With Alt held, macOS types another character (Alt+A is "å"): match the
  // physical key for letters and digits.
  if (/^[a-z]$/.test(combo.key)) return ev.code === `Key${combo.key.toUpperCase()}`;
  if (/^[0-9]$/.test(combo.key)) return ev.code === `Digit${combo.key}`;
  return false;
}

/** Whether a key event is the combo ("Ctrl+Shift+A"); Ctrl and Cmd count the same. */
export function matchesCombo(keys: string, ev: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): boolean {
  const combo = normaliseCombo(keys);
  return !!combo && eventMatches(ev as KeyboardEvent, combo);
}

function onKeyDown(ev: KeyboardEvent): void {
  if (isEditableEventTarget(ev)) return;
  if (bindings.size === 0) return;
  for (const binding of bindings.values()) {
    const combo = normaliseCombo(binding.keys);
    if (!combo) continue;
    if (eventMatches(ev, combo)) {
      // Not stopPropagation: the app's own listeners still see the key.
      ev.preventDefault();
      void binding.invoke();
      return;
    }
  }
}

function ensureListener(): void {
  if (listenerInstalled || typeof window === 'undefined') return;
  listenerInstalled = true;
  window.addEventListener('keydown', onKeyDown, true);
}

export function registerShortcuts(
  instance: SandboxInstance,
  shortcuts: Array<{ id: string; keys: string; label: string; category?: string }>,
): () => void {
  ensureListener();
  const keys: string[] = [];
  const taken = new Set([...bindings.values()].map((b) => {
    const c = normaliseCombo(b.keys);
    return c ? comboId(c) : '';
  }));
  for (const sc of shortcuts) {
    const key = `${instance.pluginId}:${sc.id}`;
    const combo = normaliseCombo(sc.keys);
    if (!combo || !isAllowedPluginCombo(sc.keys)) {
      console.warn(`[plugin-shortcuts] "${instance.pluginId}" may not bind ${sc.keys}; use Alt, Ctrl+Shift or Ctrl+Alt`);
      continue;
    }
    if (taken.has(comboId(combo))) {
      console.warn(`[plugin-shortcuts] ${sc.keys} is already used by another plugin; "${instance.pluginId}" does not get it`);
      continue;
    }
    taken.add(comboId(combo));
    bindings.set(key, {
      pluginId: instance.pluginId,
      shortcutId: sc.id,
      keys: sc.keys,
      label: sc.label,
      category: sc.category,
      invoke: async () => {
        try {
          await instance.invokeHook(`shortcut:${sc.id}`, []);
        } catch {
          /* hook tracker already logs */
        }
      },
    });
    keys.push(key);
  }
  return () => {
    for (const k of keys) bindings.delete(k);
  };
}
