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
import { noThirdPartyTraffic, subscribeThirdPartyMode } from '@/lib/third-party-mode';
import type { HostFeaturesView } from '../plugin-types';
import type { OrganisationPolicy } from '@/lib/admin/organisation-policy';

/** The external-mail-warning plugin, retired in favour of organisation.externalMail. */
export const EXTERNAL_MAIL_WARNING_PLUGIN_ID = 'external-mail-warning';

/** The flags for an externalMail policy section (missing = both off) and the third-party mode. */
export function hostFeaturesFor(externalMail: OrganisationPolicy['externalMail'] | undefined, thirdPartyOff = false): HostFeaturesView {
  return {
    externalSenderLabel: externalMail?.senderLabel === true,
    externalRecipientWarning: externalMail?.recipientWarning === true,
    noThirdPartyTraffic: thirdPartyOff,
  };
}

export function snapshotHostFeatures(): HostFeaturesView {
  return hostFeaturesFor(usePolicyStore.getState().getOrganisation().externalMail, noThirdPartyTraffic());
}

/**
 * Which flag hands over which of the plugin's parts: the send confirm goes
 * with the recipient warning, the banner and the new-mail toast (both about
 * incoming mail from outside) with the sender label.
 */
const HOOK_FLAGS: Record<string, 'externalSenderLabel' | 'externalRecipientWarning'> = {
  onBeforeEmailSend: 'externalRecipientWarning',
  onNewEmailReceived: 'externalSenderLabel',
};
const SLOT_FLAGS: Record<string, 'externalSenderLabel' | 'externalRecipientWarning'> = {
  'email-banner': 'externalSenderLabel',
};

/** True when core does this plugin hook's job right now, so the host skips it. */
export function isHookHandedOver(pluginId: string, hookName: string, features: HostFeaturesView = snapshotHostFeatures()): boolean {
  const flag = HOOK_FLAGS[hookName];
  return pluginId === EXTERNAL_MAIL_WARNING_PLUGIN_ID && !!flag && features[flag];
}

/** True when core does this plugin slot's job right now, so the host doesn't show it. */
export function isSlotHandedOver(pluginId: string, slot: string, features: HostFeaturesView = snapshotHostFeatures()): boolean {
  const flag = SLOT_FLAGS[slot];
  return pluginId === EXTERNAL_MAIL_WARNING_PLUGIN_ID && !!flag && features[flag];
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
}
