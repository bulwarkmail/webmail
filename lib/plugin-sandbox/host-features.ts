// What the host tells plugins about its own features (`api.host.features`),
// so a plugin can step back where Bulwark now does the job itself. Sent with
// every frame's init and again whenever it changes (the admin's policy, an
// account switch to another scope).
//
// And the other half of that hand-over: copies of a plugin core replaced
// that are older than the release which knows the flags keep running their
// hooks. While core does a job, the host skips the hooks that did it, by
// plugin id, one switch at a time.

import { usePolicyStore } from '@/stores/policy-store';
import { useAuthStore } from '@/stores/auth-store';
import { noThirdPartyTraffic, subscribeThirdPartyMode } from '@/lib/third-party-mode';
import type { HostFeaturesView, InstalledPlugin } from '../plugin-types';
import { assistantFeatures } from './assistant';
import { keystoreFeature } from './host-api-keystore';
import { pluginHasPermission } from './permissions';
import { EXTERNAL_MAIL_WARNING_PLUGIN_ID, hookHandedOver, hostFeaturesFor, slotHandedOver } from './handover';

export { EXTERNAL_MAIL_WARNING_PLUGIN_ID, hostFeaturesFor };

export function snapshotHostFeatures(plugin?: InstalledPlugin): HostFeaturesView {
  return {
    ...hostFeaturesFor(usePolicyStore.getState().getOrganisation().externalMail, noThirdPartyTraffic()),
    // The AI assistant's host APIs this webmail offers (lib/plugin-sandbox/assistant).
    ...assistantFeatures(plugin),
    ...keystoreFeature(plugin),
    ...(plugin && pluginHasPermission(plugin, 'email:render-takeover') ? { blockExternalContent: true } : {}),
  };
}

/** True when core does this plugin hook's job right now, so the host skips it (see handover.ts). */
export function isHookHandedOver(pluginId: string, hookName: string, features: HostFeaturesView = snapshotHostFeatures()): boolean {
  return hookHandedOver(pluginId, hookName, features);
}

/** True when core does this plugin slot's job right now, so the host doesn't show it (see handover.ts). */
export function isSlotHandedOver(pluginId: string, slot: string, features: HostFeaturesView = snapshotHostFeatures()): boolean {
  return slotHandedOver(pluginId, slot, features);
}

// ─── Change watch ────────────────────────────────────────────

let watching = false;
let lastKey = '';

/** Calls `onChange` with the new features whenever they change; set up once. */
export function watchHostFeatures(onChange: (features: HostFeaturesView) => void): void {
  if (watching) return;
  watching = true;
  lastKey = JSON.stringify(snapshotHostFeatures());
  const check = () => {
    const features = snapshotHostFeatures();
    const key = JSON.stringify(features);
    if (key === lastKey) return;
    lastKey = key;
    onChange(features);
  };
  usePolicyStore.subscribe(check);
  // The mode is known once the config has been read, and an admin may turn it on later.
  subscribeThirdPartyMode(check);
  // Flags that depend on the server (Files) change with the signed-in session.
  useAuthStore.subscribe((state, previous) => { if (state.client !== previous.client) check(); });
}
