// The user's installed plugins as the plugin store has them, for code that
// needs the list without loading the store and everything it imports (the
// composer's proofreading checks which plugins are turned on but not running
// yet). The plugin store keeps it current.

import type { InstalledPlugin } from '../plugin-types';

let plugins: readonly InstalledPlugin[] = [];
const listeners = new Set<() => void>();

export function setKnownPlugins(next: readonly InstalledPlugin[]): void {
  if (next === plugins) return;
  plugins = next;
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

export function knownPlugins(): readonly InstalledPlugin[] {
  return plugins;
}

export function subscribeKnownPlugins(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
