/**
 * Send guards the admin requires that aren't running (enterprise pack R8).
 *
 * A plugin's onBeforeEmailSend can only stop mail while it runs. One the
 * admin force-enabled that is still starting, failed to start or was turned
 * off after errors (the hook bus's three-strikes breaker) used to let every
 * message through. While such a guard is down, sending waits a few seconds
 * for it and then stays blocked.
 *
 * Doesn't count: a plugin that never runs on purpose, because Bulwark
 * refused it (the no-third-party mode, the admin's approval or user-plugin
 * rules, a tier it may not have). The Security page lists those for the
 * admin. And a plugin the user turned on themselves: that is their choice.
 *
 * Which plugins guard sending: those the last start saw registering
 * onBeforeEmailSend (remembered per bundle), and before any start a plugin
 * with the `email:send` permission, to be safe.
 *
 * The plugin store hands in its state through setSendGuardSource, so the
 * send paths need no import of it (lib/outgoing/plugin-send-check.ts).
 */

import type { InstalledPlugin } from './plugin-types';

export interface SendGuardSource {
  snapshot(): {
    /** The installed plugins. */
    plugins: readonly InstalledPlugin[];
    /** Whether the admin forces a plugin on. */
    forced: (plugin: InstalledPlugin) => boolean;
    /** The admin turned plugins off: none runs, none guards. */
    pluginsOff?: boolean;
    /**
     * The plugins started and the admin's list arrived in full. Until then a
     * plugin the admin forces on can be missing from `plugins` only because
     * it hasn't reached this browser yet (a new device, a failed sync).
     */
    complete?: boolean;
    /** The plugin ids the policy forces on. */
    forcedIds?: readonly string[];
  };
  subscribe(listener: () => void): () => void;
}

export type SendGuardState = 'loading' | 'failed';

export interface DownSendGuard {
  id: string;
  name: string;
  state: SendGuardState;
}

/** Errors that mean Bulwark refused to start the plugin, not that it broke. */
const REFUSALS = new Set([
  'third-party-off',
  'user-plugins-off',
  'approval-unavailable',
  'approval-denied',
  'approval-pending',
]);
const TIER_REFUSAL = /^Privileged tier requires /;

/** How long a send waits for guards that are still starting. */
export const SEND_GUARD_WAIT_MS = 8000;

let source: SendGuardSource | null = null;

export function setSendGuardSource(next: SendGuardSource | null): void {
  source = next;
}

export function getSendGuardSource(): SendGuardSource | null {
  return source;
}

// ─── Hooks seen at the last start ─────────────────────────────

const HOOKS_KEY_PREFIX = 'plugin-declared-hooks:';

const normalHash = (hash: string | null | undefined) => (hash ?? '').replace(/^"|"$/g, '').trim().toLowerCase();

/** Called by the loader once a plugin has started: the hooks it registered. */
export function rememberDeclaredHooks(plugin: Pick<InstalledPlugin, 'id' | 'version'>, hash: string, hooks: readonly string[]): void {
  try {
    localStorage.setItem(HOOKS_KEY_PREFIX + plugin.id, JSON.stringify({ hash: normalHash(hash), version: plugin.version, hooks }));
  } catch {
    // Storage blocked or full: the permission decides until next time.
  }
}

export function forgetDeclaredHooks(pluginId: string): void {
  try { localStorage.removeItem(HOOKS_KEY_PREFIX + pluginId); } catch { /* ignore */ }
}

function rememberedHooks(plugin: InstalledPlugin): string[] | null {
  try {
    const raw = localStorage.getItem(HOOKS_KEY_PREFIX + plugin.id);
    if (!raw) return null;
    const rec = JSON.parse(raw) as { hash?: unknown; version?: unknown; hooks?: unknown };
    const same = plugin.bundleHash ? rec.hash === normalHash(plugin.bundleHash) : rec.version === plugin.version;
    if (!same || !Array.isArray(rec.hooks)) return null;
    return rec.hooks.filter((h): h is string => typeof h === 'string');
  } catch {
    return null;
  }
}

/** Whether a plugin checks mail before it is sent. */
export function guardsSending(plugin: InstalledPlugin): boolean {
  if (!plugin.permissions?.includes('email:send')) return false;
  const hooks = rememberedHooks(plugin);
  return hooks === null || hooks.includes('onBeforeEmailSend');
}

/** The state of one required guard, or null when it runs or doesn't count. */
export function guardState(plugin: InstalledPlugin): SendGuardState | null {
  switch (plugin.status) {
    case 'running':
      return null;
    case 'error': {
      const error = plugin.error ?? '';
      if (REFUSALS.has(error) || TIER_REFUSAL.test(error)) return null;
      return 'failed';
    }
    default:
      // Enabled and not running yet, or waiting for the server sync to turn it on.
      return 'loading';
  }
}

/** The force-enabled send guards that aren't running now. */
export function downSendGuards(): DownSendGuard[] {
  if (!source) return [];
  const { plugins, forced, pluginsOff, complete = true, forcedIds = [] } = source.snapshot();
  if (pluginsOff) return [];
  const out: DownSendGuard[] = [];
  for (const plugin of plugins) {
    if (!forced(plugin) || !guardsSending(plugin)) continue;
    const state = guardState(plugin);
    if (state) out.push({ id: plugin.id, name: plugin.name, state });
  }
  // A forced plugin this browser doesn't have yet may be a send check:
  // it counts as starting until the admin's list has arrived in full.
  if (!complete) {
    for (const id of forcedIds) {
      if (!plugins.some((plugin) => plugin.id === id)) out.push({ id, name: id, state: 'loading' });
    }
  }
  return out;
}

/**
 * The required guards that are still down after waiting up to `waitMs` for
 * those that are starting. Empty: sending may go on.
 */
export async function awaitSendGuards(waitMs: number = SEND_GUARD_WAIT_MS): Promise<DownSendGuard[]> {
  const down = downSendGuards();
  if (!source || !down.some((guard) => guard.state === 'loading')) return down;
  const current = source;
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => finish(), waitMs);
    const finish = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve(downSendGuards());
    };
    unsubscribe = current.subscribe(() => {
      if (!downSendGuards().some((guard) => guard.state === 'loading')) finish();
    });
  });
}
