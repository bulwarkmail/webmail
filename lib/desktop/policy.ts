/**
 * The OS policies as a page sees them, through the desktop app's `policy` bridge.
 * In a browser, or under a shell that predates this, there's no policy: everything
 * here says "allowed" and "not locked", so browsers behave as they always did.
 *
 * Features ask here rather than reading the bridge themselves.
 */

import { useSyncExternalStore } from 'react';
import { getDesktopBridge } from './bridge';
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

export function getDesktopPolicy(): PolicySnapshot {
  return getDesktopBridge()?.policy?.get?.() ?? DEFAULT_POLICY_SNAPSHOT;
}

export function onDesktopPolicyChange(listener: (snapshot: PolicySnapshot) => void): () => void {
  return getDesktopBridge()?.policy?.onChange?.(listener) ?? (() => {});
}

/**
 * Asks to hear about a forced WipeOfflineData value. The store's wipe goes here:
 * when the handler's promise resolves, the shell remembers the value for good.
 */
export function onWipeOfflineData(handler: (nonce: string) => Promise<unknown>): () => void {
  return getDesktopBridge()?.policy?.onWipeOfflineData?.(handler) ?? (() => {});
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
  if (AllowStandalone.source !== 'default') return AllowStandalone.value;
  return !InstanceUrl.locked;
}

/**
 * Whether accounts may keep mail on this device: `forced` when the policy says so
 * either way, `fallback` for the default where the user hasn't chosen. Forced off
 * feeds `noOffline` (lib/device-policy.ts), which also clears what's there already.
 */
export function desktopOfflinePolicy(snapshot: PolicySnapshot = getDesktopPolicy()): { forced: boolean | null; fallback: boolean | null } {
  const { OfflineEnabled } = snapshot;
  if (OfflineEnabled.locked) return { forced: OfflineEnabled.value, fallback: null };
  return { forced: null, fallback: OfflineEnabled.source === 'default' ? null : OfflineEnabled.value };
}
