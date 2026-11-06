// Which of a retired plugin's jobs core does itself right now, from the
// admin's policy alone. Kept apart from host-features.ts, which also asks the
// assistant and keystore areas: the slots on the first screen need only this,
// and that code stays out of the page's first script.

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

/** True when core does this plugin hook's job with these features, so the host skips it. */
export function hookHandedOver(pluginId: string, hookName: string, features: HostFeaturesView): boolean {
  const flag = HOOK_FLAGS[hookName];
  return pluginId === EXTERNAL_MAIL_WARNING_PLUGIN_ID && !!flag && features[flag];
}

/** True when core does this plugin slot's job with these features, so the host doesn't show it. */
export function slotHandedOver(pluginId: string, slot: string, features: HostFeaturesView): boolean {
  const flag = SLOT_FLAGS[slot];
  return pluginId === EXTERNAL_MAIL_WARNING_PLUGIN_ID && !!flag && features[flag];
}
