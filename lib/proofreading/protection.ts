// Whether the message being written will be signed or encrypted, so that
// proofreading sends none of it.
//
// The webmail doesn't sign or encrypt itself; plugins do (S/MIME, OpenPGP).
// Their choice reaches the host only as ticked entries in the composer's
// Options menu:
// - an entry with `protects: 'sign' | 'encrypt'` that is ticked;
// - until plugins say so, a ticked entry with the id `sign` or `encrypt`
//   from a plugin that can sign (crypto:full).
// A running crypto:full plugin that publishes neither (OpenPGP keeps its
// toggles in its own frame) may sign or encrypt any message without the
// host seeing it. Then nothing is checked anywhere: we can't tell, so we
// don't send.
//
// The plugins' choice isn't per composer (S/MIME keeps one intent for the
// next message), so one answer covers every open composer.
//
// A crypto:full plugin that is turned on but still starting can't have said
// anything yet (S/MIME may encrypt by default): it pauses checking too.

import type { RegisteredAction } from '@/lib/plugin-sandbox/actions';
import type { InstalledPlugin } from '@/lib/plugin-types';

export const OPTIONS_SURFACE = 'composer-options-menu';

export type Protection =
  | { protected: false }
  | { protected: true; reason: 'sign' | 'encrypt' | 'unknown'; pluginName: string };

const LEGACY_IDS: Record<string, 'sign' | 'encrypt'> = { sign: 'sign', encrypt: 'encrypt' };

function canSign(plugin: InstalledPlugin): boolean {
  return (plugin.permissions ?? []).includes('crypto:full');
}

/**
 * `options`: the actions on the composer's Options menu. `running`: the
 * plugins currently loaded. `starting`: plugins turned on that aren't
 * running yet.
 */
export function draftProtection(
  options: readonly RegisteredAction[],
  running: readonly InstalledPlugin[],
  starting: readonly InstalledPlugin[] = [],
): Protection {
  const loading = starting.find(canSign);
  if (loading) return { protected: true, reason: 'unknown', pluginName: loading.name };
  const signers = new Map(running.filter(canSign).map((p) => [p.id, p]));
  const speaks = new Set<string>();
  for (const a of options) {
    const kind = a.protects ?? (signers.has(a.pluginId) ? LEGACY_IDS[a.id] : undefined);
    if (!kind) continue;
    speaks.add(a.pluginId);
    if (a.checked) return { protected: true, reason: kind, pluginName: a.pluginName };
  }
  for (const plugin of signers.values()) {
    if (!speaks.has(plugin.id)) return { protected: true, reason: 'unknown', pluginName: plugin.name };
  }
  return { protected: false };
}
