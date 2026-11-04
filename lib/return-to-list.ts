import { effectiveMailLayout, useSettingsStore, type InterfaceLayout, type MailLayout } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';

const KEY = 'returnToListAfterAction';

/**
 * Whether the message list and the reading pane are on screen side by side:
 * the split and horizontal layouts on a desktop. Phones, tablets, the focused
 * layout, Simple mode and Mountain View put the message in the list's place.
 */
export function listBesideReader(opts: {
  mailLayout: MailLayout;
  interfaceLayout: InterfaceLayout;
  simpleMode?: boolean;
  isMobile: boolean;
  isTablet: boolean;
}): boolean {
  if (opts.isMobile || opts.isTablet) return false;
  return effectiveMailLayout(opts.mailLayout, opts.interfaceLayout, opts.simpleMode) !== 'focus';
}

/**
 * "Return to list after delete, archive, move or mark unread", as it applies
 * here. Set by the user (on any device: the choice syncs) or by the admin
 * policy, the setting decides. Left alone, it follows the layout: with the
 * list beside the reading pane the next message opens, as in Outlook, so a
 * folder is worked through with e, e, e; where the message takes the list's
 * place it goes back to the list. Each device judges its own layout.
 */
export function effectiveReturnToList(
  settings: { returnToListAfterAction: boolean; explicitSettings: readonly string[] },
  besideReader: boolean,
  policySet: boolean,
): boolean {
  if (policySet || settings.explicitSettings.includes(KEY)) return settings.returnToListAfterAction;
  return besideReader ? false : settings.returnToListAfterAction;
}

/** Whether the admin policy presets or locks the setting. */
export function returnToListSetByPolicy(): boolean {
  const policy = usePolicyStore.getState();
  const defaults = policy.policy?.defaults;
  return (!!defaults && Object.prototype.hasOwnProperty.call(defaults, KEY)) || policy.isSettingLocked(KEY);
}

/** The setting as it applies now, read at the moment of the action. */
export function returnToListAfterAction(besideReader: boolean): boolean {
  return effectiveReturnToList(useSettingsStore.getState(), besideReader, returnToListSetByPolicy());
}

