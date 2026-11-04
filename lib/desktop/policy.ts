/**
 * The OS policies as a page sees them, through the desktop app's `policy` bridge.
 * In a browser, or under a shell that predates this, there's no policy: everything
 * here says "allowed" and "not locked", so browsers behave as they always did.
 *
 * Features ask here rather than reading the bridge themselves.
 */

import { useSyncExternalStore } from 'react';
import { getDesktopBridge } from './bridge';
import type { DesktopPolicyBridge } from './types';
import {
  DEFAULT_POLICY_SNAPSHOT,
  effectivePolicyValue,
  jmapServerAllowed,
  pluginAllowedByPolicy,
  type PolicyEntry,
  type PolicyKey,
  type PolicySnapshot,
} from './policy-schema';

/** A plugin the device's policy refuses, on a plugin's record and in the settings page. */
export const PLUGIN_POLICY_REFUSED_ERROR = 'device-policy';

let cached: { bridge: DesktopPolicyBridge; snapshot: PolicySnapshot } | null = null;

/**
 * The same object until the policy changes. The bridge can't give that: contextBridge
 * copies what it returns, so each `get()` is a new object, and useSyncExternalStore takes
 * a new object for a change and renders forever.
 */
export function getDesktopPolicy(): PolicySnapshot {
  const bridge = getDesktopBridge()?.policy;
  if (!bridge?.get) return DEFAULT_POLICY_SNAPSHOT;
  if (cached?.bridge !== bridge) {
    const entry = { bridge, snapshot: bridge.get() };
    cached = entry;
    bridge.onChange?.((snapshot) => {
      entry.snapshot = snapshot;
    });
  }
  return cached.snapshot;
}

export function onDesktopPolicyChange(listener: (snapshot: PolicySnapshot) => void): () => void {
  // First, so what the listener reads is already the new value.
  getDesktopPolicy();
  return getDesktopBridge()?.policy?.onChange?.(listener) ?? (() => {});
}

const serverSnapshot = () => DEFAULT_POLICY_SNAPSHOT;

/** The policies, live, for a component. */
export function useDesktopPolicy(): PolicySnapshot {
  return useSyncExternalStore(onDesktopPolicyChange, getDesktopPolicy, serverSnapshot);
}

export function desktopPolicyEntry<K extends PolicyKey>(key: K): PolicyEntry<K> {
  return getDesktopPolicy()[key];
}

/** Forced beats the user's choice, which beats a recommendation. See policy-schema.ts. */
export function desktopPolicyValue<K extends PolicyKey>(key: K, userChoice?: PolicySnapshot[K]['value'] | null): PolicySnapshot[K]['value'] {
  return effectivePolicyValue(desktopPolicyEntry(key), userChoice) as PolicySnapshot[K]['value'];
}

export function pluginAllowedByDesktopPolicy(id: string, snapshot: PolicySnapshot = getDesktopPolicy()): boolean {
  return pluginAllowedByPolicy(snapshot.PluginsMode.value, snapshot.PluginAllowlist.value, id);
}

/**
 * Whether a plugin may run. A package names its own id, so with a list only what an
 * admin deployed (`managed`) can match it: anyone could build a package called the
 * same as a listed plugin.
 */
export function pluginMayRunByDesktopPolicy(plugin: { id: string; managed?: boolean }, snapshot: PolicySnapshot = getDesktopPolicy()): boolean {
  if (snapshot.PluginsMode.value === 'allowed') return true;
  return plugin.managed === true && pluginAllowedByDesktopPolicy(plugin.id, snapshot);
}

/** With a list or none, nobody adds a package of their own. Same reason. */
export function pluginUploadsAllowedByDesktopPolicy(snapshot: PolicySnapshot = getDesktopPolicy()): boolean {
  return snapshot.PluginsMode.value === 'allowed';
}

export function jmapServerAllowedByDesktopPolicy(serverUrl: string, snapshot: PolicySnapshot = getDesktopPolicy()): boolean {
  return jmapServerAllowed(snapshot.AllowedJmapServers.value, serverUrl);
}

/**
 * Whether the login page may offer a server of the user's own. A forced Bulwark
 * server decides that alone, unless the same policy leaves direct connections on.
 * `AllowStandalone` off says the same.
 */
export function customServerAllowedByDesktopPolicy(snapshot: PolicySnapshot = getDesktopPolicy()): boolean {
  const { AllowStandalone, InstanceUrl } = snapshot;
  if (AllowStandalone.locked) return AllowStandalone.value;
  return !InstanceUrl.locked;
}

/**
 * Whether accounts may keep mail on this device: `forced` when the policy says so
 * either way, `fallback` for the default where the user hasn't chosen. Forced off
 * feeds `noOffline` (lib/device-policy.ts), which also clears what's there already.
 * `invalid`: forced to something that makes no sense. Nothing new is kept, and a typo
 * deletes nothing.
 */
export function desktopOfflinePolicy(snapshot: PolicySnapshot = getDesktopPolicy()): { forced: boolean | null; fallback: boolean | null; invalid?: true } {
  const { OfflineEnabled } = snapshot;
  if (OfflineEnabled.locked && OfflineEnabled.invalid) return { forced: false, fallback: null, invalid: true };
  if (OfflineEnabled.locked) return { forced: OfflineEnabled.value, fallback: null };
  return { forced: null, fallback: OfflineEnabled.source === 'default' ? null : OfflineEnabled.value };
}
